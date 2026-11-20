import type {Readable} from 'node:stream';
import {parseArgs} from 'node:util';
import {prepareDevinRecording} from './workload-events.ts';
import {isAbsolute,posix} from 'node:path';
import {apiOrigin,CliError} from './oauth.ts';
import {withEnvironmentTokenOrigin} from './environment-token.ts';
import {readStartEvent} from './session-start.ts';
import {writeDevinPlugin} from './setup/plugins.ts';
import {startDevinPlugin} from './setup/devin-plugin.ts';

/** Native Cloud bundle/startup entry points share ordinary setup and capture.
 * They never create a human sign-in or put a capability in a distribution. */
export async function workloadPluginCommand(args:string[],input:Readable=process.stdin):Promise<number>{
 const startup=args[0]==='start';
 try{
  const {positionals,values}=parseArgs({args,allowPositionals:true,options:{api:{type:'string'},directory:{type:'string'},command:{type:'string'},'config-home':{type:'string'},recording:{type:'string'},organization:{type:'string'},'key-stdin':{type:'boolean'},'one-session':{type:'boolean'},json:{type:'boolean'}}});
  if(positionals.length!==1||!['start','bundle'].includes(positionals[0]!)||!values.api)throw new CliError('INVALID_USAGE','Use workload bundle or the Cloud plugin’s native startup hook with an explicit --api.',64);
  const api=apiOrigin(values.api);
  if(startup){
   if(Object.keys(values).some(key=>key!=='api'))throw new CliError('INVALID_USAGE','Cloud startup accepts only --api and native hook input.',64);
   const event=await readStartEvent(input);
   const result=await withEnvironmentTokenOrigin(api,()=>startDevinPlugin(api,event));
   process.stdout.write(JSON.stringify(result)+'\n');return 0;
  }
  if(!values.directory||!values.command||!values['config-home']||!['on','off'].includes(values.recording??''))throw new CliError('INVALID_USAGE','Use workload bundle --api ORIGIN --directory PATH --command LINUX_EXECUTABLE --config-home CLOUD_PROFILE --recording on|off [--json].',64);
  const recording=values.recording==='on';
  if (!isAbsolute(values.directory)||!posix.isAbsolute(values.command)||!posix.isAbsolute(values['config-home'])) throw new CliError('INVALID_PLUGIN_BINDING','Supply an absolute bundle directory, Linux command and Cloud configuration home.');
  if (recording) await prepareDevinRecording(api,values.organization,Boolean(values['one-session']),values['key-stdin']?input:undefined);
  else if (values.organization!==undefined||values['key-stdin']||values['one-session']) throw new CliError('INVALID_USAGE','Devin credential and organization options apply only with --recording on.');
  const result=writeDevinPlugin(values.directory,api,{command:[values.command],configHome:values['config-home'],recording});
  process.stdout.write(values.json?JSON.stringify({schemaVersion:1,data:result})+'\n':`Prepared ${result.pluginName} in ${result.directory}. Install its reviewed contents in Devin Cloud; this is not native activation or capture proof.\n`);return 0;
 }catch(error){
  const known=error instanceof CliError,code=known?error.code:'DEVIN_SETUP_UNAVAILABLE';
  if(startup){
   process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:`OpenCrawl Cloud setup is pending (${code}). Preserve this installation and read its opencrawl-setup skill. Repair the provider helper or organization connection and resume this same Cloud session. Do not copy a human token, start interactive login, or claim first-turn capture.`}})+'\n');return 0;
  }
  const message=known?error.message:'The Cloud plugin bundle could not be prepared.';
  if(args.includes('--json'))process.stdout.write(JSON.stringify({schemaVersion:1,error:{code,message}})+'\n');else process.stderr.write(message+'\n');
  return known?error.exitCode:2;
 }
}
