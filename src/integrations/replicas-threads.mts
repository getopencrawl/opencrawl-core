import type {ApplicationDatabase} from '../state/postgres.mjs';
import type {SessionKey} from '../sessions/session-reference.mjs';
import {record} from '../sessions/replicas-record.mjs';
import type {Principal} from '../sessions/types.mjs';
import {replicasCaptureOwner} from './replicas-events.mjs';
import type {ReplicasHistory} from './replicas-api.mjs';

type Client=Pick<ApplicationDatabase['pool'],'query'>;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
type Thread={harness:'claude-code'|'codex';id:string};
export type ThreadEvidence=Thread|'conflict';
export function combineThreads(first?:ThreadEvidence|null,second?:ThreadEvidence|null):ThreadEvidence|undefined{
  if(!first)return second??undefined;
  if(!second)return first;
  if(first==='conflict'||second==='conflict'||first.harness!==second.harness||first.id!==second.id)return 'conflict';
  return first;
}
export type CapturePair={history:SessionKey;live:SessionKey};
export type CaptureLookup=(tenant:string,visible:readonly SessionKey[])=>Promise<CapturePair[]>;
export const captureKey=(key:SessionKey)=>JSON.stringify([key.userId,key.harness,key.sessionId]);

/** Only provider-issued thread/session identity. A chat title, an event UUID or
 * a piece of identical prose cannot establish that two sessions are one. */
export function replicasThread(history:ReplicasHistory):ThreadEvidence|undefined{
  let thread:Thread|undefined,conflict=false;
  function observe(harness:Thread['harness'],id:unknown){
    if(!uuid(id))return;
    if(thread&&(thread.harness!==harness||thread.id!==id))conflict=true;
    else thread={harness,id};
  }
  const provider=history.coding_agent;
  let claude=false,codex=false;
  if(provider==='claude'||provider==='codex')observe(provider==='claude'?'claude-code':'codex',history.thread_id);
  for(const value of history.events){
    const event=record(value);
    if(event?.type==='claude-user'||event?.type==='claude-assistant'){
      claude=true;
      const payload=record(event.payload);
      observe('claude-code',payload?.session_id);observe('claude-code',payload?.sessionId);
    }else if(typeof event?.type==='string'&&(event.type.startsWith('codex-')||event.type==='response_item'||event.type==='event_msg'))codex=true;
  }
  if(!provider&&claude!==codex)observe(claude?'claude-code':'codex',history.thread_id);
  if(thread&&((uuid(history.thread_id)&&history.thread_id!==thread.id)||(provider&&provider!==(thread.harness==='claude-code'?'claude':'codex'))))conflict=true;
  return conflict?'conflict':thread;
}
export async function prepareReplicasThreads(client:Client){
  await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_replicas_threads(
    namespace text NOT NULL,tenant text NOT NULL,owner_id text NOT NULL,session_id text NOT NULL,
    harness text,native_id text,PRIMARY KEY(namespace,tenant,owner_id,session_id));
    CREATE INDEX IF NOT EXISTS opencrawl_replicas_threads_native ON opencrawl_replicas_threads(namespace,tenant,harness,native_id)`);
}

/** A contradiction in any verified page permanently withdraws the link. */
export async function saveReplicasThread(client:Client,namespace:string,tenant:string,owner:string,session:string,evidence:ThreadEvidence){
  await client.query(`INSERT INTO opencrawl_replicas_threads AS t(namespace,tenant,owner_id,session_id,harness,native_id)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(namespace,tenant,owner_id,session_id)
    DO UPDATE SET harness=NULL,native_id=NULL WHERE t.native_id IS NOT NULL AND
    (t.harness,t.native_id) IS DISTINCT FROM (EXCLUDED.harness,EXCLUDED.native_id)`,
    [namespace,tenant,owner,session,evidence==='conflict'?null:evidence.harness,evidence==='conflict'?null:evidence.id]);
}

type NativeSession=Pick<SessionKey,'harness'|'sessionId'>;
export type CurrentCaptureLookup=(principal:Principal,current:NativeSession)=>Promise<SessionKey|undefined>;

/** Native IDs only link to a provider chat inside the authenticated workspace.
 * Forks may share native history. An ambiguous link cannot identify the caller. */
export async function currentReplicasCapture(client:Client,namespace:string,principal:Principal,current:NativeSession):Promise<SessionKey|undefined>{
  const owner=principal.owner;
  if(owner?.provider!=='replicas'||!['claude-code','codex'].includes(current.harness)||!uuid(current.sessionId))return;
  const userId=replicasCaptureOwner(owner.organizationId,owner.workspaceId);
  const {rows}=await client.query<{session_id:string}>(`SELECT session_id FROM opencrawl_replicas_threads
    WHERE namespace=$1 AND tenant=$2 AND owner_id=$3 AND harness=$4 AND native_id=$5 LIMIT 2`,
    [namespace,principal.tenantId,userId,current.harness,current.sessionId]);
  if(rows.length===1)return {userId,harness:'replicas',sessionId:rows[0]!.session_id};
}

/** One indexed lookup for the already-authorized candidate window. No read
 * permission, contents, owners or candidate IDs are added by this lookup. */
export async function visibleCapturePairs(client:Client,namespace:string,tenant:string,visible:readonly SessionKey[]):Promise<CapturePair[]>{
  const imports=new Map<string,SessionKey>(),live=new Map<string,Map<string,SessionKey>>();
  for(const key of visible){
    if(key.harness==='replicas'&&/^workload_replicas_[a-f0-9]{64}$/.test(key.userId)&&key.sessionId.startsWith('replicas-chat:'))imports.set(captureKey(key),key);
    if((key.harness==='claude-code'||key.harness==='codex')&&uuid(key.sessionId)){
      const id=key.harness+':'+key.sessionId,owners=live.get(id)??new Map();
      owners.set(key.userId,key);live.set(id,owners);
    }
  }
  if(!imports.size||!live.size)return [];
  const keys=[...imports.values()];
  const {rows}=await client.query<{owner_id:string;session_id:string;harness:string;native_id:string}>(`
    SELECT t.owner_id,t.session_id,t.harness,t.native_id FROM unnest($3::text[],$4::text[]) k(owner_id,session_id)
    JOIN opencrawl_replicas_threads t USING(owner_id,session_id)
    WHERE t.namespace=$1 AND t.tenant=$2 AND t.native_id IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM opencrawl_replicas_threads x WHERE (x.namespace,x.tenant,x.harness,x.native_id)=(t.namespace,t.tenant,t.harness,t.native_id)
        AND (x.owner_id,x.session_id)<>(t.owner_id,t.session_id))`,[namespace,tenant,keys.map(k=>k.userId),keys.map(k=>k.sessionId)]);
  const pairs:CapturePair[]=[];
  for(const row of rows){
    const history=imports.get(captureKey({userId:row.owner_id,harness:'replicas',sessionId:row.session_id}));
    const owners=live.get(row.harness+':'+row.native_id);
    if(history&&owners?.size===1)pairs.push({history,live:[...owners.values()][0]!});
  }
  return pairs;
}
