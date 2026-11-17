import {readSession} from './session.ts';
import {configuredToken,workspaceIdentityEnabled} from './workspace-identity.ts';
import {assertCheckSettings,type CheckStore} from './context-check-state.ts';
import {object} from './context-check-events.ts';

/** One bounded batch, no inference and no background poller. Failed delivery
 * stays in the private 24-hour/512-event outbox for the next eligible hook. */
export async function flushSuggestionEvents(store:CheckStore,guard:()=>void,fetcher=fetch):Promise<{accepted:string[];rejected?:boolean}|undefined> {
  try{
    const events=store.pending();if(!events.length)return;
    // Production identity plus authorized event ingestion exceeded 650 ms in
    // three consecutive probes. Keep one shared deadline within 3 s hooks.
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
    guard();assertCheckSettings(store.settings,store.harness);
    const response=await fetcher(store.settings.api+'/api/context/suggestions/events',{method:'POST',redirect:'error',signal,headers:{authorization:'Bearer '+credential,'content-type':'application/json'},body:JSON.stringify({events})});
    guard();assertCheckSettings(store.settings,store.harness);
    if(!workspaceIdentityEnabled()&&readSession(store.settings.api)?.accessToken!==credential)return;
    if([400,403,409].includes(response.status)){await response.body?.cancel();store.acknowledge(events.map(e=>e.id));return {accepted:[],rejected:true};}
    if(!response.ok){await response.body?.cancel();return;}
    const body=await boundedJson(response);
    if(object(body)&&object(body.data)&&Array.isArray(body.data.accepted)){
      const own=new Set(events.map(e=>e.id)),accepted=body.data.accepted.filter((id):id is string=>typeof id==='string'&&own.has(id));store.acknowledge(accepted);return {accepted};
    }
  }catch{/* Telemetry must not block or trigger another paid request. */}
}

async function boundedJson(response:Response):Promise<unknown>{
  if(!response.body)return;
  const reader=response.body.getReader(),parts:Uint8Array[]=[];let bytes=0;
  try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>4096)throw Error('Oversized telemetry response');parts.push(next.value);}}finally{await reader.cancel().catch(()=>{});}
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
}
