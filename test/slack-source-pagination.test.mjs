import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSlackFileCapture} from '../src/connectors/slack-source-files.mjs';
import {createSlackMessageCapture} from '../src/connectors/slack-source-messages.mjs';

const binding={tenantId:'fixture',connectionId:'conn',workspaceId:'T123',provider:'slack',access:'team-public',rawPrefix:'raw/v1/source=slack/workspace=T123/connection=conn/'};
const families=['files-channels','files-info','messages-channels','messages-history','messages-replies'];
const ok=data=>({status:200,data:{ok:true,...data}});
function setup(family,next,{empty=true,multiple=false}={}) {
 const files=family.startsWith('files-'),make=files?createSlackFileCapture:createSlackMessageCapture;
 const objects=new Map(),calls=[];let clock=1800000000000;
 const input={runId:'pagination',cutoff:clock};
 const stateKey=binding.rawPrefix+`capture/${files?'files':'messages'}-v1/${input.runId}/state.json`;
 const store={get:async key=>objects.get(key),put:async(key,bytes)=>objects.set(key,Buffer.from(bytes))};
 const channels=multiple?['C1','C2']:['C1'];
 const options={binding,store,now:()=>clock,download:async()=>assert.fail('image fixture needs no download'),request:async(method,query)=>{
  calls.push({method,query});
  if(method==='conversations.list')return ok({channels:family.endsWith('channels')&&empty?[]:channels.map(id=>({id,is_private:false})),response_metadata:{next_cursor:family.endsWith('channels')||multiple?next(query.cursor,method,query):''}});
  if(method==='files.list')return ok({files:(multiple?['F1','F2']:['F1']).map(id=>({id})),paging:{page:query.page,pages:1}});
  if(method==='files.info')return ok({file:{id:query.file,channels,mimetype:'image/png'},comments:empty?[]:[{id:'comment',comment:'same comment'}],response_metadata:{next_cursor:next(query.cursor,method,query)}});
  if(method==='conversations.history')return ok({messages:family==='messages-replies'||multiple?[{ts:'1.000001',reply_count:1}]:empty?[]:[{ts:'1.000001',text:'same message'}],response_metadata:{next_cursor:family==='messages-history'||multiple?next(query.cursor,method,query):''}});
  return ok({messages:empty?[]:[{ts:'2.000001',thread_ts:'1.000001',text:'same reply'}],response_metadata:{next_cursor:next(query.cursor,method,query)}});
 }};
 const owner=state=>family==='files-info'?state.files.F1:family==='messages-history'?state.channels.C1:family==='messages-replies'?state.threads['C1:1.000001']:state;
 return {objects,calls,store,input,stateKey,owner,state:()=>JSON.parse(objects.get(stateKey)),step:async value=>{clock+=70000;return make(options).step(value||input);},rewrite:state=>objects.set(stateKey,Buffer.from(JSON.stringify(state))),rawCount:()=>[...objects.keys()].filter(key=>key.includes('/pages/')||key.includes('/stream=')).length};
}
const finite=current=>current==='B'?'':current==='A'?'B':'A';
const cycle=current=>current==='OPAQUE_A'?'OPAQUE_B':'OPAQUE_A';
async function focused(h){
 for(let step=0;step<20;step++){if(h.objects.has(h.stateKey)&&h.owner(h.state())?.cursor)return;assert.equal((await h.step()).done,false);}
 assert.fail('fixture did not reach its cursor owner within 20 steps');
}

for(const family of families) {
 test(`${family}: cycles fail permanently before raw writes or cursor advancement after restart`,async()=>{
  for(const empty of [true,false]) {
   const h=setup(family,cycle,{empty});let failure;
   for(let step=0;step<20;step++) {
    const before=h.objects.has(h.stateKey)?h.state():null,raw=h.rawCount();
    try{assert.equal((await h.step()).done,false);}catch(error){
     failure=error;assert.equal(error.permanent,true);assert.match(error.message,/cursor/);assert.doesNotMatch(error.message,/OPAQUE/);
     assert.equal(h.rawCount(),raw);assert.equal(h.state().pages,before.pages);
     assert.equal(h.owner(h.state()).cursor,h.owner(before).cursor);assert.deepEqual(h.owner(h.state()).paginationProgress,h.owner(before).paginationProgress);break;
    }
   }
   assert.ok(failure,'two-token cycle must terminate without a page-count cap');
  }
 });
 test(`${family}: long empty finite scans are not a cycle or a fixed-page budget failure`,async()=>{
  const h=setup(family,current=>current==='149'?'':String(current===undefined?0:Number(current)+1));let result;
  for(let step=0;step<160;step++){result=await h.step();if(result.done)break;}
  assert.equal(result.done,true);assert.equal(result.failed,0);assert.ok(h.calls.length>100);
 });
 test(`${family}: absent and stale legacy progress resume without false cycles`,async()=>{
  for(const legacy of ['absent','stale']) {
   const h=setup(family,finite);await focused(h);if(legacy==='stale')await h.step();let state=h.state(),owner=h.owner(state);
   if(legacy==='absent')delete owner.paginationProgress;
   else {
    // An older worker preserves unknown fields while moving the cursor. Equality
    // with a saved anchor is not corruption when a newer worker resumes it.
    owner.cursor=owner.paginationProgress.anchor;
   }
   h.rewrite(state);let result;for(let step=0;step<12;step++){result=await h.step();if(result.done)break;}
   assert.equal(result.done,true);assert.equal(result.failed,0);
  }
 });
 test(`${family}: malformed progress rejects before a request and falsey non-string cursors reject before raw writes`,async()=>{
  const h=setup(family,finite);await focused(h);const state=h.state();h.owner(state).paginationProgress={version:1,anchor:'OPAQUE',window:'invalid',distance:'0'};h.rewrite(state);
  const calls=h.calls.length,raw=h.rawCount();await assert.rejects(h.step(),error=>error.permanent&&!error.message.includes('OPAQUE'));assert.equal(h.calls.length,calls);assert.equal(h.rawCount(),raw);
  for(const invalid of [false,0]) {
   const bad=setup(family,()=>invalid);let rejected=false;
   for(let step=0;step<5;step++){const raw=bad.rawCount();try{await bad.step();}catch(error){assert.equal(error.permanent,true);assert.equal(bad.rawCount(),raw);rejected=true;break;}}
   assert.equal(rejected,true);
  }
 });
}

test('identical finite tokens are independent across methods, files, channels, threads and cutoff runs',async()=>{
 for(const family of ['files-info','messages-replies']) {
  const h=setup(family,finite,{empty:false,multiple:true});
  for(const run of [h.input,{...h.input,runId:'next-window',cutoff:h.input.cutoff+1000}]) {
   let result;for(let step=0;step<60;step++){result=await h.step(run);if(result.done)break;}
   assert.equal(result.done,true);assert.equal(result.failed,0);assert.equal(result.channels,2);
   if(family==='files-info')assert.equal(result.files,2);else assert.equal(result.threads,2);
  }
 }
});

test('accepted raw writes survive a failed checkpoint without double-advancing pagination on retry',async()=>{
 for(const family of ['files-channels','messages-channels']) {
  const h=setup(family,finite,{empty:false}),put=h.store.put;let fail=true;
  h.store.put=async(key,bytes)=>{if(key===h.stateKey&&JSON.parse(bytes).cursor==='A'&&fail){fail=false;throw Error('checkpoint unavailable');}await put(key,bytes);};
  await assert.rejects(h.step(),/checkpoint unavailable/);assert.ok(h.rawCount()>0);assert.equal(h.state().cursor,'');assert.equal(h.state().paginationProgress,undefined);
  await h.step();assert.equal(h.state().cursor,'A');assert.deepEqual(h.state().paginationProgress,{version:1,anchor:'A',window:'2',distance:'0'});
  let result;for(let step=0;step<12;step++){result=await h.step();if(result.done)break;}assert.equal(result.done,true);
 }
});
