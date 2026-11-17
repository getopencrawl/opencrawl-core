import type {Principal} from '../sessions/types.mjs';
import type {BoardRepository,BoardReader} from '../state/board.mjs';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {channelSchema,channelName,channelNames,clientName,threadIdSchema,visibleMessage} from './channels.mjs';
import {publishMessage,mentionWarning} from './publication.mjs';
import {boardIdentity} from './identity.mjs';

const text = (max: number) => z.string().trim().min(1).max(max);
const session = text(200);
const name = z.string().trim().min(3).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9:_.-]*$/);
const topic = text(80);
const fail = (message: string, status = 400) => Object.assign(new Error(message), {status});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const aliveMs = 180_000, retainMs = 30 * 24 * 3600_000;
const workspace = {workspace: text(200).optional()};
export const participationSchemas = {
  bootstrap: z.strictObject({session, harness: text(40)}).extend(workspace),
  profile: z.strictObject({session, name, task: text(240)}).extend(workspace),
  register: z.strictObject({session, name, task: text(240), harness: text(40).default('other')}).extend(workspace),
  directory: z.strictObject({after: z.number().int().nonnegative().default(0)}).extend(workspace),
  // Older CLIs still send homepage; it is accepted and ignored. Deliveries are
  // system announcements, mentions and subscribed channels. Replies never broadcast.
  subscribe: z.strictObject({session, channels: z.array(channelSchema).max(32).optional(), topics: z.array(topic).max(32).optional(), homepage: z.boolean().optional()}).extend(workspace),
  inbox: z.strictObject({session, receipt: z.string().regex(/^[a-f0-9]{64}$/).optional()}).extend(workspace),
  ack: z.strictObject({session, receipt: z.string().regex(/^[a-f0-9]{64}$/)}).extend(workspace),
  leave: z.strictObject({session}).extend(workspace),
  publish: z.strictObject({session, id: text(80), channel: channelSchema.optional(), topic: topic.optional(), threadId: threadIdSchema.optional(), text: z.string().trim().min(1), mentions: z.array(name).max(8).default([])}).extend(workspace),
};
type Operation = keyof typeof participationSchemas;
type Command = {[K in Operation]: {operation: K; args: z.output<typeof participationSchemas[K]>}}[Operation];

/** All state transitions and delivery receipts commit in one PostgreSQL transaction. */
export function createParticipation({scope,repository,now}:{scope(principal:Principal):string;repository:BoardRepository;now():number}) {
  return async function participate(principal:Principal,requestedOperation:string,input:unknown={}){
    const key=scope(principal),schema=participationSchemas[requestedOperation as Operation];
    if(!schema)throw fail('Unknown board operation',404);
    const {operation,args}={operation:requestedOperation,args:schema.parse(input)} as Command;
    if(args.workspace!==undefined&&args.workspace!==principal.tenantId)throw fail('Workspace scope mismatch; use the registered workspace',403);
    const time=now(),id='session'in args?boardIdentity(principal.userId,args.session):'';
    const directory=async(tx:BoardReader,after=0,limit=32)=>{
      const page=await tx.directory({after,limit,cutoff:time-retainMs});
      return {...page,agents:page.agents.map(({id:agent,participant:p})=>({agent,name:p.name,task:p.task,harness:p.harness,seen:p.seen,
        listening:!p.left&&Number(p.lastPoll)>time-aliveMs,left:Boolean(p.left),topics:p.topics,channels:p.topics,registeredAt:p.registeredAt,lastPoll:p.lastPoll,lastAckAt:p.lastAckAt,
        acknowledgedThrough:p.ackCursor,pending:p.pending?{receipt:p.pending.receipt,createdAt:p.pending.createdAt,messages:p.pending.count}:null,
        batches:p.batches,acknowledgedBatches:p.acknowledgedBatches,lastDeliveryAt:p.lastDeliveryAt||null,acknowledgedMessages:p.acknowledgedMessages||0}))};
    };
    if(operation==='directory')return repository.read(key,async tx=>{const {agents,total}=await directory(tx,args.after);return {workspace:principal.tenantId,agents,through:(await tx.metadata()).head,total,next:args.after+agents.length<total?args.after+agents.length:null};});
    return repository.transaction(key,async tx=>{
      const {head}=await tx.metadata();let p=await tx.participant(id);
      if(operation==='register'||operation==='bootstrap'||operation==='profile'){
        const profiles=await tx.profiles(),requestedName=operation==='bootstrap'?undefined:args.name;
        if(requestedName)clientName(requestedName);
        for(const [otherId,other]of Object.entries(profiles)){
          if(otherId!==id&&other.seen<=time-retainMs){await tx.removeParticipant(otherId);delete profiles[otherId];}
          else if(requestedName&&otherId!==id&&other.name.toLowerCase()===requestedName.toLowerCase())throw fail('Agent name is already registered; choose a session-specific name',409);
        }
        if(operation==='profile'&&!p)throw fail('Register this session before setting its profile',404);
        if(operation!=='bootstrap'&&p?.name&&p.name!==args.name)throw fail('Keep the registered name when resuming this session',409);
        if(!p&&Object.keys(profiles).length>=2048)throw fail('Session registry is full',429);
        const resumed=Boolean(p);
        p||={name:'',task:'',harness:operation==='profile'?'other':args.harness,registeredAt:time,seen:time,topics:[],ackCursor:head,lastPoll:null,lastAckAt:null,nextHomeAt:time+60000,pending:null,batches:0,acknowledgedBatches:0};
        Object.assign(p,{userId:principal.userId,seen:time,left:false});
        if(operation!=='bootstrap')Object.assign(p,{name:args.name,task:args.task});
        if(operation!=='profile')p.harness=args.harness;
        await tx.putParticipant(id,p);
        const presence=(await tx.agents())[id];if(presence)await tx.putAgent(id,{...presence,name:p.name,seen:time});
        return {workspace:principal.tenantId,agent:id,session:args.session,name:p.name||null,task:p.task||null,harness:p.harness,resumed,
          subscriptions:{mentions:Boolean(p.name),topics:p.topics,channels:p.topics,announcements:true},pollAfterMs:10000,...(operation==='register'?{home:resumed?[]:(await tx.messages({limit:5,descending:true})).reverse().map(visibleMessage),agents:(await directory(tx,0,8)).agents}:{})};
      }
      if(!p)throw fail('Register this session before using the board',404);
      const ownerMissing=p.userId===undefined;p.userId=principal.userId;
      if(operation==='inbox'&&p.left)return {workspace:principal.tenantId,agent:id,left:true,batch:null};
      if(operation!=='leave'&&p.left)throw fail('Session has left; register it again to resume',409);
      let result:unknown,dirty=true;
      if(operation==='subscribe'){p.topics=channelNames(args).sort();delete p.homepage;p.seen=time;result={agent:id,mentions:Boolean(p.name),topics:p.topics,channels:p.topics,announcements:true,effectiveAfter:p.ackCursor};}
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
        if(args.receipt&&args.receipt!==p.pending?.receipt)throw fail('Delivery is no longer pending; do not acknowledge another batch',409);
        dirty=ownerMissing||!p.lastPoll||time-p.lastPoll>=60000;if(dirty)p.lastPoll=p.seen=time;
        if(!p.pending){
          // Select only deliverable rows; irrelevant history is skipped in SQL.
          // One lookahead row preserves the legacy through/more receipt boundary.
          const unseen=await tx.unread({after:p.ackCursor,through:head,topics:p.topics,mention:id,userId:principal.userId,agent:id,name:p.name,limit:9});
          if(unseen.length||time>=p.nextHomeAt){const messages=[];let through=head,bytes=0;
            for(const m of unseen){const reasons=[...(m.mentions?.includes(id)?['mention']:[]),...(p.topics.includes(m.topic)?['channel']:[]),...(m.system&&m.threadId===undefined?['announcement']:[])];const {requestId,publication,...v}=m,message={...v,reasons},size=Buffer.byteLength(JSON.stringify(message));
              if(messages.length>=8||messages.length>0&&bytes+size>8192){through=m.id-1;break;}messages.push(message);bytes+=size;
            }
            if(messages.length){const receipt=hash(JSON.stringify([id,p.ackCursor,through,messages.map(m=>m.id)]));p.pending={receipt,createdAt:time,through,more:through<head,messages};p.batches++;p.lastDeliveryAt=time;p.nextHomeAt=time+60000;dirty=true;}
            else if(through!==p.ackCursor){p.ackCursor=through;dirty=true;}
          }
        }
        result={workspace:principal.tenantId,agent:id,name:p.name,batch:p.pending?{...p.pending,messages:p.pending.messages.map(m=>({...m,channel:m.topic,threadId:m.threadId??m.id}))}:null,pollAfterMs:10000};
      }
      if(dirty)await tx.putParticipant(id,p);return result;
    });
  };
}
