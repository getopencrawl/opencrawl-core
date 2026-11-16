import type {ConnectorActivityInput} from './types.mjs';
import type {ConnectorActivities} from '../workflow.mjs';
const {proxyActivities, continueAsNew, ApplicationFailure, patched} = require('@temporalio/workflow') as typeof import('@temporalio/workflow');
const {runConnectorSegment} = require('../workflow.mjs') as typeof import('../workflow.mjs');

const activities = proxyActivities<ConnectorActivities<ConnectorActivityInput> & {completeSweep(input: ConnectorActivityInput): Promise<void>}>({
  startToCloseTimeout: '10 minutes', heartbeatTimeout: '45 seconds',
  retry: {initialInterval: '2 seconds', maximumInterval: '1 minute', maximumAttempts: 5},
});

async function indexConnectorV1(input: ConnectorActivityInput) {
  const result = await runConnectorSegment(input, activities, {deferPaginationFailure: true});
  const failed = (input.failed || 0) + result.failed;
  if (result.cursor) return continueAsNew({...input, cursor: result.cursor, failed,
    ...(result.paginationProgress && {paginationProgress: result.paginationProgress}),
    ...(result.paginationFailure && {paginationFailure: result.paginationFailure})});
  if (failed) throw ApplicationFailure.nonRetryable(`${failed} source objects failed; inspect failed activities and replay after repair`, 'ConnectorObjectsFailed');
  // Old completed histories contain no final activity. Retain this patch until
  // those histories have aged out; new runs publish once after the entire sweep.
  if (patched('connector-counts-after-sweep-v1')) await activities.completeSweep(input);
  return result;
};

export = {indexConnectorV1};
