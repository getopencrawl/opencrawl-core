import type {Client, ConnectionOptions} from '@temporalio/client';
import {WorkflowExecutionAlreadyStartedError, WorkflowIdReusePolicy} from '@temporalio/client';
import {connectorClient} from '../../connectors/temporal/client.mjs';
import {serviceError} from '../types.mjs';
import {ScheduleAlreadyRunning,ScheduleOverlapPolicy} from '@temporalio/client';
import {digest} from '../ingest.mjs';
export {connectorClient as sessionClient} from '../../connectors/temporal/client.mjs';
export async function ensureSessionSchedule(client: Client,{sourceId,taskQueue}: {sourceId: string; taskQueue: string}) {
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(sourceId||'')||!taskQueue)throw new Error('Invalid session schedule');
  const args=[{sourceId}],scheduleId='sessions-'+digest(sourceId);
  try {
    await client.schedule.create({scheduleId,spec:{intervals:[{every:'5 minutes'}]},
      action:{type:'startWorkflow',workflowType:'indexSessionsV1',taskQueue,args},
      policies:{overlap:ScheduleOverlapPolicy.SKIP,catchupWindow:'1 hour',pauseOnFailure:false}});
    await client.schedule.getHandle(scheduleId).trigger(ScheduleOverlapPolicy.SKIP);
  } catch(caught){const error=serviceError(caught);
    if(!(error instanceof ScheduleAlreadyRunning))throw error;
    const existing=await client.schedule.getHandle(scheduleId).describe();
    if(existing.action.workflowType!=='indexSessionsV1'||existing.action.taskQueue!==taskQueue||JSON.stringify(existing.action.args)!==JSON.stringify(args))throw new Error('Session schedule binding mismatch');
  }
  return scheduleId;
}

export async function startSessionDeletion(client: Client, {sourceId, taskQueue, key}: {sourceId: string; taskQueue: string; key: string}) {
  const hash = /\/([a-f0-9]{64})\.json$/.exec(key)?.[1];
  if (!hash || !sourceId || !taskQueue) throw new Error('Invalid session deletion job');
  // One active workflow per intent. A late accepted retry can recreate the
  // intent after completion; allow a new run to reconcile that harmless race.
  const workflowId = 'session-delete-v1-' + hash;
  try {
    await client.workflow.start('deleteSessionV1', {workflowId, taskQueue, args: [{sourceId, key}],
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE});
  } catch (error) {if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;}
  return workflowId;
}
/** Low-volume request submission, with a bounded connection owned by this call. */
export function sessionDeletionScheduler(config: {address: string; namespace: string; taskQueue: string; sourceId: string; connectionOptions?: ConnectionOptions}) {
  return async (key: string) => {
    const runtime = await connectorClient({...config, connectionOptions: {connectTimeout: 5000, ...config.connectionOptions}});
    try {return await runtime.connection.withDeadline(Date.now() + 10000, () => startSessionDeletion(runtime.client, {...config, key}));}
    finally {await runtime.connection.close();}
  };
}
export async function ensureSessionDeletionSchedule(client: Client, {sourceId, taskQueue}: {sourceId: string; taskQueue: string}) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(sourceId || '') || !taskQueue) throw new Error('Invalid session deletion schedule');
  const args = [{sourceId}], scheduleId = 'session-deletions-' + digest(sourceId);
  try {
    await client.schedule.create({scheduleId, spec: {intervals: [{every: '1 minute'}]},
      action: {type: 'startWorkflow', workflowType: 'recoverSessionDeletionsV1', taskQueue, args},
      policies: {overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: '1 hour', pauseOnFailure: false}});
    await client.schedule.getHandle(scheduleId).trigger(ScheduleOverlapPolicy.SKIP);
  } catch (error) {
    if (!(error instanceof ScheduleAlreadyRunning)) throw error;
    const existing = await client.schedule.getHandle(scheduleId).describe();
    if (existing.action.workflowType !== 'recoverSessionDeletionsV1' || existing.action.taskQueue !== taskQueue || JSON.stringify(existing.action.args) !== JSON.stringify(args))
      throw new Error('Session deletion schedule binding mismatch');
  }
  return scheduleId;
}
