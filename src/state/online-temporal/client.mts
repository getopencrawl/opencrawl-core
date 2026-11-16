import {WorkflowIdReusePolicy,WorkflowExecutionAlreadyStartedError,type Client} from '@temporalio/client';
import {onlineMigrationReference,onlineMigrationTaskQueue,onlineMigrationWorkflowId,onlineMigrationSharedTaskQueue,type OnlineMigrationQueueBinding} from './binding.mjs';
import type {OnlineMigrationBinding} from './types.mjs';
/** Explicit operator start. No production schedule or existing workflow is changed. */
export async function startOnlineMigration(client:Client,binding:OnlineMigrationBinding,shard:number,queue?:OnlineMigrationQueueBinding){
 const reference=onlineMigrationReference(binding,shard);
 const workflowId=onlineMigrationWorkflowId(reference);
 const taskQueue=queue?onlineMigrationSharedTaskQueue(queue):onlineMigrationTaskQueue(binding);
 if(queue&&(queue.epoch!==binding.epoch||queue.targetId!==binding.targetId))throw Error('Shared online migration queue target mismatch');
 try{const handle=await client.workflow.start('migrateApplicationShadowV1',{workflowId,taskQueue,args:[reference],workflowIdConflictPolicy:'USE_EXISTING',workflowIdReusePolicy:WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY});if(queue&&(await handle.describe()).taskQueue!==taskQueue)throw Error('Existing online migration workflow uses another task queue');return handle;}
 catch(error){if(!(error instanceof WorkflowExecutionAlreadyStartedError))throw error;const handle=client.workflow.getHandle(workflowId);const description=await handle.describe();if(description.status.name!=='COMPLETED'||queue&&description.taskQueue!==taskQueue)throw error;return handle;}
}

export {onlineMigrationSharedTaskQueue,type OnlineMigrationQueueBinding} from './binding.mjs';
