import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {createBoundObjectMigration,onlineProjectionValue,type BoundObjectMigrationOptions,type OnlineObjectProjection} from './object-migration.mjs';
import type {OnlineIntent} from './online-journal.mjs';
import type {OnlineCoverageTarget} from './online-coverage.mjs';
import {createOnlineObjectPolicy} from './online-object-policy.mjs';

/** Typed shadow projection only. This module never makes an installation ready.
 * Its caller supplies the journal/backfill transaction's real PoolClient. */
function fail(message:string):never{throw Object.assign(new Error('Online projection: '+message),{code:'ONLINE_PROJECTION_CONFLICT'});}
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
function canonical(value:unknown):unknown{
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value;
 if(Buffer.isBuffer(value))return ['bytes',value.toString('base64')];
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item)]));
 return fail('unsupported target value');
}
export const onlineProjectionHash=(value:unknown)=>hash(JSON.stringify(canonical(value)));
function revision(value:string){if(!/^(0|[1-9][0-9]*)$/.test(value)||BigInt(value)>9223372036854775807n)fail('invalid source revision');}
function bounded(value:string,max:number){if(typeof value!=='string'||!value||value.includes('\0')||Buffer.byteLength(value)>max)fail('invalid source binding');}
export interface OnlineTenantEnrollmentRequest {tenantId:string;evidence:unknown}
export function createOnlineProjection({epoch,sourceId,journalBinding,enrollment,agentPrefix,...options}:BoundObjectMigrationOptions&{
 epoch:string;sourceId:string;agentPrefix?:string;enrollment:{verifierId:string;initialReceiptHash:string;verify(request:OnlineTenantEnrollmentRequest):Promise<{tenantId:string;receiptHash:string}>};journalBinding:Readonly<{namespace:string;epoch:string;sourceId:string}>;
}){
 const {database}=options,namespace=database.namespace;bounded(sourceId,2048);bounded(enrollment.verifierId,512);if(!/^[a-f0-9]{64}$/.test(enrollment.initialReceiptHash)||typeof enrollment.verify!=='function')fail('invalid tenant enrollment verifier');
 const verifyEnrollment=enrollment.verify,verifierId=enrollment.verifierId,initialReceiptHash=enrollment.initialReceiptHash;if(!uuid.test(epoch))fail('invalid epoch');
 if(journalBinding.namespace!==namespace||journalBinding.epoch!==epoch||journalBinding.sourceId!==sourceId)fail('journal binding differs from projection');
 const initialTenants=Object.freeze([...options.tenantIds]),retiredTenantHashes=Object.freeze([...(options.retiredTenantHashes??[])]);
 const object=createBoundObjectMigration({...options,tenantIds:initialTenants,retiredTenantHashes}),scope=[namespace,epoch,sourceId];
 const policy=createOnlineObjectPolicy({prefix:options.prefix,credentialPurpose:options.credentialPurpose,agentPrefix});
 const agentObject=agentPrefix?createBoundObjectMigration({...options,prefix:agentPrefix,credentialPurpose:'agent',tenantIds:initialTenants,retiredTenantHashes}):undefined;
 const decoder=(key:string)=>agentObject&&policy.route(key).credentialPurpose==='agent'?agentObject:object;
 const bindingHash=onlineProjectionHash({bucket:options.store.bucket,prefix:options.prefix,purpose:options.credentialPurpose??'capture',tenantIds:[...initialTenants].sort(),retiredTenantHashes:[...retiredTenantHashes].sort(),verifierId,initialReceiptHash,...(agentPrefix?{agentPrefix,routePolicyHash:policy.policyHash}:{})});
 let preparing:Promise<void>|undefined,enrollmentRevision:string|undefined,enrolledTenants:readonly string[]=[];
 async function ready(){
  preparing??=(async()=>{
   await object.ready();await object.prepareOnline();
   await database.transaction(async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:online-projection:schema',0))");
    await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_online_projection_namespaces(namespace text PRIMARY KEY,epoch uuid NOT NULL);
      CREATE TABLE IF NOT EXISTS opencrawl_online_projection_bindings(namespace text NOT NULL,epoch uuid NOT NULL,source_id text NOT NULL,binding_hash text NOT NULL CHECK(binding_hash~'^[a-f0-9]{64}$'),enrollment_revision bigint NOT NULL DEFAULT 0 CHECK(enrollment_revision>=0 AND enrollment_revision<=100000),PRIMARY KEY(namespace,epoch,source_id));
      CREATE TABLE IF NOT EXISTS opencrawl_online_projection_tenants(namespace text NOT NULL,epoch uuid NOT NULL,source_id text NOT NULL,tenant_id text NOT NULL,tenant_hash text NOT NULL CHECK(tenant_hash~'^[a-f0-9]{64}$'),receipt_hash text NOT NULL CHECK(receipt_hash~'^[a-f0-9]{64}$'),PRIMARY KEY(namespace,epoch,source_id,tenant_id),UNIQUE(namespace,epoch,source_id,tenant_hash));
      CREATE TABLE IF NOT EXISTS opencrawl_online_projection_replicas_references(namespace text NOT NULL,epoch uuid NOT NULL,target_key text COLLATE "C" NOT NULL,source_id text NOT NULL,source_key text COLLATE "C" NOT NULL,tenant_hash text NOT NULL CHECK(tenant_hash~'^[a-f0-9]{64}$'),organization_id uuid NOT NULL,PRIMARY KEY(namespace,epoch,target_key),UNIQUE(namespace,epoch,source_id,source_key));
      CREATE TABLE IF NOT EXISTS opencrawl_online_projection_heads(namespace text NOT NULL,epoch uuid NOT NULL,target_key text COLLATE "C" NOT NULL,source_id text NOT NULL,source_key text COLLATE "C" NOT NULL,domain text NOT NULL,revision bigint NOT NULL CHECK(revision>=0),operation_id uuid,source_version text NOT NULL,content_hash text NOT NULL CHECK(content_hash~'^[a-f0-9]{64}$'),target_hash text NOT NULL CHECK(target_hash~'^[a-f0-9]{64}$'),deleted boolean NOT NULL,
      PRIMARY KEY(namespace,epoch,target_key),UNIQUE(namespace,epoch,source_id,source_key),CHECK((revision=0 AND operation_id IS NULL) OR (revision>0 AND operation_id IS NOT NULL)))`);
    await client.query('INSERT INTO opencrawl_online_projection_namespaces VALUES($1,$2) ON CONFLICT DO NOTHING',[namespace,epoch]);await assertEpoch(client);
    await client.query('INSERT INTO opencrawl_online_projection_bindings(namespace,epoch,source_id,binding_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[...scope,bindingHash]);
    const actual=(await client.query('SELECT binding_hash FROM opencrawl_online_projection_bindings WHERE namespace=$1 AND epoch=$2 AND source_id=$3',scope)).rows[0];if(actual?.binding_hash!==bindingHash)fail('reviewed source binding changed');
    for(const tenantId of initialTenants)await insertEnrollment(client,tenantId,initialReceiptHash);
   });
  })();try{await preparing;}catch(error){preparing=undefined;throw error;}
 }
 async function assertEpoch(client:PoolClient,readOnly=false){const row=(await client.query('SELECT epoch FROM opencrawl_online_projection_namespaces WHERE namespace=$1'+(readOnly?'':' FOR SHARE'),[namespace])).rows[0];if(row?.epoch!==epoch)fail('namespace is owned by a different projection epoch');}
 async function insertEnrollment(client:PoolClient,tenantId:string,receiptHash:string){
  await assertEpoch(client);
  const row=(await client.query('SELECT binding_hash FROM opencrawl_online_projection_bindings WHERE namespace=$1 AND epoch=$2 AND source_id=$3 FOR UPDATE',scope)).rows[0];if(row?.binding_hash!==bindingHash)fail('source binding changed');
  const prior=(await client.query('SELECT tenant_hash,receipt_hash FROM opencrawl_online_projection_tenants WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND tenant_id=$4',[...scope,tenantId])).rows[0];
  if(prior){if(prior.tenant_hash!==hash(tenantId))fail('tenant identity changed');return {enrolled:false,receiptHash:prior.receipt_hash as string};}
  await client.query('INSERT INTO opencrawl_online_projection_tenants VALUES($1,$2,$3,$4,$5,$6)',[...scope,tenantId,hash(tenantId),receiptHash]);
  await client.query('UPDATE opencrawl_online_projection_bindings SET enrollment_revision=enrollment_revision+1 WHERE namespace=$1 AND epoch=$2 AND source_id=$3',scope);return {enrolled:true,receiptHash};
 }
 async function enrollTenant(request:OnlineTenantEnrollmentRequest){
  if(!request||typeof request.tenantId!=='string'||request.tenantId.length>200||!/^(?:org_[A-Za-z0-9]+|personal:user_[A-Za-z0-9]+)$/.test(request.tenantId)||retiredTenantHashes.includes(hash(request.tenantId)))fail('invalid tenant enrollment');
  const serialized=JSON.stringify(request);if(!serialized||Buffer.byteLength(serialized)>65536)fail('tenant enrollment evidence exceeds bound');
  const frozen=JSON.parse(serialized) as OnlineTenantEnrollmentRequest,tenantId=frozen.tenantId;
  const verified=await verifyEnrollment(frozen);if(verified.tenantId!==tenantId||!/^[a-f0-9]{64}$/.test(verified.receiptHash))fail('tenant enrollment verifier mismatch');
  return database.transaction(client=>insertEnrollment(client,tenantId,verified.receiptHash));
 }
 async function enrolled(client:PoolClient,readOnly=false){
  await assertEpoch(client,readOnly);
  const bound=(await client.query('SELECT binding_hash,enrollment_revision::text FROM opencrawl_online_projection_bindings WHERE namespace=$1 AND epoch=$2 AND source_id=$3',scope)).rows[0];if(bound?.binding_hash!==bindingHash)fail('projection is not prepared for this source');
  if(enrollmentRevision!==bound.enrollment_revision){
   const rows=(await client.query('SELECT tenant_id,tenant_hash FROM opencrawl_online_projection_tenants WHERE namespace=$1 AND epoch=$2 AND source_id=$3 ORDER BY tenant_id LIMIT 100001',scope)).rows;
   if(rows.length>100000||rows.length!==Number(bound.enrollment_revision)||rows.some(row=>row.tenant_hash!==hash(row.tenant_id)))fail('tenant enrollment coverage changed');
   enrolledTenants=Object.freeze(rows.map(row=>String(row.tenant_id)));enrollmentRevision=bound.enrollment_revision;
  }
  return enrolledTenants;
 }
 // An alias is migration evidence only. It never creates or removes a runtime
 // connection, and can be replayed before its canonical source arrives.
 async function readTargetIn(client:PoolClient,value:OnlineObjectProjection,targetKey:string,key:string):Promise<unknown>{
  if(value.kind!=='replicas-reference')return object.readOnlineIn(client,value);
  const row=(await client.query('SELECT source_id,source_key,tenant_hash,organization_id FROM opencrawl_online_projection_replicas_references WHERE namespace=$1 AND epoch=$2 AND target_key=$3',[namespace,epoch,targetKey])).rows[0];
  if(!row)return null;
  if(row.source_id!==sourceId||row.source_key!==key||row.tenant_hash!==value.tenantHash||row.organization_id!==value.organizationId)fail('Replicas reference scope changed');
  return {organizationId:row.organization_id};
 }
 async function writeTargetIn(client:PoolClient,value:OnlineObjectProjection,targetKey:string,key:string){
  if(value.kind!=='replicas-reference')return object.projectOnlineIn(client,value);
  if(value.value===null){await client.query('DELETE FROM opencrawl_online_projection_replicas_references WHERE namespace=$1 AND epoch=$2 AND target_key=$3',[namespace,epoch,targetKey]);return;}
  await client.query('INSERT INTO opencrawl_online_projection_replicas_references(namespace,epoch,target_key,source_id,source_key,tenant_hash,organization_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(namespace,epoch,target_key) DO NOTHING',[namespace,epoch,targetKey,sourceId,key,value.tenantHash,value.organizationId]);
 }
 async function referenceMatchesIn(client:PoolClient,tenantHash:string,organizationId:string){
  const tenant=(await client.query('SELECT tenant_id,tenant_hash FROM opencrawl_online_projection_tenants WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND tenant_hash=$4',[...scope,tenantHash])).rows[0];
   if(!tenant||hash(tenant.tenant_id)!==tenantHash)return false;
   const canonical=(await client.query('SELECT source_id,source_key,domain,target_hash,deleted FROM opencrawl_online_projection_heads WHERE namespace=$1 AND epoch=$2 AND target_key=$3',[namespace,epoch,JSON.stringify(['replicas-connections',organizationId])])).rows[0];
   if(!canonical||canonical.source_id!==sourceId||canonical.source_key!==options.prefix+'/identity/replicas-v1/organizations/'+organizationId+'.json'||canonical.domain!=='replicas-connections'||canonical.deleted)return false;
   const connection=await object.readOnlineIn(client,{kind:'replicas-connection',domain:'replicas-connections',identity:[organizationId],organizationId,value:null});
  return Boolean(connection&&typeof connection==='object'&&'tenantId' in connection&&connection.tenantId===tenant.tenant_id&&onlineProjectionHash(connection)===canonical.target_hash);
 }
 /** Relationship observation only, never cutover/readiness. The caller must page
  * within ONE read-only repeatable-read transaction after replaying its closed
  * frontier. Source/frontier/fence verification belongs to that composition.
  * The union detects reference rows whose projection head was removed too. */
 async function inspectReplicasReferencesPageIn(client:PoolClient,input:{after?:string;limit?:number}={}){
  const after=input.after??'',limit=input.limit??64;if(after)bounded(after,8192);if(!Number.isSafeInteger(limit)||limit<1||limit>64)fail('invalid Replicas reference page bound');
  const settings=(await client.query("SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only")).rows[0];
  if(!settings||!['repeatable read','serializable'].includes(settings.isolation)||settings.read_only!=='on')fail('reference parity requires a read-only repeatable snapshot');
  const bound=(await client.query('SELECT b.binding_hash,n.epoch FROM opencrawl_online_projection_bindings b JOIN opencrawl_online_projection_namespaces n USING(namespace) WHERE b.namespace=$1 AND b.epoch=$2 AND b.source_id=$3',scope)).rows[0];
  if(bound?.epoch!==epoch||bound.binding_hash!==bindingHash)fail('reference parity source binding changed');
  const rows=(await client.query(`SELECT target_key FROM (
    SELECT target_key FROM opencrawl_online_projection_heads WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND domain='replicas-index'
    UNION SELECT target_key FROM opencrawl_online_projection_replicas_references WHERE namespace=$1 AND epoch=$2 AND source_id=$3
   ) references_to_check WHERE target_key>$4 COLLATE "C" ORDER BY target_key COLLATE "C" LIMIT $5`,[...scope,after,limit+1])).rows;
  const page=rows.slice(0,limit);let mismatches=0;
  for(const row of page){
   const targetKey=String(row.target_key),head=(await client.query('SELECT source_id,source_key,domain,target_hash,deleted FROM opencrawl_online_projection_heads WHERE namespace=$1 AND epoch=$2 AND target_key=$3',[namespace,epoch,targetKey])).rows[0];
   const ref=(await client.query('SELECT source_id,source_key,tenant_hash,organization_id FROM opencrawl_online_projection_replicas_references WHERE namespace=$1 AND epoch=$2 AND target_key=$3',[namespace,epoch,targetKey])).rows[0];
   if(!head||head.source_id!==sourceId||head.domain!=='replicas-index'){mismatches++;continue;}
   const found=object.classify(head.source_key);
   if(!found||found.domain!=='replicas-index'||targetKey!==JSON.stringify([found.domain,...found.parts])){mismatches++;continue;}
   if(head.deleted){if(ref||head.target_hash!==onlineProjectionHash(null))mismatches++;continue;}
   const [tenantHash,organizationId]=found.parts;
   if(!ref||ref.source_id!==sourceId||ref.source_key!==head.source_key||ref.tenant_hash!==tenantHash||ref.organization_id!==organizationId||head.target_hash!==onlineProjectionHash({organizationId})){mismatches++;continue;}
   if(!await referenceMatchesIn(client,tenantHash,organizationId))mismatches++;
  }
  return {processed:page.length,matched:page.length-mismatches,mismatches,next:rows.length>limit?String(page[page.length-1].target_key):null};
 }
 async function project(client:PoolClient,input:{key:string;bytes:Buffer|null;revision:string;operationId:string|null;version:string}):Promise<OnlineCoverageTarget>{
  bounded(input.key,8192);bounded(input.version,2048);revision(input.revision);
  if(input.revision==='0'?input.operationId!==null:input.operationId===null||!uuid.test(input.operationId))fail('invalid source operation');
  // Freeze decode input before the first SQL await; callbacks cannot redirect it.
  const key=input.key,version=input.version,rev=input.revision,operationId=input.operationId,bytes=input.bytes===null?null:Buffer.from(input.bytes);
  const decoded=decoder(key).decodeOnline(key,bytes,await enrolled(client)),targetKey=JSON.stringify([decoded.domain,...decoded.identity]);bounded(targetKey,8192);
  const value=onlineProjectionValue(decoded),contentHash=bytes===null?hash('deleted'):hash(bytes),targetHash=onlineProjectionHash(value);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['online-projection',namespace,targetKey])]);
  const prior=(await client.query('SELECT source_id,source_key,domain,revision,operation_id,source_version,content_hash,target_hash,deleted FROM opencrawl_online_projection_heads WHERE namespace=$1 AND epoch=$2 AND target_key=$3 FOR UPDATE',[namespace,epoch,targetKey])).rows[0];
  if(prior&&(prior.source_id!==sourceId||prior.source_key!==key||prior.domain!==decoded.domain))fail('canonical target has a different source publisher');
  const current=await readTargetIn(client,decoded,targetKey,key),currentHash=onlineProjectionHash(current);
  if(prior){
   if(prior.deleted&&bytes!==null&&['capture-credentials','connector-grants','replicas-connections','replicas-setup'].includes(decoded.domain))fail('deleted security identity cannot be reused');
   revision(prior.revision);if(currentHash!==prior.target_hash)fail('typed target changed outside its source projection');
   if(BigInt(prior.revision)>BigInt(rev))fail('stale projection revision');
   if(prior.revision===rev){if(prior.operation_id!==operationId||prior.source_version!==version||prior.content_hash!==contentHash||prior.target_hash!==targetHash||prior.deleted!==(bytes===null))fail('source revision was reused');return {targetKey,targetHash};}
  }else if(current!==null&&currentHash!==targetHash)fail('initial typed target conflicts with source');
  // Domain owners retain privacy/revocation/held-operation invariants even when
  // the current target is absent. Unsupported deletions never silently pass.
  await writeTargetIn(client,decoded,targetKey,key);
  if(onlineProjectionHash(await readTargetIn(client,decoded,targetKey,key))!==targetHash)fail('typed readback differs from source');
  await client.query(`INSERT INTO opencrawl_online_projection_heads(namespace,epoch,target_key,source_id,source_key,domain,revision,operation_id,source_version,content_hash,target_hash,deleted) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT(namespace,epoch,target_key) DO UPDATE SET revision=EXCLUDED.revision,operation_id=EXCLUDED.operation_id,source_version=EXCLUDED.source_version,content_hash=EXCLUDED.content_hash,target_hash=EXCLUDED.target_hash,deleted=EXCLUDED.deleted`,[namespace,epoch,targetKey,sourceId,key,decoded.domain,rev,operationId,version,contentHash,targetHash,bytes===null]);  return {targetKey,targetHash};
 }
 /** Independent target inspection on the caller's key-gated snapshot. No
  * source I/O, repair, row locks or transaction boundaries are introduced. */
 async function inspectIn(client:PoolClient,input:{key:string;bytes:Buffer|null;revision:string;operationId:string|null;version:string}){
  bounded(input.key,8192);bounded(input.version,2048);revision(input.revision);
  if(input.revision==='0'?input.operationId!==null:input.operationId===null||!uuid.test(input.operationId))fail('invalid inspected source operation');
  const key=input.key,version=input.version,rev=input.revision,operationId=input.operationId,bytes=input.bytes===null?null:Buffer.from(input.bytes);
  const decoded=decoder(key).decodeOnline(key,bytes,await enrolled(client,true)),targetKey=JSON.stringify([decoded.domain,...decoded.identity]);
  const targetHash=onlineProjectionHash(onlineProjectionValue(decoded)),contentHash=bytes===null?hash('deleted'):hash(bytes);
  const head=(await client.query('SELECT source_id,source_key,domain,revision,operation_id,source_version,content_hash,target_hash,deleted FROM opencrawl_online_projection_heads WHERE namespace=$1 AND epoch=$2 AND target_key=$3',[namespace,epoch,targetKey])).rows[0];
  if(!head||head.source_id!==sourceId||head.source_key!==key||head.domain!==decoded.domain||head.revision!==rev||head.operation_id!==operationId||head.source_version!==version||head.content_hash!==contentHash||head.target_hash!==targetHash||head.deleted!==(bytes===null))return false;
  if(onlineProjectionHash(await readTargetIn(client,decoded,targetKey,key))!==targetHash)return false;
  return decoded.kind!=='replicas-reference'||decoded.value===null||await referenceMatchesIn(client,decoded.tenantHash,decoded.organizationId);
 }
 /** Exact enrolled owner check for metadata-only native ledger coverage. */
 async function hasEnrolledTenantHashIn(client:PoolClient,tenantHash:string){
  if(!/^[a-f0-9]{64}$/.test(tenantHash))fail('invalid tenant hash');
  const row=(await client.query('SELECT t.tenant_id,t.tenant_hash,t.receipt_hash,b.binding_hash,n.epoch FROM opencrawl_online_projection_tenants t JOIN opencrawl_online_projection_bindings b USING(namespace,epoch,source_id) JOIN opencrawl_online_projection_namespaces n USING(namespace) WHERE t.namespace=$1 AND t.epoch=$2 AND t.source_id=$3 AND t.tenant_hash=$4',[...scope,tenantHash])).rows[0];
  return Boolean(row&&row.epoch===epoch&&row.binding_hash===bindingHash&&row.tenant_hash===tenantHash&&hash(row.tenant_id)===tenantHash&&/^[a-f0-9]{64}$/.test(row.receipt_hash));
 }
 async function keysPageIn(client:PoolClient,{after='',limit=64}:{after?:string;limit?:number}={}){
  if(after)bounded(after,8192);if(!Number.isSafeInteger(limit)||limit<1||limit>64)fail('invalid projection key page bound');await enrolled(client,true);
  const rows=(await client.query(`SELECT source_key FROM (
    SELECT source_key FROM opencrawl_online_projection_heads WHERE namespace=$1 AND epoch=$2 AND source_id=$3
    UNION SELECT source_key FROM opencrawl_online_projection_replicas_references WHERE namespace=$1 AND epoch=$2 AND source_id=$3
   ) projected_keys WHERE source_key>$4 COLLATE "C" ORDER BY source_key COLLATE "C" LIMIT $5`,[...scope,after,limit])).rows;
  return rows.map(row=>{bounded(row.source_key,8192);return row.source_key as string;});
 }
 async function apply(client:PoolClient,intent:OnlineIntent){
  if(intent.namespace!==namespace||intent.epoch!==epoch||intent.sourceId!==sourceId||intent.state!=='applied'||!intent.resultVersion)fail('journal intent is not applied in this source binding');
  if(intent.revision==='0')fail('journal revision cannot be baseline');
  return project(client,{key:intent.key,bytes:intent.mutation.kind==='put'?intent.mutation.bytes:null,revision:intent.revision,operationId:intent.operationId,version:intent.resultVersion});
 }
 async function backfill(client:PoolClient,input:{key:string;bytes:Buffer;version:string}){return project(client,{...input,revision:'0',operationId:null});}
 return {binding:Object.freeze({namespace,epoch,sourceId,bindingHash}),ready,apply,backfill,enrollTenant,inspectReplicasReferencesPageIn,inspectIn,keysPageIn,hasEnrolledTenantHashIn};
}
