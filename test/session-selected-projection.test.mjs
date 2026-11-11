import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {createSessionIngest} from '../dist/src/sessions/ingest.mjs';
import {batchDocuments} from '../dist/src/sessions/indexer.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';

const principal={tenantId:'selected-team',userId:'owner'},prefix='selected-capture';
async function fixture(){
  const store=memorySessionStore();
  await createSessionIngest({store,prefix}).putBatch(principal,{schemaVersion:1,owner:principal,harness:'codex',origin:'cli',installationId:'machine',sessionId:'session',attachments:[],events:[
    {id:'first',kind:'message',data:{role:'user',content:'An initial question.'}},
    {id:'long',kind:'message',data:{role:'assistant',content:('Evidence with preserved paragraph boundaries.\n\n').repeat(200)}},
    {id:'tool',kind:'tool_result',data:{call_id:'tool-call',output:'Verification passed.'}},
    {id:'echo',kind:'user_message',data:{message:'An initial question.'}},
  ]});
  const key=[...store.data.keys()].find(key=>key.endsWith('.json.gz'));
  return {prefix,key,principal,batch:JSON.parse(gunzipSync(store.data.get(key)))};
}

test('selected projection exactly preserves full-projection documents, order, privacy and omitted echoes',async()=>{
  const input=await fixture(),before=structuredClone(input.batch);
  for(const visibility of ['team','private']){
    const all=batchDocuments({...input,visibility});
    const eventIds=['tool','long','echo'];
    const selected=batchDocuments({...input,visibility,eventIds});
    assert.deepEqual(selected,all.filter(item=>eventIds.includes(item.document.eventId)));
    assert.ok(selected.length>2);
    assert.ok(selected.every(item=>item.document.private===(visibility==='private')));
    assert.deepEqual(batchDocuments({...input,eventIds:['echo']}),[]);
  }
  assert.deepEqual(input.batch,before);
});

test('selection cannot bypass batch scope or malformed event identities',async()=>{
  const input=await fixture();
  for(const principal of [{tenantId:'other-team',userId:'owner'},{tenantId:'selected-team',userId:'other-user'}]){
    assert.throws(()=>batchDocuments({...input,principal,eventIds:['first']}),/authorized scope/);
  }
  for(const change of [{owner:{...principal,tenantId:'other-team'}},{sessionId:'other-session'},{installationId:'other-machine'}]){
    assert.throws(()=>batchDocuments({...input,batch:{...input.batch,...change},eventIds:['first']}),/authorized scope/);
  }
  for(const invalid of [null,{id:'',kind:'message'},{id:'unselected',kind:17}]){
    assert.throws(()=>batchDocuments({...input,batch:{...input.batch,events:[...input.batch.events,invalid]},eventIds:['first']}),/Malformed stored event/);
  }
  for(const eventIds of [[],['first','first'],['missing'],['first',null],Array(1001).fill('first'),'first']){
    assert.throws(()=>batchDocuments({...input,eventIds}),/event selection|absent from stored batch/);
  }
});
