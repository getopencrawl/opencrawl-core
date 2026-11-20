import {z} from 'zod';
import {singleHistoryPageBytes} from '../sessions/replicas-payload.mjs';

const uuid=z.string().uuid();
export const conversationSchema=z.looseObject({chat_id:uuid,workspace_id:uuid,workspace_name:z.string(),provider:z.string().nullable(),title:z.string().nullable(),created_at:z.string(),updated_at:z.string(),workspace_status:z.string()});
export type ReplicasConversation=z.infer<typeof conversationSchema>;
const cursor=z.string().max(16384).nullable();
const conversationsSchema=z.object({conversations:z.array(conversationSchema).max(100),total:z.number().int().nonnegative(),next_cursor:cursor});
// Validate pagination without stripping or rewriting source fields.
const historySchema=z.looseObject({events:z.array(z.unknown()).max(1000),before_cursor:cursor.optional(),has_more:z.boolean().optional()})
  .refine(page=>page.waking===true||page.before_cursor!==undefined||page.has_more===false);
export type ReplicasHistory=z.infer<typeof historySchema>;
export type ReplicasOperation='identity'|'catalog'|'history'|'workspace_chats';
export interface ReplicasResponseInfo {httpStatus:number;requestId?:string;bytesRead?:number}
export class ReplicasPageError extends Error {
  constructor(readonly reason:'page_size'|'invalid_page'|'cursor'|'deleted'|'waking'|'empty_with_messages'|'empty_unverified',message:string,readonly observedBytes?:number,readonly limitBytes?:number){super(message);}
}
export function replicasError(message:string,status=400){return Object.assign(new Error(message),{status,expose:true});}

type MissingResource='chat'|'workspace'|'history'|'unspecified';

/** Replicas may include private context in its error body. Only a fixed category
 * leaves the client, and an unreadable body never replaces the HTTP result. */
async function missingResource(response:Response):Promise<MissingResource|undefined>{
  if(response.status!==404||!response.headers.get('content-type')?.includes('json'))return;
  const reader=response.body?.getReader();
  if(!reader)return;
  try{
    const chunks:Uint8Array[]=[];let bytes=0;
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      bytes+=value.length;
      if(bytes>4096)return;
      chunks.push(value);
    }
    const data:unknown=JSON.parse(Buffer.concat(chunks).toString());
    if(!data||typeof data!=='object')return;
    const message=['code' in data?data.code:undefined,'error' in data?data.error:undefined]
      .filter((part):part is string=>typeof part==='string').join(' ').replaceAll('_',' ').toLowerCase();
    if(/\b(chat|conversation)\b/.test(message))return 'chat';
    if(/\b(replica|workspace)\b/.test(message))return 'workspace';
    if(/\b(history|transcript)\b/.test(message))return 'history';
    return 'unspecified';
  }catch{return;}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}

/** Only errors returned by a Replicas HTTP request may prompt a key/visibility check. */
export class ReplicasProviderError extends Error {
  readonly expose=true;
  constructor(message:string,readonly status:number,readonly operation:ReplicasOperation,readonly requestId?:string,readonly retryAfterMs?:number,readonly missingResource?:MissingResource){super(message);}
}

/** Fixed-origin, read-only client. Never follow redirects with an organization key. */
export function replicasApi(apiKey:string,request:typeof fetch=fetch){
  async function get<T>(operation:ReplicasOperation,path:string,schema:z.ZodType<T>,maxBytes=12*1024*1024,observe?:(info:ReplicasResponseInfo)=>void):Promise<T>{
    const response=await request('https://api.replicas.dev/v1/'+path,{method:'GET',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+apiKey,'X-Replicas-Api-Version':'2026-10-07',Accept:'application/json'}});
    const id=response.headers.get('x-request-id')??response.headers.get('request-id')??response.headers.get('cf-ray');
    const requestId=id&&id!==apiKey&&/^(?:[a-fA-F0-9-]{16,64}|req_[A-Za-z0-9]{8,64}|[0-9a-f]{16}-[A-Z]{3})$/.test(id)?id:undefined;
    observe?.({httpStatus:response.status,requestId});
    if(!response.ok){
      const hint=response.headers.get('retry-after');
      const delay=hint&&/^\d+$/.test(hint)?Number(hint)*1000:hint?Date.parse(hint)-Date.now():NaN;
      const missing=await missingResource(response);
      await response.body?.cancel().catch(()=>{});
      throw new ReplicasProviderError(`Replicas returned HTTP ${response.status} for the ${operation} request.`,response.status,operation,requestId,
        Number.isFinite(delay)&&delay>0?Math.min(delay,86_400_000):undefined,missing);
    }
    // Bound streamed responses too; Content-Length is not authoritative.
    const reader=response.body?.getReader();if(!reader)throw replicasError('Replicas returned an empty response.',502);
    const chunks:Uint8Array[]=[];let bytes=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>maxBytes)throw new ReplicasPageError('page_size','A Replicas response exceeds the import limit.',bytes,maxBytes);chunks.push(value);}}finally{await reader.cancel();}
    observe?.({httpStatus:response.status,requestId,bytesRead:bytes});
    let parsed:unknown;
    try{parsed=JSON.parse(Buffer.concat(chunks).toString());}catch{throw new ReplicasPageError('invalid_page','Replicas returned invalid JSON.');}
    const result=schema.safeParse(parsed);
    if(!result.success)throw new ReplicasPageError('invalid_page','Replicas returned an unsupported history format.');
    return result.data;
  }
  return {
    identity:()=>get('identity','whoami',z.object({organization:z.object({id:uuid,name:z.string()}),caller:z.string()})),
    conversations:(next?:string|null,workspaceId?:string,observe?:(info:ReplicasResponseInfo)=>void,limit=100)=>get('catalog','organization/conversations?'+new URLSearchParams({limit:String(limit),...(next?{cursor:next}:{}),...(workspaceId?{workspace_id:workspaceId}:{})}),conversationsSchema,undefined,observe),
    workspaceChats:(workspaceId:string)=>get('workspace_chats','replica/'+workspaceId+'/chats',
      z.object({chats:z.array(z.object({id:z.string(),created_at:z.string().optional(),updated_at:z.string().optional()})),waking:z.boolean().optional()})),
    async history(conversation:ReplicasConversation,before?:string|null,limit=100,observe?:(info:ReplicasResponseInfo)=>void){
      const page=await get('history','replica/'+conversation.workspace_id+'/history?'+new URLSearchParams({chat_id:conversation.chat_id,limit:String(limit),...(before?{before_cursor:before}:{})}),historySchema,limit===1?singleHistoryPageBytes:undefined,observe);
      if(page.waking===true)throw new ReplicasPageError('waking','Replicas is preparing the workspace history.');
      return page;
    },
  };
}
