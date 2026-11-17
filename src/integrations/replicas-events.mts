import {createHash} from 'node:crypto';
import type {SessionEvent} from '../sessions/types.mjs';
import type {ReplicasConversation,ReplicasHistory} from './replicas-api.mjs';

function record(value:unknown):Record<string,unknown>|undefined{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;}
function canonical(value:unknown):string{
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  const object=record(value);return object?'{'+Object.keys(object).sort().map(key=>JSON.stringify(key)+':'+canonical(object[key])).join(',')+'}':JSON.stringify(value)??'null';
}
export const replicasDigest=(value:string)=>createHash('sha256').update(value).digest('hex');
export const replicasHarness=(provider:string|null)=>provider==='claude'?'claude-code':provider==='codex'?'codex':null;

/** Retained exports have no file offsets. Give them their own immutable identity
 * namespace; never pretend these IDs match native live-capture wire IDs. */
export function replicasEvents(conversation:ReplicasConversation,history:ReplicasHistory):SessionEvent[]{
  const result=new Map<string,SessionEvent>();
  for(const source of history.events){
    const payload=source.payload;let data:Record<string,unknown>|undefined;
    if(conversation.provider==='claude'&&['claude-user','claude-assistant'].includes(source.type)&&!payload.isMeta){
      const message=record(payload.message);if(message&&['user','assistant'].includes(String(message.role)))data=message;
    }
    if(conversation.provider==='codex'&&source.type==='codex-item'){
      const item=record(payload.item);
      if(item?.type==='userMessage'&&(typeof item.content==='string'||Array.isArray(item.content)))data={role:'user',content:typeof item.content==='string'?[{type:'text',text:item.content}]:item.content};
      if(item?.type==='agentMessage'&&typeof item.text==='string')data={role:'assistant',content:[{type:'text',text:item.text}]};
    }
    // event_msg mirrors codex-item user messages. Import only the canonical item.
    if(!data)continue;
    // This connector imports conversation text only. Tool traces and images
    // have different native schemas and are explicitly excluded in the preview.
    const content=typeof data.content==='string'?[{type:'text',text:data.content}]:Array.isArray(data.content)?data.content.filter(value=>{const block=record(value);return block&&['text','input_text','output_text'].includes(String(block.type))&&typeof block.text==='string';}):[];
    if(!content.length)continue;
    data={role:data.role,content};
    const timestamp=source.timestamp??null;
    const id='replicas-v1:'+replicasDigest(canonical({chat:conversation.chat_id,type:source.type,timestamp,data}));
    result.set(id,{id,kind:'message',data,timestamp});
  }
  return [...result.values()];
}
