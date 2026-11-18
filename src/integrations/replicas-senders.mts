import type {CapturedActor} from '../sessions/actors.mjs';
import type {SessionBatch,SessionEvent} from '../sessions/types.mjs';
import {capturedReplicasRecord,record,projectReplicasRecord} from '../sessions/replicas-record.mjs';

const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[\w.:-]{1,200}$/.test(v);
const label=(v:unknown,max:number)=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u001f]/.test(v)?v:undefined;
interface Sender {userId:string;name?:string;email?:string}
export interface SenderEvidence {workspaceId:string;senders:Record<string,Sender|null>}

/** The catalog covers the chat, while history sometimes supplies richer profiles.
 * A contradictory sender ID invalidates that message's attribution. */
export function replicasSenderEvidence(conversation:Record<string,unknown>,history:Record<string,unknown>){
  const senders=new Map<string,Sender|null>();
  for(const list of [conversation.senders,history.senders]){
    if(!Array.isArray(list))continue;
    for(const value of list){
      const row=record(value);
      if(!row||!id(row.message_id)||!uuid(row.sender_user_id))continue;
      const prior=senders.get(row.message_id),userId=row.sender_user_id.toLowerCase();
      if(prior===null||prior&&prior.userId!==userId){senders.set(row.message_id,null);continue;}
      senders.set(row.message_id,{userId,name:label(row.sender_display_name,256)||prior?.name,email:label(row.sender_email,320)||prior?.email});
    }
  }
  return uuid(conversation.workspace_id)&&senders.size?{replicasSenders:{workspaceId:conversation.workspace_id,senders:Object.fromEntries(senders)}}:{};
}
function messageIds(event:SessionEvent){
  const source=record(capturedReplicasRecord(event)?.record);
  const payload=record(source?.payload),item=record(payload?.item);
  return [payload?.replicasMessageId,item?.replicasMessageId,item?.id,payload?.uuid].filter(id);
}
// Batches containing the complete API page already carry this evidence. For
// later chunks, copy only the sender records used by that chunk's messages.
export function chunkSenderEvidence(events:SessionEvent[],info:SenderEvidence|undefined){
  if(!info||events.some(event=>event.kind==='replicas_history_page'))return {};
  const ids=new Set(events.filter(event=>event.kind==='message').flatMap(messageIds));
  const rows=[...ids].filter(key=>Object.hasOwn(info.senders,key)).map(key=>[key,info.senders[key]]);
  return rows.length?{replicasSenders:{workspaceId:info.workspaceId,senders:Object.fromEntries(rows)}}:{};
}
const archived=new WeakMap<SessionBatch,SenderEvidence|undefined>();
function evidence(batch:SessionBatch){
  if(batch.replicasSenders)return batch.replicasSenders;
  // Older batches can be labeled directly from their original archived page.
  if(!archived.has(batch)){
    const page=record(batch.events.find(e=>e.kind==='replicas_history_page')?.data?.replicasPage);
    archived.set(batch,replicasSenderEvidence(record(page?.conversation)??{},record(page?.response)??{}).replicasSenders);
  }
  return archived.get(batch);
}
export function historyActor(event:SessionEvent,batch:SessionBatch):CapturedActor|undefined{
  const raw=capturedReplicasRecord(event);
  if(!raw||batch.harness!=='replicas')return;
  const projected=projectReplicasRecord(raw);
  if(projected.kind!=='message'||projected.data.role!=='user')return;
  const content=projected.data.content;
  if(Array.isArray(content)&&content.some(part=>record(part)?.type==='tool_result'))return;
  if(record(record(raw.record)?.payload)?.isSynthetic)return;
  const info=evidence(batch);
  if(!info||!uuid(info.workspaceId)||!record(info.senders))return;
  const candidates=messageIds(event);
  const matches=candidates.filter(key=>Object.hasOwn(info.senders,key));
  const messageId=matches[0],sender=messageId&&info.senders[messageId];
  if(!messageId||!sender||!uuid(sender.userId)||matches.some(key=>info.senders[key]?.userId!==sender.userId))return;
  return {provider:'replicas',assurance:'collector-reported',kind:'human',workspaceId:info.workspaceId,messageId,
    nativeId:id(event.nativeId)?event.nativeId:messageId,userId:sender.userId,name:label(sender.name,256),email:label(sender.email,320)};
}
