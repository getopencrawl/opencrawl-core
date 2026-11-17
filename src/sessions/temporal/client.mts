import type {Client, ConnectionOptions} from '@temporalio/client';
import {ActivityExecutionAlreadyStartedError, ScheduleNotFoundError, WorkflowExecutionAlreadyStartedError, WorkflowIdReusePolicy} from '@temporalio/client';
import {connectorClient} from '../../connectors/temporal/client.mjs';
import {serviceError,parseJson,type ObjectStore} from '../types.mjs';
import {ScheduleAlreadyRunning,ScheduleOverlapPolicy} from '@temporalio/client';
import {digest} from '../ingest.mjs';
import {indexingBinding,sessionCatchupMarker,type SessionIndexingBinding} from './handoff.mjs';
export {sessionIndexingGeneration,type SessionIndexingBinding} from './handoff.mjs';
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

/** Producer-owned durable submission. Only the opaque source key enters Temporal;
 * the existing activity validates scope, controls and the stored payload. */
export async function startSessionObjectIndexing(client:Client,input:SessionIndexingBinding & {key:string}) {
  indexingBinding(input);
  if(typeof input.key!=='string'||input.key.length>4096||!input.key.endsWith('.json.gz'))throw new Error('Invalid session indexing source');
  const {sourceId,taskQueue,generation,key}=input;
  const id='session-object-'+digest(JSON.stringify([sourceId,generation,key]));
  try {
    return await client.activity.start<{records:number;skipped:boolean}>('indexSessionObject',{
      id,taskQueue,args:[{sourceId,key}],startToCloseTimeout:'5 minutes',heartbeatTimeout:'45 seconds',
      retry:{initialInterval:'2 seconds',maximumInterval:'1 minute'},
      idConflictPolicy:'USE_EXISTING',idReusePolicy:'ALLOW_DUPLICATE_FAILED_ONLY',
    });
  } catch(error) {
    if(!(error instanceof ActivityExecutionAlreadyStartedError))throw error;
    const existing=client.activity.getHandle<{records:number;skipped:boolean}>(id,error.runId);
    if((await existing.describe()).status!=='COMPLETED')throw error;
    return existing;
  }
}
/** Compatibility for the bundled self-hosted Temporal 1.29 server, which does
 * not implement standalone Activities. Uses the same indexing Activity. */
export async function startSessionObjectWorkflow(client:Client,input:SessionIndexingBinding & {key:string}) {
  indexingBinding(input);
  if(typeof input.key!=='string'||input.key.length>4096||!input.key.endsWith('.json.gz'))throw new Error('Invalid session indexing source');
  const {sourceId,taskQueue,generation,key}=input;
  const workflowId='session-object-'+digest(JSON.stringify([sourceId,generation,key]));
  try {
    return await client.workflow.start('indexSessionObjectV2',{workflowId,taskQueue,args:[{sourceId,key}],
      workflowIdConflictPolicy:'USE_EXISTING',workflowIdReusePolicy:WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY});
  } catch(error) {
    if(!(error instanceof WorkflowExecutionAlreadyStartedError))throw error;
    const existing=client.workflow.getHandle(workflowId);
    if((await existing.describe()).status.name!=='COMPLETED')throw error;
    return existing;
  }
}
/** Reuse one reconnecting SDK connection across uploads, rather than opening a
 * gRPC connection for each small batch. Call close after HTTP requests drain. */
export function sessionIndexingScheduler(config:SessionIndexingBinding & {address:string;namespace:string;connectionOptions?:ConnectionOptions;mode?:'standalone'|'workflow'}) {
  indexingBinding(config);
  let runtime:ReturnType<typeof connectorClient>|undefined,closed=false;
  const connect=()=>{
    if(closed)throw new Error('Session indexing scheduler is closed');
    runtime??=connectorClient({...config,connectionOptions:{connectTimeout:5000,...config.connectionOptions}}).catch(error=>{runtime=undefined;throw error;});
    return runtime;
  };
  return {
    async schedule(key:string){const current=await connect();return current.connection.withDeadline<unknown>(Date.now()+10000,()=>config.mode==='workflow'?startSessionObjectWorkflow(current.client,{...config,key}):startSessionObjectIndexing(current.client,{...config,key}));},
    async close(){closed=true;if(runtime)await (await runtime).connection.close();},
  };
}
/** Run only after every producer durably submits new objects and compatible
 * workers are running. Unless completed is true, await the returned workflow.
 * Its final Activity stores the completion marker durably, beyond retention. */
export async function activateSessionIndexing(client:Client,input:SessionIndexingBinding & {store:ObjectStore;prefix:string}) {
  indexingBinding(input);
  const {sourceId,taskQueue,generation,store,prefix}=input;
  const {workflowId,markerKey,marker:expected}=sessionCatchupMarker(input);
  const scheduleId='sessions-'+digest(sourceId),schedule=client.schedule.getHandle(scheduleId);
  try {
    const existing=await schedule.describe();
    if(existing.action.workflowType!=='indexSessionsV1'||existing.action.taskQueue!==taskQueue||JSON.stringify(existing.action.args)!==JSON.stringify([{sourceId}]))throw new Error('Session schedule binding mismatch');
    await schedule.pause('New capture objects are submitted directly to Temporal');
  } catch(error) {if(!(error instanceof ScheduleNotFoundError))throw error;}
  const saved=await store.get(markerKey,{maxBytes:4096});
  if(saved){
    const marker=parseJson<typeof expected>(saved);
    if(JSON.stringify(marker)!==JSON.stringify(expected))throw new Error('Session cutover marker mismatch');
    return {scheduleId,workflowId,markerKey,completed:true};
  }
  try {
    await client.workflow.start('reconcileSessionsV2',{workflowId,taskQueue,args:[{sourceId,generation}],workflowIdConflictPolicy:'USE_EXISTING',workflowIdReusePolicy:WorkflowIdReusePolicy.ALLOW_DUPLICATE});
  } catch(error) {if(!(error instanceof WorkflowExecutionAlreadyStartedError))throw error;}
  return {scheduleId,workflowId,markerKey,completed:false};
}
