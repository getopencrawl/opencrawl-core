import type {ApplicationDatabase} from '../state/postgres.mjs';
import type {WorkspaceVersion} from './replicas-snapshots.mjs';
import {ReplicasProviderError} from './replicas-api.mjs';

type Client=Pick<ApplicationDatabase['pool'],'query'>;
type Inventory={chats:{id:string;created_at?:string;updated_at?:string}[];waking?:boolean};
const interval=86_400_000;
const unavailableInterval=2*60_000;

/** A retained workspace inventory can postpone another negative read. A later
 * positive listing releases its exact checkpoints, which still read history
 * and go through the normal ingest path before receiving any credit. */
export async function observeReplicasWorkspace(client:Client,scope:{namespace:string;tenant:string;importId:string;workspace:string},
  now:number,read:()=>Promise<Inventory>){
  const args=[scope.namespace,scope.tenant,scope.importId,scope.workspace];
  const saved=(await client.query<{checked_at:Date;chat_ids:string[]|null;result:string}>(
    'SELECT checked_at,chat_ids,result FROM opencrawl_replicas_workspace_inventories WHERE namespace=$1 AND tenant=$2 AND import_id=$3 AND workspace=$4',args)).rows[0];
  if(saved&&now<saved.checked_at.getTime()+(saved.result==='ready'?interval:unavailableInterval)){
    return {ids:saved.result==='ready'&&saved.chat_ids?new Set(saved.chat_ids):undefined,result:saved.result,fresh:false,checkAt:saved.checked_at.getTime(),next:saved.checked_at.getTime()+interval,moved:0,released:0};
  }
  const versions:Record<string,WorkspaceVersion>=Object.create(null);
  let ids:string[]|null=null,result='unavailable',httpStatus:number|undefined;
  try{
    const inventory=await read();
    if(inventory.waking)result='waking';
    else if(inventory.chats.length<=10_000&&inventory.chats.every(chat=>chat.id.length>0&&chat.id.length<=256)){
      ids=[...new Set(inventory.chats.map(chat=>chat.id))].sort();result='ready';
      for(const chat of inventory.chats)if(chat.updated_at&&Number.isFinite(Date.parse(chat.updated_at))){
        versions[chat.id]={updated:new Date(chat.updated_at).toISOString(),...(chat.created_at?{created:chat.created_at}:{})};
      }
    }
  }catch(error){if(error instanceof ReplicasProviderError)httpStatus=error.status;}
  const at=new Date(now).toISOString(),next=now+interval;
  await client.query(`INSERT INTO opencrawl_replicas_workspace_inventories(namespace,tenant,import_id,workspace,checked_at,chat_ids,result,chat_versions)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(namespace,tenant,import_id,workspace) DO UPDATE
    SET checked_at=EXCLUDED.checked_at,chat_ids=COALESCE(EXCLUDED.chat_ids,opencrawl_replicas_workspace_inventories.chat_ids),result=EXCLUDED.result,
      chat_versions=CASE WHEN EXCLUDED.chat_ids IS NULL THEN opencrawl_replicas_workspace_inventories.chat_versions ELSE EXCLUDED.chat_versions END,
      export_check=CASE WHEN EXCLUDED.chat_ids IS NULL THEN opencrawl_replicas_workspace_inventories.export_check WHEN opencrawl_replicas_workspace_inventories.export_check ? 'retryAt' THEN opencrawl_replicas_workspace_inventories.export_check
        WHEN opencrawl_replicas_workspace_inventories.chat_ids IS DISTINCT FROM EXCLUDED.chat_ids
        OR jsonb_array_length(COALESCE(opencrawl_replicas_workspace_inventories.export_check->'outside','[]'::jsonb))>0
        OR opencrawl_replicas_workspace_inventories.chat_versions IS DISTINCT FROM EXCLUDED.chat_versions
        THEN NULL ELSE opencrawl_replicas_workspace_inventories.export_check END`,[...args,at,ids,result,versions]);
  let moved=0,released=0;
  if(ids){
    const scoped=`namespace=$1 AND tenant=$2 AND chat->>'workspace_id'=$4 AND issue->>'importId'=$3 AND checkpoint->>'before' IS NULL
      AND NOT (issue ? 'continuation') AND issue->>'operation'='history'
      AND (issue->>'httpStatus'='404' OR issue->>'reason' IN ('empty_with_messages','empty_unverified'))`;
    // An inventory can stay stale while history itself recovers. A workspace
    // refresh must never postpone a direct chat probe past its own daily
    // retry horizon. An explicit provider Retry-After remains authoritative.
    const nextProbe=`GREATEST((issue->>'providerRetryAt')::timestamptz,
      LEAST(GREATEST(retry_at,$7::timestamptz),COALESCE((issue->>'at')::timestamptz,$6::timestamptz)+interval '24 hours'))`;
    const absent=await client.query(`UPDATE opencrawl_replicas_deferred SET retry_at=${nextProbe},
      issue=issue||jsonb_build_object('workspaceAbsentAt',$6::text,'retryAt',${nextProbe})
      WHERE ${scoped} AND NOT ((chat->>'chat_id')=ANY($5::text[]))`,[...args,ids,at,new Date(next).toISOString()]);
    moved=absent.rowCount??0;
    const present=await client.query(`UPDATE opencrawl_replicas_deferred SET retry_at=GREATEST((issue->>'providerRetryAt')::timestamptz,LEAST(retry_at,$6::timestamptz)),
      issue=(issue-'workspaceAbsentAt')||jsonb_build_object('retryAt',GREATEST((issue->>'providerRetryAt')::timestamptz,LEAST(retry_at,$6::timestamptz)))
      WHERE ${scoped} AND issue ? 'workspaceAbsentAt' AND (chat->>'chat_id')=ANY($5::text[])`,[...args,ids,at]);
    released=present.rowCount??0;
  }
  return {ids:ids?new Set(ids):undefined,result,httpStatus,fresh:true,checkAt:now,next,moved,released};
}
