// Recreate historical CLI-managed desktop installs for migration and repair tests.
import {homedir} from 'node:os';
import {join,posix,resolve} from 'node:path';
import {version} from '../../../src/distribution.ts';
import {setupCommandForSelf} from '../../../src/setup/invocation.ts';
import {pluginHookFiles as bindHooks,type PluginHookBinding} from '../../../src/setup/plugin-hooks.ts';
import {installSetupPlugins as installPrepared, type PluginClient,type PluginOptions} from '../../../src/setup/plugins.ts';
import {setupPluginIdentity,scopedPluginIdentity} from '../../../src/setup/plugin-identity.ts';
import {readme,devinGuide,devinManifest} from '../../../../plugins/opencrawl-sessions/assets.ts';
import desktopIcon from '../../../../plugins/opencrawl-sessions/shared/assets/icon.svg' with {type:'text'};
import {manifests as desktopManifests,codexIcon,cursorRule,hookAssets} from './assets.ts';
const manifests={...desktopManifests,devin:devinManifest};
const extraAssets={codexIcon,cursorRule,desktopIcon,readme,devinGuide};
const json=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
export type {PluginHookBinding};
export function pluginHookFiles(client:PluginClient,binding:PluginHookBinding,platform=process.platform){
  return bindHooks(client,binding,platform,client==='devin'?undefined:hookAssets);
}
type BundleOptions={command?:string[];configHome?:string;env?:NodeJS.ProcessEnv;recording?:boolean};
/** Bundled in the executable: native plugins own hooks, MCP and agent guidance. */
export function setupPluginFiles(client:PluginClient,api:string,options:BundleOptions={}):Record<string,string> {
  const identity=client==='devin'?scopedPluginIdentity(api):setupPluginIdentity(api),origin=identity.api,url=origin+'/mcp';
  const command=options.command??setupCommandForSelf(),configHome=(client==='devin'?posix: {resolve}).resolve(options.configHome??process.env.OPENCRAWL_CONFIG_HOME??process.env.XDG_CONFIG_HOME??join(homedir(),'.config'));
  const definition=manifests[client];
  const files:Record<string,string>={
    ...pluginHookFiles(client,{command,configHome,api:origin,pluginName:identity.name,env:options.env},client==='devin'?'linux':process.platform),
    [definition.path]:json({...definition.value,name:identity.name,version}),
    'README.md':extraAssets.readme,
  };
  if(client==='devin'){
    files['.mcp.json']=json({mcpServers:{[identity.name]:{command:'/bin/sh',args:['${PLUGIN_ROOT}/scripts/opencrawl-hook.sh','mcp']}}});
    files['.opencrawl-devin.json']=json({schemaVersion:1,api:origin,configHome,command,recording:options.recording===true});
    files['AGENTS.md']=extraAssets.devinGuide;
  }else{
    files['assets/icon.svg']=client==='codex'?extraAssets.codexIcon:extraAssets.desktopIcon;
    const file=client==='codex'||client==='claude-code'?'.mcp.json':client==='antigravity'?'mcp_config.json':'mcp.json';
    files[file]=json({mcpServers:{[client==='codex'?identity.name:'opencrawl']:{...(client==='codex'||client==='claude-code'?{type:'http'}:{}),url}}});
  }
  if(client==='cursor')files['rules/opencrawl.mdc']=extraAssets.cursorRule;
  return files;
}

export async function installSetupPlugins(api:string,selected:string[],options:PluginOptions={}) {
  const bundles={...options.bundles};
  for(const client of selected as PluginClient[]) {
    if(client==='devin'||bundles[client])continue;
    const env=options.env??process.env;
    const configHome=resolve(env.OPENCRAWL_CONFIG_HOME||env.XDG_CONFIG_HOME||join(options.home??homedir(),'.config'));
    bundles[client]={files:setupPluginFiles(client,api,{...options,configHome})};
  }
  return installPrepared(api,selected,{applicationDirs:[],...options,bundles});
}
