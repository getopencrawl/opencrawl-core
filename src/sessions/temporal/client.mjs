import {ScheduleAlreadyRunning,ScheduleOverlapPolicy} from '@temporalio/client';
import {digest} from '../ingest.mjs';
export {connectorClient as sessionClient} from '../../connectors/temporal/client.mjs';
export async function ensureSessionSchedule(client,{sourceId,taskQueue}) {
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(sourceId||'')||!taskQueue)throw new Error('Invalid session schedule');
  const args=[{sourceId}],scheduleId='sessions-'+digest(sourceId);
  try {
    await client.schedule.create({scheduleId,spec:{intervals:[{every:'5 minutes'}]},
      action:{type:'startWorkflow',workflowType:'indexSessionsV1',taskQueue,args},
      policies:{overlap:ScheduleOverlapPolicy.SKIP,catchupWindow:'1 hour',pauseOnFailure:false}});
    await client.schedule.getHandle(scheduleId).trigger(ScheduleOverlapPolicy.SKIP);
  } catch(error) {
    if(!(error instanceof ScheduleAlreadyRunning))throw error;
    const existing=await client.schedule.getHandle(scheduleId).describe();
    if(existing.action.workflowType!=='indexSessionsV1'||existing.action.taskQueue!==taskQueue||JSON.stringify(existing.action.args)!==JSON.stringify(args))throw new Error('Session schedule binding mismatch');
  }
  return scheduleId;
}
