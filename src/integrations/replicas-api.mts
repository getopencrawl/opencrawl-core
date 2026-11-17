import {z} from 'zod';

const uuid=z.string().uuid();
export const conversationSchema=z.object({chat_id:uuid,workspace_id:uuid,workspace_name:z.string(),provider:z.string().nullable(),title:z.string().nullable(),created_at:z.string(),updated_at:z.string(),workspace_status:z.string()});
export type ReplicasConversation=z.infer<typeof conversationSchema>;
const cursor=z.string().max(16384).nullable();
const conversationsSchema=z.object({conversations:z.array(conversationSchema).max(100),total:z.number().int().nonnegative(),next_cursor:cursor});
const historySchema=z.object({events:z.array(z.object({type:z.string(),timestamp:z.string().optional().nullable(),payload:z.record(z.string(),z.unknown())})).max(1000),before_cursor:cursor.optional(),has_more:z.boolean().optional()})
  .refine(page=>page.before_cursor!==undefined||page.events.length===0||page.has_more===false)
  .transform(page=>({...page,before_cursor:page.before_cursor??null}));
export type ReplicasHistory=z.infer<typeof historySchema>;
export function replicasError(message:string,status=400){return Object.assign(new Error(message),{status,expose:true});}

/** Fixed-origin, read-only client. Never follow redirects with an organization key. */
export function replicasApi(apiKey:string,request:typeof fetch=fetch){
  async function get<T>(path:string,schema:z.ZodType<T>):Promise<T>{
    const response=await request('https://api.replicas.dev/v1/'+path,{method:'GET',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+apiKey,'X-Replicas-Api-Version':'2026-10-07',Accept:'application/json'}});
    if(!response.ok){await response.body?.cancel();throw replicasError(response.status===401||response.status===403?'Replicas denied access. Use an organization API key with access to retained conversations.':response.status===409?'This conversation has no retained history.':response.status===429?'Replicas is rate limiting this import. Wait a moment, then resume.':'Replicas could not read the retained history. Resume to retry.',response.status);}
    // Bound streamed responses too; Content-Length is not authoritative.
    const reader=response.body?.getReader();if(!reader)throw replicasError('Replicas returned an empty response.',502);
    const chunks:Uint8Array[]=[];let bytes=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>12*1024*1024)throw replicasError('A Replicas history page is too large to import.',502);chunks.push(value);}}finally{await reader.cancel();}
    const result=schema.safeParse(JSON.parse(Buffer.concat(chunks).toString()));
    if(!result.success)throw replicasError('Replicas returned an unsupported history format. No progress was discarded.',502);
    return result.data;
  }
  return {
    identity:()=>get('whoami',z.object({organization:z.object({id:uuid,name:z.string()}),caller:z.string()})),
    conversations:(next?:string|null)=>get('organization/conversations?'+new URLSearchParams({limit:'100',...(next?{cursor:next}:{})}),conversationsSchema),
    history:(conversation:ReplicasConversation,before?:string|null)=>get('replica/'+conversation.workspace_id+'/history?'+new URLSearchParams({chat_id:conversation.chat_id,limit:'100',...(before?{before_cursor:before}:{})}),historySchema),
  };
}
