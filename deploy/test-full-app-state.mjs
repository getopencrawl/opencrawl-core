// Synthetic private fixture for the published v0.4.1 installation. This file is
// mounted into its old image, the candidate and the exact restored old image.
// Never run against an operator installation. Tokens stay in /dev-state only.
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,chownSync,statSync} from 'node:fs';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createObjectStore} from '../dist/src/sessions/s3-store.mjs';
import {createControls} from '../dist/src/sessions/controls.mjs';
import {createSessionDeletionRequests} from '../dist/src/sessions/deletion-requests.mjs';
import {createCaptureCredentials} from '../dist/src/sessions/credentials.mjs';
import {sessionWriteBarrier} from '../dist/src/sessions/write-barrier.mjs';
import {createConnectorWriteBarrier} from '../dist/src/connectors/write-barrier.mjs';
import {roleWriteGuard} from '../dist/src/identity/role-write.mjs';
import {createReplicasConnections} from '../dist/src/identity/replicas-connections.mjs';
import {createBoard} from '../dist/src/board/board.mjs';
import {credentialVault} from '../dist/src/integrations/credential-vault.mjs';
import {connectorSettingsStore} from '../dist/src/integrations/connector-settings.mjs';
import {createOnboardingStatus} from '../dist/src/onboarding-status.mjs';
import {seedSlackSourceCatalog} from '../dist/src/connectors/slack-source-catalog.mjs';
import {createSlackMessageCapture} from '../dist/src/connectors/slack-source-messages.mjs';
import {createSlackFileCapture} from '../dist/src/connectors/slack-source-files.mjs';
import {createSlackMessageReferenceCapture} from '../dist/src/connectors/slack-source-message-references.mjs';
import {sessionCatchupMarker} from '../dist/src/sessions/temporal/handoff.mjs';
import {valueReportKey,valueReports} from '../dist/src/application/value-report.mjs';
import {createLocalIdentity} from '../dist/src/identity/better-auth.mjs';
import {createSingleOrganizationRegistry} from '../dist/src/integrations/local-registry.mjs';
import {digest,receiptKey,pipelineVersion} from '../dist/src/connectors/scope.mjs';

const phase=process.env.UPGRADE_APP_STATE_PHASE;
assert.ok(['seed','verify','restored'].includes(phase));
assert.equal(process.env.OPENCRAWL_UPGRADE_FIXTURE,'true');
const input=JSON.parse(readFileSync('/dev-state/seed-input.json','utf8'));
const seed=JSON.parse(readFileSync('/dev-state/seed.json','utf8'));
assert.match(input.project,/^ocdev-[a-f0-9]{12}$/);
assert.equal(input.organization,process.env.OPENCRAWL_ORGANIZATION_ID);
assert.ok(seed.userId);
const required=name=>{assert.ok(process.env[name],name+' is required');return process.env[name];};
const prefix=process.env.OPENCRAWL_LANDING_S3_PATH||'sessions/self-hosted/v1';
const owner={tenantId:input.organization,userId:seed.userId};
const raw=createObjectStore({endpoint:required('OPENCRAWL_LANDING_S3_ENDPOINT'),bucket:required('OPENCRAWL_LANDING_S3_BUCKET'),region:required('OPENCRAWL_LANDING_S3_REGION'),credentials:{accessKeyId:required('OPENCRAWL_LANDING_S3_ACCESS_KEY_ID'),secretAccessKey:required('OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY')}});
const path='/dev-state/app-state-fixture.json',sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const encryptionKey=Buffer.from(required('OPENCRAWL_CONNECTOR_KEY'),'base64');
assert.equal(encryptionKey.length,32);
let domain='unclassified';const touched=new Map();
const store={...raw,
 async put(key,bytes,type){const result=await raw.put(key,bytes,type);touched.set(key,domain);return result;},
 async compareAndSet(key,version,bytes){const result=await raw.compareAndSet(key,version,bytes);if(result)touched.set(key,domain);return result;},
};
const scope={store,prefix};
const manifest=phase==='seed'?{format:1,owner,prefix,objects:[],expected:{}}:JSON.parse(readFileSync(path,'utf8'));
assert.deepEqual(manifest.owner,owner);assert.equal(manifest.prefix,prefix);
const expected=manifest.expected;
const replicasOptions={...scope,tenantId:owner.tenantId,isAdmin:async()=>true,verify:async()=>{throw new Error('Fixture never contacts a provider');}};

if(phase==='seed'){
 domain='controls';
 const controls=createControls(scope);
 await controls.update(owner,'sessions','codex','upgrade-private',()=>({visibility:'private',deletedAt:null}));
 await controls.update(owner,'memories','codex','upgrade-private.md',()=>({visibility:'private',deletedAt:null}));
 await controls.update(owner,'sessions','codex','upgrade-deleted',()=>({visibility:'private',deletedAt:new Date().toISOString(),deletion:{sessionId:'upgrade-deleted',state:'pending'}}));
 expected.controls={private:await controls.read(owner,'sessions','codex','upgrade-private'),memory:await controls.read(owner,'memories','codex','upgrade-private.md'),deleted:await controls.read(owner,'sessions','codex','upgrade-deleted')};
 domain='session-deletions';await createSessionDeletionRequests(scope).put(owner,{harness:'codex',sessionId:'upgrade-deleted'});
 domain='session-fences';
 const sessionFence=sessionWriteBarrier(store,prefix,owner,'codex','upgrade-deleted');
 await assert.rejects(sessionFence.run('search-write',async()=>{throw new Error('Synthetic uncertain write; no external request');}));
 expected.sessionFence=await sessionFence.close();assert.equal(expected.sessionFence.pending,1);
 domain='connector-fences';
 expected.integrationId='int_'+randomBytes(13).toString('hex');
 const connectorFence=createConnectorWriteBarrier({store,tenantId:owner.tenantId,connectionId:expected.integrationId});
 await assert.rejects(connectorFence.run('object-put',async()=>{throw new Error('Synthetic uncertain write; no external request');}));
 expected.connectorFence=await connectorFence.close();assert.equal(expected.connectorFence.pending,1);
 domain='capture-credentials';
 const credentials=createCaptureCredentials(scope);
 expected.capture=await credentials.issue(owner);
 expected.revokedCapture=await credentials.issue(owner);await credentials.revoke(owner,expected.revokedCapture.id);
 expected.revokedOwner={...owner,userId:'user_'+randomBytes(16).toString('hex')};
 expected.generationCapture=await credentials.issue(expected.revokedOwner);await credentials.revokeAll(expected.revokedOwner);
 domain='role-guards';
 // Reads and invitations remain usable; uncertain role changes stay blocked.
 expected.guardedOrganization=owner.tenantId;
 await roleWriteGuard(store,prefix)(expected.guardedOrganization,owner.userId,owner.userId,'member');
 domain='board';
 const board=createBoard({store,prefix:prefix+'/board'});
 for(const [session,name] of [['upgrade-receiver','upgrade:receiver'],['upgrade-sender','upgrade:sender']])await board.participate(owner,'register',{session,name,task:'Synthetic migration acceptance',harness:'codex'});
 await board.participate(owner,'subscribe',{session:'upgrade-receiver',topics:['upgrade-state']});
 expected.publication={session:'upgrade-sender',id:'retained-publication',topic:'upgrade-state',text:'Synthetic pending migration delivery',mentions:['upgrade:receiver']};
 expected.published=await board.participate(owner,'publish',expected.publication);
 expected.delivery=await board.participate(owner,'inbox',{session:'upgrade-receiver'});assert.ok(expected.delivery.batch?.receipt);
 domain='replicas';
 const replicas=createReplicasConnections(replicasOptions);
 expected.replicaOrganization='12345678-1234-4234-9234-123456789abc';
 await replicas.migrateLegacy([{organizationId:expected.replicaOrganization,environmentId:'12345678-1234-4234-9234-123456789abd',tenantId:owner.tenantId,onboardingWorkspaceId:'12345678-1234-4234-9234-123456789abe'}]);
 await replicas.revoke(owner,expected.replicaOrganization);
 expected.replica=await replicas.lookupOrganization(expected.replicaOrganization);
 await replicas.issue(owner,{userId:owner.userId,organizationId:owner.tenantId,status:'active',role:{slug:'admin'}});
 domain='onboarding';
 const onboarding=createOnboardingStatus(scope);await onboarding.cli(expected.revokedOwner);await onboarding.mcp(expected.revokedOwner,{name:'Synthetic migration client'});await onboarding.mcpTest(expected.revokedOwner);
 expected.onboarding=await onboarding.read(expected.revokedOwner);
 domain='connector-grants';
 expected.grant={version:1,id:'grant_'+randomBytes(24).toString('hex'),organizationId:owner.tenantId,userId:owner.userId,integrationId:expected.integrationId,provider:'slack',status:'REFRESHING',state:randomBytes(24).toString('hex'),callbackUrl:'https://fixture.invalid/callback',flowExpiresAt:Date.now()+3600000,proxyToken:randomBytes(24).toString('hex'),accessToken:randomBytes(24).toString('hex'),refreshToken:randomBytes(24).toString('hex')};
 await credentialVault({store,prefix:'connector-credentials/v1',organizationId:owner.tenantId,key:encryptionKey}).write(expected.grant,null);
 domain='connector-settings';
 expected.settings={version:1,organizationId:owner.tenantId,broker:{apiKey:randomBytes(24).toString('hex'),savedAt:new Date().toISOString(),savedBy:owner.userId}};
 await connectorSettingsStore({store,prefix:'connector-settings/v1',organizationId:owner.tenantId,key:encryptionKey}).write(expected.settings,null);
 domain='capture-catalogs';
 const binding={tenantId:owner.tenantId,connectionId:expected.integrationId,workspaceId:'TUPGRADE',provider:'slack',access:'team-public',rawPrefix:`raw/v1/source=slack/workspace=TUPGRADE/connection=${expected.integrationId}/`};expected.binding=binding;
 await seedSlackSourceCatalog({binding,store,channelIds:['CUPGRADE','CRETAINED'],fileShares:[{fileId:'FUPGRADE',channelId:'CRETAINED'}]});
 domain='capture-runs';
 // A failed provider request leaves each real old implementation's pacing and
 // cursor intent durable. The request stub never leaves this container.
 const captureOptions={binding,store,request:async()=>{throw new Error('Synthetic interrupted provider request');}};
 expected.run={runId:'upgrade-pending',cutoff:Date.now()};
 await assert.rejects(createSlackMessageCapture(captureOptions).step(expected.run));
 await assert.rejects(createSlackFileCapture({...captureOptions,download:async()=>{throw new Error('No download in fixture');}}).step(expected.run));
 expected.references={runId:'upgrade-pending',references:[{channelId:'CUPGRADE',ts:'12345.000001'}]};
 await assert.rejects(createSlackMessageReferenceCapture(captureOptions).step(expected.references));
 domain='session-indexing';
 const sourceKey=prefix+'/tenants/'+sha(owner.tenantId)+'/users/'+sha(owner.userId)+'/codex/'+sha('upgrade-installation')+'/'+sha('upgrade-private')+'/'+sha('fixture')+'.json.gz';
 await store.put(prefix+'/_index/'+sha('fixture-search')+'/'+sha('fixture-job')+'/batches/'+sha(sourceKey)+'.json',Buffer.from(JSON.stringify({status:'indexed',sourceKey,documents:2,indexedAt:new Date().toISOString()})),'application/json');
 domain='legacy-scheduler';
 // Exact pre-Temporal formats can remain in a current v0.4.1 installation.
 // This session was deleted: its retained tombstone proves why raw bytes are absent.
 const deletedSource=prefix+'/tenants/'+sha(owner.tenantId)+'/users/'+sha(owner.userId)+'/codex/'+sha('upgrade-installation')+'/'+sha('upgrade-deleted')+'/'+sha('old-pending')+'.json.gz';
 const schedulerRoot=prefix+'/_index/'+sha('fixture-search')+'/'+sha('old-scheduler');
 const schedulerTime=new Date().toISOString();
 expected.scheduler=[
  {key:prefix+'/index-pending/tenants/'+sha(owner.tenantId)+'/users/'+sha(owner.userId)+'/'+sha(deletedSource)+'.json',payload:{sourceKey:deletedSource},retired:{kind:'pending',sourceKey:deletedSource,disposition:'deleted',generation:'postgres-app-state-v1'}},
  {key:schedulerRoot+'/batches/'+sha(deletedSource)+'.json',payload:{status:'failed',sourceKey:deletedSource,attempts:2,lastAttempt:schedulerTime,nextAttempt:Date.parse(schedulerTime)+4000,error:'INDEXING_FAILED'},retired:{kind:'failed',sourceKey:deletedSource,attempts:2,lastAttempt:schedulerTime,nextAttempt:Date.parse(schedulerTime)+4000,error:'INDEXING_FAILED',disposition:'deleted',generation:'postgres-app-state-v1'}},
  {key:schedulerRoot+'/cursor.json',payload:{nextToken:'old-pending-cursor',updatedAt:schedulerTime},retired:{kind:'cursor',nextToken:'old-pending-cursor',updatedAt:schedulerTime,disposition:'full-temporal-catchup',generation:'postgres-app-state-v1'}},
  {key:schedulerRoot+'/reconcile.json',payload:{nextToken:'old-source-cursor'},retired:{kind:'reconcile',nextToken:'old-source-cursor',disposition:'full-temporal-catchup',generation:'postgres-app-state-v1'}},
 ];
 for(const item of expected.scheduler)await store.put(item.key,Buffer.from(JSON.stringify(item.payload)),'application/json');
 domain='connector-indexing';
 const rawKey=binding.rawPrefix+'stream=canonical_messages/date=2026-11-15/sync=1/fixture.jsonl.gz';
 await store.put(receiptKey(binding,'fixture-search',rawKey),Buffer.from(JSON.stringify({pipeline:pipelineVersion(binding),key:rawKey,sha256:sha('fixture'),sourceRecords:2,records:2})),'application/json');
 const fingerprint=digest([rawKey]);
 await store.put(`derived/indexing/${pipelineVersion(binding)}/${digest([binding.tenantId,binding.connectionId,'fixture-search'])}/snapshot-${fingerprint}.json`,Buffer.from(JSON.stringify({pipeline:pipelineVersion(binding),fingerprint,checksum:digest(['fixture']),sourceRecords:2,objects:1,records:2,ignored:0})),'application/json');
 domain='temporal-cutover';
 expected.catchup=sessionCatchupMarker({prefix,sourceId:'upgrade-fixture',taskQueue:'upgrade-fixture',generation:'fixture-v1'});
 await store.put(expected.catchup.markerKey,Buffer.from(JSON.stringify(expected.catchup.marker)),'application/json');
 domain='record-counts';
 const countId=value=>createHash('sha1').update(JSON.stringify([value])).digest('base64url').slice(0,12);
 await store.put(`_opencrawl/counts/connection=${expected.integrationId}.json.gz`,gzipSync(JSON.stringify({version:1,read:[rawKey],ids:{canonical_messages:[countId('first'),countId('second')]},full:{channels:{sync:1,count:2}}})),'application/gzip');
 domain='value-reports';
 expected.report={schema:4,measuredAt:'2026-11-15',window:{from:'2026-11-15',to:'2026-11-15',days:1},model:{model:'synthetic',input:1,cacheRead:1,cacheWrite:1,output:1,asOf:'2026-11-15',share:100},work:{sessions:1,tasks:1},spend:{input:1,cacheRead:1,cacheWrite:1,output:1},drift:{conflictsAvoided:1,duplicatesAvoided:1},usage:{searches:1,boardMessages:1},value:{searchesUsed:1,fixesReused:1,found:{teammateWork:1,whereThingsLive:0,pastDecisions:0,pastFixes:0,other:0}}};
 await store.put(valueReportKey(prefix,owner.tenantId),Buffer.from(JSON.stringify(expected.report)),'application/json');
 const identity=await createLocalIdentity({url:required('OPENCRAWL_URL'),secret:required('OPENCRAWL_AUTH_SECRET'),databasePath:required('OPENCRAWL_IDENTITY_PATH'),organizationId:owner.tenantId});
 try{expected.invitation=await identity.directory.userManagement.sendInvitation({organizationId:owner.tenantId,email:'pending-upgrade@example.com',inviterUserId:owner.userId,roleSlug:'member'});assert.equal(await identity.setupRequired(),false);}finally{identity.close();}
 const registry=createSingleOrganizationRegistry({path:required('OPENCRAWL_REGISTRY_PATH'),organizationId:owner.tenantId});
 try{expected.integration=await registry.create({tenantId:owner.tenantId,userId:owner.userId,integrationId:expected.integrationId,provider:'slack',environment:'selfhost',scope:'team',status:'disconnected',createdAt:new Date().toISOString(),startDate:'2026-01-01T00:00:00Z',s3Bucket:raw.bucket,s3Prefix:binding.rawPrefix.slice(0,-1),connectedAccountId:expected.grant.id,provisionProtocol:1,provisionRun:'retained-run',provisionVersion:'retained-version'});}finally{registry.close();}
 for(const [key,unit] of touched){const bytes=await raw.get(key);assert.ok(bytes);manifest.objects.push({key,unit,sha256:sha(bytes)});}
 manifest.objects.sort((a,b)=>a.key.localeCompare(b.key));
 writeFileSync(path,JSON.stringify(manifest),{mode:0o600});const {uid,gid}=statSync('/dev-state');chownSync(path,uid,gid);
} else {
 for(const object of manifest.objects){const bytes=await raw.get(object.key);assert.ok(bytes,'Retained source missing: '+object.unit);assert.equal(sha(bytes),object.sha256,'Retained source changed: '+object.unit);}
 if(phase==='verify'){
  const {applicationDatabase}=await import('../dist/src/state/settings.mjs');const database=applicationDatabase();
  try{
   const {rows}=await database.pool.query('SELECT source_key,source_hash FROM opencrawl_application_migrations WHERE namespace=$1',[database.namespace]);
   const receipts=new Map(rows.map(row=>[row.source_key,row.source_hash]));
   for(const object of manifest.objects)assert.equal(receipts.get(object.key),object.sha256,'Migration receipt missing or mismatched: '+object.unit);
   const {createPostgresControls}=await import('../dist/src/state/resource-controls.mjs');
   const controls=createPostgresControls(database);
   await verifyControls(controls);
   const {createPostgresWriteBarrier}=await import('../dist/src/state/write-barriers.mjs');
   await verifyFences(
    createPostgresWriteBarrier({database,tenantId:owner.tenantId,connectionId:expected.integrationId}),
    createPostgresWriteBarrier({database,namespace:'sessions',tenantId:sha(owner.tenantId),connectionId:sha(JSON.stringify([prefix,owner.userId,'codex','upgrade-deleted'])),controlPrefix:prefix+'/tenants/'+sha(owner.tenantId)+'/users/'+sha(owner.userId)+'/controls/write-barriers/'}));
   const identity=await createLocalIdentity({database,url:required('OPENCRAWL_URL'),secret:required('OPENCRAWL_AUTH_SECRET'),organizationId:owner.tenantId});
   await verifyIdentity(identity);
   const registry=createSingleOrganizationRegistry({database,organizationId:owner.tenantId});
   const {migratedIntegrationCommand}=await import('../dist/src/state/lifecycle-migration.mjs');
   const resumed=migratedIntegrationCommand(database.namespace,expected.integration,'disconnect');
   assert.deepEqual(await registry.get(owner.tenantId,owner.userId,expected.integrationId),{...expected.integration,status:'disconnecting',lifecycleOperation:'disconnect',lifecycleCommandId:resumed.commandId});
   const {createApplicationState}=await import('../dist/src/state/application.mjs');
   const state=await createApplicationState({database});
   const {createSchedulerRetirements}=await import('../dist/src/state/scheduler-retirements.mjs');
   const retirements=createSchedulerRetirements(database);
   for(const item of expected.scheduler){
    assert.deepEqual(await retirements.exportRetirement(item.key),item.retired);
    assert.equal(await state.indexingReceipts.read(item.key),null,'Retired scheduler instruction became a completion receipt');
   }
   await verifyRepositories({state,prefix});
   assert.deepEqual(await state.deletionRequests(prefix).readFor(owner,{harness:'codex',sessionId:'upgrade-deleted'}),{schemaVersion:1,owner,harness:'codex',sessionId:'upgrade-deleted'});
   await assert.rejects(state.accounts.roles.acquire(owner.tenantId,owner.userId,owner.userId,'member'),error=>error.status===409);
   const {createPostgresSlackCapture}=await import('../dist/src/state/slack-capture.mjs');
   const slack=createPostgresSlackCapture(database);
   for(const object of manifest.objects.filter(item=>item.key.includes('/capture/')&&/(?:catalog|state)\.json$/.test(item.key))){
    assert.deepEqual(await slack.exportLegacy(object.key),JSON.parse((await raw.get(object.key)).toString()),'Slack checkpoint/catalog changed');
   }
   const {createConnectorCounts,legacyCountsHash}=await import('../dist/src/state/connector-counts.mjs');
   const counts=createConnectorCounts({database,legacyBucket:raw.bucket});
   const oldCounts=JSON.parse(gunzipSync(await raw.get(`_opencrawl/counts/connection=${expected.integrationId}.json.gz`)).toString());
   assert.equal(legacyCountsHash(await counts.exportLegacyCounts(expected.integration)),legacyCountsHash(oldCounts));
   assert.deepEqual(await counts.read(expected.integration),{canonical_messages:2,channels:2});
   // Behavior checks may update the new board. The retained old objects remain
   // the exact matched rollback snapshot, never a live fallback or dual write.
   for(const object of manifest.objects)assert.equal(sha(await raw.get(object.key)),object.sha256);
  }finally{await database.close();}
 }else{
  await verifyControls(createControls(scope));
  await verifyFences(createConnectorWriteBarrier({store,tenantId:owner.tenantId,connectionId:expected.integrationId}),sessionWriteBarrier(store,prefix,owner,'codex','upgrade-deleted'));
  const identity=await createLocalIdentity({databasePath:required('OPENCRAWL_IDENTITY_PATH'),url:required('OPENCRAWL_URL'),secret:required('OPENCRAWL_AUTH_SECRET'),organizationId:owner.tenantId});
  try{await verifyIdentity(identity);}finally{identity.close();}
  await verifyRepositories(scope);
 }
}
console.log(JSON.stringify({applicationStateFixture:phase,sourceObjects:manifest.objects.length,sourceDomains:[...new Set(manifest.objects.map(item=>item.unit))].sort(),retainedSources:true}));

async function verifyControls(controls){
 assert.deepEqual(await controls.read(owner,'sessions','codex','upgrade-private'),expected.controls.private);
 assert.deepEqual(await controls.read(owner,'memories','codex','upgrade-private.md'),expected.controls.memory);
 assert.deepEqual(await controls.read(owner,'sessions','codex','upgrade-deleted'),expected.controls.deleted);
 assert.equal(await controls.read({...owner,userId:'user_foreign'},'sessions','codex','upgrade-private'),null);
}
async function verifyFences(connector,session){
 assert.deepEqual(await connector.inspect(),expected.connectorFence);assert.deepEqual(await session.inspect(),expected.sessionFence);
 for(const fence of [connector,session])await assert.rejects(fence.run('object-put',async()=>{assert.fail('Closed fence admitted a write');}),error=>error.status===403);
}
async function verifyIdentity(identity){
 assert.equal(await identity.setupRequired(),false);
 const invite=await identity.pendingInvitation(expected.invitation.id);assert.ok(invite);assert.equal(invite.email,'pending-upgrade@example.com');
 const user=await identity.directory.userManagement.getUser(owner.userId);assert.equal(user.id,owner.userId);assert.equal(user.locallyEnrolled,true);
}
async function verifyRepositories(options){
 const credentials=createCaptureCredentials(options);
 assert.equal((await credentials.authenticate(expected.capture.token))?.userId,owner.userId);
 assert.equal(await credentials.authenticate(expected.revokedCapture.token),null);
 assert.equal(await credentials.authenticate(expected.generationCapture.token),null);
 const board=createBoard({...options,prefix:prefix+'/board'});
 const delivery=await board.participate(owner,'inbox',{session:'upgrade-receiver',receipt:expected.delivery.batch.receipt});
 assert.deepEqual(delivery.batch,expected.delivery.batch);
 assert.deepEqual(await board.participate(owner,'publish',expected.publication),expected.published);
 await assert.rejects(board.participate(owner,'publish',{...expected.publication,text:'Conflicting retry'}),error=>error.status===409);
 assert.deepEqual((await credentialVault({...options,prefix:'connector-credentials/v1',organizationId:owner.tenantId,key:encryptionKey}).read(expected.grant.id)).record,expected.grant);
 assert.deepEqual((await connectorSettingsStore({...options,prefix:'connector-settings/v1',organizationId:owner.tenantId,key:encryptionKey}).read()).record,expected.settings);
 assert.deepEqual(await createOnboardingStatus(options).read(expected.revokedOwner),expected.onboarding);
 const replicas=createReplicasConnections({...replicasOptions,...options});assert.deepEqual(await replicas.lookupOrganization(expected.replicaOrganization),expected.replica);assert.equal(await replicas.resolveOrganization(expected.replicaOrganization),null);
 assert.deepEqual(await valueReports(options).read(owner.tenantId),expected.report);
}
