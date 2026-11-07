const {proxyActivities, continueAsNew, ApplicationFailure} = require('@temporalio/workflow');
const {runConnectorSegment} = require('../../connectors/workflow.mjs');
const activities = proxyActivities({startToCloseTimeout:'5 minutes', heartbeatTimeout:'45 seconds',
  retry:{initialInterval:'2 seconds',maximumInterval:'1 minute',maximumAttempts:5}});
exports.indexSessionsV1 = async function indexSessionsV1(input) {
  const result = await runConnectorSegment(input, {listPage:activities.listSessionPage,processObject:activities.indexSessionObject}, {deferPaginationFailure: true});
  const failed = (input.failed || 0) + result.failed;
  if(result.cursor)return continueAsNew({...input,cursor:result.cursor,failed,
    ...(result.paginationProgress && {paginationProgress:result.paginationProgress}),
    ...(result.paginationFailure && {paginationFailure:result.paginationFailure})});
  if(failed)throw ApplicationFailure.nonRetryable(`${failed} session objects exhausted retries`, 'SessionObjectsFailed');
  return result;
};
