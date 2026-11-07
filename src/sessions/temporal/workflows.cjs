const {proxyActivities, continueAsNew, ApplicationFailure, patched} = require('@temporalio/workflow');
const {runConnectorSegment, SourcePaginationError} = require('../../connectors/workflow.mjs');
const activities = proxyActivities({startToCloseTimeout:'5 minutes', heartbeatTimeout:'45 seconds',
  retry:{initialInterval:'2 seconds',maximumInterval:'1 minute',maximumAttempts:5}});
exports.indexSessionsV1 = async function indexSessionsV1(input) {
  const trackPagination = patched('source-pagination-progress-v1');
  let result;
  try {
    result = await runConnectorSegment(input, {listPage:activities.listSessionPage,processObject:activities.indexSessionObject}, {trackPagination});
  } catch (error) {
    if (error instanceof SourcePaginationError) throw ApplicationFailure.nonRetryable(error.message, 'SourcePaginationFailed');
    throw error;
  }
  const failed = (input.failed || 0) + result.failed;
  if(result.cursor)return continueAsNew({...input,cursor:result.cursor,failed,
    ...(result.paginationProgress && {paginationProgress:result.paginationProgress})});
  if(failed)throw ApplicationFailure.nonRetryable(`${failed} session objects exhausted retries`, 'SessionObjectsFailed');
  return result;
};
