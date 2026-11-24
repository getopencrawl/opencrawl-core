import {createHash} from 'node:crypto';
import type {SessionEvent} from '../sessions/types.mjs';
import type {ReplicasConversation,ReplicasHistory} from './replicas-api.mjs';
import {record,projectReplicasRecord} from '../sessions/replicas-record.mjs';

export function canonical(value:unknown):string{
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  const object=record(value);return object?'{'+Object.keys(object).sort().map(key=>JSON.stringify(key)+':'+canonical(object[key])).join(',')+'}':JSON.stringify(value)??'null';
}
export const replicasDigest=(value:string)=>createHash('sha256').update(value).digest('hex');
export function replicasTurns(history:ReplicasHistory):unknown[]{
  const transcript=record(history.codex_asp_transcript);
  return Array.isArray(transcript?.turns)?transcript.turns:[];
}

/** Preserve the complete API page and every event/turn. Occurrence numbers
 * preserve identical records without native IDs across pagination boundaries.
 * The caller checkpoints counters only after all immutable batches land. */
export function replicasEvents(conversation:ReplicasConversation,history:ReplicasHistory,occurrences:Record<string,number>={},before:string|null=null):SessionEvent[]{
  const page={conversation,request:{before_cursor:before},response:history};
  const events:SessionEvent[]=[{id:'replicas-page-v2:'+replicasDigest(canonical(page)),kind:'replicas_history_page',timestamp:conversation.created_at,data:{replicasPage:page}}];
  return [...events,...replicasRecords(conversation.chat_id,history,occurrences)];
}

export function replicasRecords(chatId:string,history:ReplicasHistory,occurrences:Record<string,number>={}):SessionEvent[]{
  const events:SessionEvent[]=[];
  const records=[...history.events.map(value=>({collection:'events',value})),...replicasTurns(history).map(value=>({collection:'codex_asp_transcript.turns',value}))];
  for(const {collection,value} of records){
    const hash=replicasDigest(canonical({chat:chatId,collection,value}));
    const occurrence=occurrences[hash]??0;occurrences[hash]=occurrence+1;
    const source=record(value),payload=record(source?.payload),item=record(payload?.item);
    const nativeId=[payload?.uuid,item?.id,source?.id].find(value=>typeof value==='string');
    const timestamp=[source?.timestamp,item?.timestamp,payload?.timestamp].find(value=>typeof value==='string');
    // Provider/catalog metadata lives in the original page. The same native
    // chat can appear multiple times in Replicas' export with different labels.
    const raw={collection,record:value};
    events.push({id:'replicas-v2:'+hash+':'+occurrence,kind:projectReplicasRecord(raw).kind,timestamp:typeof timestamp==='string'?timestamp:null,
      ...(typeof nativeId==='string'?{nativeId}:{}),...(typeof payload?.turnId==='string'?{turnId:payload.turnId}:{}),
      ...(typeof payload?.parent_tool_use_id==='string'?{parentId:payload.parent_tool_use_id}:{}),data:{replicas:raw}});
  }
  return events;
}

export function replicasSession(tenantId:string,organizationId:string,workspaceId:string,chatId:string){
  const owner={tenantId,userId:'workload_replicas_'+replicasDigest('history-v2:'+organizationId+':'+workspaceId)};
  return {schemaVersion:1,installationId:'replicas-history-v2:'+organizationId,sessionId:'replicas-chat:'+chatId,harness:'replicas',origin:'cloud',owner};
}
