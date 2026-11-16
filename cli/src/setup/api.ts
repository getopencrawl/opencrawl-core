import {CliError,jsonRequest} from '../oauth.ts';
import {accessToken} from '../session.ts';
import {configuredToken,workspaceIdentityEnabled} from '../workspace-identity.ts';
import type {SetupHumanTask,SetupScope,SetupState} from './state.ts';
export type SetupServerStatus={scope:{tenantId:string;userId:string};pluginStateSupported?:boolean;firstWin:unknown;installations:{installationId:string;clients:{client:string;installed?:boolean;captureObservedAt?:string;mcp?:{state:string};proof?:{state:string};humanTasks:SetupHumanTask[]}[]}[]};
export async function setupRequest(api:string,path:string,input?:unknown,fetcher=fetch):Promise<unknown>{
  const configured=await configuredToken('OPENCRAWL_TOKEN',api);let token=configured||await accessToken(api,undefined,fetcher);
  const send=()=>jsonRequest(api+path,{method:input===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,...(input===undefined?{}:{'content-type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)}),signal:AbortSignal.timeout(30000)},fetcher);
  let result=await send();
  if(result.response.status===401&&(!configured||workspaceIdentityEnabled())){token=await configuredToken('OPENCRAWL_TOKEN',api,token)||await accessToken(api,token,fetcher);result=await send();}
  if(result.response.status===401)throw new CliError('AUTH_REQUIRED',workspaceIdentityEnabled()?'The cloud identity could not be verified. Repair its provider helper and organization connection; do not use a human sign-in.':'Sign in with opencrawl login before setup.',2);
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
export async function publishSetup(state:SetupState,fetcher=fetch){
  if(!state.installationId||!state.machine)return;
  const authenticated=await readServerSetup(state.scope.api,fetcher);
  if(authenticated.scope.tenantId!==state.scope.tenantId||authenticated.scope.userId!==state.scope.userId)throw new CliError('SETUP_SCOPE_CHANGED','The authenticated setup destination changed. Saved observations were not sent.');
  const ids=new Set([...Object.keys(state.selections.plugins),...Object.keys(state.selections.forward),...Object.keys(state.selections.history)]);
  const clients=[...ids].map(client=>{
    const plugin=state.pluginResults?.find(result=>result.client===client),installed=state.pluginResults?.some(result=>result.client===client&&['installed','unchanged'].includes(result.status))??false;
    const pluginState=!state.selections.plugins[client]?'not_selected':installed?'installed':plugin?.status==='prepared'?'prepared':plugin?.status==='error'?'error':'pending';
    const job=state.historyJob,done=Boolean(job?.completedClients.includes(client)),running=job?.progress?.client===client;
    return {client,installed,...(authenticated.pluginStateSupported===true?{pluginState}:{}),forward:state.selections.forward[client]===true,history:state.selections.history[client]?'import':'skip',historyProgress:{state:!state.selections.history[client]?'not_started':done?'complete':job?.state==='failed'?'failed':job?.state==='running'||job?.state==='queued'?'running':'not_started',completed:done?job?.files.filter(file=>file.harness===client).length??0:running?job?.progress?.completed??0:0,...(done?{total:job?.files.filter(file=>file.harness===client).length??0}:running?{total:job?.progress?.total}:{}),...(job?.error?{error:job.error}:{})},hookTrust:client==='codex'&&(state.selections.plugins[client]||state.selections.forward[client])?'pending':[ 'claude-code','cursor','antigravity','devin'].includes(client)?'not_required':'unknown'};
  });
  return setupRequest(state.scope.api,'/api/setup/installation',{installationId:state.installationId,machine:state.machine,clients},fetcher);
}
