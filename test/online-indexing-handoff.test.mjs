import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {MockActivityEnvironment,TestWorkflowEnvironment} from '@temporalio/testing';
import {Worker,bundleWorkflowCode,Runtime,DefaultLogger} from '@temporalio/worker';
import {fileURLToPath} from 'node:url';
import {validateOnlineIndexingHandoff,onlineIndexingHandoffHash} from '../dist/src/state/online-indexing-handoff.mjs';
import {sessionIndexingGeneration,sessionCatchupMarker} from '../dist/src/sessions/temporal/handoff.mjs';
import {activateSessionIndexing} from '../dist/src/sessions/temporal/client.mjs';
import {sessionActivities} from '../dist/src/sessions/temporal/worker.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const handoff=()=>({namespace:'online-fixture',epoch:'11111111-1111-4111-8111-111111111111',targetId:sha('target'),sourceSetHash:sha('sources'),closedFrontiersHash:sha('closed'),retirementHash:sha('retired'),authorityReceiptHash:sha('authority')});
const searchIdentity='fixture-index',jobId='fixture-job',binding={sourceId:'fixture-source',taskQueue:'fixture-queue',prefix:'sessions/fixture/v1'};
function fixture() {
 const proof=handoff(),markers=new Map(),starts=[],effects=[];
 const state={namespace:proof.namespace,indexingReceipts:{read:async key=>markers.get(key)??null,put:async(key,value)=>markers.set(key,value)}};
 const client={schedule:{getHandle:()=>({describe:async()=>({action:{workflowType:'indexSessionsV1',taskQueue:binding.taskQueue,args:[{sourceId:binding.sourceId}]}}),pause:async()=>effects.push('pause')})},workflow:{start:async(type,input)=>starts.push({type,...input})}};
 const reader={read:async()=>proof};
 const input={...binding,state,store:{bucket:'fixture-bucket'},generation:sessionIndexingGeneration(searchIdentity,jobId,proof),onlineHandoff:{...reader,searchIdentity,jobId}};
 return {proof,markers,starts,effects,state,client,reader,input};
}

test('online handoff canonical validation freezes exact namespace/epoch/provenance without granting admission',()=>{
 const value=handoff(),copy=validateOnlineIndexingHandoff(value,value.namespace),hash=onlineIndexingHandoffHash(value);
 assert.ok(Object.isFrozen(copy));value.epoch=randomUUID();assert.notEqual(copy.epoch,value.epoch);assert.equal(onlineIndexingHandoffHash(copy),hash);
 assert.equal(onlineIndexingHandoffHash(Object.fromEntries(Object.entries(copy).reverse())),hash);
 for(const bad of [null,{...copy,unexpected:true},{...copy,namespace:'bad\nnamespace'},{...copy,epoch:'bad'},{...copy,closedFrontiersHash:'123'},{...copy,authorityReceiptHash:null}])assert.throws(()=>validateOnlineIndexingHandoff(bad));
 assert.throws(()=>validateOnlineIndexingHandoff(copy,'foreign'));
 assert.equal(sessionIndexingGeneration(searchIdentity,jobId),sha(JSON.stringify([searchIdentity,jobId,'postgres-app-state-v1'])));
 assert.notEqual(sessionIndexingGeneration(searchIdentity,jobId,copy),sessionIndexingGeneration(searchIdentity,jobId));
 assert.notEqual(sessionIndexingGeneration(searchIdentity,jobId,copy),sessionIndexingGeneration(searchIdentity,jobId,{...copy,retirementHash:sha('changed')}));
});

test('online session activation cannot reuse either legacy marker and retries only its deterministic new workflow',async()=>{
 const f=fixture();
 for(const generation of [sha(JSON.stringify([searchIdentity,jobId])),sessionIndexingGeneration(searchIdentity,jobId)]){
  const old=sessionCatchupMarker({...binding,generation});f.markers.set(old.markerKey,old.marker);
 }
 const first=await activateSessionIndexing(f.client,f.input);assert.equal(first.completed,false);assert.equal(f.starts.length,1);
 const again=await activateSessionIndexing(f.client,f.input);assert.equal(again.workflowId,first.workflowId);assert.equal(f.starts[1].workflowId,f.starts[0].workflowId);
 assert.deepEqual(f.starts[0].args,[{sourceId:binding.sourceId,generation:f.input.generation}]);assert.equal(f.starts[0].type,'reconcileSessionsV2');
 const current=sessionCatchupMarker(f.input);f.markers.set(current.markerKey,current.marker);
 assert.equal((await activateSessionIndexing(f.client,f.input)).completed,true);assert.equal(f.starts.length,2);assert.equal(f.markers.size,3);
});

test('wrong online generation/scope and changing trusted handoff cannot dispatch or credit completion',async()=>{
 const f=fixture();
 await assert.rejects(activateSessionIndexing(f.client,{...f.input,generation:sessionIndexingGeneration(searchIdentity,jobId)}),/generation differs/);
 await assert.rejects(activateSessionIndexing(f.client,{...f.input,onlineHandoff:{...f.input.onlineHandoff,read:async()=>({...f.proof,namespace:'other'})}}),/Invalid online/);
 assert.equal(f.effects.length,0);assert.equal(f.starts.length,0);
 const current=sessionCatchupMarker(f.input);f.markers.set(current.markerKey,current.marker);let reads=0;
 f.input.onlineHandoff.read=async()=>++reads===1?f.proof:{...f.proof,authorityReceiptHash:sha('new authority')};
 await assert.rejects(activateSessionIndexing(f.client,f.input),/generation differs|handoff changed/);assert.equal(f.starts.length,0);
});

test('real completion activity accepts current epoch and exact prior generations only into their own markers',async()=>{
 const f=fixture(),environment=new MockActivityEnvironment({taskQueue:binding.taskQueue});
 const resolve=async()=>({state:f.state,store:f.input.store,prefix:binding.prefix,search:{identity:searchIdentity},jobId,onlineHandoff:f.reader});
 const activity=sessionActivities({resolve}).completeSessionCatchup;
 for(const generation of [f.input.generation,sessionIndexingGeneration(searchIdentity,jobId),sha(JSON.stringify([searchIdentity,jobId]))]){
  await environment.run(activity,{sourceId:binding.sourceId,generation});const marker=sessionCatchupMarker({...binding,generation});assert.deepEqual(f.markers.get(marker.markerKey),marker.marker);
 }
 assert.equal(f.markers.size,3);
 await assert.rejects(environment.run(activity,{sourceId:binding.sourceId,generation:sha('unrelated')}),error=>error.type==='InvalidSessionInput'&&error.nonRetryable===true);
 assert.equal(f.markers.size,3);
});

test('completion activity rereads trusted worker provenance and cannot write a stale generation marker',async()=>{
 const f=fixture(),environment=new MockActivityEnvironment({taskQueue:binding.taskQueue});let calls=0;
 const resolve=async()=>({state:f.state,store:f.input.store,prefix:binding.prefix,search:{identity:searchIdentity},jobId,onlineHandoff:{read:async()=>++calls===1?f.proof:{...f.proof,targetId:sha('other target')}}});
 await assert.rejects(environment.run(sessionActivities({resolve}).completeSessionCatchup,{sourceId:binding.sourceId,generation:f.input.generation}),error=>error.type==='InvalidSessionInput'&&error.nonRetryable===true);
 assert.equal(f.markers.size,0);
});


test('completion activity rejects malformed or foreign trusted admission without exposing its payload',async()=>{
 const f=fixture(),environment=new MockActivityEnvironment({taskQueue:binding.taskQueue});
 for(const proof of [{...f.proof,namespace:'foreign'},{...f.proof,authorityReceiptHash:'PRIVATE_INVALID_PROOF'}]){
  const resolve=async()=>({state:f.state,store:f.input.store,prefix:binding.prefix,search:{identity:searchIdentity},jobId,onlineHandoff:{read:async()=>proof}});
  await assert.rejects(environment.run(sessionActivities({resolve}).completeSessionCatchup,{sourceId:binding.sourceId,generation:f.input.generation}),error=>error.type==='InvalidSessionInput'&&error.nonRetryable===true&&!error.message.includes('PRIVATE'));
 }
 assert.equal(f.markers.size,0);
});

test('real Temporal online session catchup writes its new marker only after successful workflow work',{skip:process.env.OPENCRAWL_TEST_TEMPORAL!=='1',timeout:120000},async t=>{
 Runtime.install({logger:new DefaultLogger('ERROR')});const f=fixture(),env=await TestWorkflowEnvironment.createLocal(process.env.OPENCRAWL_TEST_TEMPORAL_BINARY?{server:{executable:{type:'existing-path',path:process.env.OPENCRAWL_TEST_TEMPORAL_BINARY}}}:{});t.after(()=>env.teardown());
 const workflowBundle=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL('../dist/src/sessions/temporal/workflows.cjs',import.meta.url))});let processed=0;
 const resolve=async()=>({state:f.state,store:f.input.store,prefix:binding.prefix,search:{identity:searchIdentity},jobId,onlineHandoff:f.reader});
 const worker=await Worker.create({connection:env.nativeConnection,taskQueue:binding.taskQueue,workflowBundle,activities:{listSessionPage:async()=>({keys:['raw-fixture'],cursor:null}),indexSessionObject:async()=>{processed++;assert.equal(f.markers.size,0);return {records:1};},completeSessionCatchup:sessionActivities({resolve}).completeSessionCatchup}});
 const activation=await activateSessionIndexing(env.client,f.input);assert.equal(activation.completed,false);assert.equal(f.markers.size,0);
 const handle=env.client.workflow.getHandle(activation.workflowId);await worker.runUntil(()=>handle.result());assert.equal(processed,1);
 assert.equal((await handle.describe()).status.name,'COMPLETED');const current=sessionCatchupMarker(f.input);assert.deepEqual(f.markers.get(current.markerKey),current.marker);
 await Worker.runReplayHistory({workflowBundle},await handle.fetchHistory());assert.equal((await activateSessionIndexing(env.client,f.input)).completed,true);assert.equal(processed,1);
});


test('completion activity rejects current authorization scope drift before marker write',async()=>{
 const f=fixture(),environment=new MockActivityEnvironment({taskQueue:binding.taskQueue});let calls=0;
 const resolve=async()=>({state:f.state,store:f.input.store,prefix:binding.prefix,search:{identity:searchIdentity},jobId,onlineHandoff:f.reader,principal:{tenantId:'org_fixture',userId:++calls===1?'user_first':'user_changed'}});
 await assert.rejects(environment.run(sessionActivities({resolve}).completeSessionCatchup,{sourceId:binding.sourceId,generation:f.input.generation}),error=>error.type==='InvalidSessionInput'&&error.nonRetryable===true);assert.equal(f.markers.size,0);
});
