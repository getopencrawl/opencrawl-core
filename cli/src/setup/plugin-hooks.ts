import {homedir} from 'node:os';
import {posix,win32} from 'node:path';
import {apiOrigin,CliError} from '../oauth.ts';
import {hookAssets,sharedAssets} from '../../../plugins/opencrawl-sessions/assets.ts';
import type {PluginClient} from './plugins.ts';

export type PluginHookBinding={command:string[];configHome:string;api:string;pluginName:string;env?:NodeJS.ProcessEnv};
/** Install reviewed canonical assets unchanged. Only non-executable binding
 * data varies with a deployment/profile; no hook or runner source is generated. */
export function pluginHookFiles(client:PluginClient,binding:PluginHookBinding,platform=process.platform):Record<string,string>{
  if(client==='devin'&&platform!=='linux')throw new CliError('INVALID_PLUGIN_BINDING','Devin Cloud requires Linux.');
  const windows=platform==='win32',path=windows?win32:posix;
  const {command,configHome,pluginName}=binding,api=apiOrigin(binding.api);
  if(!command.length||command.length>16||!path.isAbsolute(command[0]!)||!path.isAbsolute(configHome)||!/^opencrawl(?:-[a-z0-9]+)?$/.test(pluginName)
    ||[...command,configHome,pluginName,api].some(value=>value.length>4096||/[\x00-\x1f\x7f]/.test(value)||windows&&value.includes('"')))
    throw new CliError('INVALID_PLUGIN_BINDING','Use absolute native command/profile paths and a valid plugin name.');
  const env=binding.env??process.env;
  // Cloud exports are prepared on another machine. Existing native runners
  // validate both fields even though Devin uses its own runtime environment.
  const directories=client==='devin'
    ? {dataHome:posix.join(configHome,'data'),cacheHome:posix.join(configHome,'cache')}
    : {dataHome:path.resolve(env.XDG_DATA_HOME??path.join(homedir(),'.local','share')),
      cacheHome:path.resolve(env.XDG_CACHE_HOME??path.join(homedir(),'.cache'))};
  const data={schemaVersion:1,api,client,pluginName,configHome,command,...directories};
  return {...sharedAssets,...hookAssets[client+':'+(windows?'win32':'linux')],
    '.opencrawl-binding.json':JSON.stringify(data,null,2)+'\n','.opencrawl-command':command.join('\n')+'\n'};
}
