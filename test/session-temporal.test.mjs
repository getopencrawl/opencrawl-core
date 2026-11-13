import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TestWorkflowEnvironment} from '@temporalio/testing';
import {Worker,Runtime,DefaultLogger} from '@temporalio/worker';
import {buildSessionWorkflows,createSessionWorker} from '../dist/src/sessions/temporal/worker.mjs';
import {ensureSessionSchedule} from '../dist/src/sessions/temporal/client.mjs';
import {createSessionIngest} from '../dist/src/sessions/ingest.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';

test('real Temporal: retry, restart with queued work, durable schedule and history replay keep content outside history',{
 skip:process.env.OPENCRAWL_TEST_TEMPORAL!=='1',timeout:180000,
},async t=>{
 Runtime.install({logger:new DefaultLogger('ERROR')});
 const directory=await mkdtemp(join(tmpdir(),'opencrawl-session-temporal-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const env=await TestWorkflowEnvironment.createLocal();t.after(()=>env.teardown());
 const bundlePath=join(directory,'workflows.cjs');await buildSessionWorkflows(bundlePath);
 const documents=new Map();let attempts=0;
 const store={...memorySessionStore(),bucket:'fixture'};
 const principal={tenantId:'single-tenant',userId:'owner'},prefix='sessions/selfhost/v1';
 const search={identity:'test-index',ensureIndex:async()=>{},putDocuments:async docs=>{
  for(const d of docs)documents.set(d.id,d.document);
  if(++attempts===1)throw new Error('private provider payload MUST_NOT_ENTER_HISTORY');
 }};
 const resolve=async input=>{if(input.sourceId!=='fixture')throw Object.assign(new Error('Scope denied'),{permanent:true});return {store,prefix,search,principal};};
 const ingest=createSessionIngest({store,prefix});
 const batch={schemaVersion:1,owner:principal,harness:'codex',origin:'desktop',installationId:'test',sessionId:'test',events:[{id:'event',kind:'message',data:{role:'user',content:'PRIVATE_TRANSCRIPT_SENTINEL'}}],attachments:[]};
 await ingest.putBatch(principal,batch);
 const options={address:env.address,namespace:'default',taskQueue:'session-test',bundlePath,resolve};
 let runtime=await createSessionWorker(options);
 const handle=await env.client.workflow.start('indexSessionsV1',{taskQueue:options.taskQueue,workflowId:'retry-fixture',args:[{sourceId:'fixture'}]});
 const result=await runtime.worker.runUntil(()=>handle.result());await runtime.connection.close();
 assert.equal(result.indexed,1);assert.equal(documents.size,1);assert.equal(attempts,2);
 const history=await handle.fetchHistory();const raw=JSON.stringify(history);
 assert.ok(!raw.includes('PRIVATE_TRANSCRIPT_SENTINEL')&&!raw.includes('MUST_NOT_ENTER_HISTORY'));
 // Inspect decoded payload bytes too, since JSON serializes protobuf bytes as base64.
 for(const value of raw.matchAll(/"data":"([A-Za-z0-9+/=]+)"/g))assert.doesNotMatch(Buffer.from(value[1],'base64').toString(),/PRIVATE_TRANSCRIPT_SENTINEL|MUST_NOT_ENTER_HISTORY/);
 await Worker.runReplayHistory({workflowBundle:{codePath:bundlePath}},history);
 // No worker is running when the durable schedule is created and initially triggered.
 await ingest.putBatch(principal,{...batch,sessionId:'later',events:[{...batch.events[0],id:'later'}]});
 const scheduleId=await ensureSessionSchedule(env.client,{sourceId:'fixture',taskQueue:options.taskQueue});
 assert.equal(await ensureSessionSchedule(env.client,{sourceId:'fixture',taskQueue:options.taskQueue}),scheduleId);
 const schedule=env.client.schedule.getHandle(scheduleId);await schedule.pause('isolated test');

 let description;
 for(let i=0;i<50;i++){description=await schedule.describe();if(description.info.recentActions.length)break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(description.spec.intervals[0].every,300000);
 const action=description.info.recentActions.at(-1).action;
 const queued=env.client.workflow.getHandle(action.workflow.workflowId);
 runtime=await createSessionWorker(options);
 await runtime.worker.runUntil(()=>queued.result());await runtime.connection.close();
 assert.equal(documents.size,2);assert.equal(attempts,3);
 await schedule.delete();
});

test('real Temporal direct handoff survives server and worker restart, dedupes, retries and cuts over once',{
 skip:process.env.OPENCRAWL_TEST_TEMPORAL!=='1',timeout:180000,
},async t=>{
 const {startSessionObjectIndexing,sessionIndexingGeneration,activateSessionIndexing}=await import('../dist/src/sessions/temporal/client.mjs');
 const directory=await mkdtemp(join(tmpdir(),'opencrawl-direct-temporal-'));
 const server={dbFilename:join(directory,'temporal.sqlite')};
 let env=await TestWorkflowEnvironment.createLocal({server});t.after(async()=>{await env.teardown();await rm(directory,{recursive:true,force:true});});
 const bundlePath=join(directory,'workflows.cjs');await buildSessionWorkflows(bundlePath);
 const documents=new Map(),memories=new Map();let attempts=0,lists=0;
 const store={...memorySessionStore(),bucket:'direct-fixture'},list=store.listPage;
 // The memory visibility check lists only one owner's control prefix. Count
 // whole-capture inventory scans separately from that required authorization.
 store.listPage=async(...args)=>{if(!args[0].includes('/controls/'))lists++;return list(...args);};
 const principal={tenantId:'tenant',userId:'author'},prefix='capture',jobId='direct-fixture';
 const search={identity:'direct-search',ensureIndex:async()=>{},putDocuments:async docs=>{
  for(const doc of docs)documents.set(doc.id,doc.document);
  if(++attempts===1)throw new Error('PRIVATE_PROVIDER_FAILURE');
 },memories:{putSnapshot:async snapshot=>{memories.set(snapshot.snapshotId,snapshot);return snapshot.files.length;}}};
 const resolve=async input=>{assert.equal(input.sourceId,'direct-fixture');return {store,prefix,search,principal,jobId};};
 const binding={sourceId:'direct-fixture',taskQueue:'direct-test',generation:sessionIndexingGeneration(search.identity,jobId)};
 const original={schemaVersion:1,owner:principal,harness:'codex',origin:'desktop',installationId:'device',sessionId:'session',events:[{id:'event',kind:'message',data:{role:'user',content:'PRIVATE_CAPTURE_SENTINEL'}}],attachments:[]};
 let unavailable=true,accepted;
 const ingest=createSessionIngest({store,prefix,scheduleIndexing:async key=>{
  if(unavailable)throw Error('synthetic failure after durable storage');
  accepted=await startSessionObjectIndexing(env.client,{...binding,key});
 }});
 await assert.rejects(ingest.putBatch(principal,original),/after durable storage/);
 assert.equal([...store.data.keys()].filter(key=>key.endsWith('.json.gz')).length,1);
 unavailable=false;await ingest.putBatch(principal,original);
 const firstId=accepted.activityId,firstRun=accepted.activityRunId;
 await ingest.putBatch(principal,original);assert.equal(accepted.activityId,firstId);assert.equal(accepted.activityRunId,firstRun);
 // Accepted without a worker, then persisted through a full Temporal server restart.
 await env.teardown();env=await TestWorkflowEnvironment.createLocal({server});
 accepted=env.client.activity.getHandle(firstId,firstRun);
 const options={address:env.address,namespace:'default',taskQueue:binding.taskQueue,bundlePath,resolve};
 let runtime=await createSessionWorker(options),before=lists;
 await runtime.worker.runUntil(()=>accepted.result());await runtime.connection.close();
 assert.equal(documents.size,1);assert.equal(attempts,2);assert.equal(lists,before);
 const described=await accepted.describe({includeInput:true,includeLastFailure:true});
 assert.equal(described.status,'COMPLETED');assert.equal(described.retryPolicy.maximumAttempts,0);
 assert.doesNotMatch(JSON.stringify(await described.getInput()),/PRIVATE_CAPTURE_SENTINEL/);
 await ingest.putBatch(principal,original);assert.equal(accepted.activityRunId,firstRun);assert.equal(attempts,2);
 // A new accepted memory snapshot waits for a fresh worker, just like a session batch.
 await ingest.putMemorySnapshot(principal,{schemaVersion:1,owner:principal,harness:'codex',installationId:'device',host:'fixture',generation:1,files:[{path:'MEMORY.md',project:'',modifiedAt:'2026-11-13T00:00:00Z',text:'PRIVATE_MEMORY_SENTINEL'}]});
 runtime=await createSessionWorker(options);before=lists;
 await runtime.worker.runUntil(()=>accepted.result());await runtime.connection.close();assert.equal(memories.size,1);assert.equal(lists,before);
 // Legacy capture without handoff is recovered once; the recurring schedule is paused.
 await createSessionIngest({store,prefix}).putBatch(principal,{...original,sessionId:'historical',events:[{...original.events[0],id:'historical'}]});
 const scheduleId=await ensureSessionSchedule(env.client,binding);
 const activation=await activateSessionIndexing(env.client,{...binding,store,prefix});
 assert.equal((await env.client.schedule.getHandle(scheduleId).describe()).state.paused,true);
 runtime=await createSessionWorker(options);
 await runtime.worker.runUntil(()=>env.client.workflow.getHandle(activation.workflowId).result());await runtime.connection.close();
 assert.equal(documents.size,2);assert.equal(JSON.parse(store.data.get(activation.markerKey)).completed,true);
 const again=await activateSessionIndexing(env.client,{...binding,store,prefix});assert.deepEqual(again,{...activation,completed:true});
 const completed=(await env.client.workflow.getHandle(again.workflowId).describe()).status.name;assert.equal(completed,'COMPLETED');
 // Completion survives Temporal history retention. A missing marker requires
 // a real catch-up, even when no retained execution can explain the old state.
 await env.client.connection.workflowService.deleteWorkflowExecution({namespace:'default',workflowExecution:{workflowId:again.workflowId}});
 assert.equal((await activateSessionIndexing(env.client,{...binding,store,prefix})).completed,true);
 await store.delete(activation.markerKey);
 const recovered=await activateSessionIndexing(env.client,{...binding,store,prefix});assert.equal(recovered.completed,false);
 runtime=await createSessionWorker(options);
 await runtime.worker.runUntil(()=>env.client.workflow.getHandle(recovered.workflowId).result());await runtime.connection.close();
 assert.equal(JSON.parse(store.data.get(activation.markerKey)).completed,true);
 await env.client.schedule.getHandle(scheduleId).delete();
});

test('bundled Temporal 1.29.1 durably indexes one object without standalone APIs or inventory scans',{
 skip:process.env.OPENCRAWL_TEST_TEMPORAL!=='1',timeout:180000,
},async t=>{
 const {startSessionObjectWorkflow,sessionIndexingScheduler,sessionIndexingGeneration}=await import('../dist/src/sessions/temporal/client.mjs');
 const directory=await mkdtemp(join(tmpdir(),'opencrawl-selfhost-temporal-'));
 const server={dbFilename:join(directory,'temporal.sqlite'),executable:{type:'cached-download',version:'v1.5.1'}};
 let env=await TestWorkflowEnvironment.createLocal({server});t.after(async()=>{await env.teardown();await rm(directory,{recursive:true,force:true});});
 assert.equal((await env.client.connection.workflowService.getSystemInfo({})).serverVersion,'1.29.1');
 const bundlePath=join(directory,'workflows.cjs');await buildSessionWorkflows(bundlePath);
 const store={...memorySessionStore(),bucket:'selfhost-fixture'},principal={tenantId:'organization',userId:'user_123'},prefix='capture';
 let attempts=0,scans=0;const documents=new Map();
 const list=store.listPage;store.listPage=async(...args)=>{scans++;return list(...args);};
 const search={identity:'selfhost-index',ensureIndex:async()=>{},putDocuments:async docs=>{
  for(const doc of docs)documents.set(doc.id,doc.document);
  if(++attempts===1)throw Error('PRIVATE_PROVIDER_ERROR');
 }};
 const binding={sourceId:'selfhost-fixture',taskQueue:'selfhost-test',generation:sessionIndexingGeneration(search.identity,'sessions-v1')};
 const scheduler=sessionIndexingScheduler({...binding,address:env.address,namespace:'default',mode:'workflow'});
 let accepted;
 const ingest=createSessionIngest({store,prefix,scheduleIndexing:async key=>{accepted=await scheduler.schedule(key);}});
 const batch={schemaVersion:1,owner:principal,harness:'codex',origin:'desktop',installationId:'device',sessionId:'session',events:[{id:'event',kind:'message',data:{text:'PRIVATE_SELFHOST_CONTENT'}}],attachments:[]};
 await ingest.putBatch(principal,batch);
 const workflowId=accepted.workflowId,firstRun=(await accepted.describe()).runId;
 await ingest.putBatch(principal,batch);assert.equal((await accepted.describe()).runId,firstRun);
 await scheduler.close();await env.teardown();env=await TestWorkflowEnvironment.createLocal({server});
 const options={address:env.address,namespace:'default',taskQueue:binding.taskQueue,bundlePath,resolve:async input=>{
  if(input.sourceId!==binding.sourceId)throw Object.assign(Error('scope'),{permanent:true});return {store,prefix,principal,search};
 }};
 let runtime=await createSessionWorker(options);const before=scans;
 const handle=env.client.workflow.getHandle(workflowId);
 await runtime.worker.runUntil(()=>handle.result());await runtime.connection.close();
 assert.equal(documents.size,1);assert.equal(attempts,2);assert.equal(scans,before);
 const key=[...store.data.keys()].find(key=>key.endsWith('.json.gz'));
 const completed=await startSessionObjectWorkflow(env.client,{...binding,key});
 assert.equal((await completed.describe()).runId,firstRun);
 // Scope violations fail visibly; a resubmission gets another repairable run.
 const denied=await startSessionObjectWorkflow(env.client,{...binding,key:'outside.json.gz'});
 runtime=await createSessionWorker(options);
 await runtime.worker.runUntil(async()=>assert.rejects(denied.result()));await runtime.connection.close();
 assert.equal((await denied.describe()).status.name,'FAILED');
 const deniedRun=(await denied.describe()).runId;
 const retried=await startSessionObjectWorkflow(env.client,{...binding,key:'outside.json.gz'});
 assert.notEqual((await retried.describe()).runId,deniedRun);
 await retried.terminate('isolated invalid-source test');
 assert.equal(documents.size,1);assert.equal(scans,before);
});
