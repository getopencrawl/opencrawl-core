import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createOnlineJournal} from '../dist/src/state/online-journal.mjs';
import {createOnlineTypedShadow} from '../dist/src/state/online-typed-shadow.mjs';
import {createOnlineMigrationController} from '../dist/src/state/online-temporal/controller.mjs';
import {onlineMigrationReference} from '../dist/src/state/online-temporal/binding.mjs';
import {createValueReports} from '../dist/src/state/value-reports.mjs';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex'),encode=x=>Buffer.from(JSON.stringify(x)),signal=()=>new AbortController().signal;
const tenant='org_typed',prefix='sessions',key=prefix+'/value/tenants/'+hash(tenant)+'.json',derived=prefix+'/_index/'+hash('realm')+'/'+hash('namespace')+'/batches/'+hash('source')+'.json';
const raw=prefix+'/tenants/'+hash(tenant)+'/users/'+hash('user')+'/attachments/'+hash('attachment');
const binding=()=>({epoch:randomUUID(),sourceId:hash('source'),targetId:hash('target'),shards:1});
function external(){
 const objects=new Map(),reads=[],writes=[];
 const store={read:async key=>{reads.push(key);const value=objects.get(key);return value?{...value,bytes:value.bytes===null?null:Buffer.from(value.bytes)}:{version:null,operationId:null,revision:null,deleted:true,bytes:null,contentType:null};},putIfVersion:async(key,version,mutation)=>{writes.push(key);if((objects.get(key)?.version??null)!==version)return false;objects.set(key,{version:mutation.operationId,operationId:mutation.operationId,revision:mutation.revision,deleted:false,bytes:Buffer.from(mutation.bytes),contentType:mutation.contentType});return true;},deleteIfVersion:async(key,version,mutation)=>{writes.push(key);if((objects.get(key)?.version??null)!==version)return false;objects.set(key,{version:mutation.operationId,operationId:mutation.operationId,revision:mutation.revision,deleted:true,bytes:null,contentType:null});return true;}};
 const listing={listPage:async({prefix,cursor,limit})=>{const all=[...objects.keys()].filter(k=>k.startsWith(prefix)&&(!cursor||Buffer.compare(Buffer.from(k),Buffer.from(cursor))>0)).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))),keys=all.slice(0,limit);return {keys,cursor:all.length>limit?keys.at(-1):null};}};
 const seed=(key,value)=>objects.set(key,{version:'legacy-'+hash(key),operationId:null,revision:null,deleted:false,bytes:Buffer.isBuffer(value)?Buffer.from(value):encode(value),contentType:'application/json'});
 return {objects,reads,writes,store,listing,seed};
}
function options(database,b,journal,source){return {database,binding:b,journal,external:source.store,physicalListing:source.listing,assertCurrent:async()=>{},prefix,tenantIds:[tenant],store:{bucket:'synthetic',get:()=>assert.fail('offline source port must not be read')},registryRecords:[],eventIdentities:{},enrollment:{verifierId:'fixture',initialReceiptHash:hash('reviewed'),verify:async request=>({tenantId:request.tenantId,receiptHash:hash('verified')})}};}
function pure(retireDerived){const database={namespace:'fixture',pool:{connect:()=>assert.fail('No SQL'),query:()=>assert.fail('No SQL')}},b=binding(),source=external(),journal={binding:{namespace:database.namespace,epoch:b.epoch,sourceId:b.sourceId},backfillIfUnchanged:()=>assert.fail('No key gate for unsupported state')};return {source,b,journal,config:{...options(database,b,journal,source),...(retireDerived?{retireDerived:true}:{})}};}
test('typed coordinator exposes exact retained/retired/immutable dispositions and blocks unsupported domains before source reads',async()=>{
 const f=pure(false),shadow=createOnlineTypedShadow(f.config);assert.equal(shadow.mode,'background-observation-only');assert.equal(shadow.disposition(key).kind,'retained');assert.equal(shadow.disposition(derived).kind,'blocked');assert.deepEqual(shadow.disposition(raw),{kind:'immutable'});
 await assert.rejects(shadow.backfill(derived),/UNSUPPORTED_DOMAIN_session-indexing/);await assert.rejects(shadow.backfill(prefix+'/unknown/state.json'));assert.deepEqual(await shadow.backfill(raw),{applied:false});assert.equal(f.source.reads.length,0);
 const retired=createOnlineTypedShadow(pure(true).config);assert.equal(retired.disposition(derived).kind,'retired');assert.equal(retired.disposition(derived).scopeHash.length,64);
 assert.throws(()=>createOnlineTypedShadow({...f.config,retireDerived:false}),/INVALID_RETIREMENT_POLICY/);
});
test('typed coordinator rejects a foreign journal and freezes caller binding before any effect',()=>{
 const f=pure();assert.throws(()=>createOnlineTypedShadow({...f.config,journal:{...f.journal,binding:{...f.journal.binding,namespace:'other'}}}),/journal binding/);
 const shadow=createOnlineTypedShadow(f.config),before=shadow.bindingId;f.b.shards=256;f.b.sourceId=hash('changed');assert.equal(shadow.bindingId,before);assert.equal(shadow.disposition(key).kind,'retained');
});
test('cross-shard parity waits for lagging checkpoints but treats an advanced consumer as drift',async()=>{
 const f=pure(),calls=[];f.b.shards=2;let checkpoints=[null,'1'];f.journal.replayCheckpoint=async consumer=>{calls.push(consumer);return checkpoints[Number(consumer.at(-1))];};f.journal.frontierState=async()=>({allocated:'2',closed:'2',pending:false});const shadow=createOnlineTypedShadow(f.config),input={shard:0,shards:2,cursor:null,through:'1',limit:1,signal:signal()};
 assert.deepEqual(await shadow.adapter.parityPage(input),{cursor:null,processed:0,mismatches:0,drift:true});assert.equal(f.source.reads.length,0);
 checkpoints=['2','2'];assert.deepEqual(await shadow.adapter.parityPage(input),{cursor:null,processed:0,mismatches:0,drift:true});assert.equal(calls.length,4,'two peers checked, then own advanced checkpoint reports drift');
});
test('typed replay refuses unexpected raw journal entries before source or typed effects',async()=>{
 const f=pure(),shadow=createOnlineTypedShadow(f.config);let committed=false;
 f.journal.replayPage=async input=>{await input.apply({}, {key:raw});committed=true;return {checkpoint:'1',applied:1,notApplied:0,pending:false};};
 await assert.rejects(shadow.adapter.replayPage({consumer:shadow.bindingId+'-0',shard:0,shards:1,through:'1',limit:1,signal:signal()}),{code:'ONLINE_MIGRATION_UNSAFE'});
 assert.equal(committed,false);assert.equal(f.source.reads.length,0);
});
const live=(name,run)=>test(name,{skip:!postgresUrl},run);
async function fixture(t,{retireDerived=false,shards=1,preserveNative=false}={}){
 const database=await applicationDatabaseFixture(t,{max:8}),b={...binding(),shards},source=external(),journal=createOnlineJournal({database,epoch:b.epoch,sourceId:b.sourceId}),config={...options(database,b,journal,source),...(retireDerived?{retireDerived:true}:{})};
 if(preserveNative){const nativeBinding={applicationNamespace:database.namespace,databaseId:randomUUID(),namespace:'synthetic',bucket:'synthetic',sourceContractHash:hash('native source contract'),verifierId:'native-metadata-fixture'};config.preservedEventIdentities={binding:nativeBinding,verify:async()=>({binding:{...nativeBinding},metadataOnly:true,historicalBodiesRead:false,eventRowsCounted:false,rowsWritten:false})};config.coverage={authority:{namespace:database.namespace,epoch:b.epoch,protocol:'envelope-v1',enrollmentReceiptHash:hash('source enrollment')},policyHash:hash('explicit native policy')};}
 const shadow=createOnlineTypedShadow(config);await shadow.ready();
 const put=(key,value)=>journal.mutate({operationId:randomUUID(),key,mutation:{kind:'put',bytes:Buffer.isBuffer(value)?value:encode(value),contentType:'application/json'}},source.store),del=key=>journal.mutate({operationId:randomUUID(),key,mutation:{kind:'delete'}},source.store);
 const replay=async(through)=>{through??=await journal.closedFrontier();for(let shard=0;shard<b.shards;shard++)for(let n=0;n<100;n++){const page=await shadow.adapter.replayPage({consumer:shadow.bindingId+'-'+shard,shard,shards:b.shards,through,limit:64,signal:signal()});if(page.checkpoint===through)break;if(n===99)assert.fail('replay did not finish');}return through;};
 const mirror=async key=>(await database.pool.query('SELECT payload,revision::text,logical_deleted FROM opencrawl_online_shadow_objects WHERE namespace=$1 AND source_key=$2',[database.namespace,key])).rows[0]??null;
 return {database,b,source,journal,config,shadow,put,del,replay,mirror,reports:createValueReports(database)};
}
async function backfillAll(f,limit=2){for(let shard=0;shard<f.b.shards;shard++){let cursor=null;for(let n=0;n<100;n++){const page=await f.shadow.adapter.backfillPage({shard,shards:f.b.shards,cursor,limit,signal:signal()});cursor=page.cursor;if(cursor===null)break;if(n===99)assert.fail('backfill did not finish');}}}
async function parityAll(f,through,limit=2){let mismatches=0;for(let shard=0;shard<f.b.shards;shard++){let cursor=null;for(let n=0;n<100;n++){const page=await f.shadow.adapter.parityPage({shard,shards:f.b.shards,cursor,through,limit,signal:signal()});mismatches+=page.mismatches;if(page.drift)return {mismatches,drift:true};cursor=page.cursor;if(cursor===null)break;if(n===99)assert.fail('parity did not finish');}}return {mismatches,drift:false};}
live('byte mirror, typed values, heads and replay checkpoint commit or roll back on the same real client',async t=>{
 const f=await fixture(t);f.source.seed(key,{report:'baseline'});await backfillAll(f);assert.deepEqual(await f.reports.exportReport(hash(tenant)),{report:'baseline'});assert.equal((await f.mirror(key)).revision,'0');
 await f.put(key,{report:'next'});await assert.rejects(f.journal.replayPage({consumer:f.shadow.bindingId+'-0',apply:async(c,i)=>{await f.shadow.applyJournal(c,i);throw Error('after both projections');}}),/after both/);
 assert.deepEqual(await f.reports.exportReport(hash(tenant)),{report:'baseline'});assert.equal((await f.mirror(key)).payload.toString(),JSON.stringify({report:'baseline'}));assert.equal(await f.journal.replayCheckpoint(f.shadow.bindingId+'-0'),null);
 const through=await f.replay();assert.deepEqual(await parityAll(f,through),{mismatches:0,drift:false});assert.deepEqual(await f.reports.exportReport(hash(tenant)),{report:'next'});
 await f.del(key);await f.replay();assert.equal(await f.reports.exportReport(hash(tenant)),null);assert.equal((await f.mirror(key)).logical_deleted,true);assert.deepEqual(await parityAll(f,'2'),{mismatches:0,drift:false});
});
live('typed owner rejection rolls mirror back too, even when a valid journal source mutation exists',async t=>{
 const f=await fixture(t),id=hash('token'),credentialKey=prefix+'/_credentials/'+id+'.json',value={schemaVersion:1,id,principal:{tenantId:tenant,userId:'user_fixture'},expiresAt:'2099-01-01T00:00:00.000Z',revoked:false,generation:hash('generation')};f.source.seed(credentialKey,value);await backfillAll(f);await f.del(credentialKey);await f.replay();
 await f.put(credentialKey,value);await assert.rejects(f.replay(),/deleted security identity/);assert.equal((await f.mirror(credentialKey)).logical_deleted,true);assert.equal(await f.journal.replayCheckpoint(f.shadow.bindingId+'-0'),'1');
});
live('baseline source READ and both projections stay inside the journal key gate while a concurrent writer waits',async t=>{
 const f=await fixture(t);f.source.seed(key,{report:'old'});const entered=Promise.withResolvers(),release=Promise.withResolvers(),original=f.source.store.read;let first=true;
 f.source.store.read=async(k,o)=>{if(first){first=false;entered.resolve();await release.promise;}return original(k,o);};const baseline=f.shadow.backfill(key);await entered.promise;const mutation=f.put(key,{report:'new'});let waiting=false;for(let n=0;n<100&&!waiting;n++){waiting=(await f.database.pool.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted LIMIT 1")).rows.length>0;if(!waiting)await new Promise(resolve=>setTimeout(resolve,5));}assert.equal(waiting,true,'writer is waiting for the held database key gate');assert.equal(f.source.writes.length,0);release.resolve();await baseline;await mutation;await f.replay();assert.deepEqual(await f.reports.exportReport(hash(tenant)),{report:'new'});assert.equal((await f.mirror(key)).revision,'1');
});
live('independent typed parity detects target drift despite byte-identical mirror, and target-only heads cannot disappear from coverage',async t=>{
 const f=await fixture(t);f.source.seed(key,{report:'source'});await backfillAll(f);await f.replay('0');
 await f.database.pool.query("UPDATE opencrawl_value_reports SET report='{\"report\":\"tampered\"}' WHERE namespace=$1",[f.database.namespace]);assert.ok((await parityAll(f,'0')).mismatches>0);assert.equal((await f.mirror(key)).payload.toString(),JSON.stringify({report:'source'}));
 await f.database.pool.query('DELETE FROM opencrawl_online_shadow_objects WHERE namespace=$1',[f.database.namespace]);f.source.objects.delete(key);assert.ok((await parityAll(f,'0')).mismatches>0,'typed head still supplies target-side key coverage');
});
live('explicit derived retirement never reads historical bodies; complete pass markers detect omissions and retain tombstones',async t=>{
 const f=await fixture(t,{retireDerived:true});f.source.seed(derived,Buffer.from('malformed intentionally unread'));f.source.seed(key,{report:'retained'});f.source.seed(raw,Buffer.from('raw'));await backfillAll(f);assert.equal(f.source.reads.includes(derived),false);assert.equal(f.source.reads.includes(raw),false);assert.equal(await f.mirror(derived),null);
 await f.replay('0');assert.deepEqual(await parityAll(f,'0'),{mismatches:0,drift:false});assert.equal(f.source.reads.includes(derived),false);
 const baseline=(await f.database.pool.query('SELECT source_hash,source_version,source_bytes,disposition FROM opencrawl_online_retirements WHERE namespace=$1',[f.database.namespace])).rows[0];assert.deepEqual(baseline,{source_hash:null,source_version:null,source_bytes:null,disposition:'full-current-session-catchup'});
 f.source.objects.delete(derived);assert.ok((await parityAll(f,'0')).mismatches>0,'a prior pass marker cannot certify an omitted current key');
 f.source.seed(derived,Buffer.from('unread'));await f.del(derived);await f.replay();f.source.reads.length=0;assert.deepEqual(await parityAll(f,'1'),{mismatches:0,drift:false});assert.equal(f.source.reads.includes(derived),false);assert.equal((await f.database.pool.query('SELECT deleted FROM opencrawl_online_retirements WHERE namespace=$1',[f.database.namespace])).rows[0].deleted,true);
 const changed=createOnlineTypedShadow({...f.config,retireDerived:undefined});await assert.rejects(changed.ready(),/Online shadow scope/);
});
live('mutation between live parity pages invalidates observation rather than granting readiness',async t=>{
 const f=await fixture(t);for(const name of ['org_typed','org_second']){if(name!==tenant)await f.shadow.enrollTenant({tenantId:name,evidence:'fixture'});f.source.seed(prefix+'/value/tenants/'+hash(name)+'.json',{report:name});}await backfillAll(f);await f.replay('0');
 const first=await f.shadow.adapter.parityPage({shard:0,shards:1,cursor:null,through:'0',limit:1,signal:signal()});assert.ok(first.cursor);await f.put(key,{report:'concurrent'});
 assert.deepEqual(await f.shadow.adapter.parityPage({shard:0,shards:1,cursor:first.cursor,through:'0',limit:1,signal:signal()}),{cursor:null,processed:0,mismatches:0,drift:true});await f.replay();assert.deepEqual(await parityAll(f,'1'),{mismatches:0,drift:false});assert.equal((await f.database.pool.query('SELECT count(*)::int n FROM opencrawl_application_installations WHERE namespace=$1',[f.database.namespace])).rows[0].n,0);
});
live('cross-shard alias references wait for all replay consumers, then verify canonical relationships',async t=>{
 const f=await fixture(t,{shards:2}),organizationId=randomUUID(),canonical=prefix+'/identity/replicas-v1/organizations/'+organizationId+'.json',alias=prefix+'/identity/replicas-v1/tenants/'+hash(tenant)+'/'+organizationId+'.json';
 f.source.seed(alias,{organizationId});f.source.seed(canonical,{schemaVersion:1,organizationId,tenantId:tenant,approvedBy:'user_fixture',approvedAt:'2026-11-16T00:00:00.000Z',revokedAt:null,installations:[]});await backfillAll(f);await f.replay('0');assert.deepEqual(await parityAll(f,'0'),{mismatches:0,drift:false});
 await f.del(canonical);await f.replay();assert.ok((await parityAll(f,'1')).mismatches>0);await f.del(alias);await f.replay();assert.deepEqual(await parityAll(f,'2'),{mismatches:0,drift:false});
});

live('unexpected raw journal records roll back typed replay and preserve its durable consumer checkpoint',async t=>{
 const f=await fixture(t);await f.replay('0');await f.put(raw,Buffer.from('raw publication must use the raw adapter'));
 const through=await f.journal.closedFrontier();await assert.rejects(f.replay(through),{code:'ONLINE_MIGRATION_UNSAFE'});
 assert.equal(await f.journal.replayCheckpoint(f.shadow.bindingId+'-0'),'0');assert.equal(await f.mirror(raw),null);
});

const nativeMarker=owner=>prefix+'/tenants/'+hash(owner)+'/users/'+hash('user')+'/codex/'+hash('session')+'/'+hash('directory')+'/event-identities-v1.json';
function nativeConfig(f){const binding={applicationNamespace:f.config.database.namespace,databaseId:randomUUID(),namespace:'synthetic',bucket:'synthetic',sourceContractHash:hash('native contract'),verifierId:'native-fixture'};return {...f.config,preservedEventIdentities:{binding,verify:async()=>({binding:{...binding},metadataOnly:true,historicalBodiesRead:false,eventRowsCounted:false,rowsWritten:false})},coverage:{authority:{namespace:f.config.database.namespace,epoch:f.b.epoch,protocol:'envelope-v1',enrollmentReceiptHash:hash('enrollment')},policyHash:hash('policy')}};}
test('native adoption is explicit and exact metadata proof mismatches fail before body, key gate or SQL',async()=>{
 const f=pure(),config=nativeConfig(f),shadow=createOnlineTypedShadow(config),selected=shadow.disposition(nativeMarker(tenant));
 assert.equal(selected.kind,'preserved-native');assert.equal(selected.nativeBindingHash.length,64);assert.equal(createOnlineTypedShadow(f.config).disposition(nativeMarker(tenant)).kind,'blocked');
 assert.throws(()=>createOnlineTypedShadow({...config,coverage:undefined}),/INVALID_NATIVE_BINDING/);
 assert.throws(()=>createOnlineTypedShadow({...config,preservedEventIdentities:{...config.preservedEventIdentities,binding:{...config.preservedEventIdentities.binding,bucket:'foreign'}}}),/INVALID_NATIVE_BINDING/);
 for(const change of [{eventRowsCounted:true},{historicalBodiesRead:true},{rowsWritten:true},{binding:{...config.preservedEventIdentities.binding,databaseId:randomUUID()}},{extra:true}]){
  const original=await config.preservedEventIdentities.verify(),bad=createOnlineTypedShadow({...config,preservedEventIdentities:{...config.preservedEventIdentities,verify:async()=>({...original,...change})}});await assert.rejects(bad.backfill(nativeMarker(tenant)),/NATIVE_METADATA_MISMATCH/);
 }
 assert.deepEqual(f.source.reads,[]);
});
live('native marker baseline and parity preserve existing ledger metadata with zero body reads, mirrors or rebuild obligations',async t=>{
 const f=await fixture(t,{preserveNative:true}),marker=nativeMarker(tenant);f.source.seed(marker,Buffer.from('not parsed historical bytes'));await backfillAll(f);await f.replay('0');assert.deepEqual(await parityAll(f,'0'),{mismatches:0,drift:false});assert.equal(f.source.reads.includes(marker),false);assert.equal(await f.mirror(marker),null);
 const row=(await f.database.pool.query('SELECT kind,native_binding_hash,source_hash,source_bytes,source_version,target_hash,target_key,revision::text FROM opencrawl_online_coverage_certificates WHERE namespace=$1 AND source_key=$2',[f.database.namespace,marker])).rows[0];
 assert.deepEqual(row,{kind:'preserved-native',native_binding_hash:f.shadow.objectPolicy.nativeBindingHash,source_hash:null,source_bytes:null,source_version:null,target_hash:null,target_key:null,revision:'0'});
 assert.equal((await f.database.pool.query("SELECT 1 FROM opencrawl_online_projection_heads WHERE namespace=$1 AND source_key=$2",[f.database.namespace,marker])).rows.length,0);
 const restarted=createOnlineTypedShadow(f.config);await restarted.ready();await restarted.adapter.backfillPage({shard:0,shards:1,cursor:null,limit:2,signal:signal()});assert.equal(f.source.reads.length,0);
 await f.database.pool.query('UPDATE opencrawl_online_coverage_certificates SET native_binding_hash=$3 WHERE namespace=$1 AND source_key=$2',[f.database.namespace,marker,hash('forged binding')]);await assert.rejects(parityAll(f,'0'),/CERTIFICATE_CHANGED/);await f.database.pool.query('UPDATE opencrawl_online_coverage_certificates SET native_binding_hash=$3 WHERE namespace=$1 AND source_key=$2',[f.database.namespace,marker,f.shadow.objectPolicy.nativeBindingHash]);
 f.source.objects.delete(marker);assert.ok((await parityAll(f,'0')).mismatches>0,'complete native key coverage cannot ignore a later missing physical marker');
 const changed=createOnlineTypedShadow({...f.config,preservedEventIdentities:{...f.config.preservedEventIdentities,binding:{...f.config.preservedEventIdentities.binding,verifierId:'different verifier'},verify:async()=>({...await f.config.preservedEventIdentities.verify(),binding:{...f.config.preservedEventIdentities.binding,verifierId:'different verifier'}})}});await assert.rejects(changed.ready());
});
live('native owner mismatch cannot become covered',async t=>{
 const f=await fixture(t,{preserveNative:true}),foreign=nativeMarker('org_foreign');f.source.seed(foreign,{});await assert.rejects(backfillAll(f),/NATIVE_OWNER_MISMATCH/);assert.equal(f.source.reads.length,0);assert.equal((await f.shadow.coverage.status()).traversalComplete,false);
});
live('unexpected native marker mutation is rejected by typed replay and pending reconciliation without further external dispatch',async t=>{
 const f=await fixture(t,{preserveNative:true}),marker=nativeMarker(tenant);f.source.seed(marker,{});await backfillAll(f);await f.replay('0');await f.put(marker,{unexpected:'legacy writer'});f.source.reads.length=0;
 await assert.rejects(f.replay(),{code:'ONLINE_MIGRATION_UNSAFE'});assert.equal(await f.journal.replayCheckpoint(f.shadow.bindingId+'-0'),'0');assert.equal(f.source.reads.length,0);
 const other=marker.replace(hash('session'),hash('pending-session')),original=f.source.store.putIfVersion;f.source.store.putIfVersion=async()=>{throw Error('uncertain provider response');};await assert.rejects(f.put(other,{}));f.source.store.putIfVersion=original;f.source.reads.length=0;
 await assert.rejects(f.shadow.adapter.reconcilePending({cursor:null,limit:1,signal:signal()}),{code:'ONLINE_MIGRATION_UNSAFE'});assert.equal(f.source.reads.length,0);
});
