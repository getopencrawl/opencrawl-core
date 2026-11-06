import {Client, Connection, ScheduleAlreadyRunning, ScheduleOverlapPolicy} from '@temporalio/client';
import {digest} from '../scope.mjs';

/** connectionOptions are operator-supplied SDK options (TLS/credentials). The
 * returned connection remains available for credential rotation and close(). */
export async function connectorClient({address, namespace, connectionOptions = {}}) {
  if (!address || !namespace) throw new Error('Explicit Temporal connection required');
  if (!connectionOptions || typeof connectionOptions !== 'object' || Array.isArray(connectionOptions) ||
      connectionOptions.address !== undefined && connectionOptions.address !== address) throw new Error('Invalid Temporal connection options');
  const connection = await Connection.connect({...connectionOptions, address});
  return {connection, client: new Client({connection, namespace})};
}
export async function ensureConnectorSchedule(client, {reference, taskQueue, generation = 'v1'}) {
  if (!reference?.tenantId || !reference?.connectionId || !taskQueue || !/^v[1-9][0-9]*$/.test(generation)) throw new Error('Invalid connector schedule');
  const args = [{...reference, generation}];
  const scheduleId = 'connector-' + digest([reference.tenantId, reference.connectionId, generation]);
  try {
    await client.schedule.create({scheduleId, spec: {intervals: [{every: '5 minutes'}]},
      action: {type: 'startWorkflow', workflowType: 'indexConnectorV1', taskQueue, args},
      policies: {overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: '1 hour', pauseOnFailure: false}});
    await client.schedule.getHandle(scheduleId).trigger(ScheduleOverlapPolicy.SKIP);
  } catch (error) {
    if (!(error instanceof ScheduleAlreadyRunning)) throw error;
    const existing = await client.schedule.getHandle(scheduleId).describe();
    if (existing.action.workflowType !== 'indexConnectorV1' || existing.action.taskQueue !== taskQueue || JSON.stringify(existing.action.args) !== JSON.stringify(args)) throw new Error('Existing connector schedule does not match its authorized binding');
  }
  return scheduleId;
}
