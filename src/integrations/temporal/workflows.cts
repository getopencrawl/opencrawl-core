import type {IntegrationActivities, IntegrationCommandReference, IntegrationRecoveryInput} from './types.mjs';
const {proxyActivities, continueAsNew, startChild, sleep, ParentClosePolicy, WorkflowIdReusePolicy} = require('@temporalio/workflow') as typeof import('@temporalio/workflow');
const {WorkflowExecutionAlreadyStartedError} = require('@temporalio/common') as typeof import('@temporalio/common');
const {integrationSteps, integrationWorkflowId} = require('./contracts.mjs') as typeof import('./contracts.mjs');

const activities = proxyActivities<IntegrationActivities>({
  startToCloseTimeout: '10 minutes', heartbeatTimeout: '45 seconds',
  retry: {initialInterval: '2 seconds', maximumInterval: '1 minute'},
});

/** Payloads contain scoped references only. SQL intent records fence external
 * effects; Temporal owns step execution and retry, never provider secrets. */
async function runIntegrationCommandV1(reference: IntegrationCommandReference) {
  const command = await activities.describeIntegrationCommand(reference);
  if (command.status !== 'pending') return {status: command.status};
  for (let pass = 0; pass < 64; pass++) {
    let restart = false;
    for (const step of integrationSteps[command.operation]) {
      let result = await activities.executeIntegrationStep({...reference, step});
      while(command.operation==='consent'&&result.waitUntil!==undefined){
        await sleep(Math.max(1,result.waitUntil-Date.now()));
        result=await activities.executeIntegrationStep({...reference,step});
      }
      if (result.status === 'superseded') return result;
      if (result.status === 'restart') {restart = true; break;}
    }
    if (restart) continue;
    await activities.completeIntegrationCommand(reference);
    return {status: 'completed'};
  }
  return continueAsNew<typeof runIntegrationCommandV1>(reference);
}

/** Recovery only submits durable SQL commands. It does not accept arbitrary jobs
 * or serialize unrelated work through one signal-driven dispatcher. */
async function recoverIntegrationCommandsV1(input: IntegrationRecoveryInput) {
  const page = await activities.listIntegrationCommands(input);
  for (const reference of page.commands) {
    try {
      await startChild(runIntegrationCommandV1, {workflowId: integrationWorkflowId(reference),
        workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
        parentClosePolicy: ParentClosePolicy.ABANDON, args: [reference]});
    } catch (error) {if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;}
  }
  if (page.cursor) return continueAsNew<typeof recoverIntegrationCommandsV1>({...input, cursor: page.cursor});
  return {completed: true};
}
async function reconcileIntegrationSchedulesV1(input: {sourceId: string}) {
  await activities.reconcileIntegrationSchedules(input);
}
export = {runIntegrationCommandV1, recoverIntegrationCommandsV1, reconcileIntegrationSchedulesV1};
