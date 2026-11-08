import type {SessionTaskInput} from './worker.mjs';
import type {SourcePage} from '../../connectors/workflow.mjs';
const {proxyActivities, continueAsNew, ApplicationFailure} = require('@temporalio/workflow') as typeof import('@temporalio/workflow');
const {runConnectorSegment} = require('../../connectors/workflow.mjs') as typeof import('../../connectors/workflow.mjs');
const activities = proxyActivities<{listSessionPage(input: SessionTaskInput): Promise<SourcePage>; indexSessionObject(input: SessionTaskInput & {key: string}): Promise<{records: number}>}>({startToCloseTimeout:'5 minutes', heartbeatTimeout:'45 seconds',
  retry:{initialInterval:'2 seconds',maximumInterval:'1 minute',maximumAttempts:5}});
async function indexSessionsV1(input: SessionTaskInput) {
  const result = await runConnectorSegment(input, {listPage:activities.listSessionPage,processObject:activities.indexSessionObject}, {deferPaginationFailure: true});
  const failed = (input.failed || 0) + result.failed;
  if(result.cursor)return continueAsNew({...input,cursor:result.cursor,failed,
    ...(result.paginationProgress && {paginationProgress:result.paginationProgress}),
    ...(result.paginationFailure && {paginationFailure:result.paginationFailure})});
  if(failed)throw ApplicationFailure.nonRetryable(`${failed} session objects exhausted retries`, 'SessionObjectsFailed');
  return result;
};

export = {indexSessionsV1};
