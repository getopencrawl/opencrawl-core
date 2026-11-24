import type {Client} from '@temporalio/client';
import type {CountReference} from '../count-activities.mjs';
import type {createConnectorCounts} from '../../state/connector-counts.mjs';
import type {Environment} from '../../integrations/types.mjs';
import {digest} from '../scope.mjs';

export async function startConnectorCounts(client: Client, reference: CountReference, taskQueue: string) {
  const {tenantId,userId,connectionId,generation} = reference;
  if (!tenantId || !userId || !connectionId || !generation || !/^v[1-9]\d*$/.test(generation) || !taskQueue) throw new Error('Invalid count workflow binding');
  return client.workflow.start('materializeConnectorCountsV1',{
    workflowId:'connector-counts-'+digest([tenantId,userId,connectionId,generation]),taskQueue,
    args:[{reference:{tenantId,userId,connectionId,generation}}],workflowIdConflictPolicy:'USE_EXISTING',workflowIdReusePolicy:'ALLOW_DUPLICATE',
  });
}
/** A sparse recovery read only visits overdue committed requests. DB leases keep
 * a failed handoff from starving other tenants on the next recovery pass. */
export async function recoverConnectorCounts(client:Client, options:{state:ReturnType<typeof createConnectorCounts>;environment:Environment;generation:string;taskQueue:string}) {
  const pending=await options.state.listPending(options.environment,25);
  const starts=await Promise.allSettled(pending.map(({tenantId,userId,integrationId})=>
    startConnectorCounts(client,{tenantId,userId,connectionId:integrationId,generation:options.generation},options.taskQueue)));
  return {attempted:pending.length,failed:starts.filter(result=>result.status==='rejected').length};
}
