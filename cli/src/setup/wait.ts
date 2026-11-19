import {CliError} from '../oauth.ts';
import {nextSetupAction} from './next.ts';
import type {SetupState} from './state.ts';
import type {SetupServerStatus} from './api.ts';

/** Bounded observation only: no choices, transcripts, or native MCP receipts are created. */
export async function waitForSetup(state:()=>SetupState,{read,verify,delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms)),attempts=15,skipCodexHooks=false}:{skipCodexHooks?:boolean;read:()=>Promise<SetupServerStatus>;verify:(installationId:string,client:string)=>Promise<unknown>;delay?:(ms:number)=>Promise<void>;attempts?:number}){
 const initial=state();
 for(let attempt=0;;attempt++){
  const current=state(),server=await read();
  if(current.installationId!==initial.installationId||server.scope.tenantId!==initial.scope.tenantId||server.scope.userId!==initial.scope.userId||current.scope.api!==initial.scope.api||current.scope.tenantId!==initial.scope.tenantId||current.scope.userId!==initial.scope.userId)throw new CliError('SETUP_SCOPE_CHANGED','The installation or account changed while waiting. No choices were changed.');
  const nextAction=nextSetupAction(current,server,skipCodexHooks);
  if(nextAction.kind!=='wait_capture'||attempt>=attempts)return {status:nextAction.kind==='wait_capture'?'pending':'next_action',scope:current.scope,installationId:current.installationId,selections:current.selections,nextAction};
  await verify(current.installationId!,nextAction.client);
  await delay(3000);
 }
}
