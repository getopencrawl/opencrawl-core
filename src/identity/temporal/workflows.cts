import type {TeamOperationRef, teamChangeActivities} from '../team-operation.mjs';
import type {ChangeOutcome} from '../team-change.mjs';

const {proxyActivities,defineUpdate,defineSignal,setHandler,condition,allHandlersFinished}=require('@temporalio/workflow') as typeof import('@temporalio/workflow');
const steps=proxyActivities<ReturnType<typeof teamChangeActivities>>({
  startToCloseTimeout:'90 seconds',retry:{initialInterval:'2 seconds',maximumInterval:'1 minute'},
});
async function changeTeamMemberV1(ref:TeamOperationRef):Promise<ChangeOutcome> {
  let first:ChangeOutcome|undefined, wake=false;
  setHandler(defineUpdate<ChangeOutcome>('teamChangeOutcome'),async()=>{
    await condition(()=>first!==undefined);
    return first!;
  });
  setHandler(defineSignal('recheckTeamChange'),()=>{wake=true;});
  for (;;) {
    const step=await steps.advanceTeamChange(ref);
    first??=step.outcome;
    if (!step.review) {
      await steps.forgetCompletedTeamChange(ref);
      await condition(allHandlersFinished);
      return step.outcome;
    }
    // A signal only requests a re-read. The stored receipt and operator
    // reconciliation determine which steps may run.
    await condition(()=>wake);
    wake=false;
  }
}
export = {changeTeamMemberV1};
