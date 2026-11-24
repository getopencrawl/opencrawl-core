import {createCountActivities} from '../count-activities.mjs';
import {errorMetadata} from '../types.mjs';
import {SourcePaginationError} from '../workflow.mjs';
import {CountSnapshotBudgetExceeded} from '../count-snapshot.mjs';
import type {WorkerConnectionOptions} from './types.mjs';
import {ApplicationFailure} from '@temporalio/common';
import {Context,heartbeat} from '@temporalio/activity';
import {Worker, NativeConnection, bundleWorkflowCode} from '@temporalio/worker';
import {fileURLToPath} from 'node:url';
import {writeFile} from 'node:fs/promises';

export async function buildCountWorkflows(path:string) {
  const {code} = await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL('./count-workflows.cjs',import.meta.url))});
  await writeFile(path,code);
}
/** One activity slot independent of foreground connector indexing. */
export async function createCountWorker({address,namespace,taskQueue,bundlePath,connectionOptions={},...options}
  : WorkerConnectionOptions & Omit<Parameters<typeof createCountActivities>[0],'heartbeat'|'checkCancelled'>) {
  if (!address || !namespace || !taskQueue || !bundlePath || connectionOptions.address && connectionOptions.address !== address) throw new Error('Explicit count worker configuration required');
  const connection = await NativeConnection.connect({...connectionOptions,address});
  try {
    const operations = createCountActivities({...options,heartbeat,checkCancelled:() => Context.current().cancellationSignal.throwIfAborted()});
    const activities = Object.fromEntries(Object.entries(operations).map(([name,operation])=>[name,async(input:never)=>{
      const pulse = setInterval(() => heartbeat(),10_000);
      try {
        heartbeat();
        return await operation(input);
      } catch(error) {
        if(error instanceof CountSnapshotBudgetExceeded) throw ApplicationFailure.nonRetryable(error.message,'CountSnapshotBudgetExceeded');
        if(error instanceof SourcePaginationError) throw ApplicationFailure.nonRetryable(error.message,'SourcePaginationFailed');
        if(errorMetadata(error).permanent) throw ApplicationFailure.nonRetryable(errorMetadata(error).message||'Invalid count activity input','InvalidConnectorInput');
        throw error;
      } finally {clearInterval(pulse);}
    }]));
    const worker = await Worker.create({connection,namespace,taskQueue,workflowBundle:{codePath:bundlePath},activities,
      maxConcurrentActivityTaskExecutions:1,maxConcurrentWorkflowTaskExecutions:2,maxCachedWorkflows:2,shutdownGraceTime:'30 seconds'});
    return {worker,connection};
  } catch(error) {await connection.close();throw error;}
}
