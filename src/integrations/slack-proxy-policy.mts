import type {ProxyRequest,ProxyResponse,ProviderData} from './types.mjs';
const fail=(status:number,message='Connector authorization unavailable'):never=>{throw Object.assign(new Error(message),{status});};
const METHODS=new Set(['auth.test','conversations.list','users.list','users.info','team.info','emoji.list','search.messages']);
const SEARCH=/^in:#[a-z0-9_-]+(?: in:#[a-z0-9_-]+)* after:\d{4}-\d{2}-\d{2}(?: before:\d{4}-\d{2}-\d{2})?(?: is:thread)?$/;
export interface SlackReply {ok:boolean;status:number;data:unknown;headers?:Record<string,string>}
/**
 * The read-only Slack surface a source capability may use: listed methods over public channels.
 * Every credential adapter applies this one policy; `call` performs a single authorized GET.
 */
export async function slackPublicRead<T=ProviderData>({endpoint,method='GET',query={},headers={},body}:ProxyRequest,call:(target:URL)=>Promise<SlackReply>):Promise<ProxyResponse<T>>{
  const target=new URL(endpoint),methodName=target.pathname.slice('/api/'.length);
  if(target.origin!=='https://slack.com'||!target.pathname.startsWith('/api/')||!METHODS.has(methodName)||target.username||target.password||target.hash||target.search||method!=='GET'||body!==undefined||Object.keys(headers).length)fail(403);
  if(methodName==='conversations.list'&&query.types!=='public_channel')fail(403);
  // The source sends only channel terms and date/thread filters. A scoped proxy
  // credential must never become arbitrary search across the installer's DMs.
  let publicChannels:Map<string,string>|undefined;
  if(methodName==='search.messages'){
    if(typeof query.query!=='string'||!SEARCH.test(query.query))fail(403);
    publicChannels=new Map();let cursor='';const seen=new Set<string>();
    for(let page=0;;page++){
      if(page===1000)fail(503);
      const list=new URL('https://slack.com/api/conversations.list');list.search=new URLSearchParams({types:'public_channel',exclude_archived:'false',limit:'200',...(cursor?{cursor}:{})}).toString();
      const reply=await call(list);
      const data=reply.data as {ok?:boolean;channels?:Array<{id:string;name:string;is_private?:boolean;is_im?:boolean;is_mpim?:boolean}>;response_metadata?:{next_cursor?:string}}|null;
      if(!reply.ok||!data?.ok||!Array.isArray(data.channels))fail(503);
      for(const c of data!.channels!)if(c.is_private===false&&!c.is_im&&!c.is_mpim)publicChannels.set(c.id,c.name);
      cursor=data!.response_metadata?.next_cursor||'';if(!cursor)break;if(seen.has(cursor))fail(503);seen.add(cursor);
    }
    const names=new Set(publicChannels.values());
    if((query.query as string).split(' ').filter(p=>p.startsWith('in:#')).some(p=>!names.has(p.slice(4))))fail(403);
  }
  for(const [key,value]of Object.entries(query))if(value!==undefined){if(['token','authorization'].includes(key.toLowerCase()))fail(403);target.searchParams.set(key,String(value));}
  const reply=await call(target),data=reply.data as T;
  if(publicChannels&&data&&typeof data==='object'&&'messages' in data){
    const messages=data.messages;
    if(messages&&typeof messages==='object'&&'matches' in messages&&Array.isArray(messages.matches)){
      messages.matches=messages.matches.filter((hit:unknown)=>hit&&typeof hit==='object'&&'channel'in hit&&hit.channel&&typeof hit.channel==='object'&&'id'in hit.channel&&typeof hit.channel.id==='string'&&publicChannels!.has(hit.channel.id));
    }
  }
  return {status:reply.status,data,headers:reply.headers||{}};
}
