import type {ReplicasRepairJob} from '../../integrations/replicas-live.mjs';
import type {ReplicasJob} from '../../integrations/replicas-import.mjs';
import type {DevinRecording, DevinRecordingJob} from '../../integrations/devin-recording.mjs';
import type {replicasActivities} from './replicas.mjs';
import type {SessionDeletionInput, SessionDeletionRecoveryInput, sessionDeletionActivities} from './deletion.mjs';
import type {SessionTaskInput} from './worker.mjs';
import type {SourcePage} from '../../connectors/workflow.mjs';
const {condition,defineSignal,setHandler,workflowInfo,proxyActivities, continueAsNew, patched, sleep, ApplicationFailure, startChild, ParentClosePolicy, WorkflowIdReusePolicy} = require('@temporalio/workflow') as typeof import('@temporalio/workflow');
const {WorkflowExecutionAlreadyStartedError} = require('@temporalio/common') as typeof import('@temporalio/common');
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

// The manual/upgrade scan is not periodic. Transient failures must stay durable
// until repaired now that there is no next scheduled sweep to recover them.
const reconciliation = proxyActivities<{listSessionPage(input:SessionTaskInput):Promise<SourcePage>;indexSessionObject(input:SessionTaskInput & {key:string}):Promise<{records:number}>;completeSessionCatchup(input:SessionTaskInput & {generation:string}):Promise<void>}>({startToCloseTimeout:'5 minutes',heartbeatTimeout:'45 seconds',retry:{initialInterval:'2 seconds',maximumInterval:'1 minute'}});
/** The bundled self-hosted server predates standalone Activities. */
async function indexSessionObjectV2(input:SessionTaskInput & {key:string}) {
  return reconciliation.indexSessionObject(input);
}
async function reconcileSessionsV2(input:SessionTaskInput & {generation:string}) {
  const result=await runConnectorSegment(input,{listPage:reconciliation.listSessionPage,processObject:reconciliation.indexSessionObject},{deferPaginationFailure:true});
  const failed=(input.failed||0)+result.failed;
  if(result.cursor)return continueAsNew({...input,cursor:result.cursor,failed,
    ...(result.paginationProgress&&{paginationProgress:result.paginationProgress}),
    ...(result.paginationFailure&&{paginationFailure:result.paginationFailure})});
  if(failed)throw ApplicationFailure.nonRetryable(`${failed} session objects require repair`,'SessionObjectsFailed');
  await reconciliation.completeSessionCatchup({sourceId:input.sourceId,generation:input.generation});
  return result;
}

const deletion = proxyActivities<ReturnType<typeof sessionDeletionActivities>>({
  startToCloseTimeout: '2 hours', heartbeatTimeout: '45 seconds',
  retry: {initialInterval: '5 seconds', maximumInterval: '5 minutes'},
});
async function deleteSessionV1(input: SessionDeletionInput) {
  await deletion.prepareSessionDeletion(input);
  await deletion.purgeSessionDeletionArchives(input);
  await deletion.finishSessionDeletion(input);
  return {completed: true};
}
/** Recovery for a crash between the authorized storage intent and workflow start.
 * Normal requests submit directly; this schedule also resumes older pending work. */
async function recoverSessionDeletionsV1(input: SessionDeletionRecoveryInput) {
  const page = await deletion.listSessionDeletionRequests(input);
  for (const key of page.keys) {
    const hash = key.slice(key.lastIndexOf('/') + 1, -5);
    try {
      await startChild(deleteSessionV1, {workflowId: 'session-delete-v1-' + hash,
        workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
        parentClosePolicy: ParentClosePolicy.ABANDON, args: [{sourceId: input.sourceId, key}]});
    } catch (error) {if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;}
  }
  if (page.cursor) return continueAsNew<typeof recoverSessionDeletionsV1>({...input, cursor: page.cursor});
  return {completed: true};
}
const replicas=proxyActivities<ReturnType<typeof replicasActivities>>({startToCloseTimeout:'5 minutes',
  retry:{initialInterval:'2 seconds',maximumInterval:'2 minutes',maximumAttempts:8}});
const failureStatus=proxyActivities<Pick<ReturnType<typeof replicasActivities>,'markReplicasImportFailed'>>({startToCloseTimeout:'30 seconds',retry:{maximumInterval:'1 minute'}});
const recovery=proxyActivities<Pick<ReturnType<typeof replicasActivities>,'runReplicasImportStep'>>({
  startToCloseTimeout:'5 minutes',retry:{initialInterval:'2 seconds',maximumInterval:'10 minutes'},
});
async function importReplicasHistoryV1(job:ReplicasJob):Promise<void>{
  for(let page=0;page<100;page++){
    if(patched('replicas-checkpoint-recovery-v2')){
      const step=await recovery.runReplicasImportStep(job);
      if(step.requiresReconnect)throw ApplicationFailure.nonRetryable('Replicas organization credential requires attention','ReplicasCredentialRejected');
      if(step.done)return;
      if(step.delayMs>0)await sleep(step.delayMs);
    }else{
      try{if(await replicas.importReplicasPage(job))return;}
      catch(error){
        await failureStatus.markReplicasImportFailed(job);
        if(patched('replicas-resume-after-legacy-failure'))return continueAsNew<typeof importReplicasHistoryV1>(job);
        throw error;
      }
    }
  }
  await continueAsNew<typeof importReplicasHistoryV1>(job);
}
const devin = proxyActivities<{runDevinRecordingStep: DevinRecording['runStep']}>({
  startToCloseTimeout:'3 minutes', retry:{initialInterval:'2 seconds', maximumInterval:'2 minutes'},
});
async function recordDevinSessionsV1(job: DevinRecordingJob): Promise<void> {
  for (let step = 0; step < 200; step++) {
    const {done, delayMs} = await devin.runDevinRecordingStep(job);
    if (done) return;
    // Recheck local consent and key rotations during provider cooldowns. The
    // stored retry time continues to prevent any early request to Devin.
    if (delayMs > 0) await sleep(Math.min(delayMs,60000));
  }
  await continueAsNew<typeof recordDevinSessionsV1>(job);
}
const liveRepairs=proxyActivities<Pick<ReturnType<typeof replicasActivities>,'repairReplicasLivePage'>>({
  startToCloseTimeout:'3 minutes',retry:{initialInterval:'2 seconds',maximumInterval:'1 minute'},
});
async function repairReplicasLiveV1(job:ReplicasRepairJob):Promise<void>{
  let pending=true;
  setHandler(defineSignal('replicasRepairPending'),()=>{pending=true;});
  for(let step=0;step<200;step++){
    pending=false;
    const delay=await liveRepairs.repairReplicasLivePage(job);
    if(delay===null){
      if(pending)continue;
      return;
    }
    if(delay>0)await condition(()=>pending,delay);
    if(workflowInfo().continueAsNewSuggested)break;
  }
  await continueAsNew<typeof repairReplicasLiveV1>(job);
}
export = {repairReplicasLiveV1, recordDevinSessionsV1, importReplicasHistoryV1, indexSessionsV1, indexSessionObjectV2, reconcileSessionsV2, deleteSessionV1, recoverSessionDeletionsV1};
