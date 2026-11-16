import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {randomUUID} from 'node:crypto';
import {atomicJson,withSessionLock} from '../session.ts';
import {captureDir,readCaptureConfig,captureDaemonEnabled,type CaptureConfig} from './runtime.ts';
import {installCaptureDaemon,uninstallCaptureDaemon} from './daemon-service.ts';
import {bootstrapFile,waitForDaemonReady,cancelDaemonBootstrap,type DaemonBootstrap} from './daemon-bootstrap.ts';

type Installer=(candidate:CaptureConfig,before:CaptureConfig)=>Promise<{supervised:boolean}>;
export type DaemonUpgradeResult={state:'not-selected'|'already-enabled'|'busy'|'activated'|'fallback';reason?:string};

/** Bootstrap first, then atomically switch ingress. Failed service installation,
 * readiness, or legacy-worker contention leaves the proven collector selected.
 * This function is run by a background command, never awaited by native hooks. */
export async function upgradeCaptureDaemon({install=(candidate,before)=>installCaptureDaemon(candidate,{expectedConfig:before}),ready=waitForDaemonReady,cleanup=()=>uninstallCaptureDaemon(),command}: {
  install?:Installer;ready?:(stage:DaemonBootstrap)=>Promise<boolean>;cleanup?:()=>void;command?:string[];
}={}):Promise<DaemonUpgradeResult> {
  const before=readCaptureConfig();
  if(!before||before.authPending||(!before.daemonRequested&&(before.disabled||before.harnesses?.length===0||before.hookOwnership==='plugin')))return {state:'not-selected'};
  if(captureDaemonEnabled(before))return {state:'already-enabled'};
  try{return await withSessionLock('capture:daemon-upgrade',async()=>{
    if(!isDeepStrictEqual(readCaptureConfig(),before))return {state:'busy'};
    const stage:DaemonBootstrap={id:randomUUID(),expiresAt:Date.now()+30_000,before,candidate:{...before,harnesses:before.harnesses??['claude-code','codex'],captureWorker:'daemon-v1',...(command?{command}:{})}};
    if(before.daemonRequested){stage.candidate.backgroundStartup=before.daemonRequested.backgroundStartup;delete stage.candidate.daemonRequested;}
    atomicJson(bootstrapFile(),stage);
    let activated=false;
    const serviceFile=join(captureDir(),'daemon','service.json');
    const priorService=existsSync(serviceFile)?readFileSync(serviceFile,'utf8'):null;
    try{
      const service=await install(stage.candidate,before);
      if(!service.supervised)return {state:'fallback',reason:'supervision-unavailable'};
      if(!await ready(stage))return {state:'fallback',reason:'readiness-unconfirmed'};
      return await withSessionLock('capture:worker',()=>withSessionLock('capture:configuration',async()=>{
        if(!isDeepStrictEqual(readCaptureConfig(),before))return {state:'busy'};
        // This binding permits the daemon to recover only pending old-hook
        // notices, including an old process finishing after this atomic switch.
        atomicJson(join(captureDir(),'daemon','legacy-handoff.json'),stage.candidate);
        atomicJson(join(captureDir(),'config.json'),stage.candidate);
        activated=true;return {state:'activated'};
      },0),0);
    }catch(error){
      if(error&&typeof error==='object'&&'code' in error&&error.code==='SESSION_BUSY')return {state:'busy'};
      return {state:'fallback',reason:'bootstrap-failed'};
    }finally{
      if(!activated){
        cancelDaemonBootstrap(stage.id);
        // Only undo service state changed by this attempt. Ownership validation
        // in the service remover remains mandatory; failed removal never flips
        // capture mode or destroys queued data.
        if(isDeepStrictEqual(readCaptureConfig(),before)&&existsSync(serviceFile)&&readFileSync(serviceFile,'utf8')!==priorService)try{cleanup();}catch{}
      }
    }
  },0);}catch(error){
    if(error&&typeof error==='object'&&'code' in error&&error.code==='SESSION_BUSY')return {state:'busy'};
    throw error;
  }
}
