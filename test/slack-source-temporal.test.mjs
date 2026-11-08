import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {TestWorkflowEnvironment} from '@temporalio/testing';
import {Worker,Runtime,DefaultLogger,bundleWorkflowCode} from '@temporalio/worker';
import {buildSlackSourceWorkflows,createSlackSourceWorker,slackSourceActivities} from '../dist/src/connectors/temporal/source-worker.mjs';

test('real Temporal: file capture resumes committed checkpoints and keeps document text out of history',{
 skip:process.env.OPENCRAWL_TEST_TEMPORAL!=='1',timeout:180000,
},async t=>{
 Runtime.install({logger:new DefaultLogger('ERROR')});
 const directory=await mkdtemp(join(tmpdir(),'opencrawl-source-temporal-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const env=await TestWorkflowEnvironment.createLocal();t.after(()=>env.teardown());
 const bundlePath=join(directory,'workflows.cjs');await buildSlackSourceWorkflows(bundlePath);
 const data=new Map();let clock=1000,failed=false,requests=0;
 const binding={tenantId:'fixture',connectionId:'conn',workspaceId:'T123',provider:'slack',access:'team-public',rawPrefix:'raw/v1/source=slack/workspace=T123/connection=conn/'};
 const store={bucket:'fixture',get:async k=>data.get(k),put:async(k,v)=>{data.set(k,Buffer.from(v));if(k.endsWith('state.json')&&!failed){failed=true;throw Error('PRIVATE_PROVIDER_ERROR');}}};
 const resolve=async input=>{
  if(input.connectionId!=='conn')throw Object.assign(new Error('Scope denied'),{permanent:true});
  return {binding,store,now:()=>clock+=4000,request:async method=>{requests++;return {status:200,data:{ok:true,...(method==='conversations.list'?{channels:[{id:'C1',is_private:false}]}:method==='files.list'?{files:[{id:'F1'}],paging:{page:1,pages:1}}:{file:{id:'F1',channels:['C1'],mimetype:'text/plain'}})}};},download:async()=>({bytes:Buffer.from('PRIVATE_DOCUMENT_SENTINEL'),mediaType:'text/plain'})};
 };
 const runtime=await createSlackSourceWorker({address:env.address,namespace:'default',taskQueue:'source-test',bundlePath,resolve});
 const handle=await env.client.workflow.start('captureSlackFilesV1',{taskQueue:'source-test',workflowId:'source-fixture',args:[{connectionId:'conn'}]});
 const result=await runtime.worker.runUntil(()=>handle.result());await runtime.connection.close();
 assert.equal(result.failed,0);assert.equal(result.files,1);assert.equal(requests,3);assert.ok(failed);
 const history=await handle.fetchHistory(),raw=JSON.stringify(history);assert.doesNotMatch(raw,/PRIVATE_DOCUMENT_SENTINEL|PRIVATE_PROVIDER_ERROR/);
 for(const value of raw.matchAll(/"data":"([A-Za-z0-9+/=]+)"/g))assert.doesNotMatch(Buffer.from(value[1],'base64').toString(),/PRIVATE_DOCUMENT_SENTINEL|PRIVATE_PROVIDER_ERROR/);
 await Worker.runReplayHistory({workflowBundle:{codePath:bundlePath}},history);
 const messageData=new Map();let historyCalls=0;
 const messages=await createSlackSourceWorker({address:env.address,namespace:'default',taskQueue:'history-test',bundlePath,resolve:async()=>({binding,store:{bucket:'fixture',get:async k=>messageData.get(k),put:async(k,v)=>messageData.set(k,v)},now:()=>clock+=70000,request:async method=>({status:200,data:{ok:true,...(method==='conversations.list'?{channels:[{id:'C1',is_private:false}]}:{messages:++historyCalls===1?[{ts:'1.000001',reply_count:1,text:'PRIVATE_HISTORY_SENTINEL'}]:[{ts:'2.000001',thread_ts:'1.000001',text:'PRIVATE_REPLY_SENTINEL'}]})}})})});
 const messageHandle=await env.client.workflow.start('captureSlackMessagesV1',{taskQueue:'history-test',workflowId:'history-fixture',args:[{connectionId:'conn'}]});
 const messageResult=await messages.worker.runUntil(()=>messageHandle.result());await messages.connection.close();
 assert.equal(messageResult.failed,0);assert.equal(messageResult.emitted,3);assert.equal(historyCalls,2);
 const messageHistory=await messageHandle.fetchHistory(),serialized=JSON.stringify(messageHistory);
 assert.doesNotMatch(serialized,/PRIVATE_HISTORY_SENTINEL|PRIVATE_REPLY_SENTINEL/);
 for(const value of serialized.matchAll(/"data":"([A-Za-z0-9+/=]+)"/g))assert.doesNotMatch(Buffer.from(value[1],'base64').toString(),/PRIVATE_HISTORY_SENTINEL|PRIVATE_REPLY_SENTINEL/);
 await Worker.runReplayHistory({workflowBundle:{codePath:bundlePath}},messageHistory);
 const referenceData=new Map();
 const references=await createSlackSourceWorker({address:env.address,namespace:'default',taskQueue:'references-test',bundlePath,resolve:async()=>({binding,store:{bucket:'fixture',get:async k=>referenceData.get(k),put:async(k,v)=>referenceData.set(k,v)},now:()=>clock+=70000,request:async(method,q)=>({status:200,data:{ok:true,...(method==='conversations.info'?{channel:{id:q.channel,is_private:false}}:{messages:[{ts:q.oldest,text:'PRIVATE_REFERENCE_SENTINEL button'}]})}})})});
 const referenceHandle=await env.client.workflow.start('captureSlackMessageReferencesV1',{taskQueue:'references-test',workflowId:'reference-fixture',args:[{connectionId:'conn',references:[{channelId:'C1',ts:'3.000001'}]}]});
 const referenceResult=await references.worker.runUntil(()=>referenceHandle.result());await references.connection.close();
 assert.equal(referenceResult.failed,0);assert.equal(referenceResult.emitted,1);
 const referenceHistory=await referenceHandle.fetchHistory(),referenceSerialized=JSON.stringify(referenceHistory);
 assert.doesNotMatch(referenceSerialized,/PRIVATE_REFERENCE_SENTINEL/);
 for(const value of referenceSerialized.matchAll(/"data":"([A-Za-z0-9+/=]+)"/g))assert.doesNotMatch(Buffer.from(value[1],'base64').toString(),/PRIVATE_REFERENCE_SENTINEL/);
 await Worker.runReplayHistory({workflowBundle:{codePath:bundlePath}},referenceHistory);

});

test('real Temporal: Slack cursor progress survives 100-step continuations and rejects cycles at the existing activity boundary',{
 skip:process.env.OPENCRAWL_TEST_TEMPORAL!=='1',timeout:180000,
},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'opencrawl-source-pagination-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const env=await TestWorkflowEnvironment.createLocal();t.after(()=>env.teardown());
 const bundlePath=join(directory,'workflows.cjs');await buildSlackSourceWorkflows(bundlePath);
 // Frozen released 0.2.19 workflow bytes, retained unchanged from d217a96.
 // Both those bytes and the compiled TypeScript must replay the same commands.
 const legacyPath=new URL('./fixtures/legacy-source-workflows.cjs',import.meta.url);
 const workflow=await readFile(legacyPath);
 assert.equal(createHash('sha256').update(workflow).digest('hex'),'1aeefa60e1f98f4bd7c0f568c5557098fad61030d590f1ad93d0eef1e4803599');
 const legacy=await bundleWorkflowCode({workflowsPath:fileURLToPath(legacyPath)});
 const binding={tenantId:'fixture',connectionId:'conn',workspaceId:'T123',provider:'slack',access:'team-public',rawPrefix:'raw/v1/source=slack/workspace=T123/connection=conn/'};
 for(const [kind,workflowType] of [['files','captureSlackFilesV1'],['messages','captureSlackMessagesV1']]) {
  const objects=new Map(),taskQueue='source-pagination-'+kind,runId='durable-'+kind;
  const stateKey=binding.rawPrefix+`capture/${kind}-v1/${runId}/state.json`;
  let clock=1800000000000,calls=0,beforeLast,checkpointAfterContinuation;
  const rawPages=()=>[...objects.keys()].filter(key=>key.includes('/pages/')).length;
  const options={binding,store:{bucket:'fixture',get:async key=>objects.get(key),put:async(key,bytes)=>objects.set(key,Buffer.from(bytes))},now:()=>clock+=70000,request:async(method,query)=>{
   assert.equal(method,'conversations.list');calls++;
   beforeLast={state:JSON.parse(objects.get(stateKey)),rawPages:rawPages()};
   if(calls===101)checkpointAfterContinuation=beforeLast.state;
   const current=query.cursor===undefined?-1:Number(query.cursor.split(':')[1]);
   const next=current<110?current+1:106;
   return {status:200,data:{ok:true,channels:[],response_metadata:{next_cursor:'OPAQUE_SLACK_CURSOR:'+next}}};
  }};
  const worker=await Worker.create({connection:env.nativeConnection,taskQueue,workflowBundle:{codePath:bundlePath},activities:slackSourceActivities({resolve:async()=>options}),shutdownGraceTime:'5 seconds'});
  const handle=await env.client.workflow.start(workflowType,{taskQueue,workflowId:taskQueue,args:[{connectionId:'conn',runId,cutoff:1800000000000}]});
  await worker.runUntil(()=>assert.rejects(handle.result(),error=>{
   assert.equal(error.cause?.name,'ActivityFailure');assert.equal(error.cause?.cause?.type,'InvalidSlackSource');assert.equal(error.cause?.cause?.nonRetryable,true);return true;
  }));
  assert.ok(calls>100&&calls<150);assert.equal(checkpointAfterContinuation.pages,100);
  assert.equal(checkpointAfterContinuation.runId,runId);assert.equal(checkpointAfterContinuation.cutoff,1800000000000);
  assert.equal(typeof checkpointAfterContinuation.paginationProgress.window,'string');
  const saved=JSON.parse(objects.get(stateKey));assert.equal(saved.pages,calls-1);
  assert.equal(saved.cursor,beforeLast.state.cursor);assert.deepEqual(saved.paginationProgress,beforeLast.state.paginationProgress);
  assert.equal(rawPages(),beforeLast.rawPages,'offending response is never archived');
  let execution=handle.firstExecutionRunId,runs=0;
  while(execution) {
   const history=await env.client.workflow.getHandle(taskQueue,execution).fetchHistory();
   assert.ok(!history.events.some(event=>event.workflowTaskFailedEventAttributes));
   assert.ok(!history.events.some(event=>event.markerRecordedEventAttributes));
   function sanitized(value) {
    if(value instanceof Uint8Array)assert.doesNotMatch(Buffer.from(value).toString(),/OPAQUE_SLACK_CURSOR/);
    else if(value&&typeof value==='object')for(const child of Object.values(value))sanitized(child);
   }
   sanitized(history);
   for(const workflowBundle of [{codePath:bundlePath},legacy])await Worker.runReplayHistory({workflowBundle},history);
   const continued=history.events.find(event=>event.workflowExecutionContinuedAsNewEventAttributes)?.workflowExecutionContinuedAsNewEventAttributes;
   if(!continued)assert.ok(history.events.some(event=>event.workflowExecutionFailedEventAttributes));
   execution=continued?.newExecutionRunId;assert.ok(++runs<4);
  }
  assert.ok(runs>=2,'the corrected guard must survive a real continue-as-new');
 }
});
