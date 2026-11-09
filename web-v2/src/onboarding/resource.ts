import {useEffect,useRef} from 'react';
import {useConsoleResource} from '../data.tsx';

/** Keep step reads warm and preserve the existing bounded request deadline. */
export function useOnboardingResource<T>(read: (signal: AbortSignal) => Promise<T>, options: {key: readonly unknown[]; interval?: number; initial?: T; enabled?: boolean}) {
  const readRef=useRef(read);readRef.current=read;
  const resource=useConsoleResource(options.key,async signal=>{
    const timeout=AbortSignal.timeout(10_000);
    try{return await readRef.current(AbortSignal.any([signal,timeout]));}
    catch(error){if(timeout.aborted&&!signal.aborted)throw Object.assign(Error('This check took too long. Try again.'),{status:503});throw error;}
  },{autoRefreshMilliseconds:options.interval,staleMilliseconds:options.interval??30_000,initial:options.initial,enabled:options.enabled});
  useEffect(()=>{const online=()=>{if(options.enabled!==false&&document.visibilityState==='visible')void resource.reload();};window.addEventListener('online',online);return()=>window.removeEventListener('online',online);},[resource.reload,options.enabled]);
  return {data:resource.data??undefined,error:resource.error||null,loading:resource.loading,reload:resource.reload,replace:resource.replaceData};
}
