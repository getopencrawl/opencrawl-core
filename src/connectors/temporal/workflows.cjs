const {proxyActivities, continueAsNew, ApplicationFailure} = require('@temporalio/workflow');
const {runConnectorSegment} = require('../workflow.mjs');

const activities = proxyActivities({
  startToCloseTimeout: '10 minutes', heartbeatTimeout: '45 seconds',
  retry: {initialInterval: '2 seconds', maximumInterval: '1 minute', maximumAttempts: 5},
});

exports.indexConnectorV1 = async function indexConnectorV1(input) {
  const result = await runConnectorSegment(input, activities);
  const failed = (input.failed || 0) + result.failed;
  if (result.cursor) return continueAsNew({...input, cursor: result.cursor, failed});
  if (failed) throw ApplicationFailure.nonRetryable(`${failed} source objects failed; inspect failed activities and replay after repair`, 'ConnectorObjectsFailed');
  return result;
};
