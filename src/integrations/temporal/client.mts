import type {Client, ConnectionOptions} from '@temporalio/client';
import type {IntegrationCommandReference} from './types.mjs';
import {ScheduleAlreadyRunning, ScheduleOverlapPolicy, WorkflowExecutionAlreadyStartedError, WorkflowIdReusePolicy} from '@temporalio/client';
import {connectorClient} from '../../connectors/temporal/client.mjs';
import {integrationWorkflowId} from './contracts.mjs';

export async function startIntegrationCommand(client: Client, reference: IntegrationCommandReference, taskQueue: string): Promise<string> {
  if (!taskQueue) throw new Error('Explicit integration task queue required');
  const workflowId = integrationWorkflowId(reference);
  try {
    await client.workflow.start('runIntegrationCommandV1', {workflowId, taskQueue, args: [reference],
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY});
  } catch (error) {if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;}
  return workflowId;
}
export function integrationLifecycleScheduler(config: {address: string; namespace: string; taskQueue: string; connectionOptions?: ConnectionOptions}) {
  return async (reference: IntegrationCommandReference) => {
    const runtime = await connectorClient({...config, connectionOptions: {connectTimeout: 5000, ...config.connectionOptions}});
    try {return await runtime.connection.withDeadline(Date.now() + 10000, () => startIntegrationCommand(runtime.client, reference, config.taskQueue));}
    finally {await runtime.connection.close();}
  };
}
export async function ensureIntegrationRecoverySchedule(client: Client, {sourceId, taskQueue}: {sourceId: string; taskQueue: string}) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(sourceId) || !taskQueue) throw new Error('Invalid integration recovery binding');
  const scheduleId = 'integration-recovery-v1-' + sourceId, args = [{sourceId}];
  try {
    await client.schedule.create({scheduleId, spec: {intervals: [{every: '1 minute'}]},
      action: {type: 'startWorkflow', workflowType: 'recoverIntegrationCommandsV1', taskQueue, args},
      policies: {overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: '1 hour', pauseOnFailure: false}});
    await client.schedule.getHandle(scheduleId).trigger(ScheduleOverlapPolicy.SKIP);
  } catch (error) {
    if (!(error instanceof ScheduleAlreadyRunning)) throw error;
    const existing = await client.schedule.getHandle(scheduleId).describe();
    if (existing.action.workflowType !== 'recoverIntegrationCommandsV1' || existing.action.taskQueue !== taskQueue || JSON.stringify(existing.action.args) !== JSON.stringify(args)) throw new Error('Integration recovery binding mismatch');
  }
  return scheduleId;
}

export async function ensureIntegrationDiscoverySchedule(client: Client, {sourceId, taskQueue}: {sourceId: string; taskQueue: string}) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(sourceId) || !taskQueue) throw new Error('Invalid integration discovery binding');
  const scheduleId = 'integration-discovery-v1-' + sourceId, args = [{sourceId}];
  try {
    await client.schedule.create({scheduleId, spec: {intervals: [{every: '1 minute'}]},
      action: {type: 'startWorkflow', workflowType: 'reconcileIntegrationSchedulesV1', taskQueue, args},
      policies: {overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: '1 hour', pauseOnFailure: false}});
    await client.schedule.getHandle(scheduleId).trigger(ScheduleOverlapPolicy.SKIP);
  } catch (error) {
    if (!(error instanceof ScheduleAlreadyRunning)) throw error;
    const existing = await client.schedule.getHandle(scheduleId).describe();
    if (existing.action.workflowType !== 'reconcileIntegrationSchedulesV1' || existing.action.taskQueue !== taskQueue || JSON.stringify(existing.action.args) !== JSON.stringify(args)) throw new Error('Integration discovery binding mismatch');
  }
  return scheduleId;
}
