import {createHash,randomUUID} from 'node:crypto';
import {existsSync,readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {atomicJson,configDir,withSessionLock} from './session.ts';
import {apiOrigin,CliError} from './oauth.ts';
import {boardRequest,saveBoardRegistration} from './board.ts';
import {captureDevinStartup,captureDir,readCaptureConfig,type CaptureConfig} from './capture/runtime.ts';
import {readSetupState} from './setup/state.ts';
import {repairFilesGit} from './shared-files.ts';

type StartupHarness='codex'|'claude-code'|'cursor'|'antigravity'|'devin';
type Binding={api:string;installationId:string;owner:{tenantId:string;userId:string};harness:StartupHarness;sessionId:string};
type StartupPayload={hook_event_name:'SessionStart';source:string}|{hook_event_name:'sessionStart'}|{hookEventName:'SessionStart'};
export type SessionStartTask=Binding&{kind:'session-start';id:string;at:number;payload:StartupPayload};
type Registration={sharedFiles?:boolean;workspace:string;agent:string;session:string;name:string|null;task:string|null};
export type StartupObservation={observedAt:number;registration:Registration};
type State={schemaVersion:1;binding:Binding;pending?:{id:string;at:number};confirmed?:StartupObservation};
const nativeId=/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const owner=(value:unknown):value is Binding['owner']=>object(value)&&Object.keys(value).sort().join(',')==='tenantId,userId'&&
  ['tenantId','userId'].every(k=>typeof value[k]==='string'&&String(value[k]).length>0&&String(value[k]).length<=200);
const sameBinding=(value:unknown,binding:Binding)=>object(value)&&owner(value.owner)&&value.api===binding.api&&value.installationId===binding.installationId&&
  value.owner.tenantId===binding.owner.tenantId&&value.owner.userId===binding.owner.userId&&value.harness===binding.harness&&value.sessionId===binding.sessionId;
const invalid=()=>new CliError('STARTUP_BINDING_CHANGED','Queued startup no longer matches the selected plugin, installation, account or workspace.');
const key=(binding:Binding)=>createHash('sha256').update(JSON.stringify([binding.api,binding.installationId,binding.owner.tenantId,binding.owner.userId,binding.harness,binding.sessionId])).digest('hex');
const stateFile=(binding:Binding)=>join(configDir(),'startup','registrations',key(binding)+'.json');
const taskFile=(id:string)=>join(captureDir(),'daemon','inbox','startup-'+id+'.json');
const matches=(config:CaptureConfig|null,binding:Binding)=>Boolean(config&&config.backgroundStartup===true&&!config.authPending&&config.api===binding.api&&config.installationId===binding.installationId&&config.owner?.tenantId===binding.owner.tenantId&&config.owner?.userId===binding.owner.userId);

/** Startup is selected independently of forward recording and historical import. */
function assertCurrent(binding:Binding,expected?:CaptureConfig):void {
  if(expected&&!matches(expected,binding)||!matches(readCaptureConfig(),binding))throw invalid();
  const state=readSetupState({api:binding.api,...binding.owner});
  if(state?.installationId!==binding.installationId||state.selections.plugins[binding.harness]!==true)throw invalid();
}
function bindingFor(api:string,harness:string,sessionId:string):Binding {
  const config=readCaptureConfig();
  if(!config||apiOrigin(api)!==api||!['codex','claude-code','cursor','antigravity','devin'].includes(harness)||!nativeId.test(sessionId)||
      !config.installationId||config.installationId==='pending'||!config.owner?.tenantId||!config.owner.userId)throw invalid();
  const binding:Binding={api,installationId:config.installationId,owner:{tenantId:config.owner.tenantId,userId:config.owner.userId},harness:harness as StartupHarness,sessionId};
  assertCurrent(binding);return binding;
}
function registration(value:unknown,binding:Binding):value is Registration {
  return object(value)&&value.workspace===binding.owner.tenantId&&value.session===binding.sessionId&&typeof value.agent==='string'&&/^[a-f0-9]{64}$/.test(value.agent)&&
    (value.name===null||typeof value.name==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(value.name))&&
    (value.task===null||typeof value.task==='string'&&value.task.length<=240);
}
function readState(binding:Binding):State {
  const empty:State={schemaVersion:1,binding};
  try{
    const file=stateFile(binding);if(statSync(file).size>16_384)return empty;
    const saved:unknown=JSON.parse(readFileSync(file,'utf8'));
    if(!object(saved)||saved.schemaVersion!==1||!sameBinding(saved.binding,binding))return empty;
    const state:State={...empty};
    if(object(saved.pending)&&typeof saved.pending.id==='string'&&uuid.test(saved.pending.id)&&Number.isSafeInteger(saved.pending.at)&&Number(saved.pending.at)>0)
      state.pending={id:saved.pending.id,at:Number(saved.pending.at)};
    if(object(saved.confirmed)&&Number.isSafeInteger(saved.confirmed.observedAt)&&Number(saved.confirmed.observedAt)>0&&Number(saved.confirmed.observedAt)<=Date.now()+60_000&&registration(saved.confirmed.registration,binding))
      state.confirmed={observedAt:Number(saved.confirmed.observedAt),registration:saved.confirmed.registration};
    return state;
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'||error instanceof SyntaxError)return empty;throw error;}
}
export const startupBindingKey=(api:string,harness:string,sessionId:string)=>key(bindingFor(api,harness,sessionId));
export const startupObservation=(api:string,harness:string,sessionId:string)=>readState(bindingFor(api,harness,sessionId)).confirmed;

/** Normal board commands may wait for the already queued startup; hooks never
 * wait here. Inspect only the five exact current-profile keys, never a directory. */
export async function waitForStartupRegistration(api:string,sessionId:string,{timeoutMs,signal,check=()=>{},onConfirmed}:{timeoutMs:number;signal?:AbortSignal;check?:()=>void;onConfirmed?:(result:StartupObservation,binding:Binding)=>void}):Promise<boolean> {
  const config=readCaptureConfig();
  if(!config?.backgroundStartup||config.api!==api)return true;
  if(!nativeId.test(sessionId)||!Number.isSafeInteger(timeoutMs)||timeoutMs<0)throw invalid();
  const found:Binding[]=[];
  for(const harness of ['codex','claude-code','cursor','antigravity','devin'] as const){
    const binding:Binding={api,installationId:config.installationId,owner:{tenantId:config.owner.tenantId,userId:config.owner.userId},harness,sessionId};
    const state=readState(binding);if(state.pending||state.confirmed)found.push(binding);
  }
  if(!found.length)return true;
  if(found.length!==1)throw invalid();
  const binding=found[0]!,deadline=timeoutMs?Date.now()+timeoutMs:Infinity;
  while(true){
    check();signal?.throwIfAborted();assertCurrent(binding);
    const state=readState(binding);
    // A resumed session can have left the server. An old observation does not
    // complete its newer pending bootstrap request.
    if(!state.pending&&state.confirmed){onConfirmed?.(state.confirmed,binding);return true;}
    if(!state.pending)throw invalid();
    if(!existsSync(taskFile(state.pending.id))){
      // Success commits the observation before the worker removes its task.
      // Re-read to avoid mistaking that normal completion race for a hold.
      const latest=readState(binding);assertCurrent(binding);
      if(!latest.pending&&latest.confirmed){onConfirmed?.(latest.confirmed,binding);return true;}
      if(latest.pending?.id!==state.pending.id)continue;
      throw new CliError('BOARD_STARTUP_UNAVAILABLE','Background registration could not complete. Continue your task and inspect OpenCrawl setup and worker status; do not register again.');
    }
    if(Date.now()>=deadline)return false;
    await pause(Math.min(250,Math.max(1,deadline-Date.now())),undefined,{signal});
  }
}

/** Called only after the native plugin/profile guard. No auth, service start,
 * token refresh, network, transcript or tool payload enters this local handoff. */
export async function enqueueSessionStart(api:string,harness:string,sessionId:string,event:Record<string,unknown>):Promise<StartupObservation|undefined> {
  const binding=bindingFor(api,harness,sessionId);
  const payload:StartupPayload=harness==='antigravity'?{hookEventName:'SessionStart'}:harness==='cursor'?{hook_event_name:'sessionStart'}:{hook_event_name:'SessionStart',source:String(event.source)};
  const observed=await withSessionLock('startup:'+key(binding),async()=>{
    assertCurrent(binding);
    const state=readState(binding);
    // One outstanding request per scope/session keeps offline hooks bounded.
    if(!state.pending||!existsSync(taskFile(state.pending.id))){
      const task:SessionStartTask={...binding,kind:'session-start',id:randomUUID(),at:Date.now(),payload};
      validateTask(task);
      atomicJson(taskFile(task.id),task);
      atomicJson(stateFile(binding),{...state,pending:{id:task.id,at:task.at}});
    }
    return state.confirmed;
  },200);
  assertCurrent(binding);return observed;
}
function validateTask(value:unknown):asserts value is SessionStartTask {
  if(!object(value)||Buffer.byteLength(JSON.stringify(value))>4096||Object.keys(value).sort().join(',')!=='api,at,harness,id,installationId,kind,owner,payload,sessionId'||value.kind!=='session-start'||typeof value.id!=='string'||!uuid.test(value.id)||
    !Number.isSafeInteger(value.at)||Number(value.at)<=0||Number(value.at)>Date.now()+60_000||typeof value.api!=='string'||apiOrigin(value.api)!==value.api||
    typeof value.installationId!=='string'||!value.installationId||value.installationId.length>200||typeof value.sessionId!=='string'||!nativeId.test(value.sessionId)||
    !owner(value.owner)||
    !object(value.payload)||Buffer.byteLength(JSON.stringify(value.payload))>1024)throw invalid();
  const payload=value.payload;
  if(value.harness==='antigravity'&&Object.keys(payload).join(',')==='hookEventName'&&payload.hookEventName==='SessionStart')return;
  if(value.harness==='cursor'&&Object.keys(payload).join(',')==='hook_event_name'&&payload.hook_event_name==='sessionStart')return;
  if(value.harness==='devin'&&Object.keys(payload).sort().join(',')==='hook_event_name,source'&&payload.hook_event_name==='SessionStart'&&['startup','resume'].includes(String(payload.source)))return;
  if(['codex','claude-code'].includes(String(value.harness))&&Object.keys(payload).sort().join(',')==='hook_event_name,source'&&payload.hook_event_name==='SessionStart'&&['startup','resume','clear','compact','fork'].includes(String(payload.source)))return;
  throw invalid();
}

/** The independent worker lane owns retries/removal. Resolve only after the
 * authenticated, scope-bound observation is durable; failures retain its task. */
export async function processSessionStartTask(config:CaptureConfig,task:unknown,fetcher=fetch):Promise<void> {
  validateTask(task);
  const binding:Binding={api:task.api,installationId:task.installationId,owner:{...task.owner},harness:task.harness,sessionId:task.sessionId};
  if((await import('./incognito-state.ts')).sessionPrivate(config,binding))return;
  const guard=()=>assertCurrent(binding,config);guard();
  let captureError:unknown;
  if(task.harness==='devin' && 'source' in task.payload && task.payload.source==='startup') {
    try {await captureDevinStartup(config,task.sessionId);} catch(error){captureError=error;}
    guard();
    if((await import('./incognito-state.ts')).sessionPrivate(config,binding))return;
    const state=readState(binding);
    if(state.confirmed && state.confirmed.observedAt>=task.at && state.pending?.id!==task.id) {
      if(captureError)throw captureError;
      return;
    }
  }
  const result:unknown=await boardRequest(task.api,'bootstrap',{session:task.sessionId,harness:task.harness,workspace:task.owner.tenantId},fetcher,
    {signal:AbortSignal.timeout(10_000),expectedOwner:task.owner,validateBinding:guard});
  guard();if(!registration(result,binding))throw new CliError('BOARD_PROTOCOL_ERROR','Background startup did not confirm the bound native session.');
  if ((await import('./incognito-state.ts')).sessionPrivate(config,binding)) return;
  if (result.sharedFiles === true) await repairFilesGit(task.api,task.sessionId);
  await withSessionLock('startup:'+key(binding),async()=>{
    guard();const state=readState(binding);
    const confirmed:StartupObservation={observedAt:Date.now(),registration:{workspace:result.workspace,agent:result.agent,session:result.session,name:result.name,task:result.task,...(result.sharedFiles===true?{sharedFiles:true}:{})}};
    saveBoardRegistration(task.api,task.sessionId,result);
    atomicJson(stateFile(binding),{schemaVersion:1,binding,...(state.pending&&state.pending.id!==task.id?{pending:state.pending}:{}),confirmed});
  });
  guard();
  if(captureError)throw captureError;
}
