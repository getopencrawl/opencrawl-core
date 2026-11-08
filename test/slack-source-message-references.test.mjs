import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {createSlackMessageReferenceCapture} from '../dist/src/connectors/slack-source-message-references.mjs';
import {createConnectorPipeline} from '../dist/src/connectors/pipeline.mjs';
const binding={tenantId:'fixture',connectionId:'conn',workspaceId:'T123',provider:'slack',access:'team-public',rawPrefix:'raw/v1/source=slack/workspace=T123/connection=conn/'};
const input={runId:'references',references:[{channelId:'C1',ts:'1.000001'},{channelId:'C1',ts:'2.000001',threadTs:'1.000001'}]};
const ok=data=>({status:200,data:{ok:true,...data}});
function setup(handler){
 const objects=new Map(),calls=[];let clock=1800000000000,active=true;
 const store={bucket:'fixture',get:async k=>objects.get(k),put:async(k,v)=>objects.set(k,Buffer.from(v))};
 const options={binding,store,now:()=>clock,checkActive:async()=>{if(!active)throw Error('revoked');},request:async(method,query)=>{calls.push({method,query});return handler(method,query);}};
 return {objects,calls,store,options,restart:()=>createSlackMessageReferenceCapture(options),advance:(ms=70000)=>clock+=ms,revoke:()=>active=false};
}
const native=(method,q)=>method==='conversations.info'?ok({channel:{id:q.channel,is_private:false,is_archived:true}}):ok({messages:[{ts:q.oldest,...(q.ts?{thread_ts:q.ts}:{}),text:'Connect button',blocks:[{type:'section',text:{type:'mrkdwn',text:'Connect'}}]}]});
test('explicit roots and replies preserve native fallback and blocks through the single-tenant pipeline',async()=>{
 const h=setup(native);let result;
 for(let i=0;i<8;i++){result=await h.restart().step(input);if(result.done)break;h.advance();}
 assert.deepEqual(result,{done:true,references:2,pages:4,emitted:2,failed:0});
 assert.deepEqual(h.calls.map(c=>c.method),['conversations.info','conversations.history','conversations.info','conversations.replies']);
 assert.equal(h.calls[3].query.ts,'1.000001');assert.equal(h.calls[3].query.oldest,'2.000001');assert.equal(h.calls[3].query.latest,'2.000001');assert.equal(h.calls[3].query.inclusive,true);
 const keys=[...h.objects.keys()].filter(k=>k.includes('stream=canonical_messages/')),writes=[];
 const pipeline=createConnectorPipeline({binding,store:h.store,search:{identity:'fixture',putDocuments:async(_,__,docs)=>writes.push(...docs)}});
 for(const key of keys){assert.equal(JSON.parse(gunzipSync(h.objects.get(key)))._airbyte_data.text,'Connect button');await pipeline.processObject({key});}
 assert.equal(writes.length,2);assert.ok(writes.every(d=>d.document.sourceAuthority===1&&d.document.text.includes('Connect button')));
 const before=h.calls.length;await h.restart().step(input);assert.equal(h.calls.length,before);
});
test('durable rate reservations and Retry-After survive restarts and transport failure',async()=>{
 let attempts=0;const h=setup((method,q)=>method==='conversations.history'&&++attempts===1?{status:429,headers:{'Retry-After':'120'},data:{ok:false,error:'ratelimited'}}:native(method,q));
 await h.restart().step(input);h.advance(119999);assert.equal((await h.restart().step(input)).waitMs,1);assert.equal(attempts,1);
 h.advance(1);await h.restart().step(input);assert.equal(attempts,2);
 const t=setup((method,q)=>{if(method==='conversations.history')throw Error('transport');return native(method,q);});
 await assert.rejects(t.restart().step(input),/transport/);assert.equal((await t.restart().step(input)).waitMs,65000);assert.equal(t.calls.length,2);
});
test('reference input and checkpoints reject scope substitution, duplicate IDs, and invalid parents',async()=>{
 const h=setup(native);await h.restart().step(input);
 await assert.rejects(h.restart().step({...input,references:[{channelId:'C2',ts:'1.000001'}]}),/scope mismatch/);
 await assert.rejects(createSlackMessageReferenceCapture({...h.options,binding:{...binding,tenantId:'another'}}).step(input),/scope mismatch/);
 for(const references of [[],[{channelId:'D1',ts:'1.000001'}],[{channelId:'C1',ts:'1.000001',threadTs:'2.000001'}],[input.references[0],input.references[0]]])await assert.rejects(h.restart().step({...input,references}),/reference|parent/);
 assert.throws(()=>createSlackMessageReferenceCapture({...h.options,binding:{...binding,rawPrefix:'other/'}}),/scope/);
 h.revoke();await assert.rejects(h.restart().step(input),/revoked/);
});
test('private channels, wrong channel identities, mismatched threads, and partial pages never emit',async()=>{
 for(const response of [{channel:{id:'C1',is_private:true}},{channel:{id:'C2',is_private:false}}]){
  const h=setup(()=>ok(response));await assert.rejects(h.restart().step(input),/public channel/);assert.equal(h.calls.length,1);
 }
 for(const data of [{messages:[{ts:'2.000001',thread_ts:'9.000001'}]},{messages:[{ts:'2.000001',thread_ts:'1.000001',channel_id:'C2'}]},{messages:[],has_more:true},{messages:[],response_metadata:{next_cursor:'next'}}]){
  const h=setup((method,q)=>method==='conversations.info'?native(method,q):ok(data));
  await assert.rejects(h.restart().step({...input,references:[input.references[1]]}),/identity|Incomplete/);
  assert.equal([...h.objects.keys()].some(k=>k.includes('stream=')),false);
 }
});
test('not found and inaccessible resources are counted as failed without tombstones',async()=>{
 for(const response of [ok({messages:[]}),{status:200,data:{ok:false,error:'not_in_channel'}}]){
  const h=setup((method,q)=>method==='conversations.info'?native(method,q):response),one={...input,references:[input.references[0]]};
  await h.restart().step(one);const result=await h.restart().step(one);assert.equal(result.failed,1);assert.equal(result.emitted,0);
  assert.equal([...h.objects.keys()].some(k=>k.includes('stream=')),false);
 }
});
test('revocation after the provider request prevents raw and canonical writes',async()=>{
 const h=setup((method,q)=>{h.revoke();return native(method,q);});
 await assert.rejects(h.restart().step(input),/revoked/);assert.equal([...h.objects.keys()].some(k=>k.includes('/pages/')||k.includes('stream=')),false);
});
