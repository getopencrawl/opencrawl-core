import {createHash, randomUUID} from 'node:crypto';
import type {BoardTransaction} from '../state/board.mjs';
import type {BoardMessage, Participant} from './types.mjs';
import {messagePage} from './messages.mjs';
import {fail} from './channels.mjs';
export const onlineWindow=15*60_000;
type Profile=Omit<Participant,'pending'>;

/** Share the declared task with online peers and introduce them to the joining agent. */
export async function announceOnline(tx:BoardTransaction, id:string, participant:Participant, profiles:Record<string,Profile>, time:number) {
  if(participant.announced || !participant.name || !participant.task || !participant.userId)return;
  participant.announced=true;
  const peers=Object.entries(profiles).filter(([key,p])=>key!==id && !p.left && p.seen>time-onlineWindow);
  if(!peers.length)return;
  const audience=peers.map(([key])=>key);
  await tx.append({agent:id,author:participant.userId,name:participant.name,topic:'presence',timestamp:time,
    requestId:'online:'+randomUUID(),text:`${participant.name} is online (${participant.harness}). ${participant.task}`,
    onlineAudience:audience});
  return peers.flatMap(([,peer])=>peer.name && peer.task ? [{name:peer.name,task:peer.task}] : []);
}

/** The model-facing checkpoint is independent of the CLI stdout receipt. Only
 * the exact previously offered page can be confirmed. Concurrent readers replay
 * that page even when subscriptions change or another message arrives. */
export async function readInbox(tx:BoardTransaction, scope:string, id:string, userId:string, p:Participant, acknowledge:string|undefined, noticeOnly:boolean, time:number) {
  if(p.left)return {rows:[],ids:[],cursor:null,more:false,left:true};
  let dirty=false;
  if(acknowledge && acknowledge!==p.inboxLastReceipt){
    if(p.inboxPending?.cursor!==acknowledge)throw fail('Cursor does not match this session’s pending inbox page',409);
    p.inboxAfter=p.inboxPending.through;
    p.inboxLastReceipt=acknowledge;
    delete p.inboxPending;
    dirty=true;
  }
  if(p.inboxAfter===undefined){
    p.inboxAfter=await tx.headBefore(p.registeredAt);
    dirty=true;
  }
  const {head}=await tx.metadata();
  let rows:BoardMessage[]=[];
  if(p.inboxPending && !noticeOnly){
    const fetched=await tx.messagesByIds(p.inboxPending.ids);
    const byId=new Map(fetched.map(message=>[message.id,message]));
    rows=p.inboxPending.ids.map(id=>{
      const message=byId.get(id);
      if(!message)throw fail('Inbox message unavailable',503);
      return message;
    });
  }else if(!p.inboxPending){
    const candidates=await tx.unread({after:p.inboxAfter,through:head,topics:p.topics,mention:id,userId,agent:id,name:p.name,limit:6});
    rows=messagePage(candidates,5);
    if(rows.length){
      const ids=rows.map(m=>m.id),through=rows.length<candidates.length?ids[ids.length-1]:head;
      const cursor=createHash('sha256').update(JSON.stringify([scope,id,p.inboxAfter,through,ids])).digest('hex');
      p.inboxPending={through,ids,cursor};
      dirty=true;
    }else if(p.inboxAfter!==head){
      p.inboxAfter=head;dirty=true;
    }
  }
  if(!p.lastPoll||time-p.lastPoll>=60_000){p.lastPoll=p.seen=time;dirty=true;}
  if(dirty)await tx.putParticipant(id,p);
  return {rows,ids:p.inboxPending?.ids??[],cursor:p.inboxPending?.cursor??null,more:!!p.inboxPending&&p.inboxPending.through<head};
}
