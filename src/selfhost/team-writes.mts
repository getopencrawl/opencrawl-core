import {activateSelfhostTeamGuard} from '../identity/team-guard-authority.mjs';
import {admitTeamChange,prepareTeamOperations,teamChangeActivities,type TeamChangeOptions,type TeamOperationRef} from '../identity/team-operation.mjs';
import {rejectChange,type TeamChange} from '../identity/team-change.mjs';

/** Local accounts can be administered even when the Temporal frontend is offline.
 * An interrupted synchronous request leaves its existing operation recoverable
 * without repeating a provider write whose outcome is unknown. */
export function selfhostTeamWrites(options:TeamChangeOptions & {organizationId:string}) {
  const {database,organizationId,store,prefix}=options,activities=teamChangeActivities(options);
  let ready:Promise<void>|undefined;
  async function run(change?:TeamChange) {
    ready??=prepareTeamOperations(database).catch(error=>{ready=undefined;throw error;});
    await ready;
    const client=await database.pool.connect();
    try {
      const lock=JSON.stringify(['selfhost-team-write',database.namespace,organizationId]);
      const result=await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[lock]);
      if(!result.rows[0].acquired)return rejectChange(409,'A team change is already in progress.');
      const pending=await client.query('SELECT operation FROM opencrawl_team_operations WHERE namespace=$1 AND organization=$2 ORDER BY operation',[database.namespace,organizationId]);
      if(!change && !pending.rowCount)return;
      try {await activateSelfhostTeamGuard(database,store,prefix,organizationId);}
      catch {return rejectChange(503,'Team changes require operator verification.');}
      const advance=async(ref:TeamOperationRef)=>{
        const result=await activities.advanceTeamChange(ref);
        if(!result.review)await activities.forgetCompletedTeamChange(ref);
        return result;
      };
      for(const previous of pending.rows) {
        const result=await advance({organizationId,operationId:previous.operation});
        if(result.review && !result.outcome.ok)return rejectChange(result.outcome.status,result.outcome.message);
      }
      if(change) {
        const ref=await admitTeamChange(database,change,async admitted=>admitted);
        const {outcome}=await advance(ref);
        if(!outcome.ok)rejectChange(outcome.status,outcome.message);
      }
    } finally {client.release(true);}
  }
  return {write:(change:TeamChange)=>run(change),recover:()=>run()};
}
