import {announceOnline,onlineWindow,profileRetentionMs} from './inbox.mjs';
import {bindPresenceSession,type PreviewFactory} from './presence-prompts.mjs';
import type {Principal} from '../sessions/types.mjs';
import type {BoardRepository,BoardReader} from '../state/board.mjs';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {fail,channelSchema,channelModeSchema,updateSubscriptions,channelName,channelNames,clientName,threadIdSchema,visibleMessage} from './channels.mjs';
import {requireBoardParticipation,publishMessage,mentionWarning} from './publication.mjs';
import {currentSessionSchema} from '../search/context.mjs';
import {replyNotification} from './messages.mjs';
import {boardIdentity} from './identity.mjs';

const text = (max: number) => z.string().trim().min(1).max(max);
const session = text(200);
const name = z.string().trim().min(3).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9:_.-]*$/, 'must start with a letter or digit and use only letters, digits, colons, underscores, dots or hyphens');
const topic = text(80);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const aliveMs = 180_000;
const workspace = {workspace: text(200).optional()};
export const participationSchemas = {
  incognito: z.strictObject({currentSession:currentSessionSchema,...workspace}),
  bootstrap: z.strictObject({session, harness: text(40)}).extend(workspace),
  profile: z.strictObject({session, name, task: text(240), announce:z.boolean().optional(), installationId:text(200).optional()}).extend(workspace),
  register: z.strictObject({session, name, task: text(240), harness: text(40).default('other'),announce:z.boolean().optional(),installationId:text(200).optional()}).extend(workspace),
  directory: z.strictObject({after: z.number().int().nonnegative().default(0)}).extend(workspace),
  // Older CLIs still send homepage; it is accepted and ignored. Deliveries are
  // system announcements, mentions and subscribed channels. Replies never broadcast.
  subscribe: z.strictObject({session, channelMode: channelModeSchema.optional(), channels: z.array(channelSchema).optional(), topics: z.array(topic).optional(), homepage: z.boolean().optional()}).extend(workspace),
  inbox: z.strictObject({session, receipt: z.string().regex(/^[a-f0-9]{64}$/, 'must be the full receipt returned by the board inbox').optional()}).extend(workspace),
  ack: z.strictObject({session, receipt: z.string().regex(/^[a-f0-9]{64}$/, 'must be the full receipt returned by the board inbox')}).extend(workspace),
  leave: z.strictObject({session}).extend(workspace),
  publish: z.strictObject({session, id: text(80), channel: channelSchema.optional(), topic: topic.optional(), threadId: threadIdSchema.optional(), text: z.string().trim().min(1), mentions: z.array(name).max(8).default([])}).extend(workspace),
};
type Operation = keyof typeof participationSchemas;
type Command = {[K in Operation]: {operation: K; args: z.output<typeof participationSchemas[K]>}}[Operation];

/** All state transitions and delivery receipts commit in one PostgreSQL transaction. */
export type RequestCaptureErasure = (principal:Principal, session:z.output<typeof currentSessionSchema>)=>Promise<{deleted:boolean;pending:boolean}>;
export function createParticipation({scope,repository,now,requestCaptureErasure,previews}:{scope(principal:Principal):string;repository:BoardRepository;now():number;requestCaptureErasure?:RequestCaptureErasure;previews:PreviewFactory}) {
  return async function participate(principal:Principal,requestedOperation:string,input:unknown={}){
    const key=scope(principal),schema=participationSchemas[requestedOperation as Operation];
    if(!schema)throw fail('Unknown board operation',404);
    const {operation,args}={operation:requestedOperation,args:schema.parse(input)} as Command;
    if(args.workspace!==undefined&&args.workspace!==principal.tenantId)throw fail('Workspace scope mismatch; use the registered workspace',403);
    if(operation==='incognito'){
      const session=args.currentSession;
      // A shared workload principal can represent multiple people's conversations.
      if(principal.owner)throw fail('A personal session owner is required for erasure',403);
      const intent={tenantId:principal.tenantId,userId:principal.userId,...session};
      await repository.transaction(key,async tx=>{
        const id=boardIdentity(principal.userId,session.sessionId);
        await tx.blockPublicationAndQueueErasure(intent);
        const participant=await tx.participant(id);
        if(participant&&!participant.left)await tx.putParticipant(id,{...participant,left:true,pending:null});
        await tx.removeAgent(id);
      });
      if(!requestCaptureErasure)throw fail('Session erasure is unavailable',503);
      const result=await requestCaptureErasure(principal,session);
      await repository.transaction(key,tx=>tx.acknowledgeErasure(intent));
      return {session,boardBlocked:true,...result};
    }
    const time=now(),id='session'in args?boardIdentity(principal.userId,args.session):'';
    const directory=async(tx:BoardReader,after=0,limit=32)=>{
      const page=await tx.directory({after,limit,cutoff:time-profileRetentionMs});
      return {...page,agents:page.agents.map(({id:agent,participant:p})=>({agent,name:p.name,task:p.task,harness:p.harness,seen:p.seen,
        listening:!p.left&&Number(p.lastPoll)>time-aliveMs,left:Boolean(p.left),topics:p.topics,channels:p.topics,registeredAt:p.registeredAt,lastPoll:p.lastPoll,lastAckAt:p.lastAckAt,
        acknowledgedThrough:p.ackCursor,pending:p.pending?{receipt:p.pending.receipt,createdAt:p.pending.createdAt,messages:p.pending.count}:null,
        batches:p.batches,acknowledgedBatches:p.acknowledgedBatches,lastDeliveryAt:p.lastDeliveryAt||null,acknowledgedMessages:p.acknowledgedMessages||0}))};
    };
    if(operation==='directory')return repository.read(key,async tx=>{const {agents,total}=await directory(tx,args.after);return {workspace:principal.tenantId,agents,through:(await tx.metadata()).head,total,next:args.after+agents.length<total?args.after+agents.length:null};});
    const preview=previews(principal,key);
    return preview.finish(repository.transaction(key,async tx=>{
      const {head}=await tx.metadata();let p=await tx.participant(id);
      if(operation!=='leave'&&operation!=='inbox')await requireBoardParticipation(tx,id);
      if(operation==='register'||operation==='bootstrap'||operation==='profile'){
        const requestedName=operation==='bootstrap'?undefined:args.name;
        if(requestedName)clientName(requestedName);
        await tx.prepareRegistration(id,requestedName,time-profileRetentionMs);
        if(operation==='profile'&&!p)throw fail('Register this session before setting its profile',404);
        if(operation!=='bootstrap'&&p?.name&&p.name!==args.name)throw fail(`This session is already registered as ${p.name}. Retry with --name ${p.name} and the same session ID.`,409);
        const resumed=Boolean(p);
        p||={name:'',task:'',harness:operation==='profile'?'other':args.harness,registeredAt:time,seen:time,topics:[],inboxAfter:head,ackCursor:head,lastPoll:null,lastAckAt:null,nextHomeAt:time+60000,pending:null,batches:0,acknowledgedBatches:0};
        const announce=p.announced || (operation!=='bootstrap' && args.announce);
        if(p.left||p.seen<=time-onlineWindow)p.announced=false;
        Object.assign(p,{userId:principal.userId,seen:time,left:false});
        if(operation!=='bootstrap')Object.assign(p,{name:args.name,task:args.task});
        if(operation!=='profile')p.harness=args.harness;
        bindPresenceSession(p,principal,args.session,operation==='bootstrap'?undefined:args.installationId);
        const peers=announce?await announceOnline(tx,id,p,time,preview):undefined;
        await tx.putParticipant(id,p);
        await tx.refreshAgent(id,p.name,time);
        return {workspace:principal.tenantId,agent:id,session:args.session,name:p.name||null,task:p.task||null,harness:p.harness,resumed,...peers?.length?{peers}:{},boardProtocol:2,boardInbox:true,
          subscriptions:{mentions:Boolean(p.name),topics:p.topics,channels:p.topics,announcements:true},pollAfterMs:10000,...(operation==='register'?{home:resumed?[]:(await tx.messages({limit:5,descending:true})).reverse().map(visibleMessage),agents:(await directory(tx,0,8)).agents}:{})};
      }
      if(!p)throw fail('Register this session before using the board',404);
      const ownerMissing=p.userId===undefined;p.userId=principal.userId;
      if(operation==='inbox'&&p.left)return {workspace:principal.tenantId,agent:id,left:true,batch:null};
      if(operation!=='leave'&&p.left)throw fail('Session has left; register it again to resume',409);
      let result:unknown,dirty=true;
      if(operation==='subscribe'){p.topics=updateSubscriptions(p.topics,channelNames(args),args.channelMode).sort();delete p.homepage;p.seen=time;result={agent:id,mentions:Boolean(p.name),topics:p.topics,channels:p.topics,announcements:true,effectiveAfter:p.ackCursor};}
      else if(operation==='leave'){p.left=true;p.seen=time;result={agent:id,left:true};}
      else if(operation==='ack'){
        if(args.receipt===p.lastReceipt)return {agent:id,acknowledged:args.receipt,through:p.ackCursor};
        if(!p.pending||args.receipt!==p.pending.receipt)throw fail('Receipt does not match the pending delivery',409);
        p.ackCursor=p.pending.through;p.acknowledgedMessages=(p.acknowledgedMessages||0)+p.pending.messages.length;
        if(p.pending.more)p.nextHomeAt=time;p.lastReceipt=args.receipt;p.pending=null;p.lastAckAt=p.seen=time;p.acknowledgedBatches++;
        result={agent:id,acknowledged:args.receipt,through:p.ackCursor};
      }else if(operation==='publish'){
        if(!p.name)throw fail('Choose a session name and task with board profile before publishing',409);
        clientName(p.name);
        const message=await publishMessage(tx,{userId:principal.userId,agent:id,name:p.name,registered:true},{...args,channel:channelName(args)},time);p.seen=time;
        result={agent:id,accepted:[message.id],mentions:message.mentions??[],...mentionWarning(message.publication?.unresolvedMentions??[])};
      }else if(operation==='inbox'){
        const bound=bindPresenceSession(p,principal,args.session);
        if(args.receipt&&args.receipt!==p.pending?.receipt)throw fail('Delivery is no longer pending; do not acknowledge another batch',409);
        dirty=ownerMissing||!p.lastPoll||time-p.lastPoll>=60000;if(dirty)p.lastPoll=p.seen=time;
        dirty ||= bound;
        if(!p.pending){
          // Select only deliverable rows; irrelevant history is skipped in SQL.
          // One lookahead row preserves the legacy through/more receipt boundary.
          const unseen=await tx.unread({after:p.ackCursor,through:head,topics:p.topics,mention:id,userId:principal.userId,agent:id,name:p.name,limit:9});
          if(unseen.length||time>=p.nextHomeAt){const messages=[];let through=head,bytes=0;
            for(const m of unseen){const reasons=[...(m.onlineAudience?.includes(id)?['presence']:[]),...(m.mentions?.includes(id)?['mention']:[]),...(p.topics.includes(m.topic)?['channel']:[]),...(m.threadId&&p.followedThreads?.includes(m.threadId)&&!p.mutedThreads?.includes(m.threadId)?['thread']:[]),...(m.system&&m.threadId===undefined?['announcement']:[])];const {requestId,publication,onlineAudience,captureRef,...v}=m,message={...v,reasons},size=Buffer.byteLength(JSON.stringify(message));
              if(messages.length>=8||messages.length>0&&bytes+size>8192){through=m.id-1;break;}messages.push(message);bytes+=size;
            }
            if(messages.length){const receipt=hash(JSON.stringify([id,p.ackCursor,through,messages.map(m=>m.id)]));p.pending={receipt,createdAt:time,through,more:through<head,messages};p.batches++;p.lastDeliveryAt=time;p.nextHomeAt=time+60000;dirty=true;}
            else if(through!==p.ackCursor){p.ackCursor=through;dirty=true;}
          }
        }
        const names=await tx.agentNames([...new Set((p.pending?.messages??[]).flatMap(m=>m.mentionNames?[]:m.mentions??[]))]);
        const introductions=p.pending?.messages.filter(m=>m.reasons.includes('presence')).map(m=>m.id)??[];
        const sources=new Map((introductions.length?await tx.messagesByIds(introductions):[]).map(row=>[row.id,row]));
        result={workspace:principal.tenantId,agent:id,name:p.name,batch:p.pending?{...p.pending,messages:p.pending.messages.map(m=>{
          const view={...m,...replyNotification(m.threadId),mentionNames:m.mentionNames??(m.mentions??[]).map(id=>names[id]??id),channel:m.topic,threadId:m.threadId??m.id};
          const source=sources.get(m.id);
          return source?preview.message(view,source):view;
        })}:null,pollAfterMs:10000};
      }
      if(dirty)await tx.putParticipant(id,p);return result;
    }));
  };
}
