import {existsSync,readFileSync,readdirSync,mkdirSync,unlinkSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,realpathSync} from 'node:fs';
import {join,dirname,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {isDeepStrictEqual} from 'node:util';
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as pause} from 'node:timers/promises';
import {atomicJson,syncDirectory,configDir,withSessionLock} from '../session.ts';
import {captureDir,readCaptureConfig,captureDaemonEnabled,captureDaemonHarnesses,recordError,type CaptureConfig} from './runtime.ts';
import {hash} from './parse.ts';
import {compiled,nativeBin,selectedBinary} from '../distribution.ts';
import {workspaceIdentityEnabled,configuredProvider} from '../workspace-identity.ts';
import {hostServiceCommand,installHostService,stopHostService,verifyHostService} from './systemd-host.ts';
import {assertTokenDestination} from '../environment-token.ts';
import {apiOrigin,CliError} from '../oauth.ts';
import {validWorkerPath} from './daemon-environment.ts';
import {powershellQuote} from '../hook-runner.ts';
type HostInvoke=NonNullable<Parameters<typeof installHostService>[1]>;

const directory=()=>join(captureDir(),'daemon');
const label=()=>`com.getopencrawl.capture.${hash(configDir()).slice(0,12)}`;
const xml=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
function serviceEnvironment(config:CaptureConfig){
  const environment:Record<string,string>={OPENCRAWL_CONFIG_HOME:dirname(configDir()),OPENCRAWL_NO_UPDATE:'1'};
  for(const name of ['XDG_CACHE_HOME','XDG_DATA_HOME'])if(process.env[name])environment[name]=process.env[name]!;
  if(workspaceIdentityEnabled()){
    assertTokenDestination(config.api);
    if(!process.env.PATH||!validWorkerPath(process.env.PATH))throw new CliError('INVALID_USAGE','A workload worker needs an absolute helper search path.',64);
    environment.OPENCRAWL_AUTH=process.env.OPENCRAWL_AUTH!;environment.PATH=process.env.PATH;
  }
  return environment;
}
const continuous=(config:CaptureConfig)=>Boolean(!config.disabled&&captureDaemonHarnesses(config).length||config.backgroundStartup);
export const captureDaemonCommand=(config:CaptureConfig)=>[...config.command,'collect','daemon','--api',apiOrigin(config.api),'--worker-environment',JSON.stringify(serviceEnvironment(config))];
const hostBinding=()=>({label:label(),profileHash:hash(configDir()),uid:process.getuid!()});
const hostService=(config:CaptureConfig)=>({...hostBinding(),command:captureDaemonCommand(config),continuous:continuous(config)});
/** systemd has its own quoting, environment and percent-specifier rules; it
 * does not run ExecStart through a shell. Disable dollar expansion explicitly. */
const unitQuote=(value:string)=>'"'+value.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('\n','\\n').replaceAll('\r','\\r').replaceAll('%','%%')+'"';
export function systemdUnit(config:CaptureConfig){
  return `[Unit]\nDescription=OpenCrawl session capture\nStartLimitIntervalSec=0\n\n[Service]\nType=exec\nExecStart=:${captureDaemonCommand(config).map(unitQuote).join(' ')}\n${Object.entries(serviceEnvironment(config)).map(([key,value])=>'Environment='+unitQuote(key+'='+value)).join('\n')}\nRestart=${continuous(config)?'always':'on-failure'}\nRestartSec=10\nTimeoutStopSec=30\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}
function writeServiceFile(path:string,content:string){
  mkdirSync(dirname(path),{recursive:true});
  const temporary=path+'.'+crypto.randomUUID()+'.tmp';
  try{const fd=openSync(temporary,'wx',0o600);try{writeFileSync(fd,content);fsyncSync(fd);}finally{closeSync(fd);}renameSync(temporary,path);syncDirectory(dirname(path));}
  finally{try{unlinkSync(temporary);}catch{}}
}
const windowsArgument=(value:string)=>'"'+value.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1')+'"';
export function windowsTaskScript(config:CaptureConfig){
  if(!config.command.length)throw Error('Capture supervision requires an executable command');
  let executable=config.command[0]!;
  // Task Scheduler starts the native process directly, not a long-lived
  // PowerShell wrapper or the installer's .cmd shim.
  if(config.command.length===1&&executable===nativeBin()&&compiled())executable=selectedBinary().file;
  if(/\.(cmd|bat)$/i.test(executable))throw Error('Capture supervision requires the native executable, not a custom batch launcher');
  const args=captureDaemonCommand(config).slice(1).map(windowsArgument).join(' ');
  const task=powershellQuote(label()),description=powershellQuote('OpenCrawl capture profile '+hash(configDir()));
  // A completed action is not reliably restarted by RestartOnFailure. Recover
  // continuous workers every minute; omitting duration makes repetition indefinite.
  const recovery=continuous(config)?'$triggers+=New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 1)\n':'';
  return `$ErrorActionPreference='Stop'\n$task=${task}\n$description=${description}\n$previous=Get-ScheduledTask -TaskPath '\\' -ErrorAction Stop | Where-Object {$_.TaskName -eq $task}\nif($previous -and $previous.Description -ne $description){throw 'Capture task name is already owned by another program'}\nif($previous){Stop-ScheduledTask -TaskName $task}\n$user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value\n$action=New-ScheduledTaskAction -Execute ${powershellQuote(executable)} -Argument ${powershellQuote(args)}\n$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited\n$triggers=@(New-ScheduledTaskTrigger -AtLogOn -User $user)\n${recovery}$settings=New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Priority 7\nRegister-ScheduledTask -TaskName $task -Description $description -Action $action -Principal $principal -Trigger $triggers -Settings $settings -Force | Out-Null\nStart-ScheduledTask -TaskName $task\n`;
}
const powershell=(script:string,run:typeof spawnSync=spawnSync)=>run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{stdio:'pipe',timeout:15_000,windowsHide:true});
function launchdOperation(operation:'print'|'bootout'|'bootstrap'|'kickstart',result:Pick<ReturnType<typeof spawnSync>,'status'|'signal'|'error'>){
  const errorCode=(result.error as NodeJS.ErrnoException|undefined)?.code;
  return {operation,exitStatus:Number.isInteger(result.status)?result.status:null,
    signal:result.signal?(/^SIG[A-Z0-9]{1,16}$/.test(result.signal)?result.signal:'UNKNOWN'):null,
    errorCode:errorCode?(/^[A-Z][A-Z0-9_]{0,31}$/.test(errorCode)?errorCode:'UNKNOWN'):null};
}
export function launchAgent(config:CaptureConfig) {
  const args=captureDaemonCommand(config);
  const environment=serviceEnvironment(config);
  const keepAlive=continuous(config)?'<true/>':'<dict><key>SuccessfulExit</key><false/></dict>';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label()}</string><key>ProgramArguments</key><array>${args.map(arg=>'<string>'+xml(arg)+'</string>').join('')}</array><key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key,value])=>'<key>'+xml(key)+'</key><string>'+xml(value)+'</string>').join('')}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key>${keepAlive}<key>ThrottleInterval</key><integer>10</integer><key>ProcessType</key><string>Background</string></dict></plist>\n`;
}

/** Portable fallback for environments whose supervisor starts the worker or
 * keeps detached children alive. A kernel lock, not a PID file, owns singleton
 * exclusion. Hooks never wait for startup, authentication, or upload. */
export async function ensureCaptureDaemon(config=readCaptureConfig(),{platform=process.platform,launch=spawn,validateBinding}:{platform?:NodeJS.Platform;launch?:typeof spawn;validateBinding?:()=>void}={}) {
  if(!config||config.disabled&&!config.backgroundStartup||!captureDaemonEnabled(config)||!config.command.length)return;
  validateBinding?.();
  try{await withSessionLock('capture:daemon',async()=>{},0);}catch(error:any){if(error.code==='SESSION_BUSY')return;throw error;}
  validateBinding?.();
  if(!isDeepStrictEqual(readCaptureConfig(),config))return;
  const serviceFile=join(directory(),'service.json');
  if(existsSync(serviceFile)){
    const service=JSON.parse(readFileSync(serviceFile,'utf8'));
    if(service.kind==='external'||service.status==='failed'||service.status==='stop-failed')return;
    if(platform==='darwin'&&service.kind==='launchd'&&service.label===label()){
      // Let the supervisor own crash recovery. A detached replacement can win
      // the singleton race and leave launchd repeatedly starting duplicates.
      const child=launch('launchctl',['kickstart','gui/'+process.getuid!()+'/'+label()],{detached:true,stdio:'ignore'});
      await new Promise<void>((resolve,reject)=>{child.once('spawn',()=>resolve());child.once('error',reject);child.unref();});return;
    }
    if(platform==='linux'&&service.kind==='systemd'&&service.label===label()){
      const child=launch('systemctl',['--user','start','--no-block',label()+'.service'],{detached:true,stdio:'ignore'});
      await new Promise<void>((resolve,reject)=>{child.once('spawn',()=>resolve());child.once('error',reject);child.unref();});return;
    }
    if(service.kind==='systemd-host'){
      // Native Devin resume may request recreation, never stop/replace a unit.
      // The named transient unit and ordinary UID remain supervisor-owned.
      if(platform!=='linux'||service.status!=='installed'||service.label!==label()||service.uid!==process.getuid!()||configuredProvider()!=='devin')return;
      const [command,args]=hostServiceCommand(hostService(config));
      const child=launch(command,args,{detached:true,stdio:'ignore',env:{PATH:'/usr/bin:/bin',LANG:'C'}});
      child.on('error',()=>{});child.unref();return;
    }
    if(platform==='win32'&&service.kind==='task-scheduler'&&service.label===label()){
      const child=launch('schtasks.exe',['/Run','/TN',label()],{detached:true,stdio:'ignore',windowsHide:true});
      await new Promise<void>((resolve,reject)=>{child.once('spawn',()=>resolve());child.once('error',reject);child.unref();});return;
    }
  }
  const child=launch(config.command[0]!,[...config.command.slice(1),'collect','daemon'],{detached:true,stdio:'ignore',env:{...process.env,OPENCRAWL_CONFIG_HOME:dirname(configDir()),OPENCRAWL_NO_UPDATE:'1'}});
  await new Promise<void>((resolve,reject)=>{child.once('spawn',()=>resolve());child.once('error',reject);child.unref();});
}

export function systemdUserManagerAvailable(run=spawnSync){
  return run('systemctl',['--user','show-environment'],{stdio:'ignore',timeout:5000}).status===0;
}

/** User-scoped OS supervision; hosts without a user manager receive an explicit
 * profile-bound foreground command for their own supervisor. */
export async function installCaptureDaemon(config:CaptureConfig,{home=homedir(),service=true,platform=process.platform,run=spawnSync,ensure=ensureCaptureDaemon,hostRun,expectedConfig=config}:{expectedConfig?:CaptureConfig;home?:string;service?:boolean;platform?:NodeJS.Platform;run?:typeof spawnSync;ensure?:typeof ensureCaptureDaemon;hostRun?:HostInvoke}={}) {
  if(!isDeepStrictEqual(readCaptureConfig(),expectedConfig))throw Error('Capture configuration changed before service installation');
  const queue=join(captureDir(),'queue'),pending=existsSync(queue)&&readdirSync(queue).some(name=>name.endsWith('.json'));
  if(!captureDaemonEnabled(config)||!config.backgroundStartup&&(config.disabled||!captureDaemonHarnesses(config).length&&!pending)){
    uninstallCaptureDaemon(home,{platform,run,hostRun});return {kind:'not-required',supervised:false,queuedDataPreserved:true};
  }
  if(service){
    const path=platform==='linux'?join(process.env.XDG_CONFIG_HOME||join(home,'.config'),'systemd','user',label()+'.service'):platform==='darwin'?join(home,'Library','LaunchAgents',label()+'.plist'):null;
    const binding=platform==='linux'?'Environment='+unitQuote('OPENCRAWL_CONFIG_HOME='+dirname(configDir())):'<key>OPENCRAWL_CONFIG_HOME</key><string>'+xml(dirname(configDir()))+'</string>';
    if(path&&existsSync(path)&&!readFileSync(path,'utf8').includes(binding))throw Error('Capture service file belongs to another profile or program; it was preserved');
  }
  // Validate public workload launch settings and existing ownership before any
  // generation/receipt changes. The host adapter is only for Devin on Linux.
  captureDaemonCommand(config);
  const receipt=join(directory(),'service.json'),previous=existsSync(receipt)?JSON.parse(readFileSync(receipt,'utf8')):null;
  const userSystemctl=(args:string[])=>run('systemctl',['--user',...args],{stdio:'pipe',timeout:5000});
  let useHost=false,userManagerAvailable=false;
  if(service&&platform==='linux'){
    userManagerAvailable=systemdUserManagerAvailable(run);
    useHost=previous?.kind==='systemd-host'||!userManagerAvailable&&configuredProvider()==='devin';
    if(useHost){
      if(configuredProvider()!=='devin')throw Error('Preserve Devin Cloud workload mode when repairing its capture host service');
      if(previous?.kind==='systemd')throw Error('The existing capture user service must be stopped before changing its supervisor');
      if(previous?.kind==='systemd-host'&&(previous.label!==label()||previous.uid!==process.getuid!()))throw Error('Capture host service receipt ownership changed; local state is preserved');
      verifyHostService(hostService(config),hostRun);
    }
  }
  if(!isDeepStrictEqual(readCaptureConfig(),expectedConfig))throw Error('Capture configuration changed before service installation');
  mkdirSync(directory(),{recursive:true,mode:0o700});
  if(platform!=='darwin'||!service)atomicJson(join(directory(),'generation.json'),{generation:crypto.randomUUID()});
  if(platform==='darwin'&&service){
    const path=join(home,'Library','LaunchAgents',label()+'.plist'),definition=launchAgent(config);
    const existing=existsSync(path)?readFileSync(path,'utf8'):null;
    const generationFile=join(directory(),'generation.json');
    const readGeneration=()=>existsSync(generationFile)?readFileSync(generationFile,'utf8'):null;
    const beforeGeneration=readGeneration();
    const unchanged=(generation:string|null)=>{
      if(!isDeepStrictEqual(readCaptureConfig(),expectedConfig)||readGeneration()!==generation)
        throw new CliError('CAPTURE_CONFIG_CHANGED','Capture configuration or worker generation changed during service installation.');
    };
    const domain='gui/'+process.getuid!(),target=domain+'/'+label();
    const service={kind:'launchd',status:'installed',supervised:true,label:label(),path};
    const operations:ReturnType<typeof launchdOperation>[]=[];
    const invoke=(operation:Parameters<typeof launchdOperation>[0],args:string[])=>{
      // A restart can wait for shutdown and our 10-second launchd throttle.
      // Do not terminate its acknowledgement before that normal interval.
      const result=run('launchctl',args,{stdio:'pipe',timeout:operation==='kickstart'?30_000:5000});
      operations.push(launchdOperation(operation,result));return result;
    };
    const recordFailure=(error:CliError):never=>{
      atomicJson(receipt,{...service,status:'failed',supervised:false,operations});recordError(error);throw error;
    };
    const failed=(operation:Parameters<typeof launchdOperation>[0],result:ReturnType<typeof spawnSync>):never=>{
      const failure=launchdOperation(operation,result);
      const error=new CliError('CAPTURE_SUPERVISION_FAILED',`Could not install the capture LaunchAgent: launchctl ${operation} failed (exit=${failure.exitStatus??'none'}, signal=${failure.signal??'none'}, error=${failure.errorCode??'none'}). Check this user's LaunchAgent registration, then rerun setup.`);
      return recordFailure(error);
    };
    const isAbsent=(result:ReturnType<typeof spawnSync>)=>result.status===113&&!result.error&&!result.signal&&String(result.stderr).includes('Could not find service');
    const sameServicePath=(candidate:unknown)=>{
      if(typeof candidate!=='string'||!isAbsolute(candidate))return false;
      if(candidate===path)return true;
      try{return realpathSync(candidate)===realpathSync(path);}catch{return false;}
    };
    const loadedFromPath=(result:ReturnType<typeof spawnSync>)=>String(result.stdout).split('\n').some(line=>{
      const value=line.trim();return value.startsWith('path = ')&&sameServicePath(value.slice(7));
    });
    const checked=invoke('print',['print',target]);
    const absent=isAbsent(checked);
    if(checked.status!==0&&!absent)failed('print',checked);
    if(checked.status===0){
      const owned=previous?.kind==='launchd'&&previous.label===label()&&sameServicePath(previous.path)&&existing!==null;
      if(!owned||!loadedFromPath(checked))throw new CliError('CAPTURE_SUPERVISION_CONFLICT','The loaded LaunchAgent is not bound to this profile receipt and service file. Its registration was preserved.');
    }
    unchanged(beforeGeneration);
    if(checked.status===0&&existing===definition){
      // Keep the verified registration. -k runs the current managed wrapper,
      // including a new binary behind an unchanged command path.
      const restarted=invoke('kickstart',['kickstart','-k',target]);
      unchanged(beforeGeneration);if(restarted.status!==0)failed('kickstart',restarted);
      atomicJson(receipt,service);return service;
    }
    if(checked.status===0){
      const beforeReceipt=readFileSync(receipt,'utf8');
      const replacementUnchanged=()=>{
        unchanged(beforeGeneration);
        if(!existsSync(path)||readFileSync(path,'utf8')!==existing||!existsSync(receipt)||readFileSync(receipt,'utf8')!==beforeReceipt)
          throw new CliError('CAPTURE_SUPERVISION_CONFLICT','The capture LaunchAgent file or receipt changed while stopping it. The newer state was preserved.');
      };
      const stopped=invoke('bootout',['bootout',target]);
      replacementUnchanged();if(stopped.status!==0)failed('bootout',stopped);
      // bootout acceptance is not proof that removal and worker shutdown have
      // completed. Keep the old definition/generation until both are observed.
      // Never hold the singleton over bootstrap: the new worker takes it once.
      const deadline=performance.now()+30_000;
      while(true){
        replacementUnchanged();
        const remaining=deadline-performance.now();
        if(remaining<=0)recordFailure(new CliError('CAPTURE_SUPERVISION_TIMEOUT','The previous capture LaunchAgent or worker did not stop within 30 seconds. Its service file and queued data were preserved; check the user LaunchAgent, then rerun setup.'));
        const checked=run('launchctl',['print',target],{stdio:'pipe',timeout:Math.max(1,Math.min(5000,Math.ceil(remaining)))});
        operations.push(launchdOperation('print',checked));replacementUnchanged();
        if(isAbsent(checked)){
          let released=false;
          try{await withSessionLock('capture:daemon',async()=>{},0);released=true;}
          catch(error){
            replacementUnchanged();
            if(!(error instanceof CliError)||error.code!=='SESSION_BUSY')
              recordFailure(new CliError('CAPTURE_SUPERVISION_FAILED','Could not verify that the previous capture worker stopped. Its service file and queued data were preserved; rerun setup after checking local state.'));
          }
          replacementUnchanged();
          if(released&&performance.now()<deadline)break;
        }else{
          if(checked.status!==0)failed('print',checked);
          if(!loadedFromPath(checked))throw new CliError('CAPTURE_SUPERVISION_CONFLICT','The LaunchAgent registration changed while stopping it. The newer registration was preserved.');
        }
        await pause(Math.max(0,Math.min(100,deadline-performance.now())));
      }
      replacementUnchanged();
    }
    atomicJson(generationFile,{generation:crypto.randomUUID()});
    const generation=readGeneration();
    // Missing jobs bootstrap normally; changed definitions retain their explicit
    // replacement path. Exit 5 is generic EIO, not permission for a blind retry.
    if(existing!==definition)writeServiceFile(path,definition);
    unchanged(generation);
    const result=invoke('bootstrap',['bootstrap',domain,path]);
    unchanged(generation);if(result.status!==0)failed('bootstrap',result);
    atomicJson(receipt,service);return service;
  }
  if(platform==='linux'&&service){
    const path=join(process.env.XDG_CONFIG_HOME||join(home,'.config'),'systemd','user',label()+'.service');
    writeServiceFile(path,systemdUnit(config));
    const invoke=userSystemctl;
    if(useHost||!userManagerAvailable){
      if(useHost){
        const state={kind:'systemd-host',status:'starting',supervised:false,label:label(),uid:process.getuid!(),transient:true,recreateOnHook:true};
        atomicJson(join(directory(),'service.json'),state);
        try{const installed=installHostService(hostService(config),hostRun);atomicJson(join(directory(),'service.json'),installed);return installed;}
        catch(error){atomicJson(join(directory(),'service.json'),{...state,status:'failed'});recordError(error);throw error;}
      }
      const state={kind:'external',status:'required',supervised:false,path,command:captureDaemonCommand(config),reason:'No systemd user manager; the host supervisor must run this foreground command'};
      atomicJson(join(directory(),'service.json'),state);return state;
    }
    invoke(['stop',label()+'.service']);
    const state={kind:'systemd',status:'installed',supervised:true,label:label(),path};
    atomicJson(join(directory(),'service.json'),state);
    if(invoke(['daemon-reload']).status!==0||invoke(['enable','--now',label()+'.service']).status!==0){
      const error=Error('Could not install the capture user service; rerun setup to repair supervision');
      atomicJson(join(directory(),'service.json'),{...state,status:'failed',supervised:false});recordError(error);throw error;
    }
    return state;
  }
  if(platform==='win32'&&service){
    const state={kind:'task-scheduler',status:'installed',supervised:true,label:label(),restartIntervalSeconds:60};
    atomicJson(join(directory(),'service.json'),state);
    try{if(powershell(windowsTaskScript(config),run).status!==0)throw Error('Could not install the capture scheduled task; rerun setup to repair supervision');}
    catch(error){atomicJson(join(directory(),'service.json'),{...state,status:'failed',supervised:false});recordError(error);throw error;}
    return state;
  }
  await ensure(config,{platform});
  const state={kind:'process',status:'requested',supervised:false,command:captureDaemonCommand(config)};atomicJson(join(directory(),'service.json'),state);return state;
}

export function uninstallCaptureDaemon(home=homedir(),{platform=process.platform,run=spawnSync,hostRun}:{platform?:NodeJS.Platform;run?:typeof spawnSync;hostRun?:HostInvoke}={}) {
  const receipt=join(directory(),'service.json');
  const failed=(message:string)=>{
    const error=Error(message);let previous={};try{previous=JSON.parse(readFileSync(receipt,'utf8'));}catch{}
    atomicJson(receipt,{...previous,status:'stop-failed',supervised:false});recordError(error);throw error;
  };
  // Reconfiguration wakes the worker without trusting a possibly reused PID.
  if(existsSync(directory()))atomicJson(join(directory(),'generation.json'),{generation:crypto.randomUUID()});
  if(platform==='win32'){
    const service=join(directory(),'service.json');
    if(!existsSync(service))return;
    const state=JSON.parse(readFileSync(service,'utf8'));if(state.kind!=='task-scheduler'||state.label!==label())return;
    const result=powershell(`$ErrorActionPreference='Stop';$task=Get-ScheduledTask -TaskPath '\\' -ErrorAction Stop | Where-Object {$_.TaskName -eq ${powershellQuote(label())}};if($task){if($task.Description -ne ${powershellQuote('OpenCrawl capture profile '+hash(configDir()))}){throw 'Capture task ownership changed'};Stop-ScheduledTask -TaskName ${powershellQuote(label())};Unregister-ScheduledTask -TaskName ${powershellQuote(label())} -Confirm:$false}`,run);
    if(result.status!==0)failed('Could not remove the capture scheduled task; queued data is preserved');
    unlinkSync(service);return;
  }
  if(platform==='linux'){
    const path=join(process.env.XDG_CONFIG_HOME||join(home,'.config'),'systemd','user',label()+'.service');
    const previous=existsSync(receipt)?JSON.parse(readFileSync(receipt,'utf8')):null;
    if(existsSync(path)&&!readFileSync(path,'utf8').includes('Environment='+unitQuote('OPENCRAWL_CONFIG_HOME='+dirname(configDir()))))failed('Capture service ownership changed; its file and receipt are preserved');
    if(previous?.kind==='systemd-host'){
      if(previous.label!==label()||previous.uid!==process.getuid!())failed('Capture host service receipt ownership changed; local state is preserved');
      try{stopHostService(hostBinding(),hostRun);}catch(error){failed(error instanceof Error?error.message:'Capture host service stop failed; local state is preserved');}
      if(existsSync(path))unlinkSync(path);unlinkSync(receipt);return;
    }
    if(!existsSync(path)&&previous?.kind!=='systemd')return;
    // A missing user manager installed only a suggested unit, never a service.
    if(previous?.kind==='external'&&previous.status==='required'){unlinkSync(path);unlinkSync(receipt);return;}
    const stop=run('systemctl',['--user','disable','--now',label()+'.service'],{stdio:'pipe',timeout:5000});
    if(stop.status!==0)failed('Could not stop the capture user service; its unit, receipt and queued data are preserved');
    const active=run('systemctl',['--user','show',label()+'.service','--property=ActiveState','--value'],{stdio:'pipe',timeout:5000});
    if(active.status!==0||!['inactive','failed'].includes(active.stdout.toString().trim()))failed('Capture user service stop is unconfirmed; local state is preserved');
    const content=existsSync(path)?readFileSync(path,'utf8'):null;if(content!==null)unlinkSync(path);
    if(run('systemctl',['--user','daemon-reload'],{stdio:'pipe',timeout:5000}).status!==0){if(content!==null)writeServiceFile(path,content);failed('Could not reload the user service manager; capture unit and receipt are preserved');}
    const service=join(directory(),'service.json');if(existsSync(service))unlinkSync(service);return;
  }
  if(platform!=='darwin')return;
  const path=join(home,'Library','LaunchAgents',label()+'.plist');
  const previous=existsSync(receipt)?JSON.parse(readFileSync(receipt,'utf8')):null;
  if(existsSync(path)&&!readFileSync(path,'utf8').includes('<key>OPENCRAWL_CONFIG_HOME</key><string>'+xml(dirname(configDir()))+'</string>'))failed('Capture LaunchAgent ownership changed; its file and receipt are preserved');
  if(!existsSync(path)&&previous?.kind!=='launchd')return;
  const domain='gui/'+process.getuid!()+'/'+label();
  const stopped=run('launchctl',['bootout',domain],{stdio:'pipe',timeout:5000});
  if(stopped.status!==0){
    const checked=run('launchctl',['print',domain],{stdio:'pipe',timeout:5000});
    if(checked.status!==113||!checked.stderr.toString().includes('Could not find service'))failed('Could not confirm the capture LaunchAgent stopped; its file, receipt and queued data are preserved');
  }
  if(existsSync(path))unlinkSync(path);
  const serviceFile=join(directory(),'service.json');if(existsSync(serviceFile))unlinkSync(serviceFile);
}
