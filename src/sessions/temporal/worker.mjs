import {Worker,NativeConnection,bundleWorkflowCode} from '@temporalio/worker';
import {Context,heartbeat} from '@temporalio/activity';
import {ApplicationFailure} from '@temporalio/common';
import {fileURLToPath} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {createSessionPipeline} from '../indexer.mjs';
import {SourcePaginationError,assertSourcePaginationInput,assertSourcePaginationPage} from '../../connectors/workflow.mjs';
export async function buildSessionWorkflows(path) {
  const {code}=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL('./workflows.cjs',import.meta.url))});
  await writeFile(path,code);
}
export function sessionActivities({resolve}) {
  async function operation(input,action) {
    const pulse=setInterval(()=>heartbeat(),10000);
    try {
      if(action==='listPage')assertSourcePaginationInput(input);
      heartbeat();
      const resolved=await resolve(input);
      const pipeline=createSessionPipeline({...resolved,checkActive:async()=>{
        const current=await resolve(input);
        if(current.prefix!==resolved.prefix||current.store.bucket!==resolved.store.bucket||current.search.identity!==resolved.search.identity||JSON.stringify(current.principal)!==JSON.stringify(resolved.principal))throw Object.assign(new Error('Session binding changed'),{permanent:true});
        if(Context.current().cancellationSignal.aborted)throw new Error('Session indexing cancelled');
      }});
      const result=await pipeline[action](input);
      if(action==='listPage')assertSourcePaginationPage(result);
      return result;
    } catch(error) {
      if(error instanceof SourcePaginationError)throw ApplicationFailure.nonRetryable(error.message,'SourcePaginationFailed');
      // Never put transcript fragments, parser messages or provider bodies in history.
      if(error.permanent)throw ApplicationFailure.nonRetryable('Session source scope denied','InvalidSessionInput');
      throw ApplicationFailure.retryable('Session indexing operation failed','SessionProcessingFailed');
    } finally {clearInterval(pulse);}
  }
  return {listSessionPage:input=>operation(input,'listPage'),indexSessionObject:input=>operation(input,'processObject')};
}
/** Operator-supplied SDK connectionOptions support TLS/auth; callers own key rotation. */
export async function createSessionWorker({address,namespace,taskQueue,bundlePath,resolve,maxConcurrentActivityTaskExecutions=2,connectionOptions={}}) {
  if(!address||!namespace||!taskQueue||!bundlePath)throw new Error('Explicit Temporal worker configuration required');
  if(!connectionOptions||typeof connectionOptions!=='object'||Array.isArray(connectionOptions)||connectionOptions.address!==undefined&&connectionOptions.address!==address)throw new Error('Invalid Temporal connection options');
  const connection=await NativeConnection.connect({...connectionOptions,address});
  try {
    const worker=await Worker.create({connection,namespace,taskQueue,workflowBundle:{codePath:bundlePath},activities:sessionActivities({resolve}),
      maxConcurrentActivityTaskExecutions,maxConcurrentWorkflowTaskExecutions:2,shutdownGraceTime:'30 seconds'});
    return {worker,connection};
  } catch(error){await connection.close();throw error;}
}
