import {WorkflowIdReusePolicy,WorkflowExecutionAlreadyStartedError,type Client} from '@temporalio/client';
import {onlineMigrationReference,onlineMigrationTaskQueue,onlineMigrationWorkflowId} from './binding.mjs';
import type {OnlineMigrationBinding} from './types.mjs';
/** Explicit operator start. No production schedule or existing workflow is changed. */
export async function startOnlineMigration(client:Client,binding:OnlineMigrationBinding,shard:number){
 const reference=onlineMigrationReference(binding,shard);
 const workflowId=onlineMigrationWorkflowId(reference);
 try{return await client.workflow.start('migrateApplicationShadowV1',{workflowId,taskQueue:onlineMigrationTaskQueue(binding),args:[reference],workflowIdConflictPolicy:'USE_EXISTING',workflowIdReusePolicy:WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY});}
 catch(error){if(!(error instanceof WorkflowExecutionAlreadyStartedError))throw error;const handle=client.workflow.getHandle(workflowId);if((await handle.describe()).status.name!=='COMPLETED')throw error;return handle;}
}
