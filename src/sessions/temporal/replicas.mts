import {ReplicasProviderError} from '../../integrations/replicas-api.mjs';
import {ApplicationFailure} from '@temporalio/common';
import {activityInfo,Context} from '@temporalio/activity';
import {ReplicasRepairScopeUnavailable,type ReplicasRepairJob} from '../../integrations/replicas-live.mjs';
import type {ReplicasImport,ReplicasJob} from '../../integrations/replicas-import.mjs';

export function replicasActivities(imports:Pick<ReplicasImport,'runStep'|'repairLiveCapture'>){
  async function runReplicasImportStep(job:ReplicasJob){
    try{return await imports.runStep(job);}
    catch(error){
      const info=activityInfo();
      const code=error instanceof Error&&'code' in error&&typeof error.code==='string'&&/^(?:[0-9A-Z]{5}|ECONNRESET|ETIMEDOUT|ECONNREFUSED)$/.test(error.code)?error.code:undefined;
      console.warn(JSON.stringify({event:'replicas.import.activity_retry',operation:'checkpoint',tenantId:job.tenantId,importId:job.id,
        runId:info.workflowExecution?.runId,attempt:info.attempt,activityId:info.activityId,code}));
      throw ApplicationFailure.retryable('Replicas import checkpoint unavailable','ReplicasUnavailable');
    }
  }
  return {
    runReplicasImportStep,
    async repairReplicasLivePage(job:ReplicasRepairJob){
      try{return await imports.repairLiveCapture(job,Context.current().cancellationSignal);}
      catch(error){
        if(error instanceof ReplicasRepairScopeUnavailable){
          throw ApplicationFailure.create({message:'No local collector for this Replicas scope',type:'ReplicasRepairScopeUnavailable',nextRetryDelay:'1 minute'});
        }
        if(error instanceof ReplicasProviderError&&error.status===429){
          throw ApplicationFailure.create({message:'Replicas live repair rate limited',type:'ReplicasRateLimited',nextRetryDelay:Math.max(30000,error.retryAfterMs??0)});
        }
        throw ApplicationFailure.retryable('Replicas live repair checkpoint unavailable','ReplicasRepairUnavailable');
      }
    },
    // Activities scheduled by pre-upgrade workflow tasks keep their boolean contract.
    async importReplicasPage(job:ReplicasJob){return (await runReplicasImportStep(job)).done;},
    // The previous failure handler erased the key. A replay of that command
    // leaves recovery to the workflow; the row itself owns credential disposal.
    async markReplicasImportFailed(_job:ReplicasJob){},
  };
}
