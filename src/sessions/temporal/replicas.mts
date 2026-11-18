import {ApplicationFailure} from '@temporalio/common';
import type {ReplicasImport,ReplicasJob} from '../../integrations/replicas-import.mjs';

export function replicasActivities(imports:Pick<ReplicasImport,'advance'|'fail'>){
  return {
    async importReplicasPage(job:ReplicasJob){
      try{return await imports.advance(job);}
      catch(error){
        // Upstream bodies, keys and history must never enter Temporal.
        const status=Number((error as {status?:number}|null)?.status);
        if([400,401,403,404,409,413].includes(status)){
          await imports.fail(job,'Replicas could not read all retained history. Check the organization key and Team workspace visibility, then reconnect to resume.');
          throw ApplicationFailure.nonRetryable('Replicas history requires attention','ReplicasAccess');
        }
        throw ApplicationFailure.retryable('Replicas history page could not be imported','ReplicasUnavailable');
      }
    },
    async markReplicasImportFailed(job:ReplicasJob){
      await imports.fail(job,'The history import stopped after several retries. Reconnect to resume from the last saved page.');
    },
  };
}
