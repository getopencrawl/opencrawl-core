import type {CountActivities, CountReference} from '../count-activities.mjs';
const {proxyActivities, continueAsNew, workflowInfo} = require('@temporalio/workflow') as typeof import('@temporalio/workflow');

const counts = proxyActivities<CountActivities>({
  startToCloseTimeout:'20 minutes', heartbeatTimeout:'45 seconds',
  retry:{initialInterval:'2 seconds',maximumInterval:'1 minute',maximumAttempts:5},
});
interface Input {reference:CountReference; pass?:{generation:string;revision:number}}
async function materializeConnectorCountsV1(input:Input):Promise<void> {
  const {reference} = input;
  const {firstExecutionRunId, startTime} = workflowInfo();
  let pass = input.pass ?? await counts.beginConnectorCounts({...reference,passId:firstExecutionRunId,startedAt:startTime.getTime()});
  if (!pass) return;
  for (let page = 0; page < 20; page++) {
    const next:Awaited<ReturnType<CountActivities['advanceConnectorCounts']>> = await counts.advanceConnectorCounts({...reference,countGeneration:pass.generation,revision:pass.revision});
    if (!next || next.done) return;
    pass = {generation:pass.generation,revision:next.revision};
  }
  await continueAsNew<typeof materializeConnectorCountsV1>({reference,pass});
}
export = {materializeConnectorCountsV1};
