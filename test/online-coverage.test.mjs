import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createOnlineCoverage} from '../dist/src/state/online-coverage.mjs';
import {createOnlineJournal} from '../dist/src/state/online-journal.mjs';
import {createOnlineTypedShadow} from '../dist/src/state/online-typed-shadow.mjs';
import {Pool} from 'pg';
import {createApplicationDatabase} from '../dist/src/state/postgres.mjs';
import {applicationDatabaseFixture,postgresUrl,dropTestSchemas} from './fixtures/application-database.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex'),encode=x=>Buffer.from(JSON.stringify(x)),signal=()=>new AbortController().signal;
const ordered=(a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)),prefix='sessions';
const tenants=Array.from({length:6},(_,i)=>'org_coverage'+i),keys=tenants.map(tenant=>prefix+'/value/tenants/'+hash(tenant)+'.json').sort(ordered);
const policy=(namespace,epoch)=>({authority:{namespace,epoch,protocol:'envelope-v1',enrollmentReceiptHash:hash('actual owning enrollment receipt')},policyHash:hash('reviewed disposition policy')});
const listed=key=>({key,kind:'retained',domain:'value-reports',scopeHash:null});
function pure(){const epoch=randomUUID(),database={namespace:'synthetic',pool:{connect:()=>assert.fail('must reject before SQL')}};const input={database,epoch,sourceId:hash('source'),targetId:hash('target'),shards:2,roots:['root/'],participantIdentity:hash('participant'),policy:policy(database.namespace,epoch)};return {input,coverage:createOnlineCoverage(input)};}
test('coverage freezes exact authority/policy/root binding and rejects mismatched enrollment scope',()=>{
 const f=pure(),identity=f.coverage.identity;f.input.policy.authority.enrollmentReceiptHash=hash('changed');f.input.roots.push('other/');assert.equal(f.coverage.identity,identity);assert.equal(f.coverage.binding.policy.authority.enrollmentReceiptHash,hash('actual owning enrollment receipt'));
 assert.throws(()=>createOnlineCoverage({...f.input,policy:policy('wrong',f.input.epoch)}),{code:'ONLINE_COVERAGE_AUTHORITY_BINDING'});
 assert.throws(()=>createOnlineCoverage({...f.input,roots:['root/','root/nested/']}),{code:'ONLINE_COVERAGE_OVERLAPPING_ROOTS'});
});
test('invalid page bounds, ordering, repeated keys, cursors and source scope reject before SQL',async()=>{
 const {coverage}=pure(),input={shard:0,cursor:null,next:'next',limit:2,entries:[listed('root/a'),listed('root/b')]};
 await assert.rejects(coverage.getPage({shard:2,cursor:null,limit:1}),{code:'ONLINE_COVERAGE_INVALID_PAGE_REQUEST'});
 await assert.rejects(coverage.stagePage({...input,entries:[listed('root/b'),listed('root/a')]}),{code:'ONLINE_COVERAGE_INVALID_PAGE_ENTRIES'});
 await assert.rejects(coverage.stagePage({...input,entries:[listed('root/a'),listed('root/a')]}),{code:'ONLINE_COVERAGE_INVALID_PAGE_ENTRIES'});
 await assert.rejects(coverage.stagePage({...input,entries:[listed('other/a')]}),{code:'ONLINE_COVERAGE_KEY_OUTSIDE_ROOTS'});
 await assert.rejects(coverage.stagePage({...input,cursor:'same',next:'same'}),{code:'ONLINE_COVERAGE_INVALID_NEXT_PAGE'});
});
test('certificates cannot turn a listed retirement into invented bytes or an applied write into baseline',async()=>{
 const {coverage}=pure(),client={query:()=>assert.fail('no SQL')},base={...listed('root/a'),revision:'0',sequence:'0',operationId:null,sourceVersion:null,sourceHash:null,sourceBytes:null,deleted:false,targetKey:'typed',targetHash:hash('target'),absent:false};
 await assert.rejects(coverage.recordIn(client,base),{code:'ONLINE_COVERAGE_MISSING_SOURCE_BYTES'});
 await assert.rejects(coverage.recordIn(client,{...base,kind:'retired',scopeHash:hash('scope'),sourceHash:hash('fake'),sourceBytes:0}),{code:'ONLINE_COVERAGE_INVENTED_RETIRED_BASELINE'});
 await assert.rejects(coverage.recordIn(client,{...base,revision:'1'}),{code:'ONLINE_COVERAGE_INVALID_SOURCE_REVISION'});
 await assert.rejects(coverage.recordIn(client,{...base,absent:true,deleted:true,targetKey:null}),{code:'ONLINE_COVERAGE_INVALID_ABSENCE'});
});
function source(){
 const objects=new Map(),reads=[],lists=[];const store={read:async key=>{reads.push(key);const v=objects.get(key);return v?{...v,bytes:v.bytes===null?null:Buffer.from(v.bytes)}:{version:null,operationId:null,revision:null,deleted:true,bytes:null,contentType:null};},putIfVersion:async(key,version,m)=>{if((objects.get(key)?.version??null)!==version)return false;objects.set(key,{version:m.operationId,operationId:m.operationId,revision:m.revision,deleted:false,bytes:Buffer.from(m.bytes),contentType:m.contentType});return true;},deleteIfVersion:async(key,version,m)=>{if((objects.get(key)?.version??null)!==version)return false;objects.set(key,{version:m.operationId,operationId:m.operationId,revision:m.revision,deleted:true,bytes:null,contentType:null});return true;}};
 const listing={listPage:async({prefix,cursor,limit})=>{lists.push({prefix,cursor,limit});const all=[...objects.keys()].filter(key=>key.startsWith(prefix)&&(!cursor||ordered(key,cursor)>0)).sort(ordered),keys=all.slice(0,limit);return {keys,cursor:all.length>limit?keys.at(-1):null};}};
 return {objects,reads,lists,store,listing,seed(key,value){objects.set(key,{version:'legacy-'+hash(key),operationId:null,revision:null,deleted:false,bytes:encode(value),contentType:'application/json'});}};
}
async function fixture(t,{retireDerived=false,registered=false}={}){
 const database=await applicationDatabaseFixture(t,{max:8}),binding={epoch:randomUUID(),sourceId:hash('source'),targetId:hash('target'),shards:1},external=source(),journal=createOnlineJournal({database,epoch:binding.epoch,sourceId:binding.sourceId});
 const config={database,binding,journal,external:external.store,physicalListing:external.listing,assertCurrent:async()=>{},prefix,tenantIds:tenants,store:{bucket:'coverage-fixture',get:()=>assert.fail('offline source must not run')},registryRecords:[],eventIdentities:{},enrollment:{verifierId:'fixture',initialReceiptHash:hash('tenant inventory'),verify:async request=>({tenantId:request.tenantId,receiptHash:hash('verified')})},coverage:policy(database.namespace,binding.epoch),...(retireDerived?{retireDerived:true}:{})};
 if(registered){config.sourceRegistration={bindingHash:hash('registered source'),enrollmentReceiptHash:hash('source enrollment')};await journal.prepareSchema();await journal.registerSource(config.sourceRegistration);}
 const shadow=createOnlineTypedShadow(config);await shadow.ready();
 const page=cursor=>shadow.adapter.backfillPage({cursor,shard:0,shards:1,limit:1,signal:signal()});
 const put=(key,value)=>journal.mutate({operationId:randomUUID(),key,mutation:{kind:'put',bytes:encode(value),contentType:'application/json'}},external.store),del=key=>journal.mutate({operationId:randomUUID(),key,mutation:{kind:'delete'}},external.store);
 const replay=async()=>{const through=await journal.closedFrontier();for(let i=0;i<100;i++){const result=await shadow.adapter.replayPage({consumer:shadow.bindingId+'-0',shard:0,shards:1,through,limit:64,signal:signal()});if(result.checkpoint===through)return through;}assert.fail('unbounded replay');};
 const cert=async key=>(await database.pool.query('SELECT revision::text,source_sequence::text,operation_id,source_version,source_hash,source_bytes,deleted,target_hash,absent FROM opencrawl_online_coverage_certificates WHERE namespace=$1 AND source_key=$2',[database.namespace,key])).rows[0]??null;
 const walk=async cursor=>{for(let i=0;i<100;i++){const result=await page(cursor);if(result.cursor===null)return result;cursor=result.cursor;}assert.fail('unbounded traversal');};
 return {database,binding,journal,external,config,shadow,page,walk,put,del,replay,cert};
}
const live=(name,fn)=>test(name,{skip:!postgresUrl},fn);
function failQueryOnce(t,pool,pattern){
 const original=pool.connect,connect=original.bind(pool);let armed=true;
 function wrap(client){const query=client.query,release=client.release;client.query=function(...args){if(armed&&pattern.test(typeof args[0]==='string'?args[0]:args[0].text)){armed=false;return Promise.reject(new Error('injected coverage interruption'));}return query.apply(this,args);};client.release=function(...args){client.query=query;client.release=release;return release.apply(this,args);};return client;}
 pool.connect=function(callback){if(typeof callback==='function')return connect((error,client)=>{if(error)return callback(error);wrap(client);callback(null,client,client.release);});return connect().then(wrap);};
 const restore=()=>{pool.connect=original;};t.after(restore);return restore;
}
live('lost completed page response restarts from retained page, never a changed live page or duplicate count',async t=>{
 const f=await fixture(t);f.external.seed(keys[1],{n:1});f.external.seed(keys[4],{n:4});const first=await f.page(null),before=await f.shadow.coverage.status(),calls=f.external.lists.length;assert.notEqual(first.cursor,null);
 await f.put(keys[0],{createdBehindCursor:true});const restarted=createOnlineTypedShadow(f.config);await restarted.ready();const retry=await restarted.adapter.backfillPage({cursor:null,shard:0,shards:1,limit:1,signal:signal()});assert.deepEqual(retry,first);assert.equal(f.external.lists.length,calls);assert.deepEqual((await restarted.coverage.status()).shards,before.shards);
 await f.walk(first.cursor);await f.replay();const complete=await restarted.coverage.status();assert.equal(complete.traversalComplete,true);assert.equal(complete.unresolvedEncounter,false);assert.equal(complete.shards[0].encountered,'2');assert.equal((await f.cert(keys[0])).revision,'1');
 assert.equal((await f.database.pool.query('SELECT 1 FROM opencrawl_online_coverage_encounters WHERE namespace=$1 AND source_key=$2',[f.database.namespace,keys[0]])).rowCount,0,'journal-only key does not need a fake LIST encounter');assert.equal(complete.runtimeAdmission,false);
});
live('interruption after key effects but before page receipt retries the original staged page idempotently',async t=>{
 const f=await fixture(t);f.external.seed(keys[2],{n:2});const restore=failQueryOnce(t,f.database.pool,/UPDATE opencrawl_online_coverage_traversals SET next_page/);
 await assert.rejects(f.page(null),/injected coverage interruption/);assert.equal((await f.cert(keys[2])).revision,'0');const calls=f.external.lists.length,partial=await f.shadow.coverage.status();assert.equal(partial.traversalComplete,false);assert.equal(partial.shards[0].encountered,'0');restore();
 const restarted=createOnlineTypedShadow(f.config);await restarted.ready();const retried=await restarted.adapter.backfillPage({cursor:null,shard:0,shards:1,limit:1,signal:signal()});assert.equal(f.external.lists.length,calls);if(retried.cursor!==null)await f.walk(retried.cursor);const after=await restarted.coverage.status();assert.equal(after.traversalComplete,true);assert.equal(after.shards[0].encountered,'1');
});
live('future cursors and completion with missing or corrupted page effects are refused',async t=>{
 const f=await fixture(t);f.external.seed(keys[2],{n:2});await assert.rejects(f.page(JSON.stringify({stage:'source',root:0,token:'forged',last:null})),{code:'ONLINE_COVERAGE_MISSING_PREDECESSOR_PAGE'});assert.equal(f.external.lists.length,0);
 const restore=failQueryOnce(t,f.database.pool,/INSERT INTO opencrawl_online_shadow_objects/);await assert.rejects(f.page(null),/injected coverage interruption/);restore();
 const identity=f.shadow.coverage.identity;assert.equal((await f.shadow.coverage.status()).traversalComplete,false);assert.equal(await f.cert(keys[2]),null);
 await f.database.pool.query("UPDATE opencrawl_online_coverage_pages SET next_cursor='forged' WHERE namespace=$1",[f.database.namespace]);await assert.rejects(f.page(null),{code:'ONLINE_COVERAGE_PAGE_CHANGED'});assert.equal(f.shadow.coverage.identity,identity);
});
live('certificate failure rolls typed target, byte mirror, head and journal checkpoint back together',async t=>{
 const f=await fixture(t);await f.replay();await f.put(keys[2],{new:true});const restore=failQueryOnce(t,f.database.pool,/INSERT INTO opencrawl_online_coverage_certificates/);await assert.rejects(f.replay(),/injected coverage interruption/);restore();
 assert.equal(await f.cert(keys[2]),null);assert.equal(await f.journal.replayCheckpoint(f.shadow.bindingId+'-0'),'0');for(const table of ['opencrawl_value_reports','opencrawl_online_projection_heads','opencrawl_online_shadow_objects'])assert.equal((await f.database.pool.query('SELECT 1 FROM '+table+' WHERE namespace=$1',[f.database.namespace])).rowCount,0);
 await f.replay();const record=await f.cert(keys[2]);assert.equal(record.revision,'1');assert.equal(record.source_sequence,'1');assert.match(record.target_hash,/^[a-f0-9]{64}$/);
});
live('fresh keys and delete-before-cursor or create-delete pairs are certified by replay without fake baseline encounters',async t=>{
 const f=await fixture(t);f.external.seed(keys[2],{original:true});f.external.seed(keys[5],{later:true});const first=await f.page(null);
 await f.del(keys[2]);await f.put(keys[0],{transient:true});await f.del(keys[0]);await f.put(keys[1],{newBehindCursor:true});await f.walk(first.cursor);assert.equal((await f.cert(keys[2])).revision,'0');await f.replay();
 for(const k of [keys[0],keys[2]]){const value=await f.cert(k);assert.equal(value.deleted,true);assert.equal(value.source_hash,null);assert.equal(value.source_bytes,null);assert.notEqual(value.operation_id,null);}
 assert.equal((await f.cert(keys[0])).revision,'2');assert.equal((await f.cert(keys[1])).deleted,false);assert.equal((await f.shadow.coverage.status()).shards[0].encountered,'2');
});
live('a pending baseline is only deferred; terminal notApplied must perform a real key-gated baseline before becoming certified',async t=>{
 const f=await fixture(t);f.external.seed(keys[2],{original:true});const read=f.external.store.read;let calls=0;f.external.store.read=async(...args)=>{if(++calls===2)throw new Error('crash before dispatch');return read(...args);};
 await assert.rejects(f.put(keys[2],{unapplied:true}),/crash before dispatch/);f.external.store.read=read;await f.walk(null);assert.equal(await f.cert(keys[2]),null);assert.equal((await f.shadow.coverage.status()).unresolvedEncounter,true);
 f.external.store.putIfVersion=async()=>false;await f.shadow.adapter.reconcilePending({cursor:null,limit:8,signal:signal()});const record=await f.cert(keys[2]);assert.equal(record.revision,'0');assert.equal(record.source_sequence,'0');assert.equal(record.operation_id,null);assert.equal(record.source_hash,hash(encode({original:true})));assert.equal((await f.shadow.coverage.status()).unresolvedEncounter,false);
 await f.replay();assert.equal(await f.journal.replayCheckpoint(f.shadow.bindingId+'-0'),'1');assert.equal((await f.cert(keys[2])).revision,'0');
});
live('key-gated baseline and concurrent mutation produce ordered certificates without a stale overwrite',async t=>{
 const f=await fixture(t);f.external.seed(keys[2],{baseline:true});let release,entered;const wait=new Promise(r=>{release=r;}),inside=new Promise(r=>{entered=r;}),read=f.external.store.read;let once=true;f.external.store.read=async(...args)=>{const v=await read(...args);if(once){once=false;entered();await wait;}return v;};
 const baseline=f.page(null);await inside;const mutation=f.put(keys[2],{current:true});let waiting=false;try{for(let i=0;i<200;i++){waiting=(await f.database.pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND l.locktype='advisory' AND NOT l.granted) AS waiting")).rows[0].waiting;if(waiting)break;await new Promise(r=>setTimeout(r,5));}assert.equal(waiting,true);}finally{release();}
 await baseline;await mutation;assert.equal((await f.cert(keys[2])).revision,'0');await f.replay();assert.equal((await f.cert(keys[2])).revision,'1');assert.equal((await f.cert(keys[2])).source_hash,hash(encode({current:true})));
});
live('retirement certificates remain listed-only until actual journal metadata; authority or policy changes cannot resume traversal',async t=>{
 const f=await fixture(t,{retireDerived:true}),key=prefix+'/_index/'+hash('realm')+'/'+hash('namespace')+'/batches/'+hash('batch')+'.json';f.external.seed(key,{malformedDerived:true});f.external.reads.length=0;await f.walk(null);assert.equal(f.external.reads.length,0);const baseline=await f.cert(key);assert.equal(baseline.source_version,null);assert.equal(baseline.source_hash,null);assert.equal(baseline.source_bytes,null);assert.equal(baseline.revision,'0');
 await f.del(key);await f.replay();assert.equal((await f.cert(key)).deleted,true);const changed=createOnlineTypedShadow({...f.config,coverage:{...f.config.coverage,policyHash:hash('changed')}});await assert.rejects(changed.ready(),{code:'ONLINE_COVERAGE_BINDING_CHANGED'});
});

live('a registered source attaches read-only and cannot restart by dropping or changing its registration',async t=>{
 const f=await fixture(t,{registered:true});f.external.seed(keys[2],{registered:true});await f.walk(null);const before=await f.shadow.coverage.status();
 const restarted=createOnlineTypedShadow(f.config);await restarted.ready();assert.deepEqual(await restarted.coverage.status(),before);
 await assert.rejects(createOnlineTypedShadow({...f.config,sourceRegistration:undefined}).ready(),{code:'ONLINE_MIGRATION_BOUND_SOURCE_REQUIRES_ATTACHMENT'});
 await assert.rejects(createOnlineTypedShadow({...f.config,sourceRegistration:{...f.config.sourceRegistration,bindingHash:hash('foreign')}}).ready());
 assert.deepEqual(await f.shadow.coverage.status(),before);
});

test('native certificates contain only verified binding metadata, never invented body or typed target evidence',async()=>{
 const {coverage}=pure(),client={query:()=>assert.fail('must reject before SQL')},base={key:'root/native',kind:'preserved-native',domain:'event-identities',scopeHash:null,nativeBindingHash:hash('verified native binding'),revision:'0',sequence:'0',operationId:null,sourceVersion:null,sourceHash:null,sourceBytes:null,deleted:false,targetKey:null,targetHash:null,absent:false};
 for(const delta of [{targetHash:hash('fake target')},{targetKey:'fake target'},{sourceHash:hash('fake body')},{sourceBytes:0},{sourceVersion:'invented'},{deleted:true},{absent:true},{revision:'1',sequence:'1',operationId:randomUUID(),sourceVersion:'mutation'}])await assert.rejects(coverage.recordIn(client,{...base,...delta}),/INVENTED_NATIVE_EVIDENCE/);
 await assert.rejects(coverage.recordIn(client,{...base,nativeBindingHash:undefined}),/INVALID_NATIVE_BINDING/);
 await assert.rejects(coverage.recordIn(client,{...base,kind:'retained'}),/UNEXPECTED_NATIVE_BINDING/);
});

live('native coverage schema upgrades only the exact prior owned kind constraints and preserves old certificates',async t=>{
 const admin=new Pool({connectionString:postgresUrl,max:2}),schema='oc_shadow_'+randomUUID().replaceAll('-','');await admin.query('CREATE SCHEMA '+schema);
 const database=createApplicationDatabase({connectionString:postgresUrl,namespace:'coverage-upgrade-'+randomUUID(),max:2,options:'-c search_path='+schema});t.after(async()=>{await database.close();try{await dropTestSchemas(admin,[schema]);}finally{await admin.end();}});
 const epoch=randomUUID(),sourceId=hash('source'),journal=createOnlineJournal({database,epoch,sourceId});await journal.ready();
 const config={database,epoch,sourceId,targetId:hash('target'),shards:1,roots:['root/'],participantIdentity:hash('participant'),policy:policy(database.namespace,epoch)},coverage=createOnlineCoverage(config);await coverage.ready();
 const value={key:'root/key',kind:'retired',domain:'session-indexing',scopeHash:hash('scope'),revision:'0',sequence:'0',operationId:null,sourceVersion:null,sourceHash:null,sourceBytes:null,deleted:false,targetKey:'audit',targetHash:hash('audit'),absent:false};await database.transaction(c=>coverage.recordIn(c,value));
 for(const [table,kinds] of [['opencrawl_online_coverage_encounters',"'retained','retired','immutable'"],['opencrawl_online_coverage_certificates',"'retained','retired'"]])await database.pool.query(`ALTER TABLE ${table} DROP COLUMN native_binding_hash,DROP CONSTRAINT ${table}_kind_check,ADD CONSTRAINT ${table}_kind_check CHECK(kind IN(${kinds}))`);
 const restarted=createOnlineCoverage(config);await restarted.ready();assert.deepEqual(await database.transaction(c=>restarted.readIn(c,value.key)),value);
 const table='opencrawl_online_coverage_certificates';await database.pool.query(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_kind_check,ADD CONSTRAINT ${table}_kind_check CHECK(kind <> 'foreign')`);
 await assert.rejects(createOnlineCoverage(config).ready(),/NATIVE_SCHEMA_CONSTRAINT/);
});
