import {existsSync,readFileSync,realpathSync,mkdirSync} from 'node:fs';
import {join,dirname,basename} from 'node:path';
import {spawn} from 'node:child_process';
import {compiled,version,nativeRoot,validNative,validRelease,binary,read,releaseRoot} from '../distribution.ts';
import {atomicJson,configDir} from '../session.ts';
import {captureDir,readCaptureConfig,captureDaemonEnabled,type CaptureConfig} from './runtime.ts';
import {hasPluginContext} from '../setup/plugin-context.ts';

export function ownedNativeCaptureCommand(config:CaptureConfig){
  if(config.command.length!==1)return false;
  try{
    const path=realpathSync(config.command[0]!),v=basename(dirname(path));
    if(validNative(v)&&path===join(realpathSync(nativeRoot()),'versions',v,process.platform==='win32'?'opencrawl.exe':'opencrawl'))return true;
    const cached=join(dirname(dirname(dirname(path))),'cli'),pkg=read(join(cached,'package.json'));
    return Boolean(pkg?.version&&cached===releaseRoot(pkg.version)&&validRelease(cached,pkg.version)&&path===realpathSync(binary(cached)));
  }catch{return false;}
}
/** One detached, profile-bound migration attempt per cooldown. Hooks do not
 * wait for locks, service commands, authentication, or readiness. */
export function scheduleDaemonUpgrade({native=compiled(),platform=process.platform,launch=spawn,owned=ownedNativeCaptureCommand,now=Date.now()}: {
  native?:boolean;platform?:NodeJS.Platform;launch?:typeof spawn;owned?:(config:CaptureConfig)=>boolean;now?:number;
}={}){
  if(!native||!['darwin','linux'].includes(platform)||process.env.OPENCRAWL_NO_UPDATE==='1'||hasPluginContext())return;
  const config=readCaptureConfig();
  if(!config||config.authPending||(!config.daemonRequested&&(config.disabled||config.hookOwnership==='plugin'||config.harnesses?.length===0))||captureDaemonEnabled(config)||!owned(config))return;
  const directory=join(captureDir(),'daemon'),receipt=join(directory,'upgrade-attempt.json');
  mkdirSync(directory,{recursive:true,mode:0o700});
  if(existsSync(receipt)){try{const prior=JSON.parse(readFileSync(receipt,'utf8'));if(prior.version===version&&prior.nextAttemptAt>now&&prior.nextAttemptAt<=now+15*60_000)return;}catch{/* A damaged cooldown cannot permanently suppress migration. */}}
  // Publish the cooldown before spawning. Racing processes can both launch,
  // but the migration's nonblocking kernel lock admits only one installer.
  // No PID/claim file can strand future attempts if this process is killed.
  atomicJson(receipt,{version,nextAttemptAt:now+15*60_000});
  const child=launch(process.execPath,['collect','upgrade-daemon','--json'],{detached:true,stdio:'ignore',env:{...process.env,OPENCRAWL_CONFIG_HOME:dirname(configDir()),OPENCRAWL_NO_UPDATE:'1'}});
  child.on('error',()=>{});child.unref();
}
