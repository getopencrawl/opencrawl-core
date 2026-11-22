import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {read} from '../distribution.ts';
import {CliError} from '../oauth.ts';
import {sessionFile,withSessionLock} from '../session.ts';
import {captureDir,captureDaemonEnabled,readCaptureConfig,type CaptureConfig} from '../capture/runtime.ts';
import {installCaptureDaemon,ensureCaptureDaemon} from '../capture/daemon-service.ts';
import {upgradeCaptureDaemon} from '../capture/daemon-upgrade.ts';
import {isDeepStrictEqual} from 'node:util';

async function live(){
  const status=read(join(captureDir(),'daemon','status.json'));
  if(status?.state!=='running'||!Number.isInteger(status.pid)||status.pid<=0)return false;
  try{
    if(readFileSync(sessionFile('capture:daemon')+'.lock','utf8')!==String(status.pid))return false;
    process.kill(status.pid,0);
  }catch{return false;}
  try{await withSessionLock('capture:daemon',async()=>{},0);return false;}
  catch(error){if(error instanceof CliError&&error.code==='SESSION_BUSY')return true;throw error;}
}
export async function doctorWorker(config:CaptureConfig,repairs:string[]){
  if(!captureDaemonEnabled(config)){
    if(!config.daemonRequested)return 'unconfigured';
    const outcome=await upgradeCaptureDaemon();
    if(outcome.state==='busy')return 'starting';
    if(outcome.state!=='activated')return 'unconfigured';
    repairs.push('activated_capture_worker');
    const current=readCaptureConfig();
    if(!current||current.installationId!==config.installationId||current.api!==config.api||!isDeepStrictEqual(current.owner,config.owner))return 'starting';
    config=current;
  }
  const service=read(join(captureDir(),'daemon','service.json'));
  if(service?.supervised===true&&service.status==='installed'){
    if(await live())return 'running';
    if(!isDeepStrictEqual(config,readCaptureConfig()))return 'starting';
    await ensureCaptureDaemon(config);
    repairs.push('requested_worker_start');
    for(let attempt=0;attempt<12;attempt++){
      if(await live())return 'running';
      await delay(150);
    }
    // The saved service may have been unloaded since setup. Restore its owned definition.
  }
  const installed=await installCaptureDaemon(config,{expectedConfig:config});
  if(!installed.supervised)return 'unconfigured';
  repairs.push('installed_worker_service');
  for(let attempt=0;attempt<12;attempt++){
    if(await live())return 'running';
    await delay(150);
  }
  return 'starting';
}
