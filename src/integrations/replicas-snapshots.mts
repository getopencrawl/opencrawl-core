import type {ApplicationDatabase} from '../state/postgres.mjs';
import type {ReplicasConversation,ReplicasHistory} from './replicas-api.mjs';

type Client=Pick<ApplicationDatabase['pool'],'query'>;
type Scope=[namespace:string,tenant:string,importId:string];
export interface SnapshotCounts {events:number;turns:number;pages:number}
export interface SnapshotRefresh {revision:string;baseline:SnapshotCounts|null}
export interface WorkspaceVersion {created?:string;updated:string}
export interface SnapshotProgress extends SnapshotCounts {through:string}

function timestamp(value:unknown){
  return typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value):0;
}
export function sourceRevision(chat:ReplicasConversation,native:WorkspaceVersion){
  // The export can join the same ID to unrelated catalog metadata. Require
  // the native chat's creation time when the workspace supplies one.
  if(native.created&&timestamp(native.created)!==timestamp(chat.created_at))return;
  let time=timestamp(native.updated);
  if(Array.isArray(chat.senders))for(const item of chat.senders)time=Math.max(time,timestamp(item?.recorded_at));
  return time?new Date(time).toISOString():undefined;
}
export function snapshotProgress(previous:SnapshotProgress|undefined,chat:ReplicasConversation,history:ReplicasHistory,turns:number){
  let through=previous?timestamp(previous.through):0;
  // A catalog row's update time can belong to another artifact. Use actual
  // history timestamps for the snapshot and the catalog time as a fallback.
  for(const event of history.events){
    if(event&&typeof event==='object'&&'timestamp' in event)through=Math.max(through,timestamp(event.timestamp));
  }
  if(Array.isArray(history.senders))for(const item of history.senders)through=Math.max(through,timestamp(item?.recorded_at));
  return {events:(previous?.events??0)+history.events.length,turns:(previous?.turns??0)+turns,
    pages:(previous?.pages??0)+1,through:new Date(through||timestamp(chat.updated_at)).toISOString()};
}
export async function prepareSnapshots(client:Client){
  await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_replicas_snapshots(
    namespace text NOT NULL,tenant text NOT NULL,import_id text NOT NULL,workspace text NOT NULL,chat_id text NOT NULL,
    source_version timestamptz NOT NULL,counts jsonb NOT NULL,verify_next boolean NOT NULL DEFAULT false,PRIMARY KEY(namespace,tenant,import_id,workspace,chat_id))`);
}
export async function saveSnapshot(client:Client,scope:Scope,chat:ReplicasConversation,progress:SnapshotProgress,refresh?:SnapshotRefresh|null){
  const {through,...counts}=progress;
  const observed=new Date(Math.max(Date.parse(through),timestamp(refresh?.revision))).toISOString();
  await client.query(`INSERT INTO opencrawl_replicas_snapshots(namespace,tenant,import_id,workspace,chat_id,source_version,counts)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(namespace,tenant,import_id,workspace,chat_id) DO UPDATE
    SET source_version=GREATEST(opencrawl_replicas_snapshots.source_version,EXCLUDED.source_version),counts=EXCLUDED.counts,verify_next=false`,
    [...scope,chat.workspace_id,chat.chat_id,observed,counts]);
}
export async function snapshotsForPage(client:Client,scope:Scope,workspace:string,ids:string[]){
  if(!ids.length)return new Map<string,{source_version:Date;counts:SnapshotCounts;verify_next:boolean}>();
  const result=await client.query<{chat_id:string;source_version:Date;counts:SnapshotCounts;verify_next:boolean}>(`SELECT chat_id,source_version,counts,verify_next
    FROM opencrawl_replicas_snapshots WHERE namespace=$1 AND tenant=$2 AND import_id=$3 AND workspace=$4 AND chat_id=ANY($5::text[])`,
    [...scope,workspace,ids]);
  return new Map(result.rows.map(row=>[row.chat_id,row]));
}
