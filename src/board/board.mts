import type {Principal} from '../sessions/types.mjs';
import type {ApplicationState} from '../state/types.mjs';
import type {createRecentSessions} from '../sessions/recent.mjs';
import {serviceError} from '../sessions/types.mjs';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {boardSearchSchema,searchParameters,searchMessages} from './search.mjs';
import {createParticipation} from './participation.mjs';
import {publishMessage,mentionWarning} from './publication.mjs';
import {announcementChannel, channelSchema, channelName, channelNames, clientName, threadIdSchema, visibleMessage} from './channels.mjs';
import {boardIdentity, resolveBoardIdentity} from './identity.mjs';
import {boardFetchSchema, preview, textPage} from './disclosure.mjs';
export {boardFetchSchema} from './disclosure.mjs';

const short = (max: number) => z.string().trim().min(1).max(max);
const topic = short(80);
export const syncSchema = z.strictObject({
  workspace: short(200).optional().describe('Optional workspace; defaults to the authenticated workspace and must be authorized by the deployment.'),
  agent: short(80).describe('Registered display name, or a stable name for MCP-only use. Reuses your account-owned CLI session identity.'),
  channels: z.array(channelSchema).max(8).optional(),
  topics: z.array(topic).max(8).optional().describe('Deprecated alias for channels.'),
  after: z.number().int().min(0).optional().describe('Previous cursor for this exact channel selection. Omit to start now; 0 to read history.'),
});
export const postSchema = z.strictObject({workspace:syncSchema.shape.workspace,agent:syncSchema.shape.agent,
  posts: z.array(z.strictObject({id: short(80), channel: channelSchema.optional(), topic: topic.optional().describe('Deprecated alias for channel.'), threadId: threadIdSchema.optional().describe('Root message ID when replying. opencrawl permits client replies only.'), text: z.string().trim().min(1)})).min(1).max(3)
    .describe('Only changes others can act on. Reuse the same id when retrying.')
});
export const presenceSchema=syncSchema.omit({after:true}).extend({leave:z.boolean().default(false)});
export const topicsSchema = z.strictObject({workspace: short(200).optional(), after: z.number().int().min(0).default(0)});
export const boardReadSchema = z.strictObject({channel: channelSchema.optional(), topic: topic.optional(), threadId: threadIdSchema.optional(), rootsOnly: z.boolean().optional(), before: threadIdSchema.optional()});
export const threadSchema = z.strictObject({workspace: short(200).optional(), threadId: threadIdSchema, before: threadIdSchema.optional()});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fail = (message: string, status = 400) => Object.assign(new Error(message), {status});
const ttl=15*60*1000;
/** Durable SQL state supplied independently of immutable capture objects. */
export function createBoard({state,now=Date.now,recentSessions,sessionTimeoutMs=15000}:{state:Pick<ApplicationState,'board'>;now?:()=>number;recentSessions?:ReturnType<typeof createRecentSessions>;sessionTimeoutMs?:number}){
  if(!state?.board)throw fail('PostgreSQL board state is required',503);
  if(!Number.isInteger(sessionTimeoutMs)||sessionTimeoutMs<1||sessionTimeoutMs>30000)throw fail('Invalid session snapshot timeout');
  const repository=state.board;
  function scope(principal:Principal){if(!principal||principal.captureAccess!==undefined||typeof principal.tenantId!=='string'||!principal.tenantId||typeof principal.userId!=='string'||!principal.userId)throw fail('Board scope required',403);return hash(principal.tenantId);}
  return {
    participate:createParticipation({scope,repository,now}),
    async read(principal:Principal,input:unknown={}){const key=scope(principal),args=boardReadSchema.parse(input);return repository.read(key,async tx=>{
      const channel=args.channel!==undefined||args.topic!==undefined?channelName(args):undefined;
      const root=args.threadId!==undefined?await tx.message(args.threadId):null;
      if(args.threadId!==undefined&&(!root||root.threadId!==undefined||(channel&&root.topic!==channel)))throw fail('Thread not found',404);
      const summaries=await tx.topics(),messages=await tx.messages({before:args.before,topic:channel,threadId:args.threadId,rootsOnly:args.threadId===undefined&&args.rootsOnly,limit:21,descending:true});
      const page=messages.slice(0,20),counts=await tx.replyCounts([...page.filter(m=>m.threadId===undefined).map(m=>m.id),...root?[root.id]:[]]);
      const present=(m:typeof messages[number])=>({...visibleMessage(m),...m.threadId===undefined?{replyCount:counts[m.id]??0}:{}});
      const channelSummaries=[{channel:announcementChannel,posts:0,latest:{id:0,timestamp:0,name:'opencrawl'},readOnly:true},...summaries.filter(t=>t.topic!==announcementChannel).sort((a,b)=>b.latest.id-a.latest.id).map(({topic,first,...summary})=>({channel:topic,...summary,readOnly:false}))];
      const announcements=summaries.find(t=>t.topic===announcementChannel);if(announcements)Object.assign(channelSummaries[0],{posts:announcements.posts,latest:announcements.latest});
      return {topics:summaries.map(t=>t.topic).sort(),topicSummaries:summaries.sort((a,b)=>b.latest.id-a.latest.id).map(({first,...summary})=>summary),channels:channelSummaries.map(c=>c.channel),channelSummaries,messages:page.map(present),next:messages.length>20?messages[19].id:null,...root?{threadRoot:present(root)}:{}};
    });},
    async search(principal:Principal,input:unknown){const key=scope(principal),{workspace,...args}=boardSearchSchema.parse(input);if(workspace!==undefined&&workspace!==principal.tenantId)throw fail('Workspace scope mismatch',403);if(args.since&&args.until&&Date.parse(args.since)>Date.parse(args.until))throw fail('since must not be later than until');const result=await repository.search(key,principal.userId,searchParameters(args),now());return searchMessages(result,args.facets);},
    async fetch(principal: Principal, input: unknown) {
      const key = scope(principal), args = boardFetchSchema.parse(input);
      if (args.workspace !== undefined && args.workspace !== principal.tenantId) throw fail('Workspace scope mismatch', 403);
      if (args.id.startsWith('message:')) {
        if (!/^message:[1-9]\d{0,15}$/.test(args.id)) throw fail('Invalid message reference');
        const source=await repository.read(key,tx=>tx.message(Number(args.id.slice(8))));
        if (!source) throw fail('Message not found', 404);
        const {text, ...message} = visibleMessage(source);
        return textPage(text, args, {id: args.id, kind: 'message', message});
      }
      if (!args.id.startsWith('session:')) throw fail('Invalid board reference');
      if (!recentSessions) throw fail('Session discovery not configured', 503);
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const session = await Promise.race([recentSessions.fetch(principal, args.id, {signal: controller.signal, field: args.field}),
          new Promise<never>((_, reject) => {timer = setTimeout(() => {controller.abort(); reject(fail('Session fetch timed out', 503));}, sessionTimeoutMs);})]);
        const fields = ['firstUserMessage', 'lastUserMessage', 'latestAssistantMessage'] as const;
        const selected = fields.filter(field => args.field === 'context' || args.field === field);
        const text = args.field === 'context'
          ? selected.map(field => session[field] ? `${field}\n${session[field]!.text}` : `${field}\n[No captured text]`).join('\n\n')
          : session[args.field]?.text ?? '';
        const {firstUserMessage, lastUserMessage, latestAssistantMessage, ...metadata} = session;
        const messages = Object.fromEntries(selected.map(field => {const message = session[field]; return [field, message ? {eventId: message.eventId, timestamp: message.timestamp, receivedAt: message.receivedAt} : null];}));
        return textPage(text, args, {id: args.id, kind: 'session', session: {...metadata, title: preview(metadata.title, 120)}, field: args.field, messages},
          {id: args.id, field: args.field, messages});
      } finally {clearTimeout(timer);}
    },
    async thread(principal:Principal,input:unknown){
      const key=scope(principal),args=threadSchema.parse(input);
      if(args.workspace!==undefined&&args.workspace!==principal.tenantId)throw fail('Workspace scope mismatch',403);
      return repository.read(key,async tx=>{
        const root=await tx.message(args.threadId);if(!root||root.threadId!==undefined)throw fail('Thread not found',404);
        const replies=await tx.messages({threadId:root.id,before:args.before,limit:21,descending:true});
        return {root:visibleMessage(root),replies:replies.slice(0,20).map(visibleMessage),next:replies.length>20?replies[19].id:null};
      });
    },
    async channels(principal:Principal,input:unknown={}){
      const key=scope(principal),{after,workspace}=topicsSchema.parse(input);if(workspace!==undefined&&workspace!==principal.tenantId)throw fail('Workspace scope mismatch',403);
      return repository.read(key,async tx=>{
        const rows=await tx.topics(),agents=await tx.agents(),time=now();
        const all=[{topic:announcementChannel,latest:{id:0}},...rows.filter(row=>row.topic!==announcementChannel)];
        const announcement=rows.find(row=>row.topic===announcementChannel);if(announcement)all[0]=announcement;
        return {workspace:principal.tenantId,channels:all.slice(after,after+12).map(row=>({channel:row.topic,latest:row.latest.id,readOnly:row.topic===announcementChannel,repliesAllowed:true,system:row.topic===announcementChannel?{agent:'system:opencrawl',name:'opencrawl'}:undefined,active:Object.entries(agents).filter(([,a])=>a.seen>time-ttl&&a.topics.includes(row.topic)).slice(0,4).map(([id,a])=>({id,name:a.name,seen:a.seen}))})),next:after+12<all.length?after+12:null};
      });
    },
    async topics(principal:Principal,input:unknown={}){
      const key=scope(principal),{after,workspace}=topicsSchema.parse(input);if(workspace!==undefined&&workspace!==principal.tenantId)throw fail('Workspace scope mismatch',403);
      return repository.read(key,async tx=>{const all=await tx.topics(),agents=await tx.agents(),time=now(),topics=[];let bytes=0;
        for(const row of all.slice(after,after+12)){const item={topic:row.topic,latest:row.latest.id,active:Object.entries(agents).filter(([,a])=>a.seen>time-ttl&&a.topics.includes(row.topic)).slice(0,4).map(([id,a])=>({id,name:a.name,seen:a.seen}))};const size=Buffer.byteLength(JSON.stringify(item));if(topics.length&&bytes+size>4096)break;topics.push(item);bytes+=size;}
        return {workspace:principal.tenantId,topics,next:after+topics.length<all.length?after+topics.length:null};
      });
    },
    async post(principal:Principal,input:unknown){
      const key=scope(principal),args=postSchema.parse(input);clientName(args.agent);
      if(args.workspace!==undefined&&args.workspace!==principal.tenantId)throw fail('Workspace scope mismatch',403);
      return repository.transaction(key,async tx=>{
        const identity=await resolveBoardIdentity(tx,principal.userId,args.agent),accepted:number[]=[],unresolved:string[]=[];
        for(const post of args.posts){const message=await publishMessage(tx,identity,{...post,channel:channelName(post)},now());accepted.push(message.id);unresolved.push(...message.publication?.unresolvedMentions??[]);}
        return {agent:identity.agent,accepted,...mentionWarning(unresolved)};
      });
    },
    async presence(principal:Principal,input:unknown){
      const key=scope(principal),args=presenceSchema.parse(input),topics=channelNames(args);clientName(args.agent);
      if(args.workspace!==undefined&&args.workspace!==principal.tenantId)throw fail('Workspace scope mismatch',403);
      return repository.transaction(key,async tx=>{
        const identity=await resolveBoardIdentity(tx,principal.userId,args.agent),time=now(),agents=await tx.agents();
        for(const [id,a]of Object.entries(agents))if(a.seen<=time-ttl||(identity.registered&&id!==identity.agent&&a.name.toLowerCase()===identity.name.toLowerCase()&&id===boardIdentity(principal.userId,a.name))){await tx.removeAgent(id);delete agents[id];}
        if(args.leave)await tx.removeAgent(identity.agent);
        else {if(!agents[identity.agent]&&Object.keys(agents).length>=128)throw fail('Active agent limit reached',429);await tx.putAgent(identity.agent,{name:identity.name,topics,seen:time});}
        return {agent:identity.agent,...args.leave?{left:true}:{channels:topics,expiresAt:time+ttl}};
      });
    },
    async sync(principal:Principal,input:unknown){
      const key=scope(principal),parsed=syncSchema.parse(input),args={...parsed,topics:channelNames(parsed)};clientName(args.agent);if(args.workspace!==undefined&&args.workspace!==principal.tenantId)throw fail('Workspace scope mismatch',403);
      let sessions:Awaited<ReturnType<ReturnType<typeof createRecentSessions>['list']>>=[],sessionState=recentSessions?'ready':'not_configured';
      if(recentSessions){const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
        try{sessions=await Promise.race([recentSessions.list(principal,{signal:controller.signal}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Session snapshot timeout'));},sessionTimeoutMs);})]);}
        catch(caught){const error=serviceError(caught);if(error.status===403||error.status===401)throw error;sessionState='unavailable';}finally{clearTimeout(timer);}
      }
      return repository.read(key,async tx=>{
        const {head}=await tx.metadata(),identity=await resolveBoardIdentity(tx,principal.userId,args.agent),agentId=identity.agent,agentName=identity.name,start=args.after??head;
        if(start>head)throw fail('Cursor exceeds board history');
        const selected=await tx.unread({after:start,through:head,topics:args.topics,userId:principal.userId,agent:agentId,name:agentName,limit:6}),messages=[];let cursor=head,bytes=0;
        for(const m of selected){const message={id:m.id,ref:'message:'+m.id,timestamp:m.timestamp,name:m.name,topic:m.topic,channel:m.topic,threadId:m.threadId??m.id,...m.system?{system:true}:{},preview:preview(m.text,160)},size=Buffer.byteLength(JSON.stringify(message));if(messages.length>=5||bytes+size>4096){cursor=m.id-1;break;}messages.push(message);bytes+=size;}
        const output={agent:agentId,cursor,more:cursor<head,messages,recentSessions:sessions,recentSessionsStatus:{state:sessionState,limit:10,order:'lastActivityAt_desc',source:'indexed_capture'}};
        return output;
      });
    },
  };
}
