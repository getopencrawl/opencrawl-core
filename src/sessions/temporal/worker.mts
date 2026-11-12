import type {SessionDeletionResolver} from './deletion.mjs';
import {sessionDeletionActivities} from './deletion.mjs';
export type {SessionDeletionResolver, SessionDeletionBinding} from './deletion.mjs';
import type {NativeConnectionOptions} from '@temporalio/worker';
import type {SessionPipelineOptions} from '../indexer.mjs';
import type {SourceCheckpoint, SourcePage} from '../../connectors/workflow.mjs';
export interface SessionTaskInput {sourceId: string; key?: string; cursor?: string | null; paginationFailure?: string; paginationProgress?: SourceCheckpoint; failed?: number}
export type SessionResolver = (input: SessionTaskInput) => Promise<SessionPipelineOptions>;
import {serviceError} from '../types.mjs';
import {Worker,NativeConnection,bundleWorkflowCode} from '@temporalio/worker';
import {Context,heartbeat} from '@temporalio/activity';
import {ApplicationFailure} from '@temporalio/common';
import {fileURLToPath} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {createSessionPipeline} from '../indexer.mjs';
import {SourcePaginationError,assertSourcePaginationInput,assertSourcePaginationPage} from '../../connectors/workflow.mjs';
export async function buildSessionWorkflows(path: string) {
  const {code}=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL('./workflows.cjs',import.meta.url))});
  await writeFile(path,code);
}
export function sessionActivities({resolve}: {resolve: SessionResolver}) {
  async function operation(input: SessionTaskInput,action: 'listPage' | 'processObject'): Promise<SourcePage | {records: number; skipped: boolean}> {
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
      const result=action==='listPage' ? await pipeline.listPage(input) : await pipeline.processObject(input as SessionTaskInput & {key: string});
      if(action==='listPage')assertSourcePaginationPage(result);
      return result;
    } catch(caught){const error=serviceError(caught);
      if(error instanceof SourcePaginationError)throw ApplicationFailure.nonRetryable(error.message,'SourcePaginationFailed');
      // Never put transcript fragments, parser messages or provider bodies in history.
      if(error.code==='BULK_TOO_LARGE')throw ApplicationFailure.nonRetryable('Session search document exceeds bulk limit','BULK_TOO_LARGE');
      if(error.permanent)throw ApplicationFailure.nonRetryable('Session source scope denied','InvalidSessionInput');
      throw ApplicationFailure.retryable('Session indexing operation failed','SessionProcessingFailed');
    } finally {clearInterval(pulse);}
  }
  return {listSessionPage:(input: SessionTaskInput)=>operation(input,'listPage') as Promise<SourcePage>,indexSessionObject:(input: SessionTaskInput & {key: string})=>operation(input,'processObject') as Promise<{records: number; skipped: boolean}>};
}
/** Operator-supplied SDK connectionOptions support TLS/auth; callers own key rotation. */
export async function createSessionWorker({address,namespace,taskQueue,bundlePath,resolve,resolveDeletion,maxConcurrentActivityTaskExecutions=2,connectionOptions={}}: {address: string; namespace: string; taskQueue: string; bundlePath: string; resolve: SessionResolver; resolveDeletion?: SessionDeletionResolver; maxConcurrentActivityTaskExecutions?: number; connectionOptions?: NativeConnectionOptions}) {
  if(!address||!namespace||!taskQueue||!bundlePath)throw new Error('Explicit Temporal worker configuration required');
  if(!connectionOptions||typeof connectionOptions!=='object'||Array.isArray(connectionOptions)||connectionOptions.address!==undefined&&connectionOptions.address!==address)throw new Error('Invalid Temporal connection options');
  const connection=await NativeConnection.connect({...connectionOptions,address});
  try {
    const worker=await Worker.create({connection,namespace,taskQueue,workflowBundle:{codePath:bundlePath},activities:{...sessionActivities({resolve}), ...(resolveDeletion ? sessionDeletionActivities(resolveDeletion) : {})},
      maxConcurrentActivityTaskExecutions,maxConcurrentWorkflowTaskExecutions:2,shutdownGraceTime:'30 seconds'});
    return {worker,connection};
  } catch(caught){const error=serviceError(caught);await connection.close();throw error;}
}
