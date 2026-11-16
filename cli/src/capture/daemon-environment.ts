import {CliError} from '../oauth.ts';
import {isAbsolute,delimiter} from 'node:path';
import {workspaceIdentityEnabled} from '../workspace-identity.ts';

export function validWorkerPath(value:string){return value.length<=16384&&value.split(delimiter).every(part=>isAbsolute(part)&&!/[\x00-\x1f\x7f]/.test(part));}

/** OS supervisors can start the executable directly without a resident shell
 * just to set its profile. Workload mode and its helper search path are public
 * launch settings; tokens and provider credential locations are never accepted. */
export function applyDaemonEnvironment(args:string[]) {
  const index=args.findIndex(arg=>arg==='--worker-environment'||arg.startsWith('--worker-environment='));
  if(index<0)return;
  if(args[0]!=='collect'||args[1]!=='daemon')throw new CliError('INVALID_USAGE','Worker environment applies only to collect daemon.',64);
  const value=args[index]!.includes('=')?args[index]!.slice('--worker-environment='.length):args[index+1];
  let environment:unknown;try{if(!value||value.length>32768)throw Error();environment=JSON.parse(value);}catch{throw new CliError('INVALID_USAGE','Invalid worker environment.',64);}
  if(!environment||typeof environment!=='object'||Array.isArray(environment)||Object.entries(environment).some(([key,value])=>!['OPENCRAWL_CONFIG_HOME','OPENCRAWL_NO_UPDATE','XDG_CACHE_HOME','XDG_DATA_HOME','OPENCRAWL_AUTH','PATH'].includes(key)||typeof value!=='string'||value.includes('\0')))
    throw new CliError('INVALID_USAGE','Invalid worker environment.',64);
  const settings=environment as Record<string,string>;
  if(settings.OPENCRAWL_AUTH!==undefined){
    if(!settings.OPENCRAWL_AUTH||process.env.OPENCRAWL_AUTH&&process.env.OPENCRAWL_AUTH!==settings.OPENCRAWL_AUTH)throw new CliError('INVALID_AUTH_MODE','The worker workload mode does not match its launch environment.',64);
    workspaceIdentityEnabled({...process.env,...settings});
  }
  if(settings.PATH!==undefined&&(!settings.OPENCRAWL_AUTH||!validWorkerPath(settings.PATH)))throw new CliError('INVALID_USAGE','A workload worker needs an absolute helper search path.',64);
  if(Object.entries(settings).some(([key,value])=>!['OPENCRAWL_NO_UPDATE','OPENCRAWL_AUTH','PATH'].includes(key)&&!isAbsolute(value)))throw new CliError('INVALID_USAGE','Worker directories must be absolute paths.',64);
  Object.assign(process.env,environment);process.env.OPENCRAWL_NO_UPDATE='1';
}
