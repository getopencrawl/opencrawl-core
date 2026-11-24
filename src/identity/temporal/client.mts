import {Client,WorkflowNotFoundError} from '@temporalio/client';
import {admitTeamChange,type TeamOperationRef} from '../team-operation.mjs';
import {rejectChange,type ChangeOutcome,type TeamChange} from '../team-change.mjs';
import type {ApplicationDatabase} from '../../state/postgres.mjs';
import type workflows from './workflows.cjs';
export {prepareTeamOperations,teamChangeActivities} from '../team-operation.mjs';
export type {TeamChange,TeamOperationRef};

export function durableTeamWrites(database:ApplicationDatabase,source:Client|(()=>Promise<Client>),taskQueue:string) {
  return async (change:TeamChange)=>{
    const client=typeof source==='function'?await source():source;
    const handle=await admitTeamChange(database,change,ref=>client.connection.withDeadline(Date.now()+8000,()=>
      client.workflow.start<typeof workflows.changeTeamMemberV1>('changeTeamMemberV1',{
        args:[ref],taskQueue,workflowId:'team-member/'+ref.organizationId+'/'+ref.operationId,workflowIdReusePolicy:'REJECT_DUPLICATE',
      })));
    let outcome:ChangeOutcome;
    try {outcome=await client.connection.withDeadline(Date.now()+30000,()=>handle.executeUpdate<ChangeOutcome,[]>('teamChangeOutcome',{args:[]}));}
    catch (error) {
      // A fast mutation may already have closed before the HTTP caller's update.
      if (!(error instanceof WorkflowNotFoundError)) throw error;
      outcome=await handle.result();
    }
    if (!outcome.ok) rejectChange(outcome.status,outcome.message);
  };
}
