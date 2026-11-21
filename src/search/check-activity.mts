import {AsyncLocalStorage} from 'node:async_hooks';
import {checkEventKey,type SearchActivity} from '../state/search-activity.mjs';
import type {Principal} from '../identity/types.mjs';
import {checkInputSchema,type CheckResult} from './check.mjs';
import type {SuggestionObserver} from './suggestion-events.mjs';

const running=new AsyncLocalStorage<string[]>();
export function executedCheckQuery(query:string){running.getStore()?.push(query);}

type Check=(p:Principal,input:unknown,signal:AbortSignal)=>Promise<Pick<CheckResult,'results'>>;
/** `ran` receives the queries a check executed, for a deployment that keeps its own record of each check. */
export function measuredCheck(activity:SearchActivity|undefined,check:Check,ran?:(queries:string[])=>void):Check{
  if(!activity&&!ran)return check;
  return (p,raw,signal)=>running.run([],async()=>{
    const queries=running.getStore()!;
    let result:Awaited<ReturnType<Check>>|undefined;
    try{result=await check(p,raw,signal);return result;}
    finally{
      if(queries.length)ran?.([...queries]);
      // Skips, admission failures and receipt replays do not run a search.
      if(activity&&queries.length){
        const input=checkInputSchema.parse(raw),{harness,sessionId}=input.currentSession;
        await activity.search(p,{kind:'proactive',operation:'Context check',queries,harness,sessionId,
          eventKey:checkEventKey(harness,sessionId,input.eventId),messageId:input.eventId,message:input.message,
          returned:result?.results.length,failed:!result}).catch(()=>console.error(JSON.stringify({event:'usage.write_failed',transport:'proactive'})));
      }
    }
  });
}
export function measuredSuggestionEvents(activity?:SearchActivity,observe?:SuggestionObserver):SuggestionObserver|undefined{
  if(!activity)return observe;
  return async(p,events)=>{
    await observe?.(p,events);
    const keys=events.flatMap(e=>e.stage==='handoff'?[e.eventKey]:[]);
    await activity.handoffs(p,keys);
  };
}
