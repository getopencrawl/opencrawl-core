import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createOnlineShadow} from '../dist/src/state/online-shadow.mjs';
import {createOnlineJournal} from '../dist/src/state/online-journal.mjs';
import {createOnlineTypedShadow} from '../dist/src/state/online-typed-shadow.mjs';
import {createOnlineWriteAuthority} from '../dist/src/state/online-authority.mjs';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex'),signal=()=>new AbortController().signal,compare=(a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
const live=(name,fn)=>test(name,{skip:!postgresUrl},fn);
function source(){
 const values=new Map(),missing=new Set(),calls={read:0,list:0},absent={version:null,operationId:null,revision:null,deleted:true,bytes:null,contentType:null};let forbidden=false;
 const external={async read(key){calls.read++;assert.equal(forbidden,false,'final observation must not read external bytes');return values.get(key)??absent;},async putIfVersion(key,version,m){if((values.get(key)?.version??null)!==version)return false;values.set(key,{version:m.operationId,operationId:m.operationId,revision:m.revision,deleted:false,bytes:Buffer.from(m.bytes),contentType:m.contentType});return true;},async deleteIfVersion(key,version,m){if((values.get(key)?.version??null)!==version)return false;values.set(key,{version:m.operationId,operationId:m.operationId,revision:m.revision,deleted:true,bytes:null,contentType:null});return true;}};
 const physicalListing={async listPage({prefix,cursor,limit}){calls.list++;assert.equal(forbidden,false);const all=[...new Set([...values.keys(),...missing])].filter(k=>k.startsWith(prefix)&&(!cursor||compare(k,cursor)>0)).sort(compare),keys=all.slice(0,limit);return {keys,cursor:all.length>limit?keys.at(-1):null};}};
 return {values,missing,calls,external,physicalListing,forbid(){forbidden=true;},seed(key,value){values.set(key,{...absent,version:'legacy-'+hash(key),deleted:false,bytes:Buffer.from(JSON.stringify(value)),contentType:'application/json'});}};
}
async function fixture(t,{count=4,retireDerived=false}={}){
 const database=await applicationDatabaseFixture(t,{max:4}),binding={epoch:randomUUID(),sourceId:hash('source'),targetId:hash('target'),shards:1},s=source(),journal=createOnlineJournal({database,epoch:binding.epoch,sourceId:binding.sourceId});
 const policy={policyHash:hash('policy'),authority:{namespace:database.namespace,epoch:binding.epoch,protocol:'test-envelope-v1',enrollmentReceiptHash:hash('fleet-enrollment')}},registration={bindingHash:hash('source-binding'),enrollmentReceiptHash:hash('source-enrollment')};
 const authority=createOnlineWriteAuthority({database,epoch:binding.epoch,protocol:policy.authority.protocol});await authority.prepare({receiptHash:hash('prepared')});await authority.activate({receiptHash:policy.authority.enrollmentReceiptHash,verify:async v=>({...v,receiptHash:policy.authority.enrollmentReceiptHash})});
 await journal.prepareSchema();await journal.registerSource(registration);
 const tenants=Array.from({length:count},(_,i)=>'org_final'+i),keys=tenants.map(tenant=>'sessions/value/tenants/'+hash(tenant)+'.json').sort(compare);
 const shadow=createOnlineTypedShadow({database,binding,journal,external:s.external,physicalListing:s.physicalListing,assertCurrent:async()=>{},prefix:'sessions',tenantIds:tenants,store:{bucket:'final-snapshot-test',get:()=>assert.fail('no offline read')},registryRecords:[],eventIdentities:{},enrollment:{verifierId:'fixture',initialReceiptHash:hash('roster'),verify:async request=>({tenantId:request.tenantId,receiptHash:hash('verified')})},coverage:policy,sourceRegistration:registration,...(retireDerived?{retireDerived:true}:{})});await shadow.ready();
 const put=(key,value)=>journal.mutate({operationId:randomUUID(),key,mutation:{kind:'put',bytes:Buffer.from(JSON.stringify(value)),contentType:'application/json'}},s.external),del=key=>journal.mutate({operationId:randomUUID(),key,mutation:{kind:'delete'}},s.external);
 async function backfill(limit=2){let cursor=null;for(let i=0;i<300;i++){const result=await shadow.adapter.backfillPage({cursor,shard:0,shards:1,limit,signal:signal()});if(result.cursor===null)return;cursor=result.cursor;}assert.fail('bounded traversal');}
 async function replay(){const through=await journal.closedFrontier();for(let i=0;i<100;i++){const result=await shadow.adapter.replayPage({consumer:shadow.bindingId+'-0',through,shard:0,shards:1,limit:64,signal:signal()});if(result.checkpoint===through)return through;}assert.fail('bounded replay');}
 async function begin(mode='READ ONLY',through){const client=await database.pool.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ '+mode);try{const reader=await shadow.beginFinalSnapshotIn(client,{through:through??await journal.closedFrontier()});return {client,reader};}catch(error){await client.query('ROLLBACK');client.release();throw error;}}
 async function finish(reader,options={}){const pages=[];for(let i=0;i<1000;i++){const page=await reader.next({limit:3,maxBytes:64*1024*1024,signal:signal(),...options});pages.push(page);if(page.complete)return {result:page,pages};}assert.fail('bounded final reader');}
 async function observe(options={}){const opened=await begin(options.mode??'READ ONLY',options.through);try{return await finish(opened.reader,options.page);}finally{await opened.client.query('ROLLBACK');opened.client.release();}}
 return {database,binding,policy,journal,shadow,keys,...s,put,del,backfill,replay,begin,finish,observe};
}
test('final reader requires registered typed coverage before any SQL and rejects weak isolation',async()=>{
 const database={namespace:'pure',pool:{connect:()=>assert.fail('no pool escape')}},binding={epoch:randomUUID(),sourceId:hash('source'),targetId:hash('target'),shards:1},journal={binding:{namespace:database.namespace,epoch:binding.epoch,sourceId:binding.sourceId}},basic={database,binding,journal,external:{},listing:{},roots:['root/'],classify:()=>null,assertCurrent:async()=>assert.fail('no external assertion')};
 const shadow=createOnlineShadow(basic);await assert.rejects(shadow.beginFinalSnapshotIn({query:()=>assert.fail('no SQL')},{through:'0'}),{code:'ONLINE_MIGRATION_UNSAFE'});
});
live('registered source snapshot reconstructs multi-page baseline and journal-only updates/tombstones with actual typed readback and no IO',async t=>{
 const f=await fixture(t,{count:70,retireDerived:true});for(const key of f.keys.slice(3))f.seed(key,{baseline:key.length});
 const retired='sessions/_index/'+hash('realm')+'/'+hash('namespace')+'/batches/'+hash('batch')+'.json';f.seed(retired,{malformedRetired:true});await f.backfill(32);
 await f.put(f.keys[0],{newBehindScan:true});await f.put(f.keys[1],{temporary:true});await f.del(f.keys[1]);await f.put(f.keys[3],{changed:true});await f.del(retired);const through=await f.replay(),before={...f.calls};f.forbid();
 for(const mode of ['READ ONLY','READ WRITE']){const {result,pages}=await f.observe({mode,through});assert.equal(result.complete,true);assert.equal(result.runtimeAdmission,false);assert.equal(result.globalTypedInventoryRequired,true);assert.equal(result.binding.through,'5');assert.equal(result.counts.journalRows,'5');assert.equal(result.counts.keys,'70');assert.equal(result.counts.retired,'1');assert.equal(result.counts.retained,'69');assert.ok(pages.length>20);assert.ok(pages.every(page=>page.processed<=3));assert.match(result.digest,/^[a-f0-9]{64}$/);assert.match(result.traversalHash,/^[a-f0-9]{64}$/);assert.equal(result.snapshotIdentity.readOnly,mode==='READ ONLY');}
 assert.deepEqual(f.calls,before);assert.equal((await f.database.pool.query('SELECT count(*)::int AS n FROM opencrawl_application_installations WHERE namespace=$1',[f.database.namespace])).rows[0].n,0);
});
live('final source observation refuses journal gaps even when allocated frontier and checkpoints look complete',async t=>{
 const f=await fixture(t);await f.backfill();await f.put(f.keys[0],{a:1});await f.put(f.keys[0],{a:2});await f.replay();await f.database.pool.query('DELETE FROM opencrawl_online_migration_journal WHERE namespace=$1 AND sequence=1',[f.database.namespace]);await assert.rejects(f.observe(),{code:'ONLINE_MIGRATION_UNSAFE'});
});
live('final reader refuses incomplete or corrupted page chains rather than trusting complete flags',async t=>{
 for(const mutation of ["DELETE FROM opencrawl_online_coverage_pages WHERE namespace=$1 AND page_number=0","UPDATE opencrawl_online_coverage_traversals SET page_chain=repeat('a',64) WHERE namespace=$1","UPDATE opencrawl_online_coverage_encounters SET outcome='deferred' WHERE namespace=$1"]){const f=await fixture(t);f.seed(f.keys[0],{n:0});await f.backfill();await f.replay();await f.database.pool.query(mutation,[f.database.namespace]);await assert.rejects(f.observe());}
});
live('final header requires current registered source, active journal authority and every exact shard checkpoint',async t=>{
 for(const mutation of ["UPDATE opencrawl_online_migration_source_bindings SET binding_hash=repeat('b',64) WHERE namespace=$1","DELETE FROM opencrawl_online_migration_checkpoints WHERE namespace=$1","UPDATE opencrawl_online_migration_epochs SET state='fenced' WHERE namespace=$1","UPDATE opencrawl_online_write_authorities SET mode='legacy',enrollment_receipt_hash=NULL WHERE namespace=$1"]){const f=await fixture(t);await f.backfill();await f.replay();await f.database.pool.query(mutation,[f.database.namespace]);await assert.rejects(f.observe());}
});
live('same snapshot reader rejects a new transaction, read-committed use and reuse after any failure',async t=>{
 const f=await fixture(t);f.seed(f.keys[0],{n:0});await f.backfill();await f.replay();const {client,reader}=await f.begin();
 try{await reader.next({signal:signal()});await client.query('COMMIT');await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await assert.rejects(reader.next({signal:signal()}),{code:'ONLINE_MIGRATION_UNSAFE'});await assert.rejects(reader.next({signal:signal()}),{code:'ONLINE_MIGRATION_UNSAFE'});await client.query('ROLLBACK');await client.query('BEGIN');await assert.rejects(f.shadow.beginFinalSnapshotIn(client,{through:'0'}),{code:'ONLINE_MIGRATION_UNSAFE'});}finally{await client.query('ROLLBACK');client.release();}
});
live('byte budgets bound retained payload readback and cannot create an empty-progress retry loop',async t=>{
 const f=await fixture(t);f.seed(f.keys[0],{text:'a'.repeat(128)});f.seed(f.keys[1],{text:'b'.repeat(128)});await f.backfill();await f.replay();
 const {result,pages}=await f.observe({page:{maxBytes:180}});assert.equal(result.counts.retained,'2');assert.ok(pages.filter(p=>p.phase==='keys'||p.phase==='complete').every(p=>p.bytes<=180));
 await assert.rejects(f.observe({page:{maxBytes:16}}),{code:'ONLINE_MIGRATION_UNSAFE'});
});
live('a validly hashed but false coverage target and independently changed typed state both fail owning readback',async t=>{
 const f=await fixture(t);f.seed(f.keys[0],{n:0});await f.backfill();await f.replay();const ns=f.database.namespace,key=f.keys[0];
 const row=(await f.database.pool.query('SELECT * FROM opencrawl_online_coverage_certificates WHERE namespace=$1 AND source_key=$2',[ns,key])).rows[0];
 const value={key,kind:row.kind,domain:row.domain,scopeHash:row.scope_hash,revision:String(row.revision),sequence:String(row.source_sequence),operationId:row.operation_id,sourceVersion:row.source_version,sourceHash:row.source_hash,sourceBytes:row.source_bytes,deleted:row.deleted,targetKey:row.target_key,targetHash:hash('false owner'),absent:row.absent};
 await f.database.pool.query('UPDATE opencrawl_online_coverage_certificates SET target_hash=$3,certificate_hash=$4 WHERE namespace=$1 AND source_key=$2',[ns,key,value.targetHash,hash([f.shadow.coverage.identity,value])]);await assert.rejects(f.observe(),{code:'ONLINE_MIGRATION_UNSAFE'});
 await f.database.pool.query('UPDATE opencrawl_online_coverage_certificates SET target_hash=$3,certificate_hash=$4 WHERE namespace=$1 AND source_key=$2',[ns,key,row.target_hash,row.certificate_hash]);await f.database.pool.query("UPDATE opencrawl_value_reports SET report='{}'::jsonb WHERE namespace=$1",[ns]);await assert.rejects(f.observe());
});
live('absent baseline has no mirror/head; adding a source-local orphan head cannot pass absence evidence',async t=>{
 const f=await fixture(t);f.missing.add(f.keys[0]);f.seed(f.keys[1],{n:1});await f.backfill();await f.replay();assert.equal((await f.observe()).result.counts.absent,'1');
 const row=(await f.database.pool.query('SELECT * FROM opencrawl_online_shadow_objects WHERE namespace=$1 LIMIT 1',[f.database.namespace])).rows[0];await f.database.pool.query('INSERT INTO opencrawl_online_shadow_objects SELECT namespace,epoch,source_id,$2,target_id,logical_deleted,payload,payload_hash,content_type,revision,operation_id,source_sequence,source_version FROM opencrawl_online_shadow_objects WHERE namespace=$1 AND source_key=$3',[f.database.namespace,f.keys[0],row.source_key]);await assert.rejects(f.observe(),{code:'ONLINE_MIGRATION_UNSAFE'});
});
