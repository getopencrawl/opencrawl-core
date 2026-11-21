import {pluginRelease} from './plugin-release.ts';
import {CliError} from '../oauth.ts';
import {selectGroup,type SetupClient,type SetupSelections} from './state.ts';

export const setupAvailabilityMessage='Guided setup supports Claude Code, Codex, Antigravity, and Cursor on macOS and Linux (glibc, x64 or ARM64). Existing installations can continue with their saved choices.';
const personalSetupAvailable=(platform:NodeJS.Platform)=>platform==='darwin'||(platform==='linux'&&['x64','arm64'].includes(process.arch));
export function newSetupClientAvailable(client:string,platform:NodeJS.Platform=process.platform,registered=false){
 const release=pluginRelease.packages.find(entry=>entry.harness===client);
 if(!release)return false;
 if(platform==='darwin')return true;
 return (personalSetupAvailable(platform)||registered)&&Boolean(release.archives?.[platform+'-'+process.arch]);
}

/** Saved true choices may continue; discovery and an environment flag are not consent. */
export function assertSetupAvailability(platform:NodeJS.Platform,values:Record<string,unknown>,saved?:SetupSelections,registered=false){
 if(!personalSetupAvailable(platform)&&!saved&&!registered)throw new CliError('SETUP_NOT_AVAILABLE',setupAvailabilityMessage,2);
 for(const group of ['plugins','forward','history'] as const){
  const value=values[group];if(value===undefined||value==='all'||value==='none')continue;
  if(typeof value!=='string')throw new CliError('INVALID_USAGE','Expected comma-separated setup client IDs.',64);
  for(const id of value.split(',').filter(Boolean))if(!newSetupClientAvailable(id,platform,registered)&&saved?.[group][id]!==true)throw new CliError('SETUP_CLIENT_NOT_AVAILABLE',`${id} is not available for new ${group} selection. ${setupAvailabilityMessage}`,2);
 }
}

/** all/default applies to current offers; explicit lists/none may opt out of saved clients. */
export function selectOfferedGroup(value:string|undefined,group:keyof SetupSelections,clients:SetupClient[],current:SetupSelections,saved?:SetupSelections):Record<string,boolean>{
 if(value===undefined)return {...current[group]};
 if(value==='all')return clients.length?selectGroup(value,group,clients,current):{...current[group]};
 const retained=Object.keys(saved?.[group]??{}).filter(id=>saved?.[group][id]&&!clients.some(c=>c.id===id)).map(id=>({id,label:id,detected:true,plugin:group==='plugins',forward:group==='forward',history:group==='history',historyFiles:0,historyBytes:0}));
 const result=selectGroup(value,group,[...clients,...retained],current);
 if(value==='none')for(const id of Object.keys(result))result[id]=false;
 return result;
}
