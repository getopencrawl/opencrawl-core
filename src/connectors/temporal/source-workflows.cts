import type {ConnectionReference, SourceActivities} from './types.mjs';
import type {CaptureRun, ReferenceRun} from '../capture-types.mjs';
const {proxyActivities,continueAsNew,sleep,workflowInfo,ApplicationFailure}=require('@temporalio/workflow') as typeof import('@temporalio/workflow');
const activities=proxyActivities<SourceActivities>({startToCloseTimeout:'3 minutes',heartbeatTimeout:'45 seconds',retry:{initialInterval:'5 seconds',maximumInterval:'1 minute',maximumAttempts:5}});
exports.captureSlackFilesV1=async function captureSlackFilesV1(input: ConnectionReference & Partial<CaptureRun>) {
 const run={...input,runId:input.runId||workflowInfo().runId,cutoff:input.cutoff??Date.now()};
 for(let step=0;step<100;step++) {
  const result=await activities.captureFilePage(run);
  if(result.done){if(result.failed)throw ApplicationFailure.nonRetryable(`${result.failed} Slack source resources could not be captured`,'SlackSourceIncomplete');return result;}
  if((result.waitMs ?? 0)>0)await sleep(result.waitMs!);
 }
 return continueAsNew(run);
};

exports.captureSlackMessagesV1=async function captureSlackMessagesV1(input: ConnectionReference & Partial<CaptureRun>) {
 const run={...input,runId:input.runId||workflowInfo().runId,cutoff:input.cutoff??Date.now()};
 for(let step=0;step<100;step++) {
  const result=await activities.captureMessagePage(run);
  if(result.done){if(result.failed)throw ApplicationFailure.nonRetryable(`${result.failed} Slack history resources could not be captured`,'SlackHistoryIncomplete');return result;}
  if((result.waitMs ?? 0)>0)await sleep(result.waitMs!);
 }
 return continueAsNew(run);
};

exports.captureSlackMessageReferencesV1=async function captureSlackMessageReferencesV1(input: ConnectionReference & Omit<ReferenceRun, 'runId'> & {runId?: string}) {
 const run={...input,runId:input.runId||workflowInfo().runId};
 for(let step=0;step<100;step++) {
  const result=await activities.captureMessageReference(run);
  if(result.done){if(result.failed)throw ApplicationFailure.nonRetryable(`${result.failed} Slack message references could not be captured`,'SlackReferencesIncomplete');return result;}
  if((result.waitMs ?? 0)>0)await sleep(result.waitMs!);
 }
 return continueAsNew(run);
};
