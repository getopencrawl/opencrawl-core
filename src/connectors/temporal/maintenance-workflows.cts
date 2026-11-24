import type {ConnectorJob, ConnectorMaintenance, DiscoveryInput} from './maintenance.mjs';
const {proxyActivities, sleep, continueAsNew, startChild, ParentClosePolicy, WorkflowIdReusePolicy, ApplicationFailure} = require('@temporalio/workflow') as typeof import('@temporalio/workflow');
const {WorkflowExecutionAlreadyStartedError} = require('@temporalio/common') as typeof import('@temporalio/common');

const scans = proxyActivities<Pick<ConnectorMaintenance,'listConnectorMaintenance'|'ensureActiveConnector'>>({
  startToCloseTimeout: '10 minutes', retry: {maximumAttempts: 3, maximumInterval: '15 seconds'},
});
const cleanup = proxyActivities<Pick<ConnectorMaintenance,'purgeDisconnectedConnector'>>({
  startToCloseTimeout: '20 minutes', retry: {initialInterval: '5 seconds', maximumInterval: '5 minutes'},
});

async function purgeConnectorV1(job: ConnectorJob) {
  for (;;) {
    const deadline = await cleanup.purgeDisconnectedConnector(job);
    if (deadline === null) return;
    await sleep(Math.max(1, deadline - Date.now()));
  }
}

async function reconcileConnectorsV1(input: DiscoveryInput & {failed?: number}) {
  const page = await scans.listConnectorMaintenance(input);
  const failed = (input.failed || 0) + page.failed;
  for (const {job, id} of page.jobs) {
    try {
      await startChild(purgeConnectorV1, {workflowId: 'connector-purge-' + id, args: [job],
        workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY, parentClosePolicy: ParentClosePolicy.ABANDON});
    } catch (error) { if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error; }
  }
  if (page.cursor) return continueAsNew<typeof reconcileConnectorsV1>({...input, cursor: page.cursor, failed});
  if (failed) throw ApplicationFailure.nonRetryable(failed + ' connector schedules require another pass', 'ConnectorScheduleFailure');
}
async function activateConnectorV1(job: ConnectorJob) {
  return scans.ensureActiveConnector(job);
}
export = {activateConnectorV1, purgeConnectorV1, reconcileConnectorsV1};
