import {readFileSync,lstatSync} from 'node:fs';
import {join,isAbsolute,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {apiOrigin} from '../oauth.ts';
import {object} from '../context-check-events.ts';
import {verifyPluginBundle,pluginHookContext,type PluginHookClient} from './plugin-context.ts';

/** Canonical plugins carry code; installation supplies explicit data. Validate
 * that installation before opening transcripts or accessing its credentials. */
export function pluginInvocation(args:string[]):string[]{
  const {values,positionals}=parseArgs({args,options:{root:{type:'string'},action:{type:'string'}},allowPositionals:false});
  if(positionals.length||!values.root||!isAbsolute(values.root)||!values.action)throw Error('Invalid plugin invocation');
  const root=resolve(values.root),file=join(root,'.opencrawl-binding.json'),stat=lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw Error('Invalid plugin binding');
  const data:unknown=JSON.parse(readFileSync(file,'utf8'));
  if(!object(data)||data.schemaVersion!==1||typeof data.api!=='string'||typeof data.client!=='string'||typeof data.pluginName!=='string'||typeof data.configHome!=='string'||!isAbsolute(data.configHome)
    ||typeof data.dataHome!=='string'||!isAbsolute(data.dataHome)||typeof data.cacheHome!=='string'||!isAbsolute(data.cacheHome))throw Error('Invalid plugin binding');
  const client=data.client as PluginHookClient,api=apiOrigin(data.api);
  const binding={client,api,pluginName:data.pluginName,configHome:data.configHome,nativeRoot:root};
  verifyPluginBundle(binding);
  if(client==='devin'&&(process.env.OPENCRAWL_TOKEN||process.env.OPENCRAWL_SESSIONS_TOKEN||process.env.OPENCRAWL_AUTH&&process.env.OPENCRAWL_AUTH!=='devin-cloud'))throw Error('Invalid workload binding');
  for(const key of ['OPENCRAWL_TOKEN','OPENCRAWL_SESSIONS_TOKEN','OPENCRAWL_AUTH','OPENCRAWL_API_URL'])delete process.env[key];
  Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:data.configHome,OPENCRAWL_PLUGIN_API:api,OPENCRAWL_PLUGIN_CLIENT:client,OPENCRAWL_PLUGIN_NAME:data.pluginName,OPENCRAWL_PLUGIN_ROOT:root,
    ...(client==='devin'?{OPENCRAWL_AUTH:'devin-cloud',PATH:'/usr/local/bin:/usr/bin:/bin'}:{XDG_DATA_HOME:data.dataHome,XDG_CACHE_HOME:data.cacheHome})});
  const action=values.action;
  if(client!=='devin'||action!=='workload')pluginHookContext(api,client);
  const scope=['--harness',client,'--api',api];
  if(action==='start'||action==='start-after-tool')return ['session','start',...scope,...(action==='start-after-tool'?['--after-tool']:[])];
  if(action==='privacy')return ['privacy-hook',...scope];
  if(action==='search')return ['search-context',...scope];
  if(action==='suggest')return ['context-suggestions','hook',...scope];
  if(action==='capture')return ['collect','hook',...scope];
  if(client==='antigravity'&&/^capture-(SessionStart|PostToolUse|PostInvocation|Stop)$/.test(action))return ['collect','hook',...scope,'--event',action.slice(8)];
  if(client==='devin'&&action==='workload')return ['workload','start','--api',api];
  if(client==='devin'&&action==='inbox')return ['workload','inbox','--api',api];
  if(client==='devin'&&action==='mcp')return ['mcp','--api',api];
  throw Error('Unsupported plugin action');
}
