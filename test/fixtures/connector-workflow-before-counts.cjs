// Frozen pre-measurement workflow command sequence, for upgrade replay coverage.
const {proxyActivities, continueAsNew, ApplicationFailure} = require('@temporalio/workflow');
const {runConnectorSegment} = require('../../dist/src/connectors/workflow.mjs');
const activities = proxyActivities({startToCloseTimeout:'10 minutes',heartbeatTimeout:'45 seconds',retry:{initialInterval:'2 seconds',maximumInterval:'1 minute',maximumAttempts:5}});
exports.indexConnectorV1 = async input => {
  const result = await runConnectorSegment(input, activities, {deferPaginationFailure:true});
  const failed = (input.failed || 0) + result.failed;
  if(result.cursor)return continueAsNew({...input,cursor:result.cursor,failed,...(result.paginationProgress&&{paginationProgress:result.paginationProgress}),...(result.paginationFailure&&{paginationFailure:result.paginationFailure})});
  if(failed)throw ApplicationFailure.nonRetryable(`${failed} source objects failed; inspect failed activities and replay after repair`,'ConnectorObjectsFailed');
  return result;
};
