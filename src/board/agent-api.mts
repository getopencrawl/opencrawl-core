import {createHash} from 'node:crypto';
import {z} from 'zod';
import {boardPath,type BoardKind} from '../application/board-links.mjs';
import {workspaceLinkHint} from '../state/capture-links.mjs';
import {announceOnline,onlineWindow,profileRetentionMs,readInbox} from './inbox.mjs';
import {bindPresenceSession,type PreviewFactory} from './presence-prompts.mjs';
import type {Principal} from '../sessions/types.mjs';
import type {BoardRepository,BoardReader,BoardTransaction} from '../state/board.mjs';
import type {BoardMessage} from './types.mjs';
import {currentSessionSchema} from '../search/context.mjs';
import {boardIdentity} from './identity.mjs';
import {channelSchema,channelModeSchema,updateSubscriptions,channelName,clientName,fail} from './channels.mjs';
import {requireBoardParticipation,publishMessage,mentionWarning} from './publication.mjs';
import {agentMessage,messageId,messagePage,replyNotification,messageSelection,selectMessage,threadRoot} from './messages.mjs';

const short=z.string().trim().min(1).max(200);
const workspace=short.optional();
const identity={currentSession:currentSessionSchema.optional(),session:short.optional(),agent:z.string().trim().min(3).max(80).optional()};
const pagination={limit:z.number().int().min(1).max(50).default(5),select:messageSelection};
export const agentReadSchema=z.strictObject({workspace,ids:z.array(messageId).min(1).max(20),select:messageSelection});
export const agentListSchema=z.strictObject({workspace,...pagination,channels:z.array(channelSchema).default([]),from:z.array(short).max(32).default([]),
  query:z.string().trim().max(500).default(''),after:z.number().int().nonnegative().optional(),before:messageId.optional(),thread:messageId.optional(),
  rootsOnly:z.boolean().default(false),since:z.iso.datetime({offset:true}).optional(),until:z.iso.datetime({offset:true}).optional(),
  order:z.enum(['oldest','newest','relevance']).default('newest'),cursor:short.optional(),facets:z.array(z.enum(['channel','agent','day'])).max(3).default([])});
export const agentThreadSchema=z.strictObject({workspace,threadId:messageId,...pagination,after:z.number().int().nonnegative().optional(),before:messageId.optional(),order:z.enum(['oldest','newest']).default('oldest'),cursor:short.optional()});
export const agentSearchSchema=agentListSchema.extend({order:z.enum(['oldest','newest','relevance']).default('relevance')});
const delivery = z.enum(['direct','routine']);
export const agentSyncSchema=z.strictObject({workspace,...identity,...pagination,delivery:delivery.optional(),through:z.number().int().nonnegative().optional(),waitMs:z.number().int().min(0).max(20000).optional(),channels:z.array(channelSchema).optional(),after:z.number().int().nonnegative().optional()});
export const agentInboxSchema=z.strictObject({workspace,...identity,delivery:delivery.optional(),readId:z.uuid().optional().describe('Use the read ID supplied by a lifecycle notification.'),after:z.number().int().nonnegative().optional(),through:z.number().int().nonnegative().optional(),acknowledge:z.string().regex(/^[a-f0-9]{64}$/, 'must be the full cursor returned by the board inbox').optional(),noticeOnly:z.boolean().default(false)});
export const agentPostSchema=z.strictObject({workspace,...identity,full:z.boolean().optional().describe('Return complete published messages instead of compact receipts.'),posts:z.array(z.strictObject({id:z.string().trim().min(1).max(80),channel:channelSchema.optional(),
  text:z.string().min(1),replyTo:messageId.optional(),threadId:messageId.optional().describe('Compatibility alias for replyTo.'),mentions:z.array(short).max(32).default([]),follow:z.boolean().default(true)})).min(1).max(20)});
export const agentFollowSchema=z.strictObject({workspace,...identity,threadId:messageId,following:z.boolean().default(true)});
export const agentPresenceSchema=z.strictObject({workspace,...identity,channelMode:channelModeSchema.optional(),announce:z.boolean().optional(),installationId:short.optional(),name:z.string().trim().min(3).max(80).optional(),task:z.string().trim().max(240).optional(),channels:z.array(channelSchema).optional(),leave:z.boolean().default(false)});
export const agentDirectorySchema=z.strictObject({workspace,active:z.boolean().default(true),query:z.string().max(200).default(''),limit:z.number().int().min(1).max(50).default(10),after:z.number().int().nonnegative().default(0)});
export const agentChannelsSchema=z.strictObject({workspace,limit:z.number().int().min(1).max(50).default(10),after:z.number().int().nonnegative().default(0)});
type Identity=Pick<z.infer<typeof agentPresenceSchema>,'currentSession'|'session'|'agent'>;
const activeMs=15*60*1000;
const validName=/^[a-zA-Z0-9][a-zA-Z0-9:_.-]*$/;

/** The native session is account-bound, never a request-supplied user or tenant. */
async function findIdentity(tx:BoardReader,userId:string,input:Identity){
  const session=input.currentSession?.sessionId??input.session;
  if(input.currentSession&&input.session&&input.currentSession.sessionId!==input.session)throw fail('Conflicting session identities');
  let agent:string;
  if(session){
    agent=boardIdentity(userId,session);
  }else{
    if(!input.agent)return null;
    clientName(input.agent);
    const found=await tx.profileByName(input.agent.replace(/^@/,''),userId);
    if(!found)return null;
    agent=found.id;
  }
  const participant=await tx.participant(agent);
  if(!participant)return null;
  if(participant.userId!==undefined&&participant.userId!==userId)throw fail('Session is not owned by this account',403);
  if(input.agent && participant.name && participant.name.toLowerCase()!==input.agent.replace(/^@/,'').toLowerCase())throw fail('Agent does not match the current session',409);
  if(participant.name)clientName(participant.name);
  return {agent,name:participant.name,userId,registered:true,participant};
}

async function resolveIdentity(tx:BoardReader,userId:string,input:Identity,requireName=true){
  const identity=await findIdentity(tx,userId,input);
  if(identity&&(identity.name||!requireName))return identity;
  if(identity)throw fail('Set this session name and task with board profile',409);
  if(input.currentSession||input.session)throw fail('Register the current session before using the board',409);
  if(input.agent)throw fail('Agent is not registered to this account; use board_presence with session, name and task',409);
  throw fail('Native session unavailable; supply your registered agent handle',400);
}
const namesFor=(tx:BoardReader,messages:Array<Pick<BoardMessage,'mentions'|'mentionNames'>>)=>tx.agentNames([...new Set(messages.flatMap(message=>message.mentionNames?[]:message.mentions??[]))]);
async function followThread(tx:BoardTransaction,id:string,thread:number,following:boolean){
  const p=await tx.participant(id);if(!p)throw fail('Agent registration not found',409);
  await requireBoardParticipation(tx,id);
  p.followedThreads=[...new Set([...(p.followedThreads??[]).filter(value=>value!==thread),...following?[thread]:[]])];
  p.mutedThreads=[...new Set([...(p.mutedThreads??[]).filter(value=>value!==thread),...following?[]:[thread]])];
  await tx.putParticipant(id,p);
}

/** One agent contract shared by MCP and /api/board/v2. Legacy HTTP/UI adapters
 * remain separate so already-running clients can finish during a rolling release. */
export function createAgentBoard({repository,scope,now,previews,publicUrl}:{publicUrl?:string;repository:BoardRepository;scope(p:Principal):string;now():number;previews:PreviewFactory}){
  const link=(p:Principal,kind:BoardKind,value:string|number)=>publicUrl
    ? {url:new URL(boardPath(workspaceLinkHint(p.tenantId),kind,value),publicUrl).href} : {};
  const linked=<T extends {id:number}>(p:Principal,m:T,select?:string[])=>select && !select.includes('url')
    ? m : {...m,...link(p,'posts',m.id)};
  const checked=(p:Principal,input:{workspace?:string})=>{const key=scope(p);if(input.workspace!==undefined&&input.workspace!==p.tenantId)throw fail('Workspace scope mismatch',403);return key;};
  async function list(principal:Principal,input:unknown){
    const args=agentListSchema.parse(input),key=checked(principal,args);
    if(args.since&&args.until&&Date.parse(args.since)>Date.parse(args.until))throw fail('since must not be later than until');
    const thread=args.thread===undefined?undefined:await repository.read(key,async tx=>(await threadRoot(tx,args.thread!)).root.id);
    const result=await repository.searchAgentMessages(key,principal.userId,{query:args.query,topics:args.channels,agents:args.from,authors:[],sort:args.order,
      after:args.after,before:args.before,thread,rootsOnly:args.rootsOnly,since:args.since,until:args.until,limit:args.limit,
      facets:args.facets.map(field=>field==='channel'?'topic':field),facetSize:5,cursor:args.cursor},now(),args.select);
    return {messages:result.messages.map(m=>linked(principal,m,args.select)),next:result.next,
      ...result.facets?{facets:Object.fromEntries(Object.entries(result.facets).map(([key,value])=>[key==='topic'?'channel':key,value]))}:{}};
  }
  async function sync(principal:Principal,input:unknown){
    const args=agentSyncSchema.parse(input),key=checked(principal,args);
    if(args.waitMs && (args.delivery!=='direct' || args.through!==undefined))throw fail('A bounded wait requires an open direct feed');
    const deadline=Date.now()+(args.waitMs??0);
    const read=(startAfter:number|undefined)=>{
      const preview=previews(principal,key);
      return preview.finish(repository.read(key,async tx=>{
        const identity=args.delivery ? await resolveIdentity(tx,principal.userId,args,false) : await findIdentity(tx,principal.userId,args);
        if(args.delivery && args.currentSession && identity?.participant.harness!==args.currentSession.harness)
          throw fail('Session harness does not match its registration',409);
        const {head:latest}=await tx.metadata();
        if(args.through!==undefined && args.through>latest)throw fail('Upper bound exceeds board history');
        const head=args.through??latest;
        if(args.delivery && identity?.participant.left)return {messages:[],next:head,more:false,left:true};
        let after=startAfter;
        if(after===undefined){
          if(!identity)after=await tx.headBefore(now()-onlineWindow);
          else if(identity.participant.left)after=head;
          else after=identity.participant.inboxAfter??await tx.headBefore(identity.participant.registeredAt);
        }
        if(after>head)throw fail('Cursor exceeds board history');
        const window={after,through:head,limit:args.limit+1};
        const rows=identity
          ? await tx.unread({...window,delivery:args.delivery,topics:args.channels??identity.participant.topics,mention:identity.agent,userId:principal.userId,agent:identity.agent,name:identity.name})
          : await tx.sharedUpdates({...window,channels:args.channels});
        const names=await namesFor(tx,rows);
        const messages=messagePage(rows.map(m=>({...linked(principal,selectMessage(agentMessage(m,names),args.select),args.select),...(!args.select?replyNotification(m.threadId):{})})),args.limit);
        const more=messages.length<rows.length;
        messages.forEach((message,i)=>{
          // A routine introduction already carries the handle and declared task.
          if(args.delivery!=='routine' || !rows[i].onlineAudience)preview.message(message,rows[i]);
        });
        const receipt=args.delivery && rows[0] && identity ? createHash('sha256')
          .update(JSON.stringify([key,identity.agent,args.delivery,rows[0].id,rows[0].requestId])).digest('hex') : undefined;
        return {messages,next:more?messages.at(-1)!.id:head,more,...(receipt?{notificationReceipt:receipt}:{}),...(!identity?{scope:'workspace',
          guidance:'Showing shared board posts. To receive personal updates, pass the native currentSession from startup or a registered agent handle.'}:{})};
      }));
    };
    const first=await read(args.after);
    if(!args.waitMs || first.messages.length || 'left' in first || !repository.watchDirect)return first;
    // Listen before rechecking the durable log, covering a commit between the
    // first empty read and LISTEN. Late or coalesced signals are harmless.
    let watch=await repository.watchDirect(key).catch(()=>undefined);
    // The idle hook rechecks the durable feed on its next bounded request.
    if(!watch)return first;
    try {
      let pending=await read(first.next);
      let retried=false;
      while(watch && !pending.messages.length && !('left' in pending) && Date.now()<deadline){
        if(!await watch.wait(Math.max(0,deadline-Date.now()))){
          // Restore LISTEN before checking the log to cover posts during reconnection.
          // One retry per request bounds the work during a sustained database outage.
          watch.close();
          watch=!retried && Date.now()<deadline ? await repository.watchDirect(key).catch(()=>undefined) : undefined;
          retried=true;
        }
        pending=await read(pending.next);
      }
      return pending;
    } finally { watch?.close(); }
  }
  return {
    list,search:(principal:Principal,input:unknown)=>list(principal,agentSearchSchema.parse(input)),
    async read(principal:Principal,input:unknown){
      const args=agentReadSchema.parse(input),key=checked(principal,args);
      return repository.read(key,async tx=>{
        const rows=await tx.agentMessagesByIds(args.ids,args.select);
        const byId=new Map(rows.map(row=>[row.id,row]));
        return {messages:args.ids.map(id=>{
          const message=byId.get(id);
          if(!message)throw fail(`Message ${id} not found`,404);
          return linked(principal,message,args.select);
        })};
      });
    },
    async thread(principal:Principal,input:unknown){
      const args=agentThreadSchema.parse(input);
      return list(principal,{workspace:args.workspace,thread:args.threadId,limit:args.limit,select:args.select,after:args.after,before:args.before,order:args.order,cursor:args.cursor});
    },
    async inbox(principal:Principal,input:unknown){
      const args=agentInboxSchema.parse(input),key=checked(principal,args);
      if(args.readId && (!args.delivery || !args.currentSession))throw fail('A tracked page requires a native session and delivery type');
      if(args.delivery){
        const {delivery,after,through,readId,currentSession}=args;
        if(args.acknowledge || after===undefined || through===undefined || args.noticeOnly && !readId)throw fail('Use the supplied after and through bounds to read a notification');
        if(args.noticeOnly)return repository.read(key,async tx=>{
          const {participant}=await resolveIdentity(tx,principal.userId,args,false);
          const page=participant.servedInbox?.[delivery];
          if(participant.left || participant.harness!==currentSession?.harness || page?.readId!==readId || page?.after!==after || page?.through!==through)return {served:null};
          return {served:page};
        });
        const page=await sync(principal,{workspace:args.workspace,currentSession,agent:args.agent,session:args.session,delivery,after,through});
        const first=page.messages[0]?.id,proof='notificationReceipt' in page ? page.notificationReceipt : undefined;
        if(readId && typeof first==='number' && typeof proof==='string')await repository.transaction(key,async tx=>{
          const {agent,participant}=await resolveIdentity(tx,principal.userId,args,false);
          if(participant.left || participant.harness!==currentSession?.harness)throw fail('Session registration changed',409);
          participant.servedInbox={...participant.servedInbox,[delivery]:{readId,after,through,first,next:page.next,proof}};
          await tx.putParticipant(agent,participant);
        });
        return page;
      }
      if(args.after!==undefined || args.through!==undefined)throw fail('Bounds require a notification delivery type');
      if(args.noticeOnly&&args.acknowledge)throw fail('A notification cannot acknowledge messages');
      const preview=previews(principal,key);
      return preview.finish(repository.transaction(key,async tx=>{
        const identity=await resolveIdentity(tx,principal.userId,args);
        const bound=bindPresenceSession(identity.participant,principal,args.currentSession?.sessionId??args.session,undefined,args.currentSession?.harness);
        const {rows,ids,...state}=await readInbox(tx,key,identity.agent,principal.userId,identity.participant,args.acknowledge,args.noticeOnly,now(),bound);
        if(args.noticeOnly)return {ids,more:state.more,...state.left?{left:true}:{}};
        const names=await namesFor(tx,rows);
        return {...state,messages:rows.map(row=>preview.message({...linked(principal,agentMessage(row,names)),...replyNotification(row.threadId)},row))};
      }));
    },
    sync,
    async post(principal:Principal,input:unknown){
      const args=agentPostSchema.parse(input),key=checked(principal,args);
      return repository.transaction(key,async tx=>{const identity=await resolveIdentity(tx,principal.userId,args);if(identity.participant.left){await requireBoardParticipation(tx,identity.agent);throw fail('Session has left; resume its presence before posting',409);}
        const messages=[],unresolved:string[]=[];
        for(const post of args.posts){
          if(post.replyTo!==undefined&&post.threadId!==undefined&&post.replyTo!==post.threadId)throw fail('Conflicting reply targets');
          const target=post.replyTo??post.threadId,thread=target===undefined?undefined:await threadRoot(tx,target);
          const channel=channelName({channel:post.channel??thread?.root.topic});
          if(thread&&thread.root.topic!==channel)throw fail('Reply target belongs to another channel',404);
          const message=await publishMessage(tx,identity,{id:post.id,channel,text:post.text,threadId:thread?.root.id,replyTo:target,mentions:post.mentions.map(name=>name.replace(/^@/,''))},now());
          if(post.follow&&!identity.participant.mutedThreads?.includes(message.threadId??message.id))await followThread(tx,identity.agent,message.threadId??message.id,true);
          messages.push(linked(principal,args.full?agentMessage(message):{id:message.id,thread:message.threadId??message.id}));unresolved.push(...message.publication?.unresolvedMentions??[]);
        }
        const participant=(await tx.participant(identity.agent))!;participant.seen=now();await tx.putParticipant(identity.agent,participant);
        return {messages,...mentionWarning(unresolved)};
      });
    },
    async follow(principal:Principal,input:unknown){
      const args=agentFollowSchema.parse(input),key=checked(principal,args);
      return repository.transaction(key,async tx=>{const identity=await resolveIdentity(tx,principal.userId,args),{root}=await threadRoot(tx,args.threadId);await followThread(tx,identity.agent,root.id,args.following);return {thread:root.id,following:args.following};});
    },
    async presence(principal:Principal,input:unknown){
      const args=agentPresenceSchema.parse(input),key=checked(principal,args);
      const preview=previews(principal,key);
      return preview.finish(repository.transaction(key,async tx=>{
        const session=args.currentSession?.sessionId??args.session;
        if(args.currentSession&&args.session&&args.currentSession.sessionId!==args.session)throw fail('Conflicting session identities');
        const id=session?boardIdentity(principal.userId,session):(await resolveIdentity(tx,principal.userId,args)).agent;
        await requireBoardParticipation(tx,id);
        let p=await tx.participant(id);const name=args.name??p?.name??args.agent;
        if(!name||!validName.test(name))throw fail('Set name to a unique agent handle beginning with a letter or digit. Use letters, digits, colons, underscores, dots or hyphens, then retry presence with the same session.');clientName(name);
        const time=now();
        await tx.prepareRegistration(id,name,time-profileRetentionMs);
        if(args.agent&&name.toLowerCase()!==args.agent.replace(/^@/,'').toLowerCase())throw fail('Agent does not match the current session',409);
        if(p?.name&&p.name!==name)throw fail(`This session is already registered as ${p.name}. Retry presence with that name and the same session.`,409);
        if(!p&&!session)throw fail('A session is required to register');
        const head=(await tx.metadata()).head;
        p??={userId:principal.userId,name,task:args.task??'',harness:args.currentSession?.harness??'other',registeredAt:time,seen:time,topics:[],inboxAfter:head,ackCursor:head,lastPoll:null,lastAckAt:null,nextHomeAt:time+60000,pending:null,batches:0,acknowledgedBatches:0};
        if(p.userId!==undefined&&p.userId!==principal.userId)throw fail('Session is not owned by this account',403);
        const announce=args.announce??(p.announced || p.left || args.name!==undefined || args.task!==undefined);
        if(p.left||p.seen<=time-onlineWindow)p.announced=false;
        Object.assign(p,{userId:principal.userId,name,seen:time,left:args.leave,...args.task!==undefined?{task:args.task}:{},...args.channels?{topics:updateSubscriptions(p.topics,args.channels,args.channelMode)}:{}});
        bindPresenceSession(p,principal,session,args.installationId,args.currentSession?.harness);
        const peers=announce&&!args.leave?await announceOnline(tx,id,p,time,preview):undefined;
        await tx.putParticipant(id,p);
        // Remove only obsolete presence for this same account-owned identity.
        await tx.removeAgent(id);await tx.removeAgent(boardIdentity(principal.userId,name));
        return {name,active:!args.leave,channels:p.topics,...peers?.length?{peers}:{}};
      }));
    },
    async agents(principal:Principal,input:unknown){
      const args=agentDirectorySchema.parse(input),key=checked(principal,args);
      return repository.read(key,async tx=>{const time=now(),rows=await tx.agentProfiles({after:args.after,limit:args.limit+1,cutoff:time-activeMs,active:args.active,query:args.query});
        return {agents:rows.slice(0,args.limit).map(p=>({name:p.name,task:p.task,active:!p.left&&p.seen>time-activeMs,listening:!p.left&&Number(p.lastPoll)>time-180000,channels:p.topics})),next:rows.length>args.limit?args.after+args.limit:null};});
    },
    async channels(principal:Principal,input:unknown){
      const args=agentChannelsSchema.parse(input),key=checked(principal,args);
      return repository.read(key,async tx=>{const topics=await tx.topics(),rows=[{channel:'opencrawl',latest:topics.find(t=>t.topic==='opencrawl')?.latest.id??null,posting:'replies' as const},...topics.filter(t=>t.topic!=='opencrawl').sort((a,b)=>b.latest.id-a.latest.id).map(t=>({channel:t.topic,latest:t.latest.id,posting:'threads-and-replies' as const}))];return {channels:rows.slice(args.after,args.after+args.limit).map(row=>({...row,...link(principal,'channels',row.channel)})),next:args.after+args.limit<rows.length?args.after+args.limit:null};});
    },
  };
}
