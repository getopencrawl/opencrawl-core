import {z} from 'zod';

const uuid=z.string().uuid();
export const conversationSchema=z.looseObject({chat_id:uuid,workspace_id:uuid,workspace_name:z.string(),provider:z.string().nullable(),title:z.string().nullable(),created_at:z.string(),updated_at:z.string(),workspace_status:z.string()});
export type ReplicasConversation=z.infer<typeof conversationSchema>;
const cursor=z.string().max(16384).nullable();
const conversationsSchema=z.object({conversations:z.array(conversationSchema).max(100),total:z.number().int().nonnegative(),next_cursor:cursor});
// Validate pagination without stripping or rewriting source fields.
const historySchema=z.looseObject({events:z.array(z.unknown()).max(1000),before_cursor:cursor.optional(),has_more:z.boolean().optional()})
  .refine(page=>page.before_cursor!==undefined||page.has_more===false);
export type ReplicasHistory=z.infer<typeof historySchema>;
export type ReplicasOperation='identity'|'catalog'|'history';
export class ReplicasPageError extends Error {
  constructor(readonly reason:'page_size'|'invalid_page'|'cursor'|'deleted',message:string){super(message);}
}
export function replicasError(message:string,status=400){return Object.assign(new Error(message),{status,expose:true});}

/** Only errors returned by a Replicas HTTP request may prompt a key/visibility check. */
export class ReplicasProviderError extends Error {
  readonly expose=true;
  constructor(message:string,readonly status:number,readonly operation:ReplicasOperation,readonly requestId?:string,readonly retryAfterMs?:number){super(message);}
}

/** Fixed-origin, read-only client. Never follow redirects with an organization key. */
export function replicasApi(apiKey:string,request:typeof fetch=fetch){
  async function get<T>(operation:ReplicasOperation,path:string,schema:z.ZodType<T>):Promise<T>{
    const response=await request('https://api.replicas.dev/v1/'+path,{method:'GET',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+apiKey,'X-Replicas-Api-Version':'2026-10-07',Accept:'application/json'}});
    if(!response.ok){
      const id=response.headers.get('x-request-id')??response.headers.get('request-id')??response.headers.get('cf-ray');
      const hint=response.headers.get('retry-after');
      const delay=hint&&/^\d+$/.test(hint)?Number(hint)*1000:hint?Date.parse(hint)-Date.now():NaN;
      const requestId=id&&id!==apiKey&&/^(?:[a-fA-F0-9-]{16,64}|req_[A-Za-z0-9]{8,64}|[0-9a-f]{16}-[A-Z]{3})$/.test(id)?id:undefined;
      await response.body?.cancel();
      throw new ReplicasProviderError(`Replicas returned HTTP ${response.status} for the ${operation} request.`,response.status,operation,requestId,
        Number.isFinite(delay)&&delay>0?Math.min(delay,86_400_000):undefined);
    }
    // Bound streamed responses too; Content-Length is not authoritative.
    const reader=response.body?.getReader();if(!reader)throw replicasError('Replicas returned an empty response.',502);
    const chunks:Uint8Array[]=[];let bytes=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>12*1024*1024)throw new ReplicasPageError('page_size','A Replicas response exceeds the import limit.');chunks.push(value);}}finally{await reader.cancel();}
    let parsed:unknown;
    try{parsed=JSON.parse(Buffer.concat(chunks).toString());}catch{throw new ReplicasPageError('invalid_page','Replicas returned invalid JSON.');}
    const result=schema.safeParse(parsed);
    if(!result.success)throw new ReplicasPageError('invalid_page','Replicas returned an unsupported history format.');
    return result.data;
  }
  return {
    identity:()=>get('identity','whoami',z.object({organization:z.object({id:uuid,name:z.string()}),caller:z.string()})),
    conversations:(next?:string|null)=>get('catalog','organization/conversations?'+new URLSearchParams({limit:'100',...(next?{cursor:next}:{})}),conversationsSchema),
    history:(conversation:ReplicasConversation,before?:string|null,limit=100)=>get('history','replica/'+conversation.workspace_id+'/history?'+new URLSearchParams({chat_id:conversation.chat_id,limit:String(limit),...(before?{before_cursor:before}:{})}),historySchema),
  };
}
