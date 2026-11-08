import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {createSlackMessageCapture} from '../dist/src/connectors/slack-source-messages.mjs';
import {createConnectorPipeline} from '../dist/src/connectors/pipeline.mjs';
const binding={tenantId:'fixture',connectionId:'conn',workspaceId:'T123',provider:'slack',access:'team-public',rawPrefix:'raw/v1/source=slack/workspace=T123/connection=conn/'};
const input={runId:'history',cutoff:1800000000000};
const ok=data=>({status:200,data:{ok:true,...data}});
function setup(handler){
 const objects=new Map(),calls=[];let clock=input.cutoff,active=true;
 const store={bucket:'fixture',get:async k=>objects.get(k),put:async(k,v)=>objects.set(k,Buffer.from(v))};
 const options={binding,store,now:()=>clock,checkActive:async()=>{if(!active)throw Error('revoked');},request:async(method,query)=>{calls.push({method,query});return handler(method,query);}};
 return {objects,calls,store,capture:createSlackMessageCapture(options),restart:()=>createSlackMessageCapture(options),advance:(ms=70000)=>clock+=ms,revoke:()=>active=false};
}
test('full history exhausts archived channels and old-parent reply cursors without a backfill cutoff',async()=>{
 const h=setup((method,q)=>{
  if(method==='conversations.list')return ok({channels:[{id:q.cursor?'C2':'C1',is_private:false,is_archived:!!q.cursor}],response_metadata:{next_cursor:q.cursor?'':'channels-next'}});
  if(method==='conversations.history')return ok({messages:q.channel==='C2'?[]:q.cursor?[{ts:'1.000001',text:'Very old root',reply_count:1}]:[{ts:'1799999999.000001',text:'Current root'}],response_metadata:{next_cursor:q.channel==='C1'&&!q.cursor?'history-next':''}});
  return ok({messages:q.cursor?[{ts:'1799999998.000001',thread_ts:'1.000001',text:'Late reply on an old root',blocks:[{type:'section',text:{type:'plain_text',text:'Full tail beyond preview'}}]}]:[{ts:'1.000001',text:'Very old root',reply_count:1}],response_metadata:{next_cursor:q.cursor?'':'replies-next'}});
 });
 let result;for(let i=0;i<20;i++){result=await h.restart().step(input);if(result.done)break;h.advance();}
 assert.equal(result.done,true);assert.equal(result.failed,0);assert.equal(result.channels,2);assert.equal(result.threads,1);
 assert.equal(h.calls.filter(c=>c.method==='conversations.history').length,3);assert.equal(h.calls.filter(c=>c.method==='conversations.replies').length,2);
 assert.ok(h.calls.every(c=>!Object.hasOwn(c.query,'oldest')));assert.equal(h.calls[0].query.exclude_archived,false);
 const keys=[...h.objects.keys()].filter(k=>k.includes('stream=canonical_messages/'));
 const records=keys.flatMap(k=>gunzipSync(h.objects.get(k)).toString().trim().split('\n').map(JSON.parse));
 assert.ok(records.some(r=>r._airbyte_data.ts==='1.000001'));
 const writes=[],pipeline=createConnectorPipeline({binding,store:h.store,search:{identity:'fixture',putDocuments:async(_,__,docs)=>writes.push(...docs)}});
 for(const key of keys)await pipeline.processObject({key});
 assert.ok(writes.every(d=>d.document.sourceAuthority===1));assert.ok(writes.some(d=>d.document.text.includes('Full tail beyond preview')));
});
test('history pacing and Retry-After survive capture restarts without advancing cursors',async()=>{
 let attempts=0;const h=setup(method=>method==='conversations.list'?ok({channels:[{id:'C1',is_private:false}]}):++attempts===1?{status:429,headers:{'Retry-After':'120'},data:{ok:false,error:'ratelimited'}}:ok({messages:[]}));
 await h.capture.step(input);await h.capture.step(input);assert.equal(attempts,1);
 h.advance(119999);assert.equal((await h.restart().step(input)).waitMs,1);assert.equal(attempts,1);
 h.advance(1);await h.restart().step(input);assert.equal(attempts,2);assert.equal((await h.capture.step(input)).failed,0);
});
test('private scope, repeated cursors, malformed pagination, and changed authorization fail closed',async()=>{
 const privateSource=setup(()=>ok({channels:[{id:'C1',is_private:true}]}));await assert.rejects(privateSource.capture.step(input),/public channel/);
 for(const bad of [{messages:[],has_more:true},{messages:[],response_metadata:{next_cursor:'again'}}]){
  const h=setup(method=>method==='conversations.list'?ok({channels:[{id:'C1',is_private:false}]}):ok(bad));await h.capture.step(input);
  if(bad.has_more)await assert.rejects(h.capture.step(input),/cursor/);
  else {await h.capture.step(input);h.advance();await assert.rejects(h.capture.step(input),/cursor/);}
 }
 const h=setup(()=>ok({channels:[]}));await h.capture.step(input);
 await assert.rejects(h.capture.step({...input,cutoff:input.cutoff+1}),/scope mismatch/);
 h.revoke();await assert.rejects(h.capture.step(input),/revoked/);
});
test('inaccessible history is counted as incomplete rather than silently accepted',async()=>{
 const h=setup(method=>method==='conversations.list'?ok({channels:[{id:'C1',is_private:false}]}):{status:200,data:{ok:false,error:'not_in_channel'}});
 await h.capture.step(input);await h.capture.step(input);const result=await h.capture.step(input);assert.equal(result.done,true);assert.equal(result.failed,1);
 assert.equal([...h.objects.keys()].some(k=>k.includes('stream=canonical_messages/')),false);
});

test('history request reservations survive transport and server failures without advancing the cursor',async()=>{
 for(const failure of ['transport','server']) {
  let attempts=0;
  const h=setup(method=>{
   if(method==='conversations.list')return ok({channels:[{id:'C1',is_private:false}]});
   if(++attempts===1){if(failure==='transport')throw Error('lost response');return {status:503};}
   return ok({messages:[]});
  });
  await h.capture.step(input);
  await assert.rejects(h.capture.step(input),/lost response|Transient/);
  assert.equal((await h.restart().step(input)).waitMs,65000);
  assert.equal(attempts,1);
  h.advance(64999);assert.equal((await h.restart().step(input)).waitMs,1);
  h.advance(1);await h.restart().step(input);
  assert.equal(attempts,2);assert.equal(h.calls.at(-1).query.cursor,undefined);
  assert.equal((await h.restart().step(input)).done,true);
 }
});

test('message-only captures revoke missing public channels only after a complete enumeration',async()=>{
 let run=1;
 const h=setup((method,q)=>{
  if(method==='conversations.list')return run===1
   ?ok({channels:[{id:'C1',is_private:false},{id:'C2',is_private:false}]})
   :ok({channels:q.cursor?[{id:'C2',is_private:false}]:[],response_metadata:{next_cursor:q.cursor?'':'last'}});
  return ok({messages:[]});
 });
 for(let i=0;i<10;i++){const result=await h.restart().step(input);if(result.done)break;h.advance();}
 run=2;h.advance();
 const next={...input,runId:'next'};
 const records=()=>[...h.objects].filter(([key])=>key.includes('stream=channels/')&&key.includes('sync=next/'))
  .flatMap(([,bytes])=>gunzipSync(bytes).toString().trim().split('\n').map(line=>JSON.parse(line)._airbyte_data));
 await h.restart().step(next);
 assert.deepEqual(records(),[],'a partial enumeration cannot revoke previously public channels');
 h.advance();await h.restart().step(next);
 assert.ok(records().some(channel=>channel.id==='C1'&&channel.is_private===true));
 assert.ok(records().some(channel=>channel.id==='C2'&&channel.is_private===false));
});

test('a channel published before a failed checkpoint is still remembered for later revocation',async()=>{
 let channels=[{id:'C1',is_private:false}];
 const h=setup(()=>ok({channels}));
 const put=h.store.put;let saved=0;
 h.store.put=async(key,bytes)=>{
  if(key.endsWith('/history/state.json')&&++saved===2)throw Error('checkpoint unavailable');
  await put(key,bytes);
 };
 await assert.rejects(h.capture.step(input),/checkpoint unavailable/);
 assert.ok([...h.objects.keys()].some(key=>key.includes('stream=channels/')));
 channels=[];h.advance();await h.restart().step({...input,runId:'after-failure'});
 const revoked=[...h.objects].filter(([key])=>key.includes('stream=channels/')&&key.includes('sync=after-failure/'))
  .flatMap(([,bytes])=>gunzipSync(bytes).toString().trim().split('\n').map(line=>JSON.parse(line)._airbyte_data));
 assert.deepEqual(revoked,[{id:'C1',is_private:true}]);
});

test('same-run retry preserves catalog-only channels after raw publication and a failed checkpoint',async()=>{
 let channels=[{id:'C1',is_private:false}];
 const h=setup(()=>ok({channels}));
 const put=h.store.put;let saved=0;
 h.store.put=async(key,bytes)=>{
  if(key.endsWith('/history/state.json')&&++saved===2)throw Error('checkpoint unavailable');
  await put(key,bytes);
 };
 await assert.rejects(h.capture.step(input),/checkpoint unavailable/);
 channels=[];h.advance();await h.restart().step(input);
 assert.deepEqual(JSON.parse(h.objects.get(binding.rawPrefix+'capture/messages-v1/catalog.json')).channels,['C1']);
 const records=[...h.objects].filter(([key])=>key.includes('stream=channels/'))
  .flatMap(([,bytes])=>gunzipSync(bytes).toString().trim().split('\n').map(line=>JSON.parse(line)._airbyte_data));
 assert.deepEqual(records.map(channel=>[channel.id,channel.is_private]),[['C1',false],['C1',true]]);
});
