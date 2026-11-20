import {readSession} from './session.ts';
import {configuredToken,workspaceIdentityEnabled} from './workspace-identity.ts';
import {assertCheckSettings,type CheckStore} from './context-check-state.ts';
import {object} from './context-check-events.ts';

// Keep the native hook deadline across authentication, batching and retries.
export async function flushSuggestionEvents(store:CheckStore,guard:()=>void,fetcher=fetch):Promise<{accepted:string[];rejected:string[]}|undefined> {
  const result:{accepted:string[];rejected:string[]}={accepted:[],rejected:[]};
  try{
    let events=store.pending();if(!events.length)return;
    const signal=AbortSignal.timeout(1500);
    guard();assertCheckSettings(store.settings,store.harness);
    const saved=readSession(store.settings.api);
    // No interactive login or human refresh on a delivery hook's critical path.
    const credential=workspaceIdentityEnabled()?await configuredToken('OPENCRAWL_TOKEN',store.settings.api,undefined,signal)
      :saved&&!saved.pendingOrganization&&saved.expiresAt>Date.now()?saved.accessToken:undefined;
    if(!credential)return;
    const identity=await fetcher(store.settings.api+'/api/sessions/identity',{redirect:'error',signal,headers:{authorization:'Bearer '+credential}});
    if(!identity.ok){await identity.body?.cancel();return;}
    const who=await boundedJson(identity),principal=object(who)&&object(who.data)&&object(who.data.principal)?who.data.principal:undefined;
    if(principal?.tenantId!==store.settings.owner.tenantId||principal.userId!==store.settings.owner.userId)return;
    const verifyOwner=()=>{
      guard();assertCheckSettings(store.settings,store.harness);
      return workspaceIdentityEnabled()||readSession(store.settings.api)?.accessToken===credential;
    };
    while(events.length && !signal.aborted && verifyOwner()){
      const response=await fetcher(store.settings.api+'/api/context/suggestions/events',{method:'POST',redirect:'error',signal,headers:{authorization:'Bearer '+credential,'content-type':'application/json'},body:JSON.stringify({events})});
      const body=await boundedJson(response);
      if(!verifyOwner())break;
      const invalidReceipt=response.status===403 && object(body) && object(body.error) && body.error.code==='SUGGESTION_RECEIPT_FORBIDDEN';
      if(response.status===400||response.status===409||invalidReceipt){
        if(events.length===1){
          const id=events[0]!.id;
          store.acknowledge([id]);result.rejected.push(id);
        }else{
          // The server rejected the transaction. Isolate its members on disk so
          // a short hook or process restart still makes progress on the next try.
          store.isolate(events);
        }
      }else{
        if(!response.ok||!object(body)||!object(body.data)||!Array.isArray(body.data.accepted))break;
        const own=new Set(events.map(e=>e.id)),accepted=body.data.accepted.filter((id):id is string=>typeof id==='string'&&own.has(id));
        if(!accepted.length)break;
        store.acknowledge(accepted);result.accepted.push(...accepted);
      }
      events=store.pending();
    }
  }catch{/* A transport or profile failure leaves unacknowledged events pending. */}
  return result;
}

async function boundedJson(response:Response):Promise<unknown>{
  if(!response.body)return;
  const reader=response.body.getReader(),parts:Uint8Array[]=[];let bytes=0;
  try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>4096)throw Error('Oversized telemetry response');parts.push(next.value);}}finally{await reader.cancel().catch(()=>{});}
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
}
