const {proxyActivities, continueAsNew, ApplicationFailure, patched} = require('@temporalio/workflow');
const {runConnectorSegment, SourcePaginationError} = require('../workflow.mjs');

const activities = proxyActivities({
  startToCloseTimeout: '10 minutes', heartbeatTimeout: '45 seconds',
  retry: {initialInterval: '2 seconds', maximumInterval: '1 minute', maximumAttempts: 5},
});

exports.indexConnectorV1 = async function indexConnectorV1(input) {
  // Old histories must finish their existing segment before enabling the guard.
  const trackPagination = patched('source-pagination-progress-v1');
  let result;
  try { result = await runConnectorSegment(input, activities, {trackPagination}); }
  catch (error) {
    if (error instanceof SourcePaginationError) throw ApplicationFailure.nonRetryable(error.message, 'SourcePaginationFailed');
    throw error;
  }
  const failed = (input.failed || 0) + result.failed;
  if (result.cursor) return continueAsNew({...input, cursor: result.cursor, failed,
    ...(result.paginationProgress && {paginationProgress: result.paginationProgress})});
  if (failed) throw ApplicationFailure.nonRetryable(`${failed} source objects failed; inspect failed activities and replay after repair`, 'ConnectorObjectsFailed');
  return result;
};
