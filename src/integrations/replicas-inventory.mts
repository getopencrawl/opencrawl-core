import type {ApplicationDatabase} from '../state/postgres.mjs';
import {ReplicasProviderError} from './replicas-api.mjs';

type Client=Pick<ApplicationDatabase['pool'],'query'>;
type Inventory={chats:{id:string}[];waking?:boolean};
const interval=30*60_000;
const unavailableInterval=2*60_000;

/** A retained workspace inventory can postpone another negative read. A later
 * positive listing releases its exact checkpoints, which still read history
 * and go through the normal ingest path before receiving any credit. */
export async function observeReplicasWorkspace(client:Client,scope:{namespace:string;tenant:string;importId:string;workspace:string},
  now:number,read:()=>Promise<Inventory>){
  const args=[scope.namespace,scope.tenant,scope.importId,scope.workspace];
  const saved=(await client.query<{checked_at:Date;chat_ids:string[]|null;result:string}>(
    'SELECT checked_at,chat_ids,result FROM opencrawl_replicas_workspace_inventories WHERE namespace=$1 AND tenant=$2 AND import_id=$3 AND workspace=$4',args)).rows[0];
  if(saved&&now<saved.checked_at.getTime()+(saved.chat_ids?interval:unavailableInterval)){
    return {ids:saved.chat_ids?new Set(saved.chat_ids):undefined,result:saved.result,fresh:false,checkAt:saved.checked_at.getTime(),next:saved.checked_at.getTime()+interval,moved:0,released:0};
  }
  let ids:string[]|null=null,result='unavailable',httpStatus:number|undefined;
  try{
    const inventory=await read();
    if(inventory.waking)result='waking';
    else if(inventory.chats.length<=10_000&&inventory.chats.every(chat=>chat.id.length>0&&chat.id.length<=256)){
      ids=[...new Set(inventory.chats.map(chat=>chat.id))].sort();result='ready';
    }
  }catch(error){if(error instanceof ReplicasProviderError)httpStatus=error.status;}
  const at=new Date(now).toISOString(),next=now+interval;
  await client.query(`INSERT INTO opencrawl_replicas_workspace_inventories(namespace,tenant,import_id,workspace,checked_at,chat_ids,result)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(namespace,tenant,import_id,workspace) DO UPDATE
    SET checked_at=EXCLUDED.checked_at,chat_ids=EXCLUDED.chat_ids,result=EXCLUDED.result,
      export_check=CASE WHEN opencrawl_replicas_workspace_inventories.chat_ids IS DISTINCT FROM EXCLUDED.chat_ids
        OR opencrawl_replicas_workspace_inventories.export_check->>'phase' IN ('unavailable','inconsistent_catalog','scope_mismatch')
        OR jsonb_array_length(COALESCE(opencrawl_replicas_workspace_inventories.export_check->'outside','[]'::jsonb))>0
        THEN NULL ELSE opencrawl_replicas_workspace_inventories.export_check END`,[...args,at,ids,result]);
  let moved=0,released=0;
  if(ids){
    const scoped=`namespace=$1 AND tenant=$2 AND chat->>'workspace_id'=$4 AND issue->>'importId'=$3 AND checkpoint->>'before' IS NULL
      AND NOT (issue ? 'continuation') AND issue->>'operation'='history'
      AND (issue->>'httpStatus'='404' OR issue->>'reason' IN ('empty_with_messages','empty_unverified'))`;
    const absent=await client.query(`UPDATE opencrawl_replicas_deferred SET retry_at=GREATEST(retry_at,$7::timestamptz),
      issue=issue||jsonb_build_object('workspaceAbsentAt',$6::text,'retryAt',GREATEST(retry_at,$7::timestamptz))
      WHERE ${scoped} AND NOT ((chat->>'chat_id')=ANY($5::text[]))`,[...args,ids,at,new Date(next).toISOString()]);
    moved=absent.rowCount??0;
    const present=await client.query(`UPDATE opencrawl_replicas_deferred SET retry_at=LEAST(retry_at,$6::timestamptz),
      issue=(issue-'workspaceAbsentAt')||jsonb_build_object('retryAt',LEAST(retry_at,$6::timestamptz))
      WHERE ${scoped} AND issue ? 'workspaceAbsentAt' AND (chat->>'chat_id')=ANY($5::text[])`,[...args,ids,at]);
    released=present.rowCount??0;
  }
  return {ids:ids?new Set(ids):undefined,result,httpStatus,fresh:true,checkAt:now,next,moved,released};
}
