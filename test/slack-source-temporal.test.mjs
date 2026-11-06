import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TestWorkflowEnvironment} from '@temporalio/testing';
import {Worker,Runtime,DefaultLogger} from '@temporalio/worker';
import {buildSlackSourceWorkflows,createSlackSourceWorker} from '../src/connectors/temporal/source-worker.mjs';

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
});
