import {CliError} from '../oauth.ts';
import {captureDaemonEnabled,type CaptureConfig} from '../capture/runtime.ts';
import {packageRelease,type CaptureMode} from './published-plugins.ts';
import type {SetupState} from './state.ts';
import {realpathSync} from 'node:fs';
import {posix} from 'node:path';

/** Scope and native-service eligibility stay separate from package availability. */
export function daemonEligibility(clients:string[],platform:NodeJS.Platform=process.platform,env:NodeJS.ProcessEnv=process.env,capabilities:(client:string)=>{daemonHandoff:boolean;captureAvailable:boolean}|undefined=packageRelease){
 if(platform!=='darwin'||env.OPENCRAWL_AUTH||env.CLAUDE_CODE_REMOTE==='true'||env.SSH_CONNECTION)return {eligible:false,reason:'Background capture is available on a local Mac.'};
 if(!clients.length)return {eligible:false,reason:'Select an agent to record first.'};
 if(clients.some(client=>!capabilities(client)?.daemonHandoff||!capabilities(client)?.captureAvailable))return {eligible:false,reason:'Background capture is not available for these plugin versions yet.'};
 return {eligible:true,reason:'Retry uploads in the background, including after your agent closes.'};
}
/** A failed launch is evidence of missing readiness, not proof of a privacy denial. */
export function daemonStartupGuidance(paths:string[],platform:NodeJS.Platform=process.platform){
 const mounted=platform==='darwin'&&paths.filter(posix.isAbsolute).some(path=>{
  let actual=posix.resolve(path);if(process.platform==='darwin'){try{actual=realpathSync(path);}catch{}}
  return /^\/Volumes\/[^/]+(?:\/|$)/.test(actual);
 });
 return 'Background service startup was not confirmed. Recording is not verified.'+(mounted?' This installation uses a mounted volume; macOS background access may differ from terminal access.':'')+' Fix the host-service issue and retry. Your queued uploads are kept.';
}
export function savedCaptureMode(state:SetupState|null,config:CaptureConfig|null):CaptureMode{
 if(state?.captureMode)return state.captureMode;
 return config&&(captureDaemonEnabled(config)||config.daemonRequested||config.backgroundStartup)?'daemon':'hook';
}
export function requestedCaptureMode(value:unknown,fallback:CaptureMode):CaptureMode{
 if(value===undefined)return fallback;
 if(value!=='hook'&&value!=='daemon')throw new CliError('INVALID_USAGE','Use --capture-mode hook or --capture-mode daemon.',64);
 return value;
}
