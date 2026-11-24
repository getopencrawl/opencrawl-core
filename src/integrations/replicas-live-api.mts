import {createParser, type EventSourceMessage} from 'eventsource-parser';
import {z} from 'zod';
import {replicasApi, ReplicasProviderError} from './replicas-api.mjs';

const uuid=z.string().uuid();
const frame=z.object({type:z.string().min(1),ts:z.iso.datetime({offset:true}),payload:z.record(z.string(),z.unknown())});
export type LiveFrame=z.infer<typeof frame>&{cursor:string};

export function replicasLiveApi(key:string,organizationId:string,signal:AbortSignal,request:typeof fetch){
  uuid.parse(organizationId);
  const scopedRequest:typeof fetch=(url,options={})=>{
    const headers=new Headers(options.headers);
    headers.set('Replicas-Org-Id',organizationId);
    return request(url,{...options,headers,signal:options.signal?AbortSignal.any([signal,options.signal]):signal});
  };
  const history=replicasApi(key,scopedRequest);
  async function get(path:string,accept:string,stop:AbortSignal,cursor?:string){
    const response=await scopedRequest('https://api.replicas.dev/v1/'+path,{redirect:'error',signal:stop,
      headers:{Authorization:'Bearer '+key,'X-Replicas-Api-Version':'2026-10-07',Accept:accept,...(cursor?{'Last-Event-ID':cursor}:{})}});
    if(!response.ok){
      const hint=response.headers.get('retry-after');
      const wait=hint&&/^\d+$/.test(hint)?1000*Number(hint):hint?Date.parse(hint)-Date.now():0;
      await response.body?.cancel();
      throw new ReplicasProviderError('Replicas live read returned HTTP '+response.status,response.status,'live',undefined,
        Number.isFinite(wait)&&wait>0?Math.min(wait,86_400_000):undefined);
    }
    return response;
  }
  return {...history,
    async activeWorkspaces(){
      const result=new Set<string>();
      for(let page=1;;page++){
        const response=await get('replica?status=active&limit=100&page='+page,'application/json',AbortSignal.timeout(15000));
        const batch=z.object({replicas:z.array(z.object({id:uuid,status:z.string()})).max(100),page:z.number().int(),total_pages:z.number().int().nonnegative()}).parse(await response.json());
        if(batch.page!==page)throw new Error('Replicas returned the wrong inventory page');
        for(const workspace of batch.replicas)if(workspace.status==='active')result.add(workspace.id);
        if(page>=batch.total_pages)return result;
      }
    },
    async stream(workspaceId:string,last:string|null,stop:AbortSignal,receive:(frames:LiveFrame[])=>Promise<void>){
      uuid.parse(workspaceId);
      const idle=new AbortController();
      const timer=setTimeout(()=>idle.abort(),45000);
      try{
        const response=await get('replica/'+workspaceId+'/events','text/event-stream',AbortSignal.any([stop,idle.signal]),last??undefined);
        if(!response.body||!response.headers.get('content-type')?.includes('text/event-stream'))throw new Error('Invalid Replicas event stream');
        const frames:LiveFrame[]=[];
        const parser=createParser({maxBufferSize:16*1024*1024,onError(error){if(error.type==='max-buffer-size-exceeded')throw error;},onEvent(message:EventSourceMessage){
          if(!message.id||message.id.length>256||/[\r\n\0]/.test(message.id))throw new Error('Invalid Replicas replay cursor');
          frames.push({...frame.parse(JSON.parse(message.data)),cursor:message.id});
        }});
        const reader=response.body.getReader(),decoder=new TextDecoder();
        try{
          for(;;){
            const {value,done}=await reader.read();if(done)break;
            timer.refresh();parser.feed(decoder.decode(value,{stream:true}));
            if(frames.length)await receive(frames.splice(0));
          }
        }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      }finally{clearTimeout(timer);idle.abort();}
    },
  };
}
