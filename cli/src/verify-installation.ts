import {CliError,jsonRequest} from './oauth.ts';
import {accessToken} from './session.ts';
import {configuredToken,workspaceIdentityEnabled} from './workspace-identity.ts';
import type {SetupClientStatus} from '../../src/setup/types.mjs';

const clients=['claude-code','codex','cursor','grok-bot','antigravity','claude-desktop','chatgpt'];
export interface VerifyInstallationInput {installationId:string;client:string;revision?:string}
/** Starts or checks one server-issued proof. Never edits hooks, creates native
 * transcript files, uploads synthetic events, or treats CLI login as MCP auth. */
export async function verifyInstallation(api:string,input:VerifyInstallationInput,fetcher=fetch):Promise<SetupClientStatus> {
  if(!/^[A-Za-z0-9_.:-]{1,200}$/.test(input.installationId)||!clients.includes(input.client)||input.revision!==undefined&&!/^[a-f0-9]{64}$/.test(input.revision)||Object.keys(input).some(key=>!['installationId','client','revision'].includes(key)))throw new CliError('INVALID_USAGE','Use verify-installation --installation-id ID --client CLIENT.',64);
  const configured=await configuredToken('OPENCRAWL_TOKEN',api);
  let token=configured||await accessToken(api,undefined,fetcher);
  const send=()=>jsonRequest(`${api}/api/setup/verify`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(70_000)},fetcher);
  let result=await send();
  if(result.response.status===401&&(!configured||workspaceIdentityEnabled())){token=await configuredToken('OPENCRAWL_TOKEN',api,token)||await accessToken(api,token,fetcher);result=await send();}
  const status=result.response.status;
  if(status===401)throw new CliError('AUTH_REQUIRED','Sign in to this deployment with opencrawl login, then verify this installation.',2);
  if(status===403)throw new CliError('SETUP_FORBIDDEN','This credential cannot verify installation in the selected workspace.',2);
  if(status===404)throw new CliError('SETUP_NOT_FOUND','Apply setup for this installation and client before verifying.',2);
  if(status===409)throw new CliError('SETUP_CHANGED','Setup changed while verifying. Check setup status and retry this client.',2);
  if(status===400)throw new CliError('INVALID_USAGE','Choose the installation ID and client from opencrawl setup status.',64);
  if(!result.response.ok)throw new CliError('SETUP_UNAVAILABLE','Installation verification is temporarily unavailable. Capture and history can continue independently.');
  const data=result.body.data;
  if(result.body.schemaVersion!==1||input.revision!==undefined&&data?.proof?.revision!==input.revision||data?.client!==input.client||typeof data.installed!=='boolean'||typeof data.forward!=='boolean'||!['not_selected','pending','waiting_capture','waiting_index','verified','expired'].includes(data.proof?.state)||!['pending','observed','authenticated'].includes(data.mcp?.state)||!Array.isArray(data.humanTasks)||
    data.proof.state==='verified'&&![data.proof.id,data.proof.sessionId,data.proof.eventId,data.proof.passageId,data.proof.verifiedAt].every(value=>typeof value==='string'&&value.length>0))throw new CliError('INVALID_RESPONSE','The service returned an invalid installation proof.');
  return data as SetupClientStatus;
}
export function formatInstallationVerification(data:SetupClientStatus):string {
  const proof=data.proof;
  return [proof.state==='verified'?`A new ${data.client} session is searchable (${proof.sessionId}).`:`${data.client}: ${proof.state.replaceAll('_',' ')}.`,
    data.mcp.state==='observed'?'MCP: authenticated call observed; native client capture not yet bound.':`MCP: ${data.mcp.state}.`,
    ...data.humanTasks.map(task=>task.instruction),
    proof.id?`Proof ID: ${proof.id}`:'',
    'Each other client keeps its own status; this result does not verify another client or history import.'].filter(Boolean).join('\n');
}
