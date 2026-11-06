import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TestWorkflowEnvironment} from '@temporalio/testing';
import {Worker,Runtime,DefaultLogger} from '@temporalio/worker';
import {buildSessionWorkflows,createSessionWorker} from '../src/sessions/temporal/worker.mjs';
import {ensureSessionSchedule} from '../src/sessions/temporal/client.mjs';
import {createSessionIngest} from '../src/sessions/ingest.mjs';
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
