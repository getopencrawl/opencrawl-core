import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createApplicationDatabase} from '../dist/src/state/postgres.mjs';
import {createOnlineConnectionScopePins,normalizeOnlineConnectionScope,bindOnlineConnectionScopeReader} from '../dist/src/state/online-connection-scopes.mjs';
import {createOnlineProjection} from '../dist/src/state/online-projection.mjs';
import {createOnlineRetirements} from '../dist/src/state/online-retirements.mjs';
import {createOnlineJournal} from '../dist/src/state/online-journal.mjs';
import {createPostgresSlackCapture} from '../dist/src/state/slack-capture.mjs';
import {digest} from '../dist/src/connectors/scope.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex'),encode=x=>Buffer.from(JSON.stringify(x)),epoch=randomUUID(),namespace='scope-test',sourceId='s3:'+sha('source'),bucket='scope-bucket',connectionId='int_'+'a'.repeat(26);
const route=(change={})=>({environment:'production',tenantId:'org_scope',userId:'user_scope',connectionId,provider:'slack',bucket,prefix:'raw/v1/source=slack/workspace=T1/connection='+connectionId,workspace:'T1',...change});
const binding=(ns=namespace,ep=epoch)=>({namespace:ns,epoch:ep,verifierId:'registry-owner-v1',bindingHash:sha('immutable-registry-owner')});
const selector=id=>({bucket,connectionId:id}),countKey=id=>'_opencrawl/counts/connection='+id+'.json.gz';
const key=r=>r.prefix+'/capture/messages-v1/catalog.json',slackBinding=r=>({tenantId:r.tenantId,connectionId:r.connectionId,workspaceId:r.workspace,provider:'slack',access:'team-public',rawPrefix:r.prefix+'/'}),body=r=>encode({scope:digest(slackBinding(r)),channels:['C1']});

test('connection reader contract rejects secret fields and wrong immutable authority before SQL',()=>{
 const r=route();assert.deepEqual(normalizeOnlineConnectionScope(r),r);
 for(const change of [{secret:'do-not-store'},{tenantId:'org_other/bad'},{userId:'not-user'},{environment:'other'},{prefix:'raw/../route'},{workspace:undefined},{provider:'provider with space'}])assert.throws(()=>normalizeOnlineConnectionScope({...r,...change}));
 const readIn=async()=>[r],reader={binding:binding(),readIn};const bound=bindOnlineConnectionScopeReader(reader,namespace,epoch);reader.binding.verifierId='mutated';reader.readIn=()=>assert.fail('replaced callback');assert.equal(bound.binding.verifierId,'registry-owner-v1');assert.notEqual(bound.readIn,reader.readIn);
 for(const change of [{namespace:'wrong'},{epoch:randomUUID()},{bindingHash:'bad'}])assert.throws(()=>bindOnlineConnectionScopeReader({binding:{...binding(),...change},readIn},namespace,epoch));
});
test('unknown, ambiguous, foreign, or unenrolled routing performs no SQL effects',async()=>{
 const client={query:()=>assert.fail('no SQL after rejected reader')},database={namespace},r=route();
 for(const matches of [[],[r,r],[{...r,bucket:'other'}],[{...r,connectionId:'int_other'}]]){
  const pins=createOnlineConnectionScopePins({database,epoch,sourceId,bucket,reader:{binding:binding(),readIn:async(c,q)=>{assert.equal(c,client);assert.deepEqual(q,selector(connectionId));return matches;}},hasTenantIn:async()=>true});
  await assert.rejects(pins.resolveIn(client,{key:countKey(connectionId),lookup:selector(connectionId),write:true}),{code:'ONLINE_CONNECTION_SCOPE_INVALID'});
 }
 const pins=createOnlineConnectionScopePins({database,epoch,sourceId,bucket,reader:{binding:binding(),readIn:async()=>[r]},hasTenantIn:async()=>false});await assert.rejects(pins.resolveIn(client,{key:countKey(connectionId),lookup:selector(connectionId),write:true}),/enrolled owner/);
});
const url=process.env.OPENCRAWL_TEST_POSTGRES_URL,live=(name,fn)=>test(name,{skip:!url},fn);
async function fixture(t){
 const schema='oc_scope_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url,max:1});await admin.query('CREATE SCHEMA '+schema);
 const database=createApplicationDatabase({connectionString:url,namespace:schema,max:6,options:'-c search_path='+schema}),ep=randomUUID(),journal=createOnlineJournal({database,epoch:ep,sourceId});
 t.after(async()=>{await database.close();const c=await admin.connect();try{await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:identity-schema:maintenance',0))");await c.query('DROP SCHEMA '+schema+' CASCADE');if((await c.query('SELECT to_regnamespace($1) AS value',[database.identitySchema])).rows[0].value)await c.query('DROP SCHEMA '+database.identitySchema+' CASCADE');await c.query('COMMIT');}finally{c.release();await admin.end();}});
 await journal.ready();let current=route();const historical=new Map([[current.prefix,current]]),seen=[],tenants=new Set(['org_scope']);
 const reader={binding:binding(schema,ep),readIn:async(client,lookup)=>{assert.equal((await client.query('SELECT current_schema() AS value')).rows[0].value,schema);seen.push(client);return 'prefix' in lookup?[historical.get(lookup.prefix)].filter(Boolean):current&&current.connectionId===lookup.connectionId?[current]:[];}};
 const pins=createOnlineConnectionScopePins({database,epoch:ep,sourceId,bucket,reader,hasTenantIn:async(_c,tenant)=>tenants.has(tenant)});await pins.ready();
 const objects=new Map(),external={read:async k=>objects.get(k)??{version:null,operationId:null,revision:null,deleted:true,bytes:null,contentType:null},putIfVersion:async(k,v,m)=>{if((objects.get(k)?.version??null)!==v)return false;objects.set(k,{version:m.operationId,operationId:m.operationId,revision:m.revision,deleted:false,bytes:Buffer.from(m.bytes),contentType:m.contentType});return true;},deleteIfVersion:async(k,v,m)=>{if((objects.get(k)?.version??null)!==v)return false;objects.set(k,{version:m.operationId,operationId:m.operationId,revision:m.revision,deleted:true,bytes:null,contentType:null});return true;}};
 return {database,epoch:ep,journal,pins,reader,seen,tenants,historical,objects,external,current:()=>current,set:value=>{current=value;if(value)historical.set(value.prefix,value);}};
}
live('logical count pins survive reconnect while exact-prefix pins refuse reassignment and rollback atomically',async t=>{
 const f=await fixture(t),r=f.current(),count=countKey(r.connectionId),request={key:count,lookup:selector(r.connectionId),write:true};
 await assert.rejects(f.database.transaction(async c=>{await f.pins.resolveIn(c,request);throw Error('rollback');}),/rollback/);assert.equal((await f.database.pool.query('SELECT count(*)::int AS n FROM opencrawl_online_connection_scope_pins')).rows[0].n,0);
 const first=await f.database.transaction(c=>f.pins.resolveIn(c,request));await f.database.transaction(c=>f.pins.resolveIn(c,{key:key(r),lookup:{bucket,prefix:r.prefix},write:true}));
 const next=route({prefix:r.prefix.replace('workspace=T1','workspace=T2'),workspace:'T2'});f.set(next);
 const resumed=await f.database.transaction(c=>f.pins.resolveIn(c,request));assert.equal(resumed.scopeHash,first.scopeHash);assert.equal(resumed.scope.prefix,next.prefix);
 assert.equal((await f.database.transaction(c=>f.pins.resolveIn(c,{key:key(r),lookup:{bucket,prefix:r.prefix},write:false}))).scope.workspace,'T1');
 f.set({...next,userId:'user_reassigned'});await assert.rejects(f.database.transaction(c=>f.pins.resolveIn(c,request)),/reassigned/);
 f.historical.set(r.prefix,{...r,userId:'user_reassigned'});await assert.rejects(f.database.transaction(c=>f.pins.resolveIn(c,{key:r.prefix+'/capture/messages-v1/new/state.json',lookup:{bucket,prefix:r.prefix},write:true})),/physical prefix was reassigned/);
});
live('Slack accepts new verified connection without fixed registry roster and includes immutable route in parity',async t=>{
 const f=await fixture(t),options={database:f.database,epoch:f.epoch,sourceId,journalBinding:f.journal.binding,prefix:'sessions/production/v1',tenantIds:['org_scope'],store:{bucket,get:()=>assert.fail('no source dependency read')},registryRecords:[],eventIdentities:{},connectionScopes:f.reader,enrollment:{verifierId:'tenant-owner',initialReceiptHash:sha('initial'),verify:async r=>({tenantId:r.tenantId,receiptHash:sha('verified-'+r.tenantId)})}},projection=createOnlineProjection(options);await projection.ready();const identity=projection.binding.bindingHash;
 const fresh=route({tenantId:'org_new',userId:'user_new',connectionId:'int_'+'b'.repeat(26),prefix:'raw/v1/source=slack/workspace=TNEW/connection=int_'+'b'.repeat(26),workspace:'TNEW'});f.set(fresh);const sourceKey=key(fresh);
 await assert.rejects(f.database.transaction(c=>projection.backfill(c,{key:sourceKey,bytes:body(fresh),version:'legacy'})),/enrolled owner/);assert.equal((await f.database.pool.query('SELECT count(*)::int AS n FROM opencrawl_online_connection_scope_pins')).rows[0].n,0);
 await projection.enrollTenant({tenantId:fresh.tenantId,evidence:{verified:true}});assert.equal(projection.binding.bindingHash,identity);
 await f.journal.mutate({operationId:randomUUID(),key:sourceKey,mutation:{kind:'put',bytes:body(fresh),contentType:'application/json'}},f.external);
 await assert.rejects(f.journal.replayPage({consumer:'slack',apply:async(c,i)=>{await projection.apply(c,i);throw Error('checkpoint failed');}}),/checkpoint failed/);
 assert.equal(await f.journal.replayCheckpoint('slack'),null);assert.equal((await f.database.pool.query('SELECT count(*)::int AS n FROM opencrawl_online_connection_scope_pins')).rows[0].n,0);
 await f.journal.replayPage({consumer:'slack',apply:projection.apply});assert.equal(await f.journal.replayCheckpoint('slack'),'1');
 const snapshot=f.objects.get(sourceKey);assert.equal(await f.database.transaction(c=>projection.inspectIn(c,{key:sourceKey,bytes:snapshot.bytes,revision:snapshot.revision,operationId:snapshot.operationId,version:snapshot.version})),true);
 const target=await createPostgresSlackCapture(f.database).exportLegacy(sourceKey,digest(slackBinding(fresh)));assert.deepEqual(target,{scope:digest(slackBinding(fresh)),channels:['C1']});
 const pin=(await f.database.pool.query('SELECT scope_hash FROM opencrawl_online_connection_scope_pins WHERE source_key=$1',[sourceKey])).rows[0].scope_hash;
 const head=(await f.database.pool.query('SELECT target_hash FROM opencrawl_online_projection_heads WHERE source_key=$1',[sourceKey])).rows[0].target_hash;assert.notEqual(head,sha(JSON.stringify(target)));assert.equal(pin.length,64);
 f.historical.set(fresh.prefix,{...fresh,userId:'user_changed'});await assert.rejects(f.database.transaction(c=>projection.inspectIn(c,{key:sourceKey,bytes:snapshot.bytes,revision:snapshot.revision,operationId:snapshot.operationId,version:snapshot.version})),/reassigned/);
});
live('dynamic count retirement stays metadata-only, includes route ownership and retains tombstone obligations',async t=>{
 const f=await fixture(t),repo=createOnlineRetirements({database:f.database,epoch:f.epoch,sourceId,journalBinding:f.journal.binding,source:{bucket,prefix:'sessions/production/v1'},connectionScopes:f.reader,connectionTenantEnrolledIn:async(_c,id)=>f.tenants.has(id)});await repo.ready();const identity=repo.binding.policyHash,k=countKey(connectionId),observation={key:k,...repo.classify(k)};
 await f.journal.backfillIfUnchanged({key:k,apply:c=>repo.backfillIn(c,observation)});const baseline=await f.database.transaction(c=>repo.readIn(c,observation));assert.equal(baseline.sourceBytes,null);assert.equal(baseline.connectionScopeHash.length,64);assert.equal(baseline.disposition,'unavailable-until-count-rebuild');
 f.set(route({prefix:'raw/v1/source=slack/workspace=T2/connection='+connectionId,workspace:'T2'}));assert.equal(repo.binding.policyHash,identity);assert.equal((await f.database.transaction(c=>repo.readIn(c,observation))).connectionScopeHash,baseline.connectionScopeHash);
 const apply=(c,i)=>repo.applyIn(c,i,repo.classify(i.key));await f.journal.mutate({operationId:randomUUID(),key:k,mutation:{kind:'put',bytes:Buffer.from('unparsed gzip cache'),contentType:'application/gzip'}},f.external);await f.journal.replayPage({consumer:'counts',apply});await f.journal.mutate({operationId:randomUUID(),key:k,mutation:{kind:'delete'}},f.external);await f.journal.replayPage({consumer:'counts',apply});
 const deleted=await f.database.transaction(c=>repo.readIn(c,observation));assert.equal(deleted.deleted,true);assert.equal(deleted.connectionScopeHash,baseline.connectionScopeHash);assert.equal(deleted.disposition,'unavailable-until-count-rebuild');assert.equal(await f.database.transaction(c=>repo.inspectIn(c,observation)),true);
 await f.database.pool.query('UPDATE opencrawl_online_retirements SET connection_scope_hash=$1 WHERE source_key=$2',[sha('wrong'),k]);await assert.rejects(f.database.transaction(c=>repo.readIn(c,observation)),/stored connection scope/);
});
live('fixed retirement schema upgrade preserves old rows and fixed-mode hashes',async t=>{
 const f=await fixture(t),r=route(),options={database:f.database,epoch:f.epoch,sourceId,journalBinding:f.journal.binding,source:{bucket,prefix:'sessions/production/v1'},tenantIds:[r.tenantId],registryRecords:[{environment:r.environment,tenantId:r.tenantId,userId:r.userId,integrationId:r.connectionId,s3Bucket:r.bucket,s3Prefix:r.prefix}]},repo=createOnlineRetirements(options);await repo.ready();const k=countKey(connectionId),observed={key:k,...repo.classify(k)};await f.journal.backfillIfUnchanged({key:k,apply:c=>repo.backfillIn(c,observed)});const before=await f.database.transaction(c=>repo.readIn(c,observed));assert.equal(Object.hasOwn(before,'connectionScopeHash'),false);
 await f.database.pool.query('ALTER TABLE opencrawl_online_retirements DROP COLUMN connection_scope_hash');const upgraded=createOnlineRetirements(options);await upgraded.ready();assert.equal(upgraded.binding.policyHash,repo.binding.policyHash);assert.deepEqual(await f.database.transaction(c=>upgraded.readIn(c,observed)),before);
});
