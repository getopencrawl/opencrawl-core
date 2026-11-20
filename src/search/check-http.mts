import {admitActivity} from '../application/agent-activity.mjs';
import {CHECK_LIMITS} from './check.mjs';
import {sessionScope} from '../sessions/ingest.mjs';
import {serviceError,type Principal,type Authenticate,type HttpHandler} from '../sessions/types.mjs';

export function createContextCheckHandler({authenticate,check}:{authenticate:Authenticate;check:(p:Principal,input:unknown,signal:AbortSignal)=>Promise<unknown>}):HttpHandler {
  return async(req,res)=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),CHECK_LIMITS.deadlineMs);
    const disconnect=()=>{if(!res.writableFinished)controller.abort();};res.once('close',disconnect);
    const send=(status:number,body:unknown)=>{if(!res.destroyed){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({schemaVersion:1,...body as object}));}};
    try {
      if(req.method!=='POST')return send(405,{error:{code:'METHOD_NOT_ALLOWED'}});
      if(req.headers.origin)return send(403,{error:{code:'BROWSER_REQUEST_DENIED'}});
      const principal=await authenticate(req);sessionScope(principal);
      if(!principal)return send(401,{error:{code:'AUTH_REQUIRED'}});
      admitActivity(principal);
      const chunks:Buffer[]=[];let bytes=0;
      for await(const chunk of req){bytes+=chunk.length;if(bytes>16384)return send(413,{error:{code:'REQUEST_TOO_LARGE'}});chunks.push(chunk);}
      let input:unknown;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return send(400,{error:{code:'INVALID_JSON'}});}
      let aborted:()=>void=()=>{};
      const interrupted=new Promise<never>((_resolve,reject)=>{aborted=()=>reject(new Error('Context check deadline'));controller.signal.addEventListener('abort',aborted,{once:true});if(controller.signal.aborted)aborted();});
      let result:unknown;
      try{result=await Promise.race([check(principal,input,controller.signal),interrupted]);}
      finally{controller.signal.removeEventListener('abort',aborted);}
      controller.signal.throwIfAborted();
      send(200,{data:result});
    }catch(error){const status=serviceError(error).status;send(status&&[400,401,402,403,409,429].includes(status)?status:503,{error:{code:status===402?'CHECK_CREDITS_EXHAUSTED':status===429?'CHECK_BUDGET_REACHED':status===409?'CHECK_ALREADY_SUBMITTED':'CONTEXT_CHECK_UNAVAILABLE'}});}
    finally{clearTimeout(timer);res.off('close',disconnect);}
  };
}
