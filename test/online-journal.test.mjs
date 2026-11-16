import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const {runOnlineMutationProtocol,createOnlineJournal,ONLINE_MAX_PAYLOAD_BYTES}=await import(process.env.OPENCRAWL_ONLINE_JOURNAL_SOURCE||'../dist/src/state/online-journal.mjs');
const absent=()=>({version:null,operationId:null,revision:null,deleted:true,bytes:null,contentType:null});
function intent(change={}){return {namespace:'customer-a',epoch:randomUUID(),sourceId:'private-source',operationId:randomUUID(),key:'account/key',sequence:'1',revision:'1',expectedVersion:null,mutation:{kind:'put',bytes:Buffer.from('private-value'),contentType:'application/json'},state:'pending',dispatched:false,resultVersion:null,requestHash:'a'.repeat(64),...change};}
function fixture(initial=absent()){
 let value=initial,dispatches=0,finishes=0,writes=0;const events=[];
 const store={read:async()=>({...value,bytes:value.bytes?Buffer.from(value.bytes):null}),putIfVersion:async(key,expected,m)=>{
  events.push('write');writes++;assert.ok(dispatches>0,'Durable dispatch must precede every external write');if(value.version!==expected)return false;
  value={version:'etag-'+m.operationId,operationId:m.operationId,revision:m.revision,deleted:false,bytes:Buffer.from(m.bytes),contentType:m.contentType};return true;
 },deleteIfVersion:async(key,expected,m)=>{
  events.push('delete');writes++;assert.ok(dispatches>0);if(value.version!==expected)return false;
  value={version:'tombstone-'+m.operationId,operationId:m.operationId,revision:m.revision,deleted:true,bytes:null,contentType:null};return true;
 }};
 const hooks=i=>({dispatch:async()=>{events.push('dispatch-committed');dispatches++;i.dispatched=true;},finish:async(state,resultVersion)=>{events.push('finish-committed');finishes++;Object.assign(i,{state,resultVersion});return i;}});
 return {store,hooks,events,get value(){return value;},set value(x){value=x;},get writes(){return writes;},get finishes(){return finishes;}};
}
test('durable dispatch precedes external effect, terminal evidence binds operation/revision/payload',async()=>{
 const i=intent(),f=fixture();const result=await runOnlineMutationProtocol(i,f.store,f.hooks(i));assert.equal(result.state,'applied');assert.equal(result.resultVersion,f.value.version);assert.deepEqual(f.events,['dispatch-committed','write','finish-committed']);
 await runOnlineMutationProtocol(i,f.store,f.hooks(i));assert.equal(f.writes,1,'Terminal retry never rewrites');
});
test('failed durable intent/dispatch never permits external mutation',async()=>{
 const i=intent(),f=fixture();await assert.rejects(runOnlineMutationProtocol(i,f.store,{...f.hooks(i),dispatch:async()=>{throw Error('database unavailable');}}),/database unavailable/);assert.equal(f.writes,0);assert.equal(f.finishes,0);
});
test('commit-then-lost HTTP response remains pending, restart recovers exact object metadata without another write',async()=>{
 const i=intent(),f=fixture(),put=f.store.putIfVersion;f.store.putIfVersion=async(...a)=>{await put(...a);throw Error('lost response');};
 await assert.rejects(runOnlineMutationProtocol(i,f.store,f.hooks(i)),{code:'ONLINE_MIGRATION_EXTERNAL_OUTCOME_UNCERTAIN'});assert.equal(i.state,'pending');assert.equal(f.finishes,0);
 assert.equal((await runOnlineMutationProtocol(i,f.store,f.hooks(i))).state,'applied');assert.equal(f.writes,1);
});
test('timeout with old ETag/absence is never interpreted as notApplied; retry is the same conditional operation',async()=>{
 const i=intent(),f=fixture();f.store.putIfVersion=async()=>{throw Error('timeout');};
 for(let n=0;n<2;n++)await assert.rejects(runOnlineMutationProtocol(i,f.store,f.hooks(i)),{code:'ONLINE_MIGRATION_EXTERNAL_OUTCOME_UNCERTAIN'});
 assert.equal(i.state,'pending');assert.equal(f.finishes,0);assert.equal(i.dispatched,true);
});
test('definite first conditional rejection is notApplied, but a rejected recovery retry remains unresolved',async()=>{
 for(const dispatched of [false,true]){const i=intent({dispatched}),f=fixture();f.store.putIfVersion=async()=>false;
  if(dispatched){await assert.rejects(runOnlineMutationProtocol(i,f.store,f.hooks(i)),{code:'ONLINE_MIGRATION_EXTERNAL_OUTCOME_UNCERTAIN'});assert.equal(f.finishes,0);}
  else assert.equal((await runOnlineMutationProtocol(i,f.store,f.hooks(i))).state,'notApplied');
 }
});
test('an unissued intent with changed source is rejected without writes; issued intent never adopts unrelated state',async()=>{
 const state={version:'other',operationId:null,revision:null,deleted:false,bytes:Buffer.from('other'),contentType:'application/json'};
 for(const dispatched of [false,true]){const i=intent({dispatched}),f=fixture(state);
  if(dispatched)await assert.rejects(runOnlineMutationProtocol(i,f.store,f.hooks(i)),{code:'ONLINE_MIGRATION_UNRESOLVED_INTENT'});
  else assert.equal((await runOnlineMutationProtocol(i,f.store,f.hooks(i))).state,'notApplied');assert.equal(f.writes,0);
 }
});
test('delete is a versioned retained tombstone; loss of ack recovers without deleting a later value',async()=>{
 const i=intent({expectedVersion:'old',mutation:{kind:'delete'}}),f=fixture({version:'old',operationId:null,revision:null,deleted:false,bytes:Buffer.from('old'),contentType:'text/plain'}),del=f.store.deleteIfVersion;
 f.store.deleteIfVersion=async(...a)=>{await del(...a);throw Error('crash');};await assert.rejects(runOnlineMutationProtocol(i,f.store,f.hooks(i)));assert.equal(f.value.deleted,true);assert.notEqual(f.value.version,null);
 assert.equal((await runOnlineMutationProtocol(i,f.store,f.hooks(i))).state,'applied');assert.equal(f.writes,1);
 const old=f.value.version;f.value={version:'new-generation',operationId:randomUUID(),revision:'2',deleted:false,bytes:Buffer.from('old'),contentType:'text/plain'};assert.equal(await del(i.key,old,{operationId:i.operationId,revision:i.revision}),false);assert.equal(f.value.deleted,false);
});
test('physical absence cannot settle an uncertain delete',async()=>{
 const i=intent({dispatched:true,expectedVersion:'old',mutation:{kind:'delete'}}),f=fixture();await assert.rejects(runOnlineMutationProtocol(i,f.store,f.hooks(i)),{code:'ONLINE_MIGRATION_UNRESOLVED_INTENT'});assert.equal(f.finishes,0);
});
test('matching operation with corrupted bytes, revision or deletion state fails closed',async()=>{
 for(const changed of [{bytes:Buffer.from('different')},{revision:'2'},{deleted:true,bytes:null,contentType:null}]){
  const i=intent({dispatched:true}),f=fixture({version:'op-version',operationId:i.operationId,revision:i.revision,deleted:false,bytes:Buffer.from(i.mutation.bytes),contentType:i.mutation.contentType,...changed});
  await assert.rejects(runOnlineMutationProtocol(i,f.store,f.hooks(i)),{code:'ONLINE_MIGRATION_OPERATION_EVIDENCE_CONFLICT'});assert.equal(f.writes,0);assert.equal(f.finishes,0);
 }
});
test('invalid or oversized external records cannot become positive evidence',async()=>{
 for(const changed of [{version:null,deleted:false},{operationId:randomUUID(),revision:null},{bytes:Buffer.alloc(ONLINE_MAX_PAYLOAD_BYTES+1)}]){
  const i=intent(),f=fixture({version:'old',operationId:null,revision:null,deleted:false,bytes:Buffer.from('value'),contentType:'text/plain',...changed});await assert.rejects(runOnlineMutationProtocol(i,f.store,f.hooks(i)));assert.equal(f.writes,0);
 }
});
test('scope is explicit and invalid operations cannot acquire a DB connection',async()=>{
 let connections=0;const database={namespace:'a',pool:{connect:async()=>{connections++;throw Error('unexpected DB access');}}};
 for(const change of [{epoch:'bad'},{sourceId:''},{database:{...database,namespace:''}}])assert.throws(()=>createOnlineJournal({database,epoch:randomUUID(),sourceId:'source',...change}));
 const j=createOnlineJournal({database,epoch:randomUUID(),sourceId:'source'}),f=fixture();
 for(const request of [{operationId:'bad',key:'k',mutation:{kind:'delete'}},{operationId:randomUUID(),key:'',mutation:{kind:'delete'}},{operationId:randomUUID(),key:'k',mutation:{kind:'put',bytes:Buffer.alloc(ONLINE_MAX_PAYLOAD_BYTES+1),contentType:'text/plain'}}])await assert.rejects(j.mutate(request,f.store));
 assert.equal(connections,0);
});
test('caller mutation while lock acquisition waits cannot redirect the key or operation ID',async()=>{
 let release;const wait=new Promise(resolve=>{release=resolve;}),queries=[],reads=[];
 const client={on(){},removeListener(){},release(){},async query(sql,args){queries.push({sql,args});return {rows:sql.startsWith('SELECT state FROM')?[{state:'active'}]:[],rowCount:0};}};
 const database={namespace:'immutable-request',pool:{connect:async()=>{await wait;return client;}}},j=createOnlineJournal({database,epoch:randomUUID(),sourceId:'source'});
 const request={operationId:randomUUID(),key:'original/key',mutation:{kind:'put',bytes:Buffer.from('original'),contentType:'text/plain'}},id=request.operationId;
 const task=j.mutate(request,{read:async key=>{reads.push(key);throw Error('stop before dispatch');}});
 request.key='other/owner';request.operationId=randomUUID();request.mutation.bytes.fill(0);release();
 await assert.rejects(task,/stop before dispatch/);assert.deepEqual(reads,['original/key']);
 const lookup=queries.find(x=>x.sql.includes('operation_id=$4'));assert.equal(lookup.args[3],id);
 const lock=queries.find(x=>x.sql.startsWith('SELECT pg_advisory_lock('));assert.equal(JSON.parse(lock.args[0]).at(-1),'original/key');
});

test('uncertain epoch or key acquisition destroys the session instead of pooling unknown locks',async()=>{
 for(const failAt of [1,2]){
  let acquisitions=0,released,queries=[];
  const client={on(){},removeListener(){},release(destroy){released=destroy;},async query(sql){queries.push(sql);if(sql.includes('pg_advisory_lock')&&++acquisitions===failAt)throw Error('Query read timeout');return {rows:[]};}};
  const journal=createOnlineJournal({database:{namespace:'lock-timeout',pool:{connect:async()=>client}},epoch:randomUUID(),sourceId:'source'});
  await assert.rejects(journal.mutate({operationId:randomUUID(),key:'key',mutation:{kind:'delete'}},{read:async()=>{throw Error('must not dispatch');}}),/Query read timeout/);
  assert.equal(released,true);assert.equal(queries.some(sql=>sql.includes('pg_advisory_unlock')),false,'Do not enqueue cleanup behind an uncertain acquisition');
 }
});
