import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {atomicJson,configDir} from '../session.ts';
import {CliError} from '../oauth.ts';
import {hash} from './parse.ts';

const execute=promisify(execFile);
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const identifier=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,200}$/.test(value);
export type ReplicasActor={provider:'replicas';assurance:'collector-reported';workspaceId:string;messageId:string;nativeId:string;kind:'human'|'unknown';userId?:string;name?:string;email?:string};
/** Mutable profile labels belong to the batch envelope, outside event identity. */
export function replicasEventAttribution(value:ReplicasActor){
 const {name,email,...actor}=value;
 return {actor,profile:actor.userId?{provider:actor.provider,userId:actor.userId,...(name?{name}:{}),...(email?{email}:{})}:undefined};
}
type History={thread_id?:unknown;coding_agent?:unknown;events?:unknown;senders?:unknown;has_more?:unknown;before_cursor?:unknown};
const bounded=(value:unknown,max:number)=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u001f]/.test(value)?value:undefined;
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const unavailable=()=>new CliError('REPLICAS_PROVENANCE_UNAVAILABLE','Replicas message provenance is unavailable; the transcript cursor is retained for retry.');

/** Exact platform message IDs only. Neither creator claims, email text in a
 * prompt, timestamp proximity nor message ordering establishes the sender. */
export function claudeReplicasActors(history:History,workspaceId:string,sessionId:string):Map<string,ReplicasActor>{
 if(!uuid(workspaceId)||history.thread_id!==sessionId||history.coding_agent!=='claude'||!Array.isArray(history.events)||!Array.isArray(history.senders))throw unavailable();
 const senders=new Map<string,Record<string,unknown>>();
 for(const value of history.senders){const s=object(value);if(!identifier(s.message_id))continue;if(senders.has(s.message_id)&&JSON.stringify(senders.get(s.message_id))!==JSON.stringify(s))throw unavailable();senders.set(s.message_id,s);}
 const actors=new Map<string,ReplicasActor>();
 for(const value of history.events){
  const event=object(value),payload=object(event.payload);
  if(event.type!=='claude-user'||!uuid(payload.uuid)||!identifier(payload.replicasMessageId))continue;
  const sender=senders.get(payload.replicasMessageId),human=uuid(sender?.sender_user_id);
  const actor:ReplicasActor={provider:'replicas',assurance:'collector-reported',workspaceId,nativeId:payload.uuid,messageId:payload.replicasMessageId,kind:human?'human':'unknown',
   ...(human?{userId:sender!.sender_user_id as string,name:bounded(sender!.sender_display_name,256),email:bounded(sender!.sender_email,320)}:{})};
  if(actors.has(payload.uuid)&&JSON.stringify(actors.get(payload.uuid))!==JSON.stringify(actor))throw unavailable();
  actors.set(payload.uuid,actor);
 }
 return actors;
}

/** The first observed attribution is persisted before spooling its event, so
 * later profile-name changes or a worker restart cannot change an event ID.
 * This is collector-reported provenance, never a human authentication grant. */
export function createReplicasAttribution({run=async(args:string[])=>{
 const {stdout}=await execute('replicas',[...args,'--json'],{encoding:'utf8',timeout:15000,maxBuffer:64*1024*1024});return JSON.parse(stdout) as unknown;
},directory=()=>join(configDir(),'capture','replicas-actors')}: {run?:(args:string[])=>Promise<unknown>;directory?:()=>string}={}){
 const sessions=new Map<string,{chatId:string;actors:Map<string,ReplicasActor>}>();
 return async(workspaceId:string,sessionId:string,nativeId:string):Promise<ReplicasActor|undefined>=>{
  if(!uuid(workspaceId)||!uuid(sessionId)||!uuid(nativeId))throw unavailable();
  const cacheKey=workspaceId+':'+sessionId,file=join(directory(),hash(cacheKey)+'.json');
  let state=sessions.get(cacheKey);
  if(!state){
   try{
    const raw=readFileSync(file,'utf8');if(raw.length>16*1024*1024)throw unavailable();
    const saved=JSON.parse(raw);
    if(saved.schemaVersion!==1||saved.workspaceId!==workspaceId||saved.sessionId!==sessionId||!uuid(saved.chatId)||!Array.isArray(saved.actors)||saved.actors.length>20000)throw unavailable();
    for(const entry of saved.actors){
     if(!Array.isArray(entry)||entry.length!==2)throw unavailable();
     const [id,actor]=entry;
     if(!uuid(id)||actor?.nativeId!==id||actor.workspaceId!==workspaceId||actor.provider!=='replicas'||actor.assurance!=='collector-reported'||!identifier(actor.messageId)||!['human','unknown'].includes(actor.kind)||actor.kind==='human'&&!uuid(actor.userId))throw unavailable();
    }
    state={chatId:saved.chatId,actors:new Map(saved.actors)};sessions.set(cacheKey,state);
   }catch(error:any){if(error.code!=='ENOENT')throw unavailable();}
  }
  const remembered=state?.actors.get(nativeId);if(remembered)return remembered;
  try{
   const chats=state?[{id:state.chatId,provider:'claude'}]:object(await run(['chat','list',workspaceId])).chats;
   if(!Array.isArray(chats)||chats.length>1000)throw unavailable();
   for(const row of chats){
    const chat=object(row);if(chat.provider!=='claude'||!uuid(chat.id))continue;
    let history=object(await run(['read',workspaceId,'--chat',chat.id,'--limit','200'])) as History;
    if(history.thread_id!==sessionId)continue;
    state??={chatId:chat.id,actors:new Map()};sessions.set(cacheKey,state);
    const visited=new Set<string>();
    for(let page=0;page<100;page++){
     for(const [id,actor] of claudeReplicasActors(history,workspaceId,sessionId))if(!state.actors.has(id))state.actors.set(id,actor);
     if(state.actors.size>20000)throw unavailable();
     if(state.actors.has(nativeId)){
      atomicJson(file,{schemaVersion:1,workspaceId,sessionId,chatId:state.chatId,actors:[...state.actors]});
      return state.actors.get(nativeId);
     }
     if(history.has_more!==true)throw unavailable();
     const cursor=bounded(history.before_cursor,8192);if(!cursor||visited.has(cursor))throw unavailable();visited.add(cursor);
     history=object(await run(['read',workspaceId,'--chat',chat.id,'--limit','200','--before',cursor])) as History;
    }
    throw unavailable();
   }
   // A native CLI/subagent session may run inside this VM without being a
   // Replicas chat. Preserve its transcript without inventing a platform sender.
   return undefined;
  }catch{sessions.delete(cacheKey);throw unavailable();}
 };
}
export const replicasAttribution=createReplicasAttribution();
