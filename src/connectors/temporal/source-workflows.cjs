const {proxyActivities,continueAsNew,sleep,workflowInfo,ApplicationFailure}=require('@temporalio/workflow');
const activities=proxyActivities({startToCloseTimeout:'3 minutes',heartbeatTimeout:'45 seconds',retry:{initialInterval:'5 seconds',maximumInterval:'1 minute',maximumAttempts:5}});
exports.captureSlackFilesV1=async function captureSlackFilesV1(input) {
 const run={...input,runId:input.runId||workflowInfo().runId,cutoff:input.cutoff??Date.now()};
 for(let step=0;step<100;step++) {
  const result=await activities.captureFilePage(run);
  if(result.done){if(result.failed)throw ApplicationFailure.nonRetryable(`${result.failed} Slack source resources could not be captured`,'SlackSourceIncomplete');return result;}
  if(result.waitMs>0)await sleep(result.waitMs);
 }
 return continueAsNew(run);
};
