import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {Pool} from 'pg';
import {createApplicationDatabase} from '../dist/src/state/postgres.mjs';
import {createOnlineJournal} from '../dist/src/state/online-journal.mjs';
import {createOnlineProjection} from '../dist/src/state/online-projection.mjs';
import {createBoundObjectMigration} from '../dist/src/state/object-migration.mjs';
import {createSetupState} from '../dist/src/state/setup.mjs';
import {legacySetupState} from './fixtures/setup-state.mjs';
import {createAccountState} from '../dist/src/state/account-state.mjs';
import {createPostgresControls} from '../dist/src/state/resource-controls.mjs';
import {createReplicasState} from '../dist/src/state/replicas.mjs';
import {createPostgresBoardState} from '../dist/src/state/board.mjs';
import {createConnectorSecrets} from '../dist/src/state/connector-secrets.mjs';
import {sealedEnvelope} from '../dist/src/integrations/credential-vault.mjs';
const url=process.env.OPENCRAWL_TEST_POSTGRES_URL,live=(name,run)=>test(name,{skip:!url},run);
const digest=value=>createHash('sha256').update(value).digest('hex'),encode=value=>Buffer.from(JSON.stringify(value));
const owner={tenantId:'org_online',userId:'user_online'},prefix='sessions',ownerScope=`tenants/${digest(owner.tenantId)}/users/${digest(owner.userId)}`,date='2026-11-16T00:00:00.000Z';
const keyCred=prefix+'/_credentials/'+digest('credential')+'.json',keyGen=prefix+'/_credential-generations/'+ownerScope+'.json',keyOnboard=prefix+'/'+ownerScope+'/onboarding/mcp.json';
const credential={schemaVersion:1,id:digest('credential'),principal:owner,expiresAt:'2099-01-01T00:00:00.000Z',revoked:false,generation:digest('generation')};
const identity={tenantHash:digest(owner.tenantId),userHash:digest(owner.userId),kind:'sessions',harness:'codex',resourceHash:digest('session')};
const keyControl=prefix+'/'+ownerScope+'/controls/sessions/codex/'+identity.resourceHash+'.json';
const control={schemaVersion:1,visibility:'private',deletedAt:null,updatedAt:date};
function external(){const values=new Map();return {values,read:async key=>values.get(key)??{version:null,operationId:null,revision:null,deleted:true,bytes:null,contentType:null},putIfVersion:async(key,version,m)=>{if((values.get(key)?.version??null)!==version)return false;values.set(key,{version:m.operationId,operationId:m.operationId,revision:m.revision,deleted:false,bytes:Buffer.from(m.bytes),contentType:m.contentType});return true;},deleteIfVersion:async(key,version,m)=>{if((values.get(key)?.version??null)!==version)return false;values.set(key,{version:m.operationId,operationId:m.operationId,revision:m.revision,deleted:true,bytes:null,contentType:null});return true;}};}
async function fixture(t,{agentPrefix}={}){
 const admin=new Pool({connectionString:url,max:2}),schema='oc_projection_'+randomUUID().replaceAll('-','');await admin.query('CREATE SCHEMA '+schema);
 const database=createApplicationDatabase({connectionString:url,namespace:'projection-'+randomUUID(),max:6,options:'-c search_path='+schema}),epoch=randomUUID(),sourceId='source',store=external(),connectorKey=Buffer.alloc(32,17);
 t.after(async()=>{await database.close();const c=await admin.connect();try{await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:identity-schema:maintenance',0))");await c.query('DROP SCHEMA '+schema+' CASCADE');await c.query('COMMIT');}finally{c.release();await admin.end();}});
 const journal=createOnlineJournal({database,epoch,sourceId});await journal.ready();
 const options={database,epoch,sourceId,journalBinding:journal.binding,prefix,...(agentPrefix?{agentPrefix}:{}),tenantIds:[owner.tenantId],store:{bucket:'synthetic',get:async()=>assert.fail('Projection must not read legacy dependencies')},registryRecords:[],eventIdentities:{},connectorKey,enrollment:{verifierId:'synthetic-authoritative-directory-v1',initialReceiptHash:digest('reviewed-inventory'),verify:async request=>{if(request.evidence!=='verified-test-origin')throw Error('untrusted enrollment origin');return {tenantId:request.tenantId,receiptHash:digest('verified-'+request.tenantId)};}}};
 const projection=createOnlineProjection(options);await projection.ready();
 const put=async(key,value)=>journal.mutate({operationId:randomUUID(),key,mutation:{kind:'put',bytes:Buffer.isBuffer(value)?value:encode(value),contentType:'application/json'}},store);
 const del=async key=>journal.mutate({operationId:randomUUID(),key,mutation:{kind:'delete'}},store);
 const baseline=async(key,value)=>journal.backfillIfUnchanged({key,apply:async client=>{const bytes=Buffer.isBuffer(value)?value:encode(value);store.values.set(key,{version:'legacy-'+digest(key),operationId:null,revision:null,deleted:false,bytes,contentType:'application/json'});await projection.backfill(client,{key,bytes,version:'legacy-'+digest(key)});}});
 const replay=()=>journal.replayPage({consumer:'typed',apply:projection.apply});
 return {admin,database,epoch,sourceId,store,connectorKey,journal,projection,options,put,del,baseline,replay,accounts:createAccountState(database),controls:createPostgresControls(database)};
}
live('typed account/privacy effects, projection heads and journal checkpoint commit or rollback together',async t=>{
 const f=await fixture(t);await f.baseline(keyControl,control);await f.baseline(keyCred,credential);await f.baseline(keyGen,{generation:credential.generation});
 await f.put(keyCred,{...credential,revoked:true});await f.put(keyOnboard,{observedAt:date,client:'synthetic'});
 await assert.rejects(f.journal.replayPage({consumer:'typed',apply:async(c,i)=>{await f.projection.apply(c,i);if(i.sequence==='2')throw Error('after typed effects');}}),/after typed effects/);
 assert.equal((await f.accounts.exportCredential(credential.id)).revoked,false);assert.equal(await f.accounts.onboarding.read(ownerScope,'mcp'),null);assert.equal(await f.journal.replayCheckpoint('typed'),null);
 assert.equal((await f.replay()).checkpoint,'2');assert.equal((await f.accounts.exportCredential(credential.id)).revoked,true);assert.equal((await f.accounts.onboarding.read(ownerScope,'mcp')).client,'synthetic');
 assert.equal((await f.controls.readIdentity(identity)).visibility,'private');assert.equal((await f.database.pool.query('SELECT count(*)::int n FROM opencrawl_application_installations')).rows[0].n,0,'Projection never grants runtime readiness');
 await f.put(keyGen,{generation:digest('new-generation')});await f.replay();assert.equal(await f.accounts.credentials.authenticate(credential.id),null);
});
live('privacy controls and credential generations cannot be deleted or reverted by journal replay',async t=>{
 const f=await fixture(t);await f.baseline(keyControl,{...control,deletedAt:date,deletion:{sessionId:'session',state:'complete'}});await f.baseline(keyGen,{generation:digest('revoked')});
 for(const value of [null,control]){const intent=value===null?await f.del(keyControl):await f.put(keyControl,value);await assert.rejects(f.database.transaction(c=>f.projection.apply(c,intent)),/privacy control|cannot be restored/);}
 const deletedGeneration=await f.del(keyGen);await assert.rejects(f.database.transaction(c=>f.projection.apply(c,deletedGeneration)),/cannot erase a credential revocation generation/);
 assert.equal((await f.controls.readIdentity(identity)).deletion.state,'complete');assert.equal((await f.accounts.exportGeneration(ownerScope)).generation,digest('revoked'));
});
live('credential delete retains projection tombstone and cannot revive the same credential identity',async t=>{
 const f=await fixture(t);await f.baseline(keyCred,credential);await f.del(keyCred);await f.replay();assert.equal(await f.accounts.exportCredential(credential.id),null);
 const tombstone=(await f.database.pool.query("SELECT deleted,revision FROM opencrawl_online_projection_heads WHERE domain='capture-credentials'")).rows[0];assert.deepEqual(tombstone,{deleted:true,revision:'1'});
 await f.put(keyCred,credential);await assert.rejects(f.replay(),/deleted security identity/);assert.equal(await f.accounts.exportCredential(credential.id),null);assert.equal(await f.journal.replayCheckpoint('typed'),'1');
});
live('canonical publisher, source binding, target drift and Replicas alias checks fail closed',async t=>{
 const f=await fixture(t);assert.throws(()=>createOnlineProjection({...f.options,journalBinding:{...f.journal.binding,sourceId:'other'}}),/journal binding/);
 await f.baseline(keyCred,credential);await f.database.pool.query("UPDATE opencrawl_capture_credentials SET record=record||'{\"revoked\":true}'::jsonb");await f.put(keyCred,{...credential,revoked:true});await assert.rejects(f.replay(),/outside its source projection/);
 const alias=prefix+'/identity/replicas-v1/tenants/'+digest(owner.tenantId)+'/'+randomUUID()+'.json';await assert.rejects(f.database.transaction(c=>f.projection.backfill(c,{key:alias,bytes:encode({organizationId:randomUUID()}),version:'legacy'})),/Replicas index identity mismatch/);
 const other=createOnlineJournal({database:f.database,epoch:f.epoch,sourceId:'other'});await other.ready();const p=createOnlineProjection({...f.options,sourceId:'other',journalBinding:other.binding});await p.ready();await assert.rejects(f.database.transaction(c=>p.backfill(c,{key:keyCred,bytes:encode(credential),version:'legacy'})),/different source publisher/);
});
live('board projection preserves normalized publications, delivery receipts and atomic child replacement',async t=>{
 const f=await fixture(t),key=prefix+'/board/tenants/'+digest(owner.tenantId)+'.json',repo=createPostgresBoardState(f.database);
 const msg={id:1,timestamp:1,agent:'agent',author:owner.userId,name:'Agent',topic:'topic',text:'synthetic text',requestId:'request'};
 const {requestId,...visible}=msg,participant={name:'Agent',task:'task',harness:'codex',registeredAt:1,seen:1,topics:['topic'],ackCursor:0,lastPoll:1,lastAckAt:null,nextHomeAt:2,pending:{receipt:digest('receipt'),createdAt:1,through:1,more:false,messages:[{...visible,reasons:['topic']}]},batches:1,acknowledgedBatches:0};
 const state={schema:1,messages:[msg],agents:{agent:{name:'Agent',topics:['topic'],seen:1}},usage:{calls:1,inputBytes:2,outputBytes:3},participants:{agent:participant}};
 await f.baseline(key,state);assert.deepEqual(await repo.exportLegacy(digest(owner.tenantId)),state);
 const next={...state,participants:{agent:{...participant,pending:null,ackCursor:1,acknowledgedBatches:1}}};await f.put(key,next);await f.replay();assert.deepEqual(await repo.exportLegacy(digest(owner.tenantId)),next);
 assert.equal((await f.database.pool.query('SELECT count(*)::int n FROM opencrawl_board_delivery_messages')).rows[0].n,0);await f.del(key);await f.replay();assert.equal(await repo.exportLegacy(digest(owner.tenantId)),null);assert.equal((await f.database.pool.query('SELECT count(*)::int n FROM opencrawl_board_messages')).rows[0].n,0);
});
live('encrypted settings stay byte exact; wrong AAD/body and unknown owner fail before target effects',async t=>{
 const f=await fixture(t),key='connector-settings/v1/'+owner.tenantId+'/settings.enc',scope={kind:'settings',organizationId:owner.tenantId,id:'settings'},repo=createConnectorSecrets(f.database),envelope=sealedEnvelope(f.connectorKey);
 const value={version:1,organizationId:owner.tenantId,broker:{apiKey:'synthetic',savedAt:date,savedBy:owner.userId}},bytes=envelope.seal(key,encode(value));await f.baseline(key,bytes);assert.deepEqual((await repo.read(scope,key)).data,bytes);
 const next=envelope.seal(key,encode({...value,broker:null}));await f.put(key,next);await f.replay();assert.deepEqual((await repo.read(scope,key)).data,next);
 const wrong=envelope.seal('other/path',encode(value));await f.put(key,wrong);await assert.rejects(f.replay());assert.deepEqual((await repo.read(scope,key)).data,next);
 await assert.rejects(f.database.transaction(c=>f.projection.backfill(c,{key:'connector-settings/v1/org_other/settings.enc',bytes,version:'x'})),/another installation/);
});
live('Replicas connection and installations replace atomically; duplicate children roll back checkpoint and head',async t=>{
 const f=await fixture(t),org=randomUUID(),key=prefix+'/identity/replicas-v1/organizations/'+org+'.json',repo=createReplicasState(f.database),item={id:'i',tenantId:owner.tenantId,userId:'workload_replicas_'+digest('user'),name:'Replicas'};
 const value={schemaVersion:1,organizationId:org,tenantId:owner.tenantId,approvedBy:owner.userId,approvedAt:date,revokedAt:null,installations:[item]};await f.baseline(key,value);
 await f.put(key,{...value,installations:[item,item]});await assert.rejects(f.replay());assert.deepEqual((await repo.readConnection(org)).record,value);assert.equal(await f.journal.replayCheckpoint('typed'),null);
 const valid=await f.put(key,{...value,revokedAt:date,installations:[]});await f.database.transaction(c=>f.projection.apply(c,valid));assert.equal((await repo.readConnection(org)).record.installations.length,0);
 const del=await f.del(key);await f.database.transaction(c=>f.projection.apply(c,del));assert.equal((await repo.readConnection(org)).record,null);assert.equal((await f.database.pool.query('SELECT count(*)::int n FROM opencrawl_replicas_installations')).rows[0].n,0);
});

live('trusted append-only tenant enrollment is required before new signup state projects; offline scope stays finite',async t=>{
 const f=await fixture(t),other={tenantId:'org_new',userId:'user_new'},id=digest('new-user-token'),key=prefix+'/_credentials/'+id+'.json',value={...credential,id,principal:other};
 const intent=await f.put(key,value);await assert.rejects(f.replay(),/another installation/);await assert.rejects(f.projection.enrollTenant({tenantId:other.tenantId,evidence:'user-supplied'}),/untrusted enrollment/);
 assert.equal((await f.projection.enrollTenant({tenantId:other.tenantId,evidence:'verified-test-origin'})).enrolled,true);assert.equal((await f.projection.enrollTenant({tenantId:other.tenantId,evidence:'verified-test-origin'})).enrolled,false);await f.replay();assert.deepEqual((await f.accounts.exportCredential(id)).principal,other);
 const restarted=createOnlineProjection(f.options);await restarted.ready();const genKey=prefix+'/_credential-generations/tenants/'+digest(other.tenantId)+'/users/'+digest(other.userId)+'.json';const generation=await f.put(genKey,{generation:digest('new-user-generation')});await f.database.transaction(c=>restarted.apply(c,generation));
 const {createBoundObjectMigration}=await import('../dist/src/state/object-migration.mjs');assert.throws(()=>createBoundObjectMigration(f.options).decodeOnline(key,encode(value)),/another installation/);
 const wrong=createOnlineProjection({...f.options,enrollment:{...f.options.enrollment,verifierId:'different-verifier'}});await assert.rejects(wrong.ready(),/source binding changed/);
 assert.equal(intent.operationId.length,36);
});
live('role holds release only through their real matching operation receipt',async t=>{
 const f=await fixture(t),key=prefix+'/organization-role-writes/'+owner.tenantId+'.json',op=randomUUID(),held={schemaVersion:1,state:'held',operationId:op,organizationId:owner.tenantId,actorId:owner.userId,userId:owner.userId,role:'member',startedAt:date};
 await f.baseline(key,held);const wrong=await f.put(key,{schemaVersion:1,state:'idle',operationId:randomUUID(),completedAt:date});await assert.rejects(f.database.transaction(c=>f.projection.apply(c,wrong)),/operator check/);
 const correct=await f.put(key,{schemaVersion:1,state:'idle',operationId:op,completedAt:date});await f.database.transaction(c=>f.projection.apply(c,correct));assert.equal((await f.accounts.exportRole(owner.tenantId)).state,'idle');
});

live('authoritative fence updates and deletion-request completion retain the privacy tombstone',async t=>{
 const f=await fixture(t),connectionId=digest(JSON.stringify([prefix,owner.userId,'codex','session'])),barrierPrefix=prefix+'/'+ownerScope+'/controls/write-barriers/';
 const fence={version:1,namespace:'sessions',tenantId:digest(owner.tenantId),connectionId,closedAt:null,writers:[{id:'writer',operation:'object-put',phase:'writing',startedAt:1,instance:'compatibility',target:'synthetic'}]};
 const fenceKey=barrierPrefix+digest(JSON.stringify([fence.namespace,fence.tenantId,connectionId]))+'.json';
 const {createPostgresWriteBarrier}=await import('../dist/src/state/write-barriers.mjs'),barrier=createPostgresWriteBarrier({database:f.database,namespace:'sessions',tenantId:fence.tenantId,connectionId,controlPrefix:barrierPrefix});
 await f.baseline(fenceKey,fence);assert.equal((await barrier.inspect()).pending,1);
 await f.put(fenceKey,{...fence,writers:[{...fence.writers[0],phase:'settled',settledAt:2}]});await f.put(fenceKey,{...fence,closedAt:3,writers:[]});await f.replay();assert.equal((await barrier.inspect()).closed,true);assert.equal((await barrier.inspect()).pending,0);
 const reopened=await f.put(fenceKey,{...fence,writers:[]});await assert.rejects(f.database.transaction(c=>f.projection.apply(c,reopened)),/cannot reopen/);const deleted=await f.del(fenceKey);await assert.rejects(f.database.transaction(c=>f.projection.apply(c,deleted)),/cannot erase a write fence/);
 const request={schemaVersion:1,owner,harness:'codex',sessionId:'session'},requestKey=prefix+'/_deletions/v1/'+digest(JSON.stringify([prefix,owner.tenantId,owner.userId,'codex','session']))+'.json';
 await f.baseline(keyControl,{...control,deletedAt:date,deletion:{sessionId:'session',state:'complete'}});await f.baseline(requestKey,request);const done=await f.del(requestKey);await f.database.transaction(c=>f.projection.apply(c,done));
 assert.equal((await f.database.pool.query('SELECT count(*)::int n FROM opencrawl_session_deletions')).rows[0].n,0);assert.equal((await f.controls.readIdentity(identity)).deletedAt,date);assert.equal((await barrier.inspect()).closed,true);
});

live('one projection epoch owns typed namespace targets; a concurrent new epoch cannot adopt them',async t=>{
 const f=await fixture(t);await f.baseline(keyCred,credential);const epoch=randomUUID(),other=createOnlineJournal({database:f.database,epoch,sourceId:f.sourceId});await other.ready();
 const candidate=createOnlineProjection({...f.options,epoch,journalBinding:other.binding});await assert.rejects(candidate.ready(),/different projection epoch/);
 assert.equal((await f.database.pool.query('SELECT epoch FROM opencrawl_online_projection_namespaces WHERE namespace=$1',[f.database.namespace])).rows[0].epoch,f.epoch);assert.deepEqual(await f.accounts.exportCredential(credential.id),credential);
});

async function references(f,limit=64){
 const client=await f.database.pool.connect();try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');let after,processed=0,mismatches=0,pages=0;
  do{const page=await f.projection.inspectReplicasReferencesPageIn(client,{after,limit});processed+=page.processed;mismatches+=page.mismatches;pages++;after=page.next??undefined;}while(after);
  await client.query('COMMIT');return {processed,mismatches,pages};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
const connectionValue=organizationId=>({schemaVersion:1,organizationId,tenantId:owner.tenantId,approvedBy:owner.userId,approvedAt:date,revokedAt:null,installations:[]});
const canonicalKey=organizationId=>prefix+'/identity/replicas-v1/organizations/'+organizationId+'.json';
const aliasKey=(organizationId,tenant=owner.tenantId)=>prefix+'/identity/replicas-v1/tenants/'+digest(tenant)+'/'+organizationId+'.json';
live('Replicas reference can arrive before canonical source; bounded parity waits, and alias deletion never mutates the connection',async t=>{
 const f=await fixture(t),repo=createReplicasState(f.database),orgs=[randomUUID(),randomUUID(),randomUUID()];
 for(const org of orgs)await f.baseline(aliasKey(org),{organizationId:org});
 assert.deepEqual(await references(f,2),{processed:3,mismatches:3,pages:2});assert.deepEqual(await repo.listConnections(owner.tenantId),[]);
 for(const org of orgs)await f.baseline(canonicalKey(org),connectionValue(org));assert.deepEqual(await references(f,2),{processed:3,mismatches:0,pages:2});
 const before=await repo.readConnection(orgs[0]);await f.del(aliasKey(orgs[0]));await f.replay();assert.deepEqual(await repo.readConnection(orgs[0]),before);
 assert.deepEqual(await references(f,2),{processed:3,mismatches:0,pages:2});assert.equal((await f.database.pool.query('SELECT count(*)::int n FROM opencrawl_online_projection_replicas_references')).rows[0].n,2);
});
live('Replicas reference effects and head/checkpoint rollback together; deleting canonical source leaves an honest unresolved reference',async t=>{
 const f=await fixture(t),org=randomUUID();await f.baseline(canonicalKey(org),connectionValue(org));await f.put(aliasKey(org),{organizationId:org});
 await assert.rejects(f.journal.replayPage({consumer:'typed',apply:async(c,i)=>{await f.projection.apply(c,i);throw Error('rollback reference');}}),/rollback reference/);
 assert.equal((await f.database.pool.query('SELECT count(*)::int n FROM opencrawl_online_projection_replicas_references')).rows[0].n,0);assert.equal((await f.database.pool.query("SELECT count(*)::int n FROM opencrawl_online_projection_heads WHERE domain='replicas-index'")).rows[0].n,0);assert.equal(await f.journal.replayCheckpoint('typed'),null);
 await f.replay();assert.equal((await references(f)).mismatches,0);await f.del(canonicalKey(org));await f.replay();assert.equal((await references(f)).mismatches,1);
 await f.del(aliasKey(org));await f.replay();assert.equal((await references(f)).mismatches,0);
});
live('Replicas reference parity rejects a different canonical publisher/tenant and detects orphan or tampered reference evidence',async t=>{
 const f=await fixture(t),org=randomUUID(),other=createOnlineJournal({database:f.database,epoch:f.epoch,sourceId:'other'});await other.ready();
 const p=createOnlineProjection({...f.options,sourceId:'other',journalBinding:other.binding});await p.ready();await f.database.transaction(c=>p.backfill(c,{key:canonicalKey(org),bytes:encode(connectionValue(org)),version:'other-source'}));await f.baseline(aliasKey(org),{organizationId:org});assert.equal((await references(f)).mismatches,1,'Another source cannot satisfy this reference');
 const foreign='org_other';await f.projection.enrollTenant({tenantId:foreign,evidence:'verified-test-origin'});const org2=randomUUID();await f.baseline(canonicalKey(org2),{...connectionValue(org2),tenantId:foreign});await f.baseline(aliasKey(org2),{organizationId:org2});assert.equal((await references(f)).mismatches,2,'Enrolled does not mean the same tenant');
 await f.database.pool.query("DELETE FROM opencrawl_online_projection_heads WHERE domain='replicas-index' AND source_key=$1",[aliasKey(org2)]);assert.equal((await references(f)).processed,2,'Orphan reference remains in coverage');assert.equal((await references(f)).mismatches,2);
 const org3=randomUUID();await f.baseline(canonicalKey(org3),connectionValue(org3));await f.baseline(aliasKey(org3),{organizationId:org3});await f.database.pool.query("UPDATE opencrawl_replicas_connections SET record=record||'{\"approvedBy\":\"user_tampered\"}'::jsonb WHERE organization_id=$1",[org3]);assert.equal((await references(f)).mismatches,3,'Typed row drift cannot pass reference parity');
});
live('value reports update/delete and projection checkpoint commit atomically, preserving unsupported historical schemas without invented measurements',async t=>{
 const f=await fixture(t),{createValueReports}=await import('../dist/src/state/value-reports.mjs'),repo=createValueReports(f.database),key=prefix+'/value/tenants/'+digest(owner.tenantId)+'.json',old={schema:0,historical:'retained'},next={schema:0,historical:'changed'};
 await f.baseline(key,old);assert.deepEqual(await repo.exportReport(digest(owner.tenantId)),old);assert.equal(await repo.read(owner.tenantId),null);
 await f.put(key,next);await f.del(key);await assert.rejects(f.journal.replayPage({consumer:'typed',apply:async(c,i)=>{await f.projection.apply(c,i);if(i.sequence==='2')throw Error('rollback report');}}),/rollback report/);
 assert.deepEqual(await repo.exportReport(digest(owner.tenantId)),old);assert.equal(await f.journal.replayCheckpoint('typed'),null);assert.equal((await f.database.pool.query("SELECT revision FROM opencrawl_online_projection_heads WHERE domain='value-reports'")).rows[0].revision,'0');
 await f.replay();assert.equal(await repo.exportReport(digest(owner.tenantId)),null);await f.put(key,next);await f.replay();assert.deepEqual(await repo.exportReport(digest(owner.tenantId)),next,'Derived report may be recreated after a tombstone');
 await f.database.pool.query("UPDATE opencrawl_value_reports SET report='{\"tampered\":true}'::jsonb WHERE namespace=$1",[f.database.namespace]);await f.del(key);await assert.rejects(f.replay(),/outside its source projection/);assert.equal(await f.journal.replayCheckpoint('typed'),'3');
});
live('value report and reference projection isolate identical local keys by namespace',async t=>{
 const f=await fixture(t),org=randomUUID(),otherDb={...f.database,namespace:'isolated-'+randomUUID()},otherJournal=createOnlineJournal({database:otherDb,epoch:f.epoch,sourceId:f.sourceId});await otherJournal.ready();
 const projection=createOnlineProjection({...f.options,database:otherDb,journalBinding:otherJournal.binding});await projection.ready();const key=prefix+'/value/tenants/'+digest(owner.tenantId)+'.json';
 await f.database.transaction(async c=>{await projection.backfill(c,{key,bytes:encode({scope:'other'}),version:'legacy'});await projection.backfill(c,{key:aliasKey(org),bytes:encode({organizationId:org}),version:'legacy'});});
 await f.baseline(key,{scope:'primary'});await f.del(key);await f.replay();assert.equal((await f.database.pool.query('SELECT report FROM opencrawl_value_reports WHERE namespace=$1',[otherDb.namespace])).rows[0].report.scope,'other');assert.deepEqual(await references(f),{processed:0,mismatches:0,pages:1});
 await assert.rejects(f.database.transaction(c=>f.projection.backfill(c,{key:key.replace(digest(owner.tenantId),digest('org_unenrolled')),bytes:encode({}),version:'x'})),/owner hash/);
});

live('one bucket and journal project capture and nested agent credentials without purpose collision',async t=>{
 const f=await fixture(t,{agentPrefix:prefix+'/_agent-access'}),agentKey=keyCred.replace(prefix+'/',prefix+'/_agent-access/'),agentGen=keyGen.replace(prefix+'/',prefix+'/_agent-access/');
 await f.baseline(keyCred,credential);await f.baseline(agentKey,credential);await f.baseline(keyGen,{generation:credential.generation});await f.baseline(agentGen,{generation:credential.generation});
 await f.put(agentGen,{generation:digest('agent-revoked')});await f.replay();
 const agentAccounts=createAccountState(f.database);assert.equal(await agentAccounts.credentials.authenticate(credential.id,'agent'),null);assert.ok(await f.accounts.credentials.authenticate(credential.id));
 await f.del(agentKey);await f.replay();assert.equal(await agentAccounts.exportCredential(credential.id,'agent'),null);assert.deepEqual(await f.accounts.exportCredential(credential.id),credential);
 const heads=(await f.database.pool.query("SELECT target_key FROM opencrawl_online_projection_heads WHERE namespace=$1 AND domain='capture-credentials' ORDER BY target_key",[f.database.namespace])).rows;assert.deepEqual(heads.map(x=>JSON.parse(x.target_key)[1]),['agent','capture']);
 const wrong=createOnlineProjection({...f.options,agentPrefix:undefined});await assert.rejects(wrong.ready(),/source binding changed/);
 await assert.rejects(f.baseline(prefix+'/_agent-access/board/tenants/'+digest(owner.tenantId)+'.json',{}),/unrelated application state/);
});


test('Setup online decoder uses exact upstream validation and enrolled hashed owner without reading targets', () => {
 const object=createBoundObjectMigration({database:{namespace:'pure',pool:{query:async()=>assert.fail('No SQL during decode')}},prefix,tenantIds:[owner.tenantId],store:{bucket:'fixture'},registryRecords:[],eventIdentities:{}});
 const key=prefix+'/'+ownerScope+'/setup/status-v1.json',record=legacySetupState(owner),decoded=object.decodeOnline(key,encode(record));
 assert.equal(decoded.kind,'setup-status');assert.deepEqual(decoded.value,record);assert.deepEqual(decoded.scope,{tenantId:owner.tenantId,userHash:digest(owner.userId)});
 assert.equal(object.decodeOnline(key,null).value,null);
 assert.throws(()=>object.decodeOnline(key.replace(digest(owner.userId),digest('other-user')),encode(record)),/differs from its owner/);
 assert.throws(()=>object.decodeOnline(key,encode({...record,scope:{...owner,tenantId:'org_foreign'}})),/another installation organization/);
 assert.throws(()=>object.decodeOnline(key,Buffer.alloc(256*1024+1)),/exceeds/);
 assert.throws(()=>object.decodeOnline(key,encode({...record,unexpected:true})));
});

test('Setup transaction seam refuses hash ambiguity and foreign owner before a write', async () => {
 const state=createSetupState({namespace:'fixture'}),record=legacySetupState(owner),scope={tenantId:owner.tenantId,userHash:digest(owner.userId)};let writes=0;
 const client={query:async()=>{writes++;return {rows:[]};}};
 await assert.rejects(state.projectIn(client,{...scope,userHash:digest('another')},record),/owner differs/);
 await assert.rejects(state.projectIn(client,{...scope,tenantId:'org_other'},record),/owner differs/);assert.equal(writes,0);
 await assert.rejects(state.readProjectionIn({query:async()=>({rows:[{},{}]})},scope),/Ambiguous/);
 await assert.rejects(state.readProjectionIn({query:async()=>({rows:[{record,revision:randomUUID(),user_id:'user_other'}]})},scope),/owner differs/);
});

live('Setup typed projection preserves upstream evidence, rolls back update/deletion and detects independent target drift',async t=>{
 const f=await fixture(t),state=createSetupState(f.database),key=prefix+'/'+ownerScope+'/setup/status-v1.json',record=legacySetupState(owner);
 const otherUser={...owner,userId:'user_other'},otherTenant={...owner,tenantId:'org_other'};
 await state.save(otherUser,null,legacySetupState(otherUser));await state.save(otherTenant,null,legacySetupState(otherTenant));
 await f.baseline(key,record);assert.deepEqual((await state.read(owner)).record,record);
 const updated=structuredClone(record);updated.installations[0].clients[0].historyProgress.completed=4;updated.installations[0].clients[0].historyProgress.total=4;
 await f.put(key,updated);
 await assert.rejects(f.journal.replayPage({consumer:'typed',apply:async(c,i)=>{await f.projection.apply(c,i);throw Error('setup-update-rollback');}}),/setup-update-rollback/);
 assert.deepEqual((await state.read(owner)).record,record);assert.equal(await f.journal.replayCheckpoint('typed'),null);
 await f.replay();assert.deepEqual((await state.read(owner)).record,updated);
 const snapshot=await f.store.read(key),inspect=()=>f.database.transaction(c=>f.projection.inspectIn(c,{key,bytes:encode(updated),revision:'1',operationId:snapshot.operationId,version:snapshot.version}));
 assert.equal(await inspect(),true);const row=await state.read(owner),drift=structuredClone(updated);drift.firstWin={installationId:'setup-installation',client:'codex',verifiedAt:date};
 await state.save(owner,row.version,drift);assert.equal(await inspect(),false);
 await state.save(owner,(await state.read(owner)).version,updated);assert.equal(await inspect(),true);
 await f.del(key);
 await assert.rejects(f.journal.replayPage({consumer:'typed',apply:async(c,i)=>{await f.projection.apply(c,i);throw Error('setup-delete-rollback');}}),/setup-delete-rollback/);
 assert.deepEqual((await state.read(owner)).record,updated);assert.equal(await f.journal.replayCheckpoint('typed'),'1');
 await f.replay();assert.equal((await state.read(owner)).record,null);assert.equal(await f.journal.replayCheckpoint('typed'),'2');
 assert.deepEqual((await state.read(otherUser)).record,legacySetupState(otherUser));assert.deepEqual((await state.read(otherTenant)).record,legacySetupState(otherTenant));
 const deleted=await f.store.read(key);assert.equal(await f.database.transaction(c=>f.projection.inspectIn(c,{key,bytes:null,revision:'2',operationId:deleted.operationId,version:deleted.version})),true);
});
