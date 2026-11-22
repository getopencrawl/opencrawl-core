import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {atomicJson,configDir,withSessionLock} from '../session.ts';
import {CliError} from '../oauth.ts';
import type {CaptureMode} from './published-plugins.ts';
import type {PluginResult} from './plugins.ts';
import type {HistoryFile} from '../capture/backfill.ts';

export type SetupScope={api:string;tenantId:string;userId:string};
export type SetupHumanTask={id:string;kind:'mcp_auth'|'hook_trust'|'restart'|'login'|'workspace'|'new_session'|'plugin_install';client?:string;title:string;instruction:string;url?:string};
export type SetupSelections={plugins:Record<string,boolean>;forward:Record<string,boolean>;history:Record<string,boolean>};
export type SetupClient={id:string;label:string;detected:boolean;plugin:boolean;forward:boolean;history:boolean;historyFiles:number;historyBytes:number};
export type HistoryJob={id:string;clients:string[];files:HistoryFile[];state:'queued'|'running'|'complete'|'failed'|'paused';completedClients:string[];createdAt:string;updatedAt:string;progress?:{client:string;completed:number;total:number;uploaded:number};error?:string;pid?:number};
export type SetupWorker={kind:string;status?:string;supervised:boolean;harnesses:string[];startup:boolean;command?:string[];environment?:Record<string,string>;reason?:string};
export type SetupState={schemaVersion:1;pluginAutoUpdates?:{installationId:string;clients:string[]};firstRun?:'choosing'|'ready'|'complete';scope:SetupScope;selections:SetupSelections;captureMode?:CaptureMode;acceptedAt:string;installationId?:string;machine?:{id:string;label:string};historyJob?:HistoryJob;worker?:SetupWorker;pluginResults?:{client:string;status:string;message?:string;preparedAt?:string;captureAvailable?:boolean;daemonHandoff?:boolean;source?:PluginResult['source']}[];humanTasks?:SetupHumanTask[]};
export const historyBenefit='Import past sessions so your agents can find previous decisions, fixes, and context.';
export const scopeKey=(scope:SetupScope)=>createHash('sha256').update(JSON.stringify([scope.api,scope.tenantId,scope.userId])).digest('hex');
export const setupRoot=()=>join(configDir(),'setup');
export function statePath(key:string){if(!/^[a-f0-9]{64}$/.test(key))throw new CliError('SETUP_SCOPE_INVALID','Invalid setup scope.');return join(setupRoot(),key+'.json');}
export function readStateKey(key:string):SetupState|null {
  let value:SetupState & {checkpoint?:unknown};
  try{value=JSON.parse(readFileSync(statePath(key),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw new CliError('SETUP_STATE_INVALID','Saved setup choices could not be read. Preserve this file and repair it before continuing.');}
  if(value.captureMode!==undefined&&!['hook','daemon'].includes(value.captureMode)||value.schemaVersion!==1||!value.scope?.api||!value.scope.tenantId||!value.scope.userId||scopeKey(value.scope)!==key||!value.selections||!['plugins','forward','history'].every(k=>{const group=value.selections[k as keyof SetupSelections];return group&&typeof group==='object'&&!Array.isArray(group)&&Object.values(group).every(v=>typeof v==='boolean');}))throw new CliError('SETUP_STATE_INVALID','Saved setup scope or choices are invalid; no changes were made.');
  // Older versions stored TUI navigation here. Discard it on the next state write.
  delete value.checkpoint;
  return value;
}
/** This grant is local to one enrolled installation. Older setups have no grant. */
export function automaticUpdateClients(state:SetupState|null):string[] {
  const grant=state?.pluginAutoUpdates;
  if(!state?.installationId||grant?.installationId!==state.installationId||!Array.isArray(grant.clients))return [];
  return [...new Set(grant.clients.filter(client=>typeof client==='string'&&['claude-code','codex','cursor','antigravity'].includes(client)&&state.selections.plugins[client]===true))].sort();
}
export const readSetupState=(scope:SetupScope)=>readStateKey(scopeKey(scope));
export async function updateSetupState(scope:SetupScope,change:(previous:SetupState|null)=>SetupState){
  const key=scopeKey(scope);
  return withSessionLock('setup:'+key,async()=>{
    const next=change(readStateKey(key));
    if(scopeKey(next.scope)!==key)throw new CliError('SETUP_SCOPE_CHANGED','Setup scope changed.');
    if(next.pluginAutoUpdates){
      const clients=automaticUpdateClients(next);
      if(next.installationId&&clients.length)next.pluginAutoUpdates={installationId:next.installationId,clients};
      else delete next.pluginAutoUpdates;
    }
    atomicJson(statePath(key),next);
    return next;
  });
}
/** Missing clients may default on; a saved false is never treated as missing. */
export function defaultSelections(clients:SetupClient[],previous?:SetupSelections,legacyForward?:string[]):SetupSelections {
  const result:SetupSelections={plugins:{...previous?.plugins},forward:{...previous?.forward},history:{...previous?.history}};
  for(const client of clients)for(const group of ['plugins','forward','history'] as const){
    const supported=group==='plugins'?client.plugin:client[group];
    if(result[group][client.id]===undefined)result[group][client.id]=supported&&(group==='history'?false:group==='forward'&&legacyForward!==undefined?legacyForward.includes(client.id):client.detected);
  }
  return result;
}
export function chosen(selections:SetupSelections,group:keyof SetupSelections){return Object.keys(selections[group]).filter(id=>selections[group][id]).sort();}
export function selectGroup(value:string|undefined,group:keyof SetupSelections,clients:SetupClient[],current:SetupSelections):Record<string,boolean>{
  if(value===undefined)return {...current[group]};
  const supported=(client:SetupClient)=>group==='plugins'?client.plugin:client[group];
  const ids=value==='all'?clients.filter(c=>supported(c)&&(group==='history'?c.historyFiles>0:c.detected)).map(c=>c.id):value==='none'?[]:value.split(',').filter(Boolean);
  if(value!== 'none'&&!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!clients.some(c=>c.id===id&&supported(c))))throw new CliError('INVALID_USAGE','Unsupported '+group+' selection. Use the client IDs from opencrawl setup --json, all, or none.',64);
  const result={...current[group]};for(const c of clients)result[c.id]=ids.includes(c.id);return result;
}
export function selectionDigest(scope:SetupScope,selections:SetupSelections){return createHash('sha256').update(JSON.stringify([scope.api,scope.tenantId,scope.userId,...(['plugins','forward','history'] as const).map(g=>chosen(selections,g))])).digest('hex');}
