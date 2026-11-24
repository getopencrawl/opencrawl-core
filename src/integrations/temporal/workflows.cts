import type {integrationCommandActivities, LegacyCursor} from './runtime.mjs';
import type {IntegrationCommandReference, IntegrationRecoveryInput} from './types.mjs';
const {proxyActivities, startChild, ParentClosePolicy, WorkflowIdReusePolicy, continueAsNew} =
  require('@temporalio/workflow') as typeof import('@temporalio/workflow');
const {WorkflowExecutionAlreadyStartedError} = require('@temporalio/common') as typeof import('@temporalio/common');

const {executeIntegrationCommand} = proxyActivities<ReturnType<typeof integrationCommandActivities>>({
  startToCloseTimeout: '1 hour', heartbeatTimeout: '45 seconds',
  retry: {initialInterval: '5 seconds', maximumInterval: '5 minutes'},
});
const {listPendingIntegrationCommands} = proxyActivities<ReturnType<typeof integrationCommandActivities>>({
  startToCloseTimeout: '1 minute', retry: {initialInterval: '5 seconds', maximumInterval: '1 minute', maximumAttempts: 5},
});
const {adoptLegacyIntegrationCommands} = proxyActivities<ReturnType<typeof integrationCommandActivities>>({
  startToCloseTimeout: '10 minutes', retry: {initialInterval: '5 seconds', maximumAttempts: 2},
});

async function executeIntegrationCommandV1(reference: IntegrationCommandReference): Promise<void> {
  for (let step = 0; step < 64; step++) {
    if (await executeIntegrationCommand(reference) === 'done') return;
  }
  await continueAsNew<typeof executeIntegrationCommandV1>(reference);
}

async function dispatchPage(input: IntegrationRecoveryInput) {
  const page = await listPendingIntegrationCommands({sourceId: input.sourceId, cursor: input.cursor});
  for (const {workflowId, reference} of page.commands) {
    try {
      await startChild(executeIntegrationCommandV1, {workflowId, args: [reference],
        workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY, parentClosePolicy: ParentClosePolicy.ABANDON});
    } catch (error) {if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;}
  }
  return page.cursor;
}

// Each scan advances independently. A failed legacy page never hides later
// command pages. The schedule retries incomplete scans from the start.
async function recoverIntegrationCommandsV1(input: IntegrationRecoveryInput & {legacyCursor?: LegacyCursor | null; incomplete?: boolean}): Promise<void> {
  const [dispatch, adoption] = await Promise.allSettled([
    input.cursor === null ? null : dispatchPage(input),
    input.legacyCursor === null ? null : adoptLegacyIntegrationCommands({sourceId: input.sourceId, cursor: input.legacyCursor}),
  ]);
  const incomplete = input.incomplete || dispatch.status === 'rejected' || adoption.status === 'rejected';
  const cursor = dispatch.status === 'fulfilled' ? dispatch.value : null;
  const legacyCursor = adoption.status === 'fulfilled' ? adoption.value : null;
  if (cursor || legacyCursor) {
    await continueAsNew<typeof recoverIntegrationCommandsV1>({sourceId: input.sourceId, cursor, legacyCursor, incomplete});
  }
  if (incomplete) {
    const {ApplicationFailure} = require('@temporalio/common') as typeof import('@temporalio/common');
    throw ApplicationFailure.nonRetryable('Integration recovery pass incomplete', 'IntegrationRecoveryIncomplete');
  }
}

export = {executeIntegrationCommandV1, recoverIntegrationCommandsV1};
