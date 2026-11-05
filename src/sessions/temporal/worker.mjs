import {Worker,NativeConnection,bundleWorkflowCode} from '@temporalio/worker';
import {Context,heartbeat} from '@temporalio/activity';
import {ApplicationFailure} from '@temporalio/common';
import {fileURLToPath} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {createSessionPipeline} from '../indexer.mjs';
export async function buildSessionWorkflows(path) {
  const {code}=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL('./workflows.cjs',import.meta.url))});
  await writeFile(path,code);
}
export function sessionActivities({resolve}) {
  async function operation(input,action) {
    const pulse=setInterval(()=>heartbeat(),10000);
    try {
      heartbeat();
      const resolved=await resolve(input);
      const pipeline=createSessionPipeline({...resolved,checkActive:async()=>{
        const current=await resolve(input);
        if(current.prefix!==resolved.prefix||current.store.bucket!==resolved.store.bucket||current.search.identity!==resolved.search.identity||JSON.stringify(current.principal)!==JSON.stringify(resolved.principal))throw Object.assign(new Error('Session binding changed'),{permanent:true});
        if(Context.current().cancellationSignal.aborted)throw new Error('Session indexing cancelled');
      }});
      return await pipeline[action](input);
    } catch(error) {
      // Never put transcript fragments, parser messages or provider bodies in history.
      if(error.permanent)throw ApplicationFailure.nonRetryable('Session source scope denied','InvalidSessionInput');
      throw ApplicationFailure.retryable('Session indexing operation failed','SessionProcessingFailed');
    } finally {clearInterval(pulse);}
  }
  return {listSessionPage:input=>operation(input,'listPage'),indexSessionObject:input=>operation(input,'processObject')};
}
export async function createSessionWorker({address,namespace,taskQueue,bundlePath,resolve,maxConcurrentActivityTaskExecutions=2}) {
  if(!address||!namespace||!taskQueue||!bundlePath)throw new Error('Explicit Temporal worker configuration required');
  const connection=await NativeConnection.connect({address});
  try {
    const worker=await Worker.create({connection,namespace,taskQueue,workflowBundle:{codePath:bundlePath},activities:sessionActivities({resolve}),
      maxConcurrentActivityTaskExecutions,maxConcurrentWorkflowTaskExecutions:2,shutdownGraceTime:'30 seconds'});
    return {worker,connection};
  } catch(error){await connection.close();throw error;}
}
