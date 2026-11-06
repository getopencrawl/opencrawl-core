import {Worker,NativeConnection,bundleWorkflowCode} from '@temporalio/worker';
import {Context,heartbeat} from '@temporalio/activity';
import {ApplicationFailure} from '@temporalio/common';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createSlackMessageCapture} from '../slack-source-messages.mjs';
import {createSlackFileCapture} from '../slack-source-files.mjs';
export async function buildSlackSourceWorkflows(path) {
 const {code}=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL('./source-workflows.cjs',import.meta.url))});await writeFile(path,code);
}
export function slackSourceActivities({resolve}) {
 async function capture(input,makeCapture) {
  const timer=setInterval(()=>heartbeat(),10000);
  try {
   heartbeat();const resolved=await resolve(input);
   const operation=makeCapture({...resolved,checkActive:async()=>{
    const current=await resolve(input);
    if(JSON.stringify(current.binding)!==JSON.stringify(resolved.binding)||current.store.bucket!==resolved.store.bucket||current.sourceIdentity!==resolved.sourceIdentity)throw Object.assign(new Error('Slack source authorization changed'),{permanent:true});
    Context.current().cancellationSignal.throwIfAborted();
   }});
   return await operation.step(input);
  } catch(error){if(error.permanent)throw ApplicationFailure.nonRetryable('Slack source rejected invalid scope or input','InvalidSlackSource');throw new Error('Slack source activity failed; inspect scoped capture checkpoint');}
  finally{clearInterval(timer);}
 }
 return {captureFilePage:input=>capture(input,createSlackFileCapture),captureMessagePage:input=>capture(input,createSlackMessageCapture)};
}
export async function createSlackSourceWorker({address,namespace,taskQueue,bundlePath,resolve}) {
 if(!address||!namespace||!taskQueue||!bundlePath)throw new Error('Explicit source worker configuration required');
 const connection=await NativeConnection.connect({address});
 try{const worker=await Worker.create({connection,namespace,taskQueue,workflowBundle:{codePath:bundlePath},activities:slackSourceActivities({resolve}),maxConcurrentActivityTaskExecutions:2,maxConcurrentWorkflowTaskExecutions:4,shutdownGraceTime:'30 seconds'});return {connection,worker};}
 catch(error){await connection.close();throw error;}
}
