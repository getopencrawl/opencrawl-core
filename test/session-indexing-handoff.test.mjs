import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSessionIngest} from '../dist/src/sessions/ingest.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';

const owner={tenantId:'tenant',userId:'author'};
const batch={schemaVersion:1,owner,harness:'codex',origin:'desktop',installationId:'device',sessionId:'session',events:[{id:'event',kind:'message',data:{text:'retained evidence'}}],attachments:[]};
const snapshot={schemaVersion:1,owner,harness:'codex',installationId:'device',host:'fixture',generation:1,files:[{path:'MEMORY.md',project:'',modifiedAt:'2026-11-13T00:00:00Z',text:'retained memory'}]};

for(const kind of ['session','memory'])test(`${kind} handoff retries the existing durable object after dispatch failure without acknowledging it`,async()=>{
 const store=memorySessionStore(),scheduled=[];let fail=true,rawWrites=0,observed=0;
 const put=store.put;store.put=async(key,...args)=>{if(key.endsWith('.json.gz'))rawWrites++;await put(key,...args);};
 const ingest=createSessionIngest({store,prefix:'capture',scheduleIndexing:async key=>{
  assert.ok(store.data.has(key));scheduled.push(key);if(fail)throw new Error('Temporal unavailable');
 },onStored:async()=>observed++,onMemoryStored:async()=>observed++});
 const submit=()=>kind==='session'?ingest.putBatch(owner,batch):ingest.putMemorySnapshot(owner,snapshot);
 await assert.rejects(submit(),/Temporal unavailable/);assert.equal(observed,0);assert.equal(rawWrites,1);
 fail=false;assert.equal((await submit()).stored,true);
 assert.equal(rawWrites,1);assert.equal(scheduled.length,2);assert.equal(scheduled[0],scheduled[1]);assert.equal(observed,1);
 assert.ok(!scheduled[0].includes('retained'));
});

test('forged capture ownership is rejected before storage or durable submission',async()=>{
 const store=memorySessionStore();let dispatched=0;
 const ingest=createSessionIngest({store,prefix:'capture',scheduleIndexing:async()=>{dispatched++;}});
 await assert.rejects(ingest.putBatch({...owner,tenantId:'other'},batch),e=>e.status===403);
 await assert.rejects(ingest.putMemorySnapshot({...owner,userId:'other'},snapshot),e=>e.status===403);
 assert.equal(dispatched,0);assert.equal(store.data.size,0);
});
