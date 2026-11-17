import type {SessionEvent,EventData} from './types.mjs';

export function record(value:unknown):Record<string,unknown>|undefined{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;}
export interface ReplicasRecord {provider?:unknown;collection:unknown;record:unknown}
export function capturedReplicasRecord(event:Pick<SessionEvent,'data'>):ReplicasRecord|undefined{
  const value=record(event.data?.replicas);
  return value&&'record' in value?{provider:value.provider,collection:value.collection,record:value.record}:undefined;
}
/** Read projection only. The stored source record is never rewritten. */
export function projectReplicasRecord(raw:ReplicasRecord):{kind:string;data:EventData}{
  const source=record(raw.record),payload=record(source?.payload)??{},message=record(payload.message),item=record(payload.item);
  if(['claude-user','claude-assistant'].includes(String(source?.type))&&message)return {kind:'message',data:message};
  if(source?.type==='codex-item'&&item){
    if(item.type==='userMessage')return {kind:'message',data:{role:'user',content:item.content}};
    if(item.type==='agentMessage')return {kind:'message',data:{role:'assistant',content:item.text,phase:item.phase}};
    if(item.type==='commandExecution')return {kind:'replicas_tool',data:{name:'exec_command',input:item.command,output:item.aggregatedOutput??item.output??item.stdout,exitCode:item.exitCode,status:item.status,call_id:typeof item.id==='string'?item.id:null}};
    if(item.type==='toolCall')return {kind:'replicas_tool',data:{name:String(item.tool??item.name??'tool'),server:item.server,input:item.input??item.arguments,output:item.output,status:item.status,call_id:typeof item.id==='string'?item.id:null}};
  }
  if(['response_item','codex-response_item'].includes(String(source?.type))){
    if(payload.type==='message')return {kind:'message',data:payload};
    if(['function_call','custom_tool_call'].includes(String(payload.type)))return {kind:'tool_call',data:payload};
    if(['function_call_output','custom_tool_call_output'].includes(String(payload.type)))return {kind:'tool_result',data:payload};
  }
  return {kind:'replicas_event',data:{source:raw.record}};
}
export function replicasProjection(event:SessionEvent):SessionEvent{
  const raw=capturedReplicasRecord(event);
  return raw?{...event,...projectReplicasRecord(raw)}:event;
}
export function replicasRaw(event:SessionEvent):unknown{
  const raw=capturedReplicasRecord(event);return raw?raw.record:event.data?.replicasPage;
}
