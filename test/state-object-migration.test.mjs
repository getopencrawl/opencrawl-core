import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
import {createObjectMigration,createTenantObjectMigration,createBoundObjectMigration} from '../dist/src/state/object-migration.mjs';
import {createPostgresEventIdentities} from '../dist/src/sessions/postgres-identities.mjs';
import {digest,eventIdentityLocation} from '../dist/src/sessions/event-identity.mjs';
import {digest as objectDigest} from '../dist/src/connectors/scope.mjs';
import {sealedEnvelope} from '../dist/src/integrations/credential-vault.mjs';
import {sessionCatchupMarker} from '../dist/src/sessions/temporal/handoff.mjs';
import {createApplicationState} from '../dist/src/state/application.mjs';

const prefix='sessions/self-hosted/v1',organizationId='org_migrationfixture',owner={tenantId:organizationId,userId:'user_fixture'};
const tenantHash=digest(organizationId),ownerScope='tenants/'+tenantHash+'/users/'+digest(owner.userId),date='2026-11-15T01:00:00.000Z';
const encode=value=>Buffer.from(JSON.stringify(value));
async function setup(t){
 const database=await applicationDatabaseFixture(t),objects=new Map(),connectorKey=randomBytes(32);
 const eventIdentities=createPostgresEventIdentities({connectionString:postgresUrl,namespace:database.namespace});t.after(()=>eventIdentities.close());
 const store={bucket:'synthetic-fixture',get:async key=>objects.get(key)??null,
  readVersion:async key=>({data:objects.get(key)??null,version:objects.has(key)?digest(objects.get(key)):null}),
  listPage:async start=>({keys:[...objects.keys()].filter(key=>key.startsWith(start)).sort(),nextToken:null}),
  put:async()=>assert.fail('Migration modified an original object'),compareAndSet:async()=>assert.fail('Migration replaced an original object')};
 const record={integrationId:'int_'+'1'.repeat(26),tenantId:organizationId,userId:owner.userId,environment:'selfhost',provider:'slack',scope:'team',status:'disconnected',createdAt:date,startDate:date,s3Bucket:store.bucket,workspace:'T123',s3Prefix:'raw/v1/source=slack/workspace=T123/connection=int_'+'1'.repeat(26)};
 const options={database,prefix,organizationId,store,eventIdentities,connectorKey,registryRecords:[record]};
 return {database,objects,store,record,connectorKey,eventIdentities,options,migration:createObjectMigration(options)};
}
function sources({record,connectorKey}){
 const entries=[],add=(key,value)=>entries.push([key,encode(value)]),raw=record.s3Prefix+'/';
 add(prefix+'/'+ownerScope+'/controls/sessions/codex/'+digest('deleted')+'.json',{schemaVersion:1,visibility:'private',deletedAt:date,updatedAt:date,deletion:{sessionId:'deleted',state:'pending'}});
 add(prefix+'/'+ownerScope+'/controls/memories/codex/'+digest('private.md')+'.json',{schemaVersion:1,visibility:'private',deletedAt:null,updatedAt:date});
 const request={schemaVersion:1,owner,harness:'codex',sessionId:'deleted'};
 add(prefix+'/_deletions/v1/'+digest(JSON.stringify([prefix,owner.tenantId,owner.userId,'codex','deleted']))+'.json',request);
 const writer={id:'uncertain-writer',operation:'search-write',phase:'writing',startedAt:123,instance:'stopped-image',target:'synthetic'};
 const fence={version:1,namespace:'selfhost',tenantId:organizationId,connectionId:record.integrationId,closedAt:124,writers:[writer]};
 add('control/connectors/write-barriers/v1/'+objectDigest([fence.namespace,fence.tenantId,fence.connectionId])+'.json',fence);
 const sessionFence={...fence,namespace:'sessions',tenantId:tenantHash,connectionId:digest(JSON.stringify([prefix,owner.userId,'codex','deleted']))};
 add(prefix+'/'+ownerScope+'/controls/write-barriers/'+objectDigest([sessionFence.namespace,sessionFence.tenantId,sessionFence.connectionId])+'.json',sessionFence);
 add(prefix+'/_credentials/'+digest('active-token')+'.json',{schemaVersion:1,id:digest('active-token'),principal:owner,expiresAt:'2099-01-01T00:00:00.000Z',revoked:false,generation:digest('generation')});
 add(prefix+'/_credentials/'+digest('revoked-token')+'.json',{schemaVersion:1,id:digest('revoked-token'),principal:owner,expiresAt:'2099-01-01T00:00:00.000Z',revoked:true,generation:digest('generation')});
 add(prefix+'/_credential-generations/'+ownerScope+'.json',{generation:digest('generation')});
 add(prefix+'/'+ownerScope+'/onboarding/mcp.json',{observedAt:date,client:'fixture'});
 add(prefix+'/organization-role-writes/'+organizationId+'.json',{schemaVersion:1,state:'held',operationId:randomUUID(),organizationId,actorId:owner.userId,userId:owner.userId,role:'member',startedAt:date});
 const replica='12345678-1234-4234-9234-123456789abc';
 add(prefix+'/identity/replicas-v1/organizations/'+replica+'.json',{schemaVersion:1,organizationId:replica,tenantId:organizationId,approvedBy:owner.userId,approvedAt:date,revokedAt:date,installations:[{id:'fixture',tenantId:organizationId,userId:'workload_replicas_'+digest('fixture'),name:'Replicas'}]});
 add(prefix+'/identity/replicas-v1/tenants/'+tenantHash+'/'+replica+'.json',{organizationId:replica});
 add(prefix+'/identity/replicas-v1/setup/'+digest('setup')+'.json',{schemaVersion:1,tenantId:organizationId,userId:owner.userId,issuedAt:1,expiresAt:2,claim:null});
 const grantId='grant_'+'a'.repeat(48),grantKey='connector-credentials/v1/'+organizationId+'/'+grantId+'.enc';
 const grant={version:1,id:grantId,organizationId,userId:owner.userId,integrationId:record.integrationId,provider:'slack',status:'REFRESHING',state:'synthetic',callbackUrl:'https://example.com/callback',flowExpiresAt:1,proxyToken:'synthetic',accessToken:'synthetic',refreshToken:'synthetic'};
 entries.push([grantKey,sealedEnvelope(connectorKey).seal(grantKey,encode(grant))]);
 const settingsKey='connector-settings/v1/'+organizationId+'/settings.enc';entries.push([settingsKey,sealedEnvelope(connectorKey).seal(settingsKey,encode({version:1,organizationId,broker:{apiKey:'synthetic',savedAt:date,savedBy:owner.userId}}))]);
 add(prefix+'/value/tenants/'+tenantHash+'.json',{schema:3,measuredAt:date,retainedOldReport:true});
 const scope=objectDigest({tenantId:record.tenantId,connectionId:record.integrationId,workspaceId:record.workspace,provider:record.provider,access:'team-public',rawPrefix:raw});
 add(raw+'capture/messages-v1/catalog.json',{scope,channels:['COLD','C1']});
 add(raw+'capture/files-v1/catalog.json',{scope,channels:['COLD','C1'],files:{F1:['C1','COLD']}});
 add(raw+'capture/messages-v1/pending/state.json',{version:1,scope,runId:'pending',cutoff:123,cursor:'',channels:{C1:{id:'C1',cursor:'next',done:false}},threads:{},priorChannels:['COLD'],listed:true,nextDue:{'conversations.history':65000},pages:1,emitted:1,errors:[]});
 add(raw+'capture/files-v1/pending/state.json',{version:1,scope,runId:'pending',cutoff:123,cursor:'',channels:{C1:{id:'C1',page:1,done:false}},files:{F1:{id:'F1',channels:['C1'],comments:{comment:'retained'},cursor:'',done:false}},priorChannels:['COLD'],listed:true,nextDue:65000,pages:1,emitted:0,errors:[]});
 add(raw+'capture/message-references-v1/pending/state.json',{version:1,scope,runId:'pending',inputHash:digest('references'),position:1,nextDue:{'conversations.replies':65000},pages:1,emitted:1,errors:[]});
 const sourceKey=prefix+'/'+ownerScope+'/codex/'+digest('installation')+'/'+digest('session')+'/'+digest('batch')+'.json.gz';
 add(prefix+'/_index/'+digest('search')+'/'+digest('job')+'/batches/'+digest(sourceKey)+'.json',{status:'indexed',sourceKey,documents:2,indexedAt:date});
 const rawKey=raw+'stream=canonical_messages/date=2026-11-15/sync=1/page.jsonl.gz';
 add('derived/indexing/slack-v6/'+digest('binding')+'/'+digest(rawKey)+'.json',{pipeline:'slack-v6',key:rawKey,sha256:digest('object'),sourceRecords:2,records:2});
 add('derived/indexing/slack-v6/'+digest('binding')+'/snapshot-'+digest('snapshot')+'.json',{pipeline:'slack-v6',fingerprint:digest('snapshot'),checksum:digest('checksum'),sourceRecords:2,records:2,objects:1,ignored:0});
 const marker=sessionCatchupMarker({prefix,sourceId:'fixture',taskQueue:'fixture',generation:'fixture'});add(marker.markerKey,marker.marker);
 entries.push(['_opencrawl/counts/connection='+record.integrationId+'.json.gz',gzipSync(encode({version:1,read:[rawKey,rawKey],ids:{canonical_messages:['123456789012','123456789012','abcdefghijkl']},full:{channels:{sync:1,count:2}}}))]);
 const location=eventIdentityLocation({prefix,principal:owner,harness:'codex',installationId:'reserved-only',sessionId:'reserved-only'});
 add(location.key,{schemaVersion:1,identity:location.identity,events:{[digest('failed-upload-event')]:digest('content')}});
 add(prefix+'/board/tenants/'+tenantHash+'.json',{schema:1,messages:[],agents:{},usage:{calls:1,inputBytes:2,outputBytes:3},participants:{}});
 return entries;
}

test('legacy state migration validates, imports, and independently reads every mutable object domain',{skip:!postgresUrl},async t=>{
 const fixture=await setup(t),{migration,objects,database}=fixture,entries=sources(fixture);
 for(const [key,value] of entries)objects.set(key,value);
 const before=new Map(entries.map(([key,value])=>[key,digest(value)]));
 for(const [key,value]of entries){const result=await migration.process(key,value,{write:false});assert.equal(result.target,null,key);}
 const domains=await database.pool.query("SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='namespace' AND table_name LIKE 'opencrawl_%'");
 for(const {table_name}of domains.rows){assert.match(table_name,/^opencrawl_[a-z_]+$/);assert.equal(Number((await database.pool.query(`SELECT count(*) AS count FROM \"${table_name}\" WHERE namespace=$1`,[database.namespace])).rows[0].count),0,'check wrote '+table_name);}
 // Simulate a process interruption after half the independently committed units.
 for(const [key,value]of entries.slice(0,14))await migration.process(key,value,{write:true});
 const restarted=createObjectMigration(fixture.options);
 for(const [key,value]of entries){const result=await restarted.process(key,value,{write:true});assert.deepEqual(result.target,result.source,key);assert.ok(result.rows>=0);}
 for(const [key,value]of entries){const result=await restarted.process(key,value,{write:false});assert.deepEqual(result.target,result.source,key);assert.equal(digest(objects.get(key)),before.get(key));}
 const state=await createApplicationState({database});
 const {createConnectorCacheRetirements}=await import('../dist/src/state/connector-cache-retirements.mjs');
 const cacheAudit=createConnectorCacheRetirements(database);assert.deepEqual(await cacheAudit.required(),{receipts:2,buckets:[fixture.store.bucket]});
 for(const [key,bytes]of entries.filter(([key])=>key.startsWith('derived/indexing/'))){const audit=await cacheAudit.exportRetirement(fixture.store.bucket,key);assert.equal(audit.sourceHash,digest(bytes));assert.equal(audit.disposition,'full-temporal-connector-catchup');assert.deepEqual(audit.receipt,JSON.parse(bytes));assert.equal(await state.indexingReceipts.read(key),null,'Unprovable connector cache became live skip authority');}
 assert.equal((await state.controls.read(owner,'sessions','codex','deleted')).deletion.state,'pending');
 assert.equal((await state.controls.read(owner,'memories','codex','private.md')).visibility,'private');
 assert.equal(await state.controls.read({...owner,userId:'user_foreign'},'sessions','codex','deleted'),null);
 assert.equal((await state.accounts.credentials.authenticate(digest('active-token'))).principal.userId,owner.userId);
 await assert.rejects(state.accounts.roles.acquire(organizationId,owner.userId,owner.userId,'member'),error=>error.status===409);
 assert.equal((await state.replicas.readConnection('12345678-1234-4234-9234-123456789abc')).record.revokedAt,date);
 // No broad re-copy can overwrite newer data after import; a conflict is fatal.
 const [controlKey,controlBytes]=entries[0];await state.controls.update(owner,'sessions','codex','deleted',old=>({...old,deletion:{...old.deletion,state:'complete'}}));
 await assert.rejects(restarted.process(controlKey,controlBytes,{write:true}),/differs/);
});

test('migration rejects unknown mutable paths, fields, mismatched owners, lost keys and missing count owners',{skip:!postgresUrl},async t=>{
 const fixture=await setup(t),{migration}=fixture,entries=sources(fixture);
 for(const path of [prefix+'/_forgotten/state.json',prefix+'/_index/unknown.json','connector-settings/v1/unknown','raw/v1/source=slack/workspace=T1/connection=C1/capture/unknown/state.json'])assert.throws(()=>migration.classify(path),/Unrecognized/);
 const [key,bytes]=entries[0];await assert.rejects(migration.process(key,encode({...JSON.parse(bytes),unknown:1}),{write:false}));
 await assert.rejects(migration.process(key.replace(tenantHash,digest('org_foreign')),bytes,{write:false}),/owner hash/);
 const secret=entries.find(([key])=>key.startsWith('connector-credentials/'));
 await assert.rejects(createObjectMigration({...fixture.options,connectorKey:undefined}).process(...secret,{write:false}),/original connector encryption key/);
 await assert.rejects(createObjectMigration({...fixture.options,connectorKey:randomBytes(32)}).process(...secret,{write:false}));
 const receipt=entries.find(([key])=>key.startsWith('derived/indexing/')&&!key.includes('/snapshot-'));
 await assert.rejects(createObjectMigration({...fixture.options,registryRecords:[]}).process(...receipt,{write:false}),/original source binding/);
 const count=entries.find(([key])=>key.startsWith('_opencrawl/'));
 await assert.rejects(createObjectMigration({...fixture.options,registryRecords:[]}).process(...count,{write:false}),/matching original integration/);
 await assert.rejects(createObjectMigration({...fixture.options,registryRecords:[{...fixture.record,s3Bucket:'another-source-bucket'}]}).ready(),/multi-store migration/);
 const source=prefix+'/'+ownerScope+'/codex/'+digest('i')+'/'+digest('s')+'/';
 for(const path of [source+digest('batch')+'.json.gz',source+'attachments/'+digest('attachment'),prefix+'/'+ownerScope+'/attachments/'+digest('legacy'),fixture.record.s3Prefix+'/files/sha256/'+digest('content')+'.bin'])assert.equal(migration.classify(path),null);
});

test('authoritative event deletion survives an old ledger with failed-upload reservations',{skip:!postgresUrl},async t=>{
 const fixture=await setup(t),where={prefix,principal:owner,harness:'codex',installationId:'retained',sessionId:'deleted'},location=eventIdentityLocation(where);
 const bytes=encode({schemaVersion:1,identity:location.identity,events:{[digest('reserved')]:digest('event')}});fixture.objects.set(location.key,bytes);
 await fixture.eventIdentities.purgeSession(where);
 const result=await fixture.migration.process(location.key,bytes,{write:true});assert.equal(result.target.deleted,true);assert.deepEqual(result.source,result.target);assert.equal(result.rows,0);
 await assert.rejects(fixture.eventIdentities.reserve({...where,store:fixture.store,events:[{id:'new',kind:'message'}]}),error=>error.status===410);
 assert.equal(digest(fixture.objects.get(location.key)),digest(bytes));
});

function schedulerSources(sessionId='pending-session'){
 const sourceKey=prefix+'/'+ownerScope+'/codex/'+digest('installation')+'/'+digest(sessionId)+'/'+digest('batch')+'.json.gz';
 const root=prefix+'/_index/'+digest('old-search')+'/'+digest('sessions-v1:'+ownerScope);
 return {sourceKey,root,pending:prefix+'/index-pending/'+ownerScope+'/'+digest(sourceKey)+'.json',failed:root+'/batches/'+digest(sourceKey)+'.json',
  retry:{status:'failed',sourceKey,attempts:2,lastAttempt:date,nextAttempt:Date.parse(date)+4000,error:'INDEXING_FAILED'}};
}

test('legacy pending, failed and cursor instructions retire separately from live indexing receipts',{skip:!postgresUrl},async t=>{
 const fixture=await setup(t),{migration,objects,database}=fixture,old=schedulerSources();
 objects.set(old.sourceKey,gzipSync(encode({fixture:true})));
 const entries=[[old.pending,{sourceKey:old.sourceKey}],[old.failed,old.retry],[old.root+'/cursor.json',{nextToken:'opaque-pending-cursor',updatedAt:date}],[old.root+'/reconcile.json',{nextToken:'opaque-raw-cursor'}]];
 for(const [key,value]of entries){
  const bytes=encode(value);objects.set(key,bytes);
  const checked=await migration.process(key,bytes,{write:false});assert.equal(checked.target,null);
  const written=await migration.process(key,bytes,{write:true});assert.deepEqual(written.source,written.target);
  assert.equal(written.target.disposition,'full-temporal-catchup');assert.equal(written.target.generation,'postgres-app-state-v1');
  assert.deepEqual((await createObjectMigration(fixture.options).process(key,bytes,{write:false})).target,written.target);
  assert.equal(digest(objects.get(key)),digest(bytes));
 }
 const state=await createApplicationState({database});
 assert.equal(await state.indexingReceipts.read(old.failed),null);
 await state.indexingReceipts.put(old.failed,{status:'indexed',sourceKey:old.sourceKey,documents:1,indexedAt:date});
 assert.equal((await state.indexingReceipts.read(old.failed)).status,'indexed');
 // Retirement evidence cannot be overwritten by a changed source on restart.
 await assert.rejects(migration.process(old.failed,encode({...old.retry,attempts:3}),{write:true}),/differs/);
 const other=await applicationDatabaseFixture(t);
 const {createSchedulerRetirements}=await import('../dist/src/state/scheduler-retirements.mjs');
 assert.equal(await createSchedulerRetirements(other).exportRetirement(old.pending),null);
});

test('legacy scheduler retirement rejects wrong scope, wrong hashes, unknown shapes and unexplained missing sources',{skip:!postgresUrl},async t=>{
 const fixture=await setup(t),{migration,objects}=fixture,old=schedulerSources('deleted');
 for(const key of [old.pending,old.failed])await assert.rejects(migration.process(key,encode(key===old.pending?{sourceKey:old.sourceKey}:old.retry),{write:true}),/missing without.*tombstone/);
 objects.set(old.sourceKey,gzipSync(encode({fixture:true})));
 await assert.rejects(migration.process(old.pending.replace(digest(old.sourceKey),digest('wrong')),encode({sourceKey:old.sourceKey}),{write:false}),/identity mismatch/);
 await assert.rejects(migration.process(old.pending.replace(digest(owner.userId),digest('wrong-user')),encode({sourceKey:old.sourceKey}),{write:false}),/identity mismatch/);
 await assert.rejects(migration.process(old.failed.replace(digest(old.sourceKey),digest('wrong')),encode(old.retry),{write:false}),/identity mismatch/);
 const foreign=old.sourceKey.replace(tenantHash,digest('org_foreign'));
 await assert.rejects(migration.process(old.failed.replace(digest(old.sourceKey),digest(foreign)),encode({...old.retry,sourceKey:foreign}),{write:false}),/owner hash/);
 await assert.rejects(migration.process(old.pending,encode({sourceKey:old.sourceKey,unknown:true}),{write:false}));
 await assert.rejects(migration.process(old.failed,encode({...old.retry,error:'provider body'}),{write:false}));
 await assert.rejects(migration.process(old.root+'/cursor.json',encode({nextToken:null}),{write:false}),/shape mismatch/);
 await assert.rejects(migration.process(old.root+'/reconcile.json',encode({nextToken:null,updatedAt:date}),{write:false}),/shape mismatch/);
 assert.throws(()=>migration.classify(old.root+'/retry.json'),/Unrecognized/);
 // A retained, scoped deletion control is valid even before its SQL import.
 objects.delete(old.sourceKey);
 const controlKey=prefix+'/'+ownerScope+'/controls/sessions/codex/'+digest('deleted')+'.json';
 objects.set(controlKey,encode({schemaVersion:1,visibility:'private',deletedAt:date,updatedAt:date,deletion:{sessionId:'other',state:'complete'}}));
 await assert.rejects(migration.process(old.pending,encode({sourceKey:old.sourceKey}),{write:false}),/deletion proof identity mismatch/);
 objects.set(controlKey,encode({schemaVersion:1,visibility:'private',deletedAt:date,updatedAt:date,deletion:{sessionId:'deleted',state:'complete'}}));
 const retired=await migration.process(old.pending,encode({sourceKey:old.sourceKey}),{write:true});assert.equal(retired.target.disposition,'deleted');assert.deepEqual(retired.source,retired.target);
});

test('a retained old cutover marker cannot suppress fresh full catch-up after retiring pending work',{skip:!postgresUrl},async t=>{
 const fixture=await setup(t),old=schedulerSources(),searchIdentity='old-search',jobId='sessions-v1';
 fixture.objects.set(old.sourceKey,gzipSync(encode({fixture:true})));
 await fixture.migration.process(old.pending,encode({sourceKey:old.sourceKey}),{write:true});
 const {sessionIndexingGeneration,activateSessionIndexing}=await import('../dist/src/sessions/temporal/client.mjs');
 const oldBinding={prefix,sourceId:'fixture',taskQueue:'fixture',generation:digest(JSON.stringify([searchIdentity,jobId]))},oldMarker=sessionCatchupMarker(oldBinding);
 await fixture.migration.process(oldMarker.markerKey,encode(oldMarker.marker),{write:true});
 const state=await createApplicationState({database:fixture.database}),started=[],binding={...oldBinding,generation:sessionIndexingGeneration(searchIdentity,jobId)};
 assert.notEqual(binding.generation,oldBinding.generation);
 const client={schedule:{getHandle:()=>({describe:async()=>({action:{workflowType:'indexSessionsV1',taskQueue:binding.taskQueue,args:[{sourceId:binding.sourceId}]}}),pause:async()=>{}})},workflow:{start:async(type,options)=>{started.push({type,...options});}}};
 const activation=await activateSessionIndexing(client,{...binding,state,store:fixture.store});
 assert.equal(activation.completed,false);assert.notEqual(activation.workflowId,oldMarker.workflowId);assert.notEqual(activation.markerKey,oldMarker.markerKey);
 assert.equal(started.length,1);assert.equal(started[0].type,'reconcileSessionsV2');assert.deepEqual(started[0].args,[{sourceId:binding.sourceId,generation:binding.generation}]);
 assert.deepEqual(await state.indexingReceipts.read(oldMarker.markerKey),oldMarker.marker);
 assert.equal(await state.indexingReceipts.read(activation.markerKey),null);
});


test('explicit tenant import preserves personal scope and separate capture/agent revocation histories',{skip:!postgresUrl},async t=>{
 const fixture=await setup(t),principal={tenantId:'personal:user_fixture',userId:'user_fixture'},scope='tenants/'+digest(principal.tenantId)+'/users/'+digest(principal.userId),id=digest('same-synthetic-hash');
 assert.throws(()=>createObjectMigration({...fixture.options,organizationId:principal.tenantId}),/Invalid object migration scope/);
 const base={...fixture.options,registryRecords:[],tenantId:principal.tenantId};
 const capture=createTenantObjectMigration(base),agent=createTenantObjectMigration({...base,prefix:prefix+'/_agent-access',credentialPurpose:'agent'});
 const record={schemaVersion:1,id,principal,expiresAt:'2099-01-01T00:00:00.000Z',revoked:false,generation:digest('original-generation')};
 const entries=[
  [capture,prefix+'/_credentials/'+id+'.json',record],
  [capture,prefix+'/_credential-generations/'+scope+'.json',{generation:digest('capture-was-revoked')}],
  [agent,prefix+'/_agent-access/_credentials/'+id+'.json',record],
  [agent,prefix+'/_agent-access/_credential-generations/'+scope+'.json',{generation:record.generation}],
 ];
 for(const [importer,key,value]of entries){const result=await importer.process(key,encode(value),{write:true});assert.deepEqual(result.target,result.source);}
 const state=await createApplicationState({database:fixture.database});
 assert.equal(await state.accounts.credentials.authenticate(id,'capture'),null);
 assert.equal((await state.accounts.credentials.authenticate(id,'agent')).principal.tenantId,principal.tenantId);
 await state.accounts.credentials.revokeAll(principal,'agent');assert.equal(await state.accounts.credentials.authenticate(id,'agent'),null);
 assert.throws(()=>agent.classify(prefix+'/_agent-access/value/tenants/'+digest(principal.tenantId)+'.json'),/unrelated application state/);
 assert.throws(()=>agent.classify('control/connectors/write-barriers/v1/'+digest('fence')+'.json'),/escaped its bound prefix/);
 assert.throws(()=>agent.classify(prefix+'/_agent-access/'+scope+'/codex/'+digest('i')+'/'+digest('s')+'/'+digest('batch')+'.json.gz'),/unrelated application state/);
 const foreign=createTenantObjectMigration({...base,tenantId:'org_other'});
 await assert.rejects(foreign.process(prefix+'/_credentials/'+id+'.json',encode(record),{write:false}),/another installation organization/);
});


test('finite reviewed tenant sets preserve colliding resource IDs and reject cross-bound source identities',{skip:!postgresUrl},async t=>{
 const f=await setup(t),second='org_second',bound=createBoundObjectMigration({...f.options,registryRecords:[],tenantIds:[organizationId,second]});
 for(const tenantId of [organizationId,second]){
  const key=prefix+'/tenants/'+digest(tenantId)+'/users/'+digest(owner.userId)+'/controls/sessions/codex/'+digest('same-resource')+'.json';
  const value={schemaVersion:1,visibility:tenantId===organizationId?'private':'team',deletedAt:null,updatedAt:date};
  assert.deepEqual((await bound.process(key,encode(value),{write:true})).target,value);
 }
 const state=await createApplicationState({database:f.database});
 assert.equal((await state.controls.read(owner,'sessions','codex','same-resource')).visibility,'private');
 assert.equal((await state.controls.read({...owner,tenantId:second},'sessions','codex','same-resource')).visibility,'team');
 const badControl=prefix+'/tenants/'+digest('org_unreviewed')+'/users/'+digest(owner.userId)+'/controls/sessions/codex/'+digest('same-resource')+'.json';
 await assert.rejects(bound.process(badControl,encode({schemaVersion:1,visibility:'team',deletedAt:null,updatedAt:date}),{write:false}),/owner hash differs/);
 const role={schemaVersion:1,state:'held',operationId:randomUUID(),organizationId:second,actorId:owner.userId,userId:owner.userId,role:'member',startedAt:date};
 await assert.rejects(bound.process(prefix+'/organization-role-writes/'+organizationId+'.json',encode(role),{write:false}),/source key/);
 const settingsKey='connector-settings/v1/'+organizationId+'/settings.enc';
 const settings=sealedEnvelope(f.connectorKey).seal(settingsKey,encode({version:1,organizationId:second,broker:{apiKey:randomBytes(8).toString('hex'),savedAt:date,savedBy:owner.userId}}));
 await assert.rejects(bound.process(settingsKey,settings,{write:false}),/source key/);
 const replica='12345678-1234-4234-9234-123456789abc';
 f.objects.set(prefix+'/identity/replicas-v1/organizations/'+replica+'.json',encode({schemaVersion:1,organizationId:replica,tenantId:second,approvedBy:owner.userId,approvedAt:date,revokedAt:null,installations:[]}));
 await assert.rejects(bound.process(prefix+'/identity/replicas-v1/tenants/'+tenantHash+'/'+replica+'.json',encode({organizationId:replica}),{write:false}),/source mismatch/);
 assert.throws(()=>createBoundObjectMigration({...f.options,tenantIds:[]}),/Invalid object migration scope/);
 assert.throws(()=>createBoundObjectMigration({...f.options,tenantIds:[organizationId,organizationId]}),/Ambiguous/);
 const marker=sessionCatchupMarker({prefix,sourceId:'shared-hosted-source',taskQueue:'session-indexing-v1',generation:'old-generation'});
 assert.deepEqual((await bound.process(marker.markerKey,encode(marker.marker),{write:true})).target,marker.marker);
});


test('retained Slack catalogs require the original registry workspace even for disconnected records',{skip:!postgresUrl},async t=>{
 const f=await setup(t),entry=sources(f).find(([key])=>key.endsWith('/capture/messages-v1/catalog.json'));
 assert.equal(f.record.status,'disconnected');
 const {workspace,...missing}=f.record;
 await assert.rejects(createObjectMigration({...f.options,registryRecords:[missing]}).process(...entry,{write:false}),/Invalid connector scope/);
 await assert.rejects(createObjectMigration({...f.options,registryRecords:[{...f.record,workspace:'TFOREIGN'}]}).process(...entry,{write:false}),/prefix does not match/);
 const correct=await f.migration.process(...entry,{write:false});assert.equal(correct.target,null);
 const migrated=await f.migration.process(...entry,{write:true});assert.deepEqual(migrated.target,migrated.source);
 const state=await createApplicationState({database:f.database});
 const binding={tenantId:f.record.tenantId,connectionId:f.record.integrationId,workspaceId:workspace,provider:'slack',access:'team-public',rawPrefix:f.record.s3Prefix+'/'};
 assert.deepEqual(await state.slackCapture.readCatalog(binding,'messages-v1'),JSON.parse(entry[1]));
});
