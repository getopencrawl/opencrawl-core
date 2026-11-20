import {pluginRelease} from './plugin-release.ts';
import {CliError} from '../oauth.ts';
import {selectGroup,type SetupClient,type SetupSelections} from './state.ts';

export const setupAvailabilityMessage='New setup is available for Claude Code, Codex, Antigravity, and Cursor on macOS. Existing installations can continue setup with their saved choices.';
export const newSetupClientAvailable=(client:string,platform:NodeJS.Platform=process.platform,registered=false)=>(platform==='darwin'||registered&&Boolean(pluginRelease.packages.find(entry=>entry.harness===client)?.archives?.[platform+'-'+process.arch]))&&['claude-code','codex','antigravity','cursor'].includes(client);

/** Saved true choices may continue; discovery and an environment flag are not consent. */
export function assertSetupAvailability(platform:NodeJS.Platform,values:Record<string,unknown>,saved?:SetupSelections,registered=false){
 if(platform!=='darwin'&&!saved&&!registered)throw new CliError('SETUP_NOT_AVAILABLE',setupAvailabilityMessage,2);
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
