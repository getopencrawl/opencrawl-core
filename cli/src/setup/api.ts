import {CliError,jsonRequest} from '../oauth.ts';
import type {CodexHookReview} from '../capture/codex-hooks.ts';
import {readSetupState,scopeKey} from './state.ts';
import {accessToken,withSessionLock} from '../session.ts';
import {configuredToken,workspaceIdentityEnabled} from '../workspace-identity.ts';
import type {SetupHumanTask,SetupScope,SetupState} from './state.ts';
type HookTrust='trusted'|'pending'|'unknown'|'not_required';
type SetupHookObservation={scope:SetupScope;installationId:string;recordingSelected:boolean;review:CodexHookReview};
type HookReport=SetupHookObservation & {onlyHooks?:true};
export type SetupServerStatus={scope:{tenantId:string;userId:string};pluginStateSupported?:boolean;revisionProofSupported?:boolean;firstWin:unknown;installations:{installationId:string;clients:{client:string;installed?:boolean;pluginState?:string;history?:string;historyProgress?:unknown;forward?:boolean;hookTrust?:HookTrust;captureObservedAt?:string;mcp?:{state:string};proof?:{state:string};humanTasks:SetupHumanTask[]}[]}[]};
export async function setupRequest(api:string,path:string,input?:unknown,fetcher=fetch,timeoutMs=30000):Promise<unknown>{
  const configured=await configuredToken('OPENCRAWL_TOKEN',api);let token=configured||await accessToken(api,undefined,fetcher);
  const send=()=>jsonRequest(api+path,{method:input===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,...(input===undefined?{}:{'content-type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)}),signal:AbortSignal.timeout(timeoutMs)},fetcher);
  let result=await send();
  if(result.response.status===401&&(!configured||workspaceIdentityEnabled())){token=await configuredToken('OPENCRAWL_TOKEN',api,token)||await accessToken(api,token,fetcher);result=await send();}
  if(result.response.status===401)throw new CliError('AUTH_REQUIRED',workspaceIdentityEnabled()?'The cloud identity could not be verified. Repair its provider helper and organization connection; do not use a human sign-in.':'Sign in with opencrawl login before setup.',2);
  if(path==='/api/setup/invitations' && input!==undefined){
    const message=({
      400:'Enter a valid email address for someone other than yourself.',
      403:'Your workspace or admin access changed. Continue setup and check Team settings.',
      409:'That person may already be a member or have a pending invitation.',
    } as Record<number,string>)[result.response.status];
    if(message)throw new CliError('INVITATION_REJECTED',message);
  }
  if(result.response.status===403)throw new CliError('SETUP_FORBIDDEN','This account cannot configure setup in the selected workspace.',2);
  if(result.response.status===404)throw new CliError('SETUP_UNAVAILABLE','This deployment does not support CLI setup yet. Upgrade the self-hosted server or use the existing capture commands.');
  if(!result.response.ok||result.body.schemaVersion!==1||!result.body.data)throw new CliError('SETUP_UNAVAILABLE','Setup could not reach the deployment. Your saved choices are retained; retry.');
  return result.body.data;
}
export async function readServerSetup(api:string,fetcher=fetch):Promise<SetupServerStatus>{
  const value=await setupRequest(api,'/api/setup',undefined,fetcher) as SetupServerStatus;
  if(!value.scope||typeof value.scope.tenantId!=='string'||!value.scope.tenantId||typeof value.scope.userId!=='string'||!value.scope.userId||!Array.isArray(value.installations))throw new CliError('SETUP_RESPONSE_INVALID','The deployment did not provide a valid authenticated setup scope.');
  return value;
}
export const serverScope=(api:string,value:SetupServerStatus):SetupScope=>({api,...value.scope});
function observedTrust(review:CodexHookReview):HookTrust {
  if(review.state!=='observed'||review.total===0||review.pending===null||review.disabled===null)return 'unknown';
  if(review.pending>0)return 'pending';
  // Disabled hooks are opt-outs. No enabled hook needs approval in this case.
  return review.disabled>0?'not_required':'trusted';
}

export async function publishSetup(snapshot:SetupState,fetcher=fetch,hooks?:HookReport){
  if(!snapshot.installationId||!snapshot.machine){
    if(hooks)throw new CliError('SETUP_STATE_INVALID','A complete saved installation is required to publish its hook review.');
    return;
  }
  // Progress and native review both publish installation rows. Serialize their
  // read-modify-writes so a concurrent history update cannot undo a review.
  return withSessionLock('setup:publish:'+scopeKey(snapshot.scope),async()=>{
    const saved=readSetupState(snapshot.scope);
    if(hooks&&!saved)throw new CliError('SETUP_SCOPE_CHANGED','The installation was removed before its hook review could be sent.');
    const state=saved??snapshot;
    if(state.installationId!==snapshot.installationId||state.acceptedAt!==snapshot.acceptedAt)
      throw new CliError('SETUP_SCOPE_CHANGED','Setup changed before its observations could be sent.');
    if(hooks&&(scopeKey(hooks.scope)!==scopeKey(state.scope)||hooks.installationId!==state.installationId||
        hooks.recordingSelected!==(state.selections.forward.codex===true)))
      throw new CliError('SETUP_SCOPE_CHANGED','The hook review belongs to a different installation or recording choice.');
    return publishInstallation(state,fetcher,hooks);
  });
}

async function publishInstallation(state:SetupState,fetcher:typeof fetch,hooks?:HookReport){
  const authenticated=await readServerSetup(state.scope.api,fetcher);
  if(authenticated.scope.tenantId!==state.scope.tenantId||authenticated.scope.userId!==state.scope.userId)throw new CliError('SETUP_SCOPE_CHANGED','The authenticated setup destination changed. Saved observations were not sent.');
  const previousCodex=authenticated.installations.find(row=>row.installationId===state.installationId)?.clients.find(row=>row.client==='codex');
  let codexTrust:HookTrust='not_required';
  if(state.selections.forward.codex){
    const lastReport=previousCodex?.forward?previousCodex.hookTrust:undefined;
    codexTrust=hooks?observedTrust(hooks.review):lastReport??'unknown';
  }
  if(hooks?.onlyHooks){
    if(!previousCodex||previousCodex.forward!==hooks.recordingSelected)
      throw new CliError('SETUP_SCOPE_CHANGED','The server has a different recording choice for this installation.');
    // This path can run after a native approval while other clients are still
    // onboarding. Send only the existing Codex row with the new trust value.
    const {client,installed,pluginState,forward,history,historyProgress}=previousCodex;
    const row={client,installed,...(authenticated.pluginStateSupported?{pluginState}:{}),forward,history,historyProgress,hookTrust:codexTrust};
    return setupRequest(state.scope.api,'/api/setup/installation',{installationId:state.installationId,machine:state.machine,clients:[row]},fetcher);
  }
  const ids=new Set([...Object.keys(state.selections.plugins),...Object.keys(state.selections.forward),...Object.keys(state.selections.history)]);
  const clients=[...ids].map(client=>{
    const plugin=state.pluginResults?.find(result=>result.client===client),installed=state.pluginResults?.some(result=>result.client===client&&['installed','unchanged'].includes(result.status))??false;
    const pluginState=!state.selections.plugins[client]?'not_selected':installed?'installed':plugin?.status==='prepared'?'prepared':plugin?.status==='error'?'error':'pending';
    const job=state.historyJob,done=Boolean(job?.completedClients.includes(client)),running=job?.progress?.client===client;
    return {client,installed,...(authenticated.pluginStateSupported===true?{pluginState}:{}),forward:state.selections.forward[client]===true,history:state.selections.history[client]?'import':'skip',historyProgress:{state:!state.selections.history[client]?'not_started':done?'complete':job?.state==='failed'?'failed':job?.state==='running'||job?.state==='queued'?'running':'not_started',completed:done?job?.files.filter(file=>file.harness===client).length??0:running?job?.progress?.completed??0:0,...(done?{total:job?.files.filter(file=>file.harness===client).length??0}:running?{total:job?.progress?.total}:{}),...(job?.error?{error:job.error}:{})},hookTrust:client==='codex'?codexTrust:[ 'claude-code','cursor','antigravity','devin'].includes(client)?'not_required':'unknown'};
  });
  return setupRequest(state.scope.api,'/api/setup/installation',{installationId:state.installationId,machine:state.machine,clients},fetcher);
}
