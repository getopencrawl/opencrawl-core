import {gunzipSync} from 'node:zlib';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import type {ApplicationDatabase} from './postgres.mjs';
import type {ObjectStore,JsonObject} from '../sessions/types.mjs';
import {SESSION_HARNESSES,isSessionHarness} from '../sessions/types.mjs';
import type {IntegrationRecord} from '../integrations/types.mjs';
import type {OnboardingKind} from '../onboarding-status.mjs';
import type {BoardState} from '../board/types.mjs';
import type {createPostgresEventIdentities} from '../sessions/postgres-identities.mjs';
import {sourceBatchIdentity,digest,MAX_EVENT_LEDGER_BYTES} from '../sessions/event-identity.mjs';
import {memorySourceIdentity} from '../memories/snapshot.mjs';
import {sessionCatchupMarker} from '../sessions/temporal/handoff.mjs';
import {createPostgresControls} from './resource-controls.mjs';
import {createPostgresWriteBarrier,ensureWriteBarrierSchema} from './write-barriers.mjs';
import {createPostgresDeletionRequests,ensureDeletionRequestSchema} from './deletion-requests.mjs';
import {createAccountState,captureCredentialSchema,onboardingReceiptSchema,roleWriteSchema} from './account-state.mjs';
import {createConnectorSecrets} from './connector-secrets.mjs';
import {connectorGrantSchema,sealedEnvelope} from '../integrations/credential-vault.mjs';
import {connectorSettingsSchema} from '../integrations/connector-settings.mjs';
import {createReplicasState} from './replicas.mjs';
import {replicasConnectionSchema,replicasChallengeSchema} from '../identity/replicas-connections.mjs';
import {createValueReports} from './value-reports.mjs';
import {createPostgresIndexingReceipts} from './indexing-receipts.mjs';
import {createPostgresSlackCapture} from './slack-capture.mjs';
import {digest as connectorBindingHash,validateBinding} from '../connectors/scope.mjs';
import {createConnectorCounts} from './connector-counts.mjs';
import {createPostgresBoardState,validateLegacyBoard} from './board.mjs';
import {createConnectorCacheRetirements,type ConnectorCacheRetirement} from './connector-cache-retirements.mjs';
import {createSchedulerRetirements,type SchedulerRetirement} from './scheduler-retirements.mjs';

const H='[a-f0-9]{64}',U='[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const hash=z.string().regex(/^[a-f0-9]{64}$/),number=z.number().int().nonnegative().safe();
const identifier=z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const date=z.string().refine(value=>Number.isFinite(Date.parse(value)));
const json=(bytes:Buffer):unknown=>JSON.parse(bytes.toString('utf8'));
function fail(message:string):never{throw Object.assign(new Error(message),{code:'APPLICATION_MIGRATION_UNSAFE'});}
const controlSchema=z.strictObject({schemaVersion:z.literal(1),visibility:z.enum(['team','private']),deletedAt:date.nullable(),updatedAt:date,
  deletion:z.strictObject({sessionId:identifier,state:z.enum(['pending','complete'])}).optional()});
const writerSchema=z.strictObject({id:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),operation:z.enum(['object-put','search-write']),phase:z.enum(['writing','settled']),
  startedAt:number,settledAt:number.optional(),instance:z.string().max(100),target:z.string().max(8192)});
const fenceSchema=z.strictObject({version:z.literal(1),namespace:identifier,tenantId:identifier,connectionId:identifier,closedAt:number.nullable(),writers:z.array(writerSchema)});
const deletionSchema=z.strictObject({schemaVersion:z.literal(1),owner:z.strictObject({tenantId:identifier,userId:identifier}),harness:z.string().refine(isSessionHarness),sessionId:identifier});
const countSchema=z.strictObject({version:z.literal(1),read:z.array(z.string().min(1).max(8192)),ids:z.record(z.string().min(1).max(200),z.array(z.string().regex(/^[A-Za-z0-9_-]{12}$/))),
  full:z.record(z.string().min(1).max(200),z.strictObject({sync:number.nullable(),count:number})).optional()});
const eventSchema=z.discriminatedUnion('schemaVersion',[
  z.strictObject({schemaVersion:z.literal(1),identity:hash,events:z.record(hash,hash)}),
  z.strictObject({schemaVersion:z.literal(2),identity:hash,database:z.string().uuid(),namespace:hash}),
]);
const normalizeCounts=(value:z.infer<typeof countSchema>)=>({version:1 as const,read:[...new Set(value.read)].sort(),
  ids:Object.fromEntries(Object.entries(value.ids).map(([stream,ids])=>[stream,[...new Set(ids)].sort()])),full:value.full??{}});
interface Classification {domain:string;maxBytes:number;parts:string[]}
export interface ObjectMigrationOptions {
  database:ApplicationDatabase;prefix:string;organizationId:string;store:ObjectStore;registryRecords:IntegrationRecord[];
  connectorKey?:Uint8Array;eventIdentities:ReturnType<typeof createPostgresEventIdentities>;
}

export interface TenantObjectMigrationOptions extends Omit<ObjectMigrationOptions,'organizationId'> {
  tenantId:string;credentialPurpose?:'capture'|'agent';
}
export interface BoundObjectMigrationOptions extends Omit<TenantObjectMigrationOptions,'tenantId'> {tenantIds:readonly string[];retiredTenantHashes?:readonly string[]}

/** Self-host migration pins exactly one organization. The portable per-tenant
 * importer below is also used by explicitly bound multi-tenant runtimes. */
export function createObjectMigration(options:ObjectMigrationOptions){
  if(!/^org_[A-Za-z0-9]+$/.test(options.organizationId))fail('Invalid object migration scope');
  return createTenantObjectMigration({...options,tenantId:options.organizationId});
}

/** Offline source reader. Every mutable path has a typed importer and an
 * independent readback. Unknown paths fail closed; no runtime object-state
 * adapter is available here. Schema creation is lazy and only happens on write. */
export function createTenantObjectMigration({tenantId,...options}:TenantObjectMigrationOptions){return createBoundObjectMigration({...options,tenantIds:[tenantId]});}

/** The runtime supplies a finite reviewed source binding. Scoped records must
 * match that set exactly; installation-level markers remain bound to this
 * bucket and prefix and never borrow an arbitrary tenant identity. */
export function createBoundObjectMigration({database,prefix,tenantIds,store,registryRecords,connectorKey,eventIdentities,credentialPurpose='capture',retiredTenantHashes=[]}:BoundObjectMigrationOptions){
  if(!prefix||prefix.split('/').some(value=>!value||value==='.'||value==='..')||!tenantIds.length||tenantIds.length>100000||tenantIds.some(value=>!/^(?:org_[A-Za-z0-9]+|personal:user_[A-Za-z0-9]+)$/.test(value))||!['capture','agent'].includes(credentialPurpose)||!store.bucket)fail('Invalid object migration scope');
  const tenants=new Set(tenantIds),tenantHashes=new Set(tenantIds.map(digest)),retiredHashes=new Set(retiredTenantHashes);
  if(retiredHashes.size!==retiredTenantHashes.length||retiredTenantHashes.length>100000||retiredTenantHashes.some(value=>!hash.safeParse(value).success||tenantHashes.has(value)))fail('Invalid retired tenant evidence binding');
  if(tenants.size!==tenantIds.length||tenantHashes.size!==tenants.size)fail('Ambiguous object migration tenant binding');
  const roots=credentialPurpose==='agent'?[prefix+'/']:[prefix+'/', 'control/connectors/write-barriers/v1/','connector-credentials/v1/','connector-settings/v1/','derived/indexing/','raw/v1/source=slack/','_opencrawl/counts/'];
  const controls=createPostgresControls(database),deletions=createPostgresDeletionRequests(database,prefix),accounts=createAccountState(database),secrets=createConnectorSecrets(database),
    replicas=createReplicasState(database),reports=createValueReports(database),receipts=createPostgresIndexingReceipts(database),slack=createPostgresSlackCapture(database),counts=createConnectorCounts({database,legacyBucket:store.bucket}),board=createPostgresBoardState(database),retirements=createSchedulerRetirements(database),connectorRetirements=createConnectorCacheRetirements(database);
  const preparations=new Map<string,Promise<void>>();
  async function prepare(name:string,run:()=>Promise<void>){let pending=preparations.get(name);if(!pending){pending=run();preparations.set(name,pending);}await pending;}
  // Missing domain tables mean an uninitialized target. Every other SQL error
  // remains an error, including missing columns, constraints and access denial.
  async function read<T>(run:()=>Promise<T>):Promise<T|null>{try{return await run();}catch(error){if((error as {code?:string}).code==='42P01')return null;throw error;}}
  const tenant=(value:string)=>{if(!tenants.has(value))fail('Legacy object belongs to another installation organization');};
  const tenantDigest=(value:string)=>{if(!tenantHashes.has(value))fail('Legacy object owner hash differs from the installation organization');};
  function classify(key:string):Classification|null {
    if(typeof key!=='string'||key.length>8192||key.split('/').some(part=>!part||part==='.'||part==='..'))fail('Invalid object migration key');
    const match=(pattern:RegExp,domain:string,maxBytes=65536):Classification|null=>{const value=pattern.exec(key.startsWith(prefix+'/')?key.slice(prefix.length+1):key);return value?{domain,maxBytes,parts:value.slice(1)}:null;};
    if(key.startsWith(prefix+'/')){
      const raw=key.slice(prefix.length+1);
      if(credentialPurpose==='agent'&&!new RegExp(`^(?:_credentials/${H}|_credential-generations/tenants/${H}/users/${H})\\.json$`).test(raw))fail('Agent credential source contains unrelated application state');
      const source=sourceBatchIdentity(prefix,key)??memorySourceIdentity(prefix,key);
      if(source){tenantDigest(source.tenantHash);return null;}
      const attachment=new RegExp(`^tenants/(${H})/users/${H}/(?:(?:${SESSION_HARNESSES.join('|')})/${H}/${H}/)?attachments/${H}$`).exec(raw);
      if(attachment){tenantDigest(attachment[1]);return null;}
      const found=match(new RegExp(`^board/tenants/(${H})\\.json$`),'board',16*1024*1024)
        ??match(new RegExp(`^tenants/(${H})/users/(${H})/controls/(sessions|memories)/([^/]+)/(${H})\\.json$`),'resource-controls')
        ??match(new RegExp(`^tenants/(${H})/users/(${H})/controls/write-barriers/(${H})\\.json$`),'session-write-fences',16*1024*1024)
        ??match(new RegExp(`^_deletions/v1/(${H})\\.json$`),'deletion-requests')
        ??match(new RegExp(`^_credentials/(${H})\\.json$`),'capture-credentials')
        ??match(new RegExp(`^_credential-generations/(tenants/(${H})/users/${H})\\.json$`),'credential-generations')
        ??match(/^organization-role-writes\/(org_[A-Za-z0-9]+)\.json$/,'role-writes')
        ??match(new RegExp(`^identity/replicas-v1/organizations/(${U})\\.json$`),'replicas-connections')
        ??match(new RegExp(`^identity/replicas-v1/tenants/(${H})/(${U})\\.json$`),'replicas-index')
        ??match(new RegExp(`^identity/replicas-v1/setup/(${H})\\.json$`),'replicas-setup')
        ??match(new RegExp(`^(tenants/(${H})/users/${H})/onboarding/(cli|mcp|mcpTest|session|history|completed)\\.json$`),'onboarding')
        ??match(new RegExp(`^value/tenants/(${H})\\.json$`),'value-reports')
        ??match(new RegExp(`^index-pending/tenants/(${H})/users/(${H})/(${H})\\.json$`),'session-scheduler-retirement',32768)
        ??match(new RegExp(`^_index/${H}/${H}/(cursor|reconcile)\\.json$`),'session-scheduler-retirement',32768)
        ??match(new RegExp(`^_index/${H}/${H}/batches/(${H})\\.json$`),'session-indexing',32768)
        ??match(new RegExp(`^_index/temporal-cutover/(${H})\\.json$`),'temporal-cutover',32768)
        ??match(new RegExp(`^tenants/(${H})/users/${H}/(?:${SESSION_HARNESSES.join('|')})/${H}/${H}/event-identities-v1\\.json$`),'event-identities',MAX_EVENT_LEDGER_BYTES);
      if(found){if(credentialPurpose==='agent'&&!['capture-credentials','credential-generations'].includes(found.domain))fail('Agent credential source contains unrelated application state');return found;}
      fail('Unrecognized object under the application source prefix; retain it and add a reviewed migration');
    }
    if(credentialPurpose==='agent')fail('Agent credential source escaped its bound prefix');
    const found=match(new RegExp(`^control/connectors/write-barriers/v1/(${H})\\.json$`),'connector-write-fences',16*1024*1024)
      ??match(/^connector-credentials\/v1\/(org_[A-Za-z0-9]+)\/(grant_[a-f0-9]{48})\.enc$/,'connector-grants')
      ??match(/^connector-settings\/v1\/(org_[A-Za-z0-9]+)\/settings\.enc$/,'connector-settings')
      ??match(new RegExp(`^derived/indexing/([A-Za-z0-9_-]+)/${H}/(${H})\\.json$`),'connector-indexing',32768)
      ??match(new RegExp(`^derived/indexing/([A-Za-z0-9_-]+)/${H}/snapshot-(${H})\\.json$`),'connector-snapshots',32768)
      ??match(/^_opencrawl\/counts\/connection=(int_[a-f0-9]{26})\.json\.gz$/,'record-counts',64*1024*1024)
      ??match(/^raw\/v1\/source=slack\/workspace=[A-Za-z0-9_:-]{1,200}\/connection=[A-Za-z0-9_:-]{1,200}\/capture\/(files-v1|messages-v1|message-references-v1)\/(?:catalog\.json|[A-Za-z0-9_-]{1,150}\/state\.json)$/,'slack-capture',16*1024*1024);
    if(found)return found;
    if(/^raw\/v1\/source=slack\/workspace=[A-Za-z0-9_:-]{1,200}\/connection=[A-Za-z0-9_:-]{1,200}\/(?:stream=[A-Za-z0-9_-]+\/date=\d{4}-\d{2}-\d{2}\/sync=[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.jsonl\.gz|files\/sha256\/[a-f0-9]{64}\.bin|capture\/(?:files-v1|messages-v1|message-references-v1)\/[A-Za-z0-9_-]{1,150}\/pages\/[a-f0-9]{64}\.json)$/.test(key))return null;
    if(roots.some(root=>key.startsWith(root)))fail('Unrecognized object under a mutable state namespace; retain it and add a reviewed migration');
    return null;
  }
  async function retirementDisposition(sourceKey:string):Promise<'full-temporal-catchup'|'deleted'>{
    const identity=sourceBatchIdentity(prefix,sourceKey);if(!identity)fail('Legacy scheduler source is not a captured session');tenantDigest(identity.tenantHash);
    if(await store.get(sourceKey,{maxBytes:17*1024*1024}))return 'full-temporal-catchup';
    // Import order must not matter: the deletion control may sort after its
    // queue item. Validate original control bytes, or use authoritative SQL.
    const current=await read(()=>controls.readSource(identity));
    if(current?.deletedAt)return 'deleted';
    const controlKey=prefix+'/tenants/'+identity.tenantHash+'/users/'+identity.userHash+'/controls/sessions/'+identity.harness+'/'+identity.sessionHash+'.json';
    const bytes=await store.get(controlKey,{maxBytes:65536});
    if(bytes){const control=controlSchema.parse(json(bytes));
      if(control.deletion&&digest(control.deletion.sessionId)!==identity.sessionHash)fail('Legacy scheduler deletion proof identity mismatch');
      if(control.deletedAt)return 'deleted';
    }
    fail('Legacy scheduler source is missing without an authoritative deletion tombstone');
  }
  async function retire(key:string,value:SchedulerRetirement,write:boolean){
    if(write){await prepare('scheduler-retirements',retirements.ready);await retirements.importRetirement(key,value);}
    return {source:value,target:await read(()=>retirements.exportRetirement(key)),rows:1};
  }
  async function process(key:string,bytes:Buffer,{write}:{write:boolean}):Promise<{source:unknown|Buffer;target:unknown|Buffer|null;rows:number}>{
    const found=classify(key);if(!found)fail('Immutable source objects do not use application-state import');
    if(bytes.length>found.maxBytes)fail('Legacy state object exceeds its supported migration limit');
    const {domain,parts}=found;let source:unknown,target:unknown|null=null,rows=1;
    switch(domain){
      case 'resource-controls':{
        const [tenantHash,userHash,kind,harness,resourceHash]=parts;if(!retiredHashes.has(tenantHash))tenantDigest(tenantHash);if(!isSessionHarness(harness))fail('Unknown control harness');
        const value=controlSchema.parse(json(bytes));if(retiredHashes.has(tenantHash)&&!value.deletedAt)fail('Retired tenant scope allows only deletion tombstones');if(value.deletion&&(!value.deletedAt||kind!=='sessions'||digest(value.deletion.sessionId)!==resourceHash))fail('Deletion control identity mismatch');
        const identity={tenantHash,userHash,kind:kind as 'sessions'|'memories',harness,resourceHash};source=value;
        if(write){await prepare('controls',controls.ready);await controls.importControl(identity,value);}target=await read(()=>controls.readIdentity(identity));break;
      }
      case 'session-write-fences':case 'connector-write-fences':{
        const value=fenceSchema.parse(json(bytes));
        if(domain==='session-write-fences'){if(retiredHashes.has(value.tenantId)){if(value.closedAt===null)fail('Retired tenant scope requires a closed deletion fence');}else tenantDigest(value.tenantId);if(value.namespace!=='sessions'||value.tenantId!==parts[0]||!hash.safeParse(value.connectionId).success)fail('Session write fence owner mismatch');}
        else tenant(value.tenantId);
        if(new Set(value.writers.map(writer=>writer.id)).size!==value.writers.length||value.writers.some(writer=>writer.phase==='settled'&&writer.settledAt===undefined))fail('Invalid legacy writer receipts');
        const controlPrefix=key.slice(0,key.lastIndexOf('/')+1);
        if(domain==='session-write-fences'&&!retiredHashes.has(parts[0]))tenantDigest(parts[0]);
        const fence=createPostgresWriteBarrier({database,namespace:value.namespace,tenantId:value.tenantId,connectionId:value.connectionId,controlPrefix});
        if(fence.key!==key)fail('Legacy write fence key does not match its scope');
        source={...value,writers:[...value.writers].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)};rows=1+value.writers.length;
        if(write){await prepare('fences',()=>ensureWriteBarrierSchema(database));await fence.importFence(value);}target=await read(()=>fence.exportFence());break;
      }
      case 'deletion-requests':{
        const value=deletionSchema.parse(json(bytes));tenant(value.owner.tenantId);
        if(prefix+'/_deletions/v1/'+digest(JSON.stringify([prefix,value.owner.tenantId,value.owner.userId,value.harness,value.sessionId]))+'.json'!==key)fail('Deletion request key differs from its identity');
        source=value;if(write){await prepare('deletions',()=>ensureDeletionRequestSchema(database));await deletions.importRequest(key,value);}target=await read(()=>deletions.read(key));break;
      }
      case 'capture-credentials':{
        const value=captureCredentialSchema.parse(json(bytes));tenant(value.principal.tenantId);if(value.id!==parts[0])fail('Capture credential key mismatch');source=value;
        if(write){await prepare('accounts',accounts.ready);await accounts.importCredential(value,credentialPurpose);}target=await read(()=>accounts.exportCredential(parts[0],credentialPurpose));break;
      }
      case 'credential-generations':{
        tenantDigest(parts[1]);source=z.strictObject({generation:hash}).parse(json(bytes));
        if(write){await prepare('accounts',accounts.ready);await accounts.importGeneration(parts[0],source,credentialPurpose);}target=await read(()=>accounts.exportGeneration(parts[0],credentialPurpose));break;
      }
      case 'onboarding':{
        tenantDigest(parts[1]);source=onboardingReceiptSchema.parse(json(bytes));const kind=parts[2] as OnboardingKind;
        if(write){await prepare('accounts',accounts.ready);await accounts.importReceipt(parts[0],kind,source);}target=await read(()=>accounts.onboarding.read(parts[0],kind));break;
      }
      case 'role-writes':{
        tenant(parts[0]);const value=roleWriteSchema.parse(json(bytes));if(value.state==='held'&&value.organizationId!==parts[0])fail('Role write organization differs from its source key');source=value;
        if(write){await prepare('accounts',accounts.ready);await accounts.importRole(parts[0],source);}target=await read(()=>accounts.exportRole(parts[0]));break;
      }
      case 'connector-grants':case 'connector-settings':{
        tenant(parts[0]);if(!connectorKey||connectorKey.length!==32)fail('The original connector encryption key is required to verify saved connector credentials');
        const plain=json(sealedEnvelope(connectorKey).open(key,bytes));
        if(domain==='connector-grants'){const grant=connectorGrantSchema.parse(plain);if(grant.organizationId!==parts[0])fail('Connector grant organization differs from its source key');if(grant.id!==parts[1])fail('Connector grant identity mismatch');}
        else if(connectorSettingsSchema.parse(plain).organizationId!==parts[0])fail('Connector settings organization differs from its source key');
        const scope={kind:domain==='connector-grants'?'grant' as const:'settings' as const,organizationId:parts[0],id:parts[1]??'settings'};source=bytes;
        if(write){await prepare('secrets',secrets.ready);await secrets.importSecret(scope,key,bytes);}target=await read(async()=>(await secrets.read(scope,key)).data);break;
      }
      case 'replicas-connections':{
        const value=replicasConnectionSchema.parse(json(bytes));tenant(value.tenantId);if(value.organizationId!==parts[0]||value.installations.some(item=>item.tenantId!==value.tenantId))fail('Replicas connection key mismatch');source=value;rows=1+value.installations.length;
        if(write){await prepare('replicas',replicas.ready);await replicas.importConnection(value);}target=await read(async()=>(await replicas.readConnection(parts[0])).record);break;
      }
      case 'replicas-setup':{
        const value=replicasChallengeSchema.parse(json(bytes));tenant(value.tenantId);source=value;
        if(write){await prepare('replicas',replicas.ready);await replicas.importSetup(parts[0],value);}target=await read(async()=>(await replicas.readSetup(parts[0])).record);break;
      }
      case 'replicas-index':{
        tenantDigest(parts[0]);const value=z.strictObject({organizationId:z.string().regex(new RegExp('^'+U+'$'))}).parse(json(bytes));if(value.organizationId!==parts[1])fail('Replicas index identity mismatch');
        const connectionKey=prefix+'/identity/replicas-v1/organizations/'+value.organizationId+'.json';
        const raw=await store.get(connectionKey,{maxBytes:65536});if(!raw)fail('Replicas lookup has no authoritative source connection');
        const connection=replicasConnectionSchema.parse(json(raw));tenant(connection.tenantId);if(connection.organizationId!==value.organizationId||digest(connection.tenantId)!==parts[0])fail('Replicas index source mismatch');
        source=value;rows=0;if(write){await prepare('replicas',replicas.ready);await replicas.importConnection(connection);}
        const actual=await read(async()=>(await replicas.readConnection(value.organizationId)).record);if(actual){if(actual.tenantId!==connection.tenantId)fail('Replicas index target tenant mismatch');target={organizationId:actual.organizationId};}break;
      }
      case 'value-reports':{
        tenantDigest(parts[0]);source=z.record(z.string(),z.unknown()).parse(json(bytes));
        if(write){await prepare('reports',reports.ready);await reports.importReport(parts[0],source);}target=await read(()=>reports.exportReport(parts[0]));break;
      }
      case 'slack-capture':{
        const value=slack.validateLegacy(key,bytes),scope=hash.parse((value as {scope:unknown}).scope);
        const matches=registryRecords.filter(record=>record.provider==='slack'&&record.s3Prefix&&key.startsWith(record.s3Prefix+'/capture/')&&(record.s3Bucket||store.bucket)===store.bucket);
        if(matches.length!==1)fail('Slack capture requires exactly one matching original integration record');
        const record=matches[0];tenant(record.tenantId);
        const binding=validateBinding({tenantId:record.tenantId,connectionId:record.integrationId,workspaceId:record.workspace as string,provider:'slack',access:'team-public',rawPrefix:record.s3Prefix+'/'});
        if(scope!==connectorBindingHash(binding))fail('Slack capture scope differs from its original integration binding');source=value;
        if(write){await prepare('slack',slack.ready);await slack.importLegacy(key,bytes);}target=await read(()=>slack.exportLegacy(key,scope));break;
      }
      case 'record-counts':{
        const matches=registryRecords.filter(record=>record.integrationId===parts[0]&&(record.s3Bucket||store.bucket)===store.bucket);
        if(matches.length!==1)fail('Connector counts require exactly one matching original integration record');const record=matches[0];tenant(record.tenantId);
        const value=countSchema.parse(json(gunzipSync(bytes,{maxOutputLength:256*1024*1024})));
        if(value.read.some(name=>!record.s3Prefix||!name.startsWith(record.s3Prefix+'/')||!/\/stream=[^/]+\/date=[^/]+\/sync=\d+\//.test(name)))fail('Connector count source scope mismatch');
        source=normalizeCounts(value);rows=new Set(value.read).size+Object.values(value.ids).reduce((n,ids)=>n+new Set(ids).size,0)+Object.keys(value.full??{}).length;
        if(write){await prepare('counts',counts.ready);await counts.importLegacyCounts(record,value);}if(await read(()=>counts.hasLegacyCounts(record)))target=normalizeCounts(await counts.exportLegacyCounts(record));break;
      }
      case 'event-identities':{
        tenantDigest(parts[0]);source=eventSchema.parse(json(bytes));const session=key.slice(0,-'event-identities-v1.json'.length);
        if(write)await eventIdentities.migrateSession({store,prefix,source:session});target=await eventIdentities.exportLegacyLedger({store,prefix,source:session});
        if(target&&typeof target==='object'&&'deleted' in target){source=target;rows=0;}else rows='events' in (source as z.infer<typeof eventSchema>)?Object.keys((source as {events:Record<string,string>}).events).length:1;break;
      }
      case 'session-scheduler-retirement':{
        if(parts.length===3){
          const value=z.strictObject({sourceKey:z.string().min(1).max(8192)}).parse(json(bytes));
          const identity=sourceBatchIdentity(prefix,value.sourceKey);
          if(!identity||identity.tenantHash!==parts[0]||identity.userHash!==parts[1]||digest(value.sourceKey)!==parts[2])fail('Legacy pending queue identity mismatch');
          return retire(key,{kind:'pending',sourceKey:value.sourceKey,disposition:await retirementDisposition(value.sourceKey),generation:'postgres-app-state-v1'},write);
        }
        const cursor=z.strictObject({nextToken:z.string().min(1).max(8192).nullable(),updatedAt:date.optional()}).parse(json(bytes));
        if((parts[0]==='cursor')!==(cursor.updatedAt!==undefined))fail('Legacy scheduler cursor shape mismatch');
        return retire(key,{kind:parts[0] as 'cursor'|'reconcile',...cursor,disposition:'full-temporal-catchup',generation:'postgres-app-state-v1'},write);
      }
      case 'session-indexing':case 'temporal-cutover':case 'connector-indexing':case 'connector-snapshots':{
        const raw=json(bytes);
        if(domain==='session-indexing'){
          if(raw&&typeof raw==='object'&&'status' in raw&&raw.status==='failed'){
            const value=z.strictObject({status:z.literal('failed'),sourceKey:z.string().min(1).max(8192),attempts:number.min(1),lastAttempt:date,nextAttempt:number,error:z.literal('INDEXING_FAILED')}).parse(raw);
            if(!sourceBatchIdentity(prefix,value.sourceKey)||digest(value.sourceKey)!==parts[0])fail('Legacy retry receipt identity mismatch');
            const {status,...details}=value;
            return retire(key,{kind:'failed',...details,disposition:await retirementDisposition(value.sourceKey),generation:'postgres-app-state-v1'},write);
          }
          const value=z.strictObject({status:z.literal('indexed'),sourceKey:z.string().max(8192),documents:number,indexedAt:date,deleted:z.boolean().optional()}).parse(raw);
          const identity=sourceBatchIdentity(prefix,value.sourceKey)??memorySourceIdentity(prefix,value.sourceKey);if(!identity||digest(value.sourceKey)!==parts[0])fail('Session indexing receipt identity mismatch');tenantDigest(identity.tenantHash);source=value;
        }else if(domain==='temporal-cutover'){
          const value=z.strictObject({schemaVersion:z.literal(1),sourceId:z.string(),taskQueue:z.string(),generation:z.string(),workflowId:z.string(),completed:z.literal(true)}).parse(raw);
          const marker=sessionCatchupMarker({...value,prefix});if(marker.markerKey!==key||!isDeepStrictEqual(marker.marker,value))fail('Temporal catch-up receipt identity mismatch');source=value;
        }else if(domain==='connector-indexing'){
          const value=z.strictObject({pipeline:z.string(),key:z.string().max(8192),sha256:hash,sourceRecords:number,records:number}).parse(raw);
          if(value.pipeline!==parts[0]||digest(value.key)!==parts[1]||!/^raw\/v1\/source=/.test(value.key))fail('Connector indexing receipt identity mismatch');
          const matches=registryRecords.filter(record=>record.s3Prefix&&value.key.startsWith(record.s3Prefix+'/')&&(record.s3Bucket||store.bucket)===store.bucket);
          if(matches.length!==1)fail('Connector indexing receipt has no unique original source binding');tenant(matches[0].tenantId);source=value;
        }else{
          const value=z.strictObject({pipeline:z.string(),fingerprint:hash,checksum:hash.optional(),sourceRecords:number.optional(),records:number,objects:number,ignored:number.optional()}).parse(raw);
          if(value.pipeline!==parts[0]||value.fingerprint!==parts[1])fail('Connector snapshot receipt identity mismatch');source=value;
        }
        if(domain==='connector-indexing'||domain==='connector-snapshots'){
          const retired:ConnectorCacheRetirement={version:1,kind:domain==='connector-indexing'?'object':'snapshot',bucket:store.bucket!,key,sourceHash:digest(bytes),disposition:'full-temporal-connector-catchup',receipt:source as ConnectorCacheRetirement['receipt']};
          if(write){await prepare('connector-retirements',connectorRetirements.ready);await connectorRetirements.importRetirement(retired);}
          return {source:retired,target:await connectorRetirements.exportRetirement(store.bucket!,key),rows:1};
        }
        if(write){await prepare('receipts',receipts.ready);await receipts.importReceipt(key,source as JsonObject);}target=await read(()=>receipts.read(key));break;
      }
      case 'board':{
        tenantDigest(parts[0]);const value=json(bytes) as BoardState;validateLegacyBoard(value);source=value;rows=value.messages.length+Object.keys(value.agents).length+Object.keys(value.participants??{}).length+1;
        if(write){await prepare('board',board.ready);await board.importLegacy(parts[0],value);}target=await read(()=>board.exportLegacy(parts[0]));break;
      }
      default:fail('No typed migration is registered for this legacy state domain');
    }
    return {source,target,rows};
  }
  return {roots,async ready(){
    for(const record of registryRecords){
      tenant(record.tenantId);
      if(record.s3Bucket&&record.s3Bucket!==store.bucket)fail('Legacy integration state uses another bucket; a reviewed multi-store migration is required');
    }
  },classify,process};
}
