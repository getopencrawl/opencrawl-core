import {Client,WorkflowNotFoundError} from '@temporalio/client';
import {admitTeamChange,type TeamOperationRef} from '../team-operation.mjs';
import {rejectChange,type ChangeOutcome,type TeamChange} from '../team-change.mjs';
import type {ApplicationDatabase} from '../../state/postgres.mjs';
import type workflows from './workflows.cjs';
export {prepareTeamOperations,preparePostgresTeamOperations,teamChangeActivities} from '../team-operation.mjs';
export type {TeamChange,TeamOperationRef};

export function durableTeamWrites(database:ApplicationDatabase,source:Client|(()=>Promise<Client>),taskQueue:string) {
  let admissions=0;
  async function admit(client:Client,change:TeamChange) {
    // The transaction spans only a bounded Temporal start. Keep the rest of the
    // shared API pool available during an outage or a burst across organizations.
    if (admissions>=2) return rejectChange(503,'Team changes are busy. Please try again shortly.');
    admissions++;
    try {
      return await admitTeamChange(database,change,ref=>client.connection.withDeadline(Date.now()+8000,()=>
        client.workflow.start<typeof workflows.changeTeamMemberV1>('changeTeamMemberV1',{
          args:[ref],taskQueue,workflowId:'team-member/'+ref.organizationId+'/'+ref.operationId,workflowIdReusePolicy:'REJECT_DUPLICATE',
        })));
    } finally {admissions--;}
  }
  return async (change:TeamChange)=>{
    const client=typeof source==='function'?await source():source;
    const handle=await admit(client,change);
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
