import {ConsoleApiError} from './errors.ts';
const rpcFetch = async (url:RequestInfo|URL, init?:RequestInit):Promise<Response> => {
    const response=await fetch(url,{...init,credentials:'same-origin'});
    const status=response.redirected?401:response.status;
    if(![401,402,403].includes(status))return response;
    const body:unknown=await response.clone().json().catch(()=>null);
    const first=Array.isArray(body)?body[0]:body;
    if(!response.redirected&&typeof first==='object'&&first!==null&&'error' in first&&typeof first.error==='object'&&first.error!==null&&'data' in first.error)return response;
    const target=new URL(String(url),'http://transport.invalid');
    const error={error:{message:status===403?'Your workspace access changed. Sign in again to continue.':'Your session changed. Sign in again to continue.',code:status===403?-32003:-32001,data:{httpStatus:status,code:status===403?'FORBIDDEN':'UNAUTHORIZED'}}};
    return Response.json(target.searchParams.get('batch')==='1'?target.pathname.split('/').at(-1)!.split(',').map(()=>error):error,{status});
  };
/** Reads use POST bodies and one shared bounded batch. */
export const rpcBatchOptions = (url = '/api/trpc') => ({url, maxItems: 8, maxURLLength: 8000, fetch: rpcFetch, methodOverride: 'POST' as const});

/** Normalize transport failures once; every operation retains the router's inferred types. */
export async function rpcRead<T>(operation:()=>Promise<T>,signal?:AbortSignal):Promise<T> {
  try{return await operation();}catch(failure){
    if(signal?.aborted)throw failure;
    // A consuming app may load its own copy of tRPC; do not rely on SDK class identity.
    const metadata = failure instanceof Error && 'meta' in failure && typeof failure.meta === 'object' && failure.meta !== null ? failure.meta : undefined;
    const data = failure instanceof Error && 'data' in failure && typeof failure.data === 'object' && failure.data !== null ? failure.data : undefined;
    const response = metadata && 'response' in metadata && metadata.response instanceof Response ? metadata.response : undefined;
    const status = response?.redirected ? 401 : data && 'httpStatus' in data && typeof data.httpStatus === 'number' ? data.httpStatus : response?.status ?? 503;
    const error=new ConsoleApiError(failure instanceof Error?failure.message:'We couldn’t load this information. Please try again.',status);
    if(typeof window!=='undefined'&&[401,402,403].includes(status))window.dispatchEvent(new CustomEvent('opencrawl:access-denied',{detail:error.message}));
    throw error;
  }
}
export async function rpcWrite<T>(operation:()=>Promise<T>,signal?:AbortSignal):Promise<T> {
  let invalidate=true;
  try{return await rpcRead(operation,signal);}
  catch(error){if(error instanceof ConsoleApiError&&[401,402,403].includes(error.status))invalidate=false;throw error;}
  finally{if(invalidate&&!signal?.aborted&&typeof window!=='undefined')window.dispatchEvent(new Event('opencrawl:console-mutated'));}
}
