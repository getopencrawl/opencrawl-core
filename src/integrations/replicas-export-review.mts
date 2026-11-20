import type {ApplicationDatabase} from '../state/postgres.mjs';
import {ReplicasProviderError,type replicasApi} from './replicas-api.mjs';
import {deferredHistory,emptyCheckpoint} from './replicas-deferred.mjs';
import {observeReplicasWorkspace} from './replicas-inventory.mjs';
import {replicasDigest} from './replicas-events.mjs';

type Client=Pick<ApplicationDatabase['pool'],'query'>;
type Scope=[namespace:string,tenant:string,importId:string];
interface Review {phase:string;cursor?:string|null;cursors?:string[];examined?:number;total?:number;added?:number;outside?:string[];fullCatalog?:boolean}
const eligible=`((chat_ids IS NOT NULL AND (
  export_check IS NULL OR export_check->>'phase'='checking' OR
  ($4::boolean AND export_check->>'phase'='complete' AND NOT COALESCE((export_check->>'fullCatalog')::boolean,false))
)) OR ($4::boolean AND result='unobserved'))`;

export async function hasWorkspaceExportReview(client:Client,scope:Scope,sweep:boolean){
  return (await client.query<{pending:boolean}>(`SELECT EXISTS(SELECT 1 FROM opencrawl_replicas_workspace_inventories
    WHERE namespace=$1 AND tenant=$2 AND import_id=$3 AND ${eligible}) AS pending`,[...scope,sweep])).rows[0].pending;
}

/** The original catalog can omit a workspace-listed chat. Only a matching row
 * from the organization's retained export may enroll that chat. Check one
 * export page per activity, under the same tenant lock as the ordinary queue. */
export async function reviewWorkspaceExport(client:Client,scope:Scope,completed:readonly string[],api:ReturnType<typeof replicasApi>,now:number,sweep:boolean){
  const [namespace,tenant,importId]=scope;
  const result=await client.query<{workspace:string;chat_ids:string[]|null;export_check:Review|null}>(`SELECT workspace,chat_ids,export_check
    FROM opencrawl_replicas_workspace_inventories WHERE namespace=$1 AND tenant=$2 AND import_id=$3 AND ${eligible}
    ORDER BY checked_at,workspace LIMIT 1`,[...scope,sweep]);
  const row=result.rows[0];
  if(!row)return {requested:false,added:0};
  const workspace=row.workspace,args=[...scope,workspace],at=new Date(now).toISOString();
  if(!row.chat_ids){
    await observeReplicasWorkspace(client,{namespace,tenant,importId,workspace},now,()=>api.workspaceChats(workspace));
    return {requested:true,added:0};
  }
  const save=(value:Review)=>client.query(`UPDATE opencrawl_replicas_workspace_inventories SET export_check=$5
    WHERE namespace=$1 AND tenant=$2 AND import_id=$3 AND workspace=$4`,[...args,value]);
  const done=new Set(completed);
  const unknown=new Set(row.chat_ids.filter(id=>!done.has(replicasDigest(workspace+':'+id))));
  if(unknown.size){
    const existing=await client.query<{id:string}>(`SELECT DISTINCT chat->>'chat_id' AS id FROM opencrawl_replicas_deferred
      WHERE namespace=$1 AND tenant=$2 AND chat->>'workspace_id'=$3 AND chat->>'chat_id'=ANY($4::text[])`,[namespace,tenant,workspace,[...unknown]]);
    for(const known of existing.rows)unknown.delete(known.id);
  }
  const continuing=row.export_check?.phase==='checking'&&(!sweep||row.export_check.fullCatalog===true);
  const previous:Review=continuing?row.export_check!:{phase:'checking',added:row.export_check?.added??0};
  if(!sweep&&!unknown.size){await save({...previous,phase:'complete',outside:[],cursor:null,cursors:[]});return {requested:false,added:0};}
  let page;
  try{page=await api.conversations(previous.cursor,workspace);}
  catch(error){
    const status=error instanceof ReplicasProviderError?error.status:undefined;
    await save({phase:'unavailable'});
    console.warn(JSON.stringify({event:'replicas.import.workspace_export',tenantId:tenant,importId,workspaceId:workspace,result:'unavailable',httpStatus:status}));
    return {requested:true,added:0};
  }
  const cursors=previous.cursors??[],next=page.next_cursor?replicasDigest(page.next_cursor):null;
  const examined=(previous.examined??0)+page.conversations.length;
  const mismatch=page.conversations.some(c=>c.workspace_id!==workspace),unstable=previous.total!==undefined&&previous.total!==page.total||
    examined>page.total||(!next&&examined!==page.total)||Boolean(next&&(cursors.includes(next)||!page.conversations.length));
  if(mismatch||unstable){
    const phase=mismatch?'scope_mismatch':'inconsistent_catalog';
    await save({phase});
    console.warn(JSON.stringify({event:'replicas.import.workspace_export',tenantId:tenant,importId,workspaceId:workspace,result:phase}));
    return {requested:true,added:0};
  }
  const pending=deferredHistory(client,namespace,tenant);
  // A retained history can be readable even when the native chat list omits
  // it. The exact scoped export is authoritative for enrollment.
  const knownIds=new Set<string>();
  if(sweep&&page.conversations.length){
    const existing=await client.query<{id:string}>(`SELECT DISTINCT chat->>'chat_id' AS id FROM opencrawl_replicas_deferred
      WHERE namespace=$1 AND tenant=$2 AND chat->>'workspace_id'=$3 AND chat->>'chat_id'=ANY($4::text[])`,
      [namespace,tenant,workspace,page.conversations.map(chat=>chat.chat_id)]);
    for(const item of existing.rows)knownIds.add(item.id);
  }
  let added=0;
  for(const chat of page.conversations){
    const listed=unknown.delete(chat.chat_id);
    if((!sweep&&!listed)||knownIds.has(chat.chat_id)||done.has(replicasDigest(workspace+':'+chat.chat_id)))continue;
    knownIds.add(chat.chat_id);
    await pending.save(chat,emptyCheckpoint(),{at,operation:'catalog',reason:'newly_exported',decision:'continue',attempt:0,
      elapsedMs:0,importId,workspaceId:workspace,chatId:chat.chat_id},at);
    added++;
  }
  const more=Boolean(next&&(sweep||unknown.size)),totalAdded=(previous.added??0)+added;
  await save({phase:more?'checking':'complete',cursor:more?page.next_cursor:null,cursors:more?[...cursors,next!]:[],examined,total:page.total,
    added:totalAdded,fullCatalog:sweep,...more?{}:{outside:[...unknown]}});
  console.info(JSON.stringify({event:'replicas.import.workspace_export',tenantId:tenant,importId,workspaceId:workspace,result:more?'checking':'complete',
    examined,total:page.total,added,remaining:unknown.size}));
  return {requested:true,added};
}
