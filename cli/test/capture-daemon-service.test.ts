import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {ChildProcess,spawnSync as executeSync,type spawnSync,type spawn,type SpawnSyncReturns} from 'node:child_process';
import {launchAgent,systemdUnit,windowsTaskScript,installCaptureDaemon,uninstallCaptureDaemon,ensureCaptureDaemon} from '../src/capture/daemon-service.ts';
import {applyDaemonEnvironment} from '../src/capture/daemon-environment.ts';
import {captureDir,type CaptureConfig} from '../src/capture/runtime.ts';
import {atomicJson,configDir,withSessionLock} from '../src/session.ts';
import {hash} from '../src/capture/parse.ts';
import {CliError} from '../src/oauth.ts';

const outcome=(status=0,stdout='',stderr=''):SpawnSyncReturns<Buffer>=>({pid:0,output:[null,Buffer.from(stdout),Buffer.from(stderr)],stdout:Buffer.from(stdout),stderr:Buffer.from(stderr),status,signal:null});
const runner=(fn:(command:string,args:string[],options?:{timeout?:number})=>SpawnSyncReturns<Buffer>)=>((command:string,args?:readonly string[],options?:{timeout?:number})=>fn(command,[...(args??[])],options)) as typeof spawnSync;
const forbidden=runner(()=>{throw Error('Unexpected supervisor invocation');});
async function fixture(run:(f:{root:string,config:CaptureConfig,label:string,receipt:string,unit:(platform:'linux'|'darwin')=>string})=>Promise<void>|void){
  const root=mkdtempSync(join(tmpdir(),'opencrawl-service-unit-')),before={...process.env};
  try{
    Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(root,'config'),XDG_CONFIG_HOME:join(root,'xdg-config'),XDG_CACHE_HOME:join(root,'cache'),XDG_DATA_HOME:join(root,'data'),OPENCRAWL_NO_UPDATE:'1'});
    const config:CaptureConfig={schemaVersion:1,captureWorker:'daemon-v1',api:'http://127.0.0.1:1',installationId:'service-fixture',owner:{tenantId:'fixture',userId:'fixture'},installedAt:'2026-11-16T00:00:00Z',harnesses:['claude-code'],roots:{'claude-code':join(root,'claude'),codex:join(root,'codex')},command:[join(root,'selected CLI','opencrawl')]};
    mkdirSync(join(captureDir(),'daemon'),{recursive:true});atomicJson(join(captureDir(),'config.json'),config);
    const label='com.getopencrawl.capture.'+hash(configDir()).slice(0,12),receipt=join(captureDir(),'daemon','service.json');
    await run({root,config,label,receipt,unit:platform=>platform==='linux'?join(root,'xdg-config','systemd','user',label+'.service'):join(root,'Library','LaunchAgents',label+'.plist')});
  }finally{
    for(const name of Object.keys(process.env))if(!(name in before))delete process.env[name];Object.assign(process.env,before);
    // All supervisor calls above are injected. These files never represented a real service.
    rmSync(root,{recursive:true,force:true});
  }
}
function ownedUnit(file:string,config:CaptureConfig,platform:'linux'|'darwin'){
  mkdirSync(dirname(file),{recursive:true});const bytes=platform==='linux'?systemdUnit(config):launchAgent(config);writeFileSync(file,bytes);return bytes;
}

test('supervisor commands preserve literal paths and never serialize credentials',()=>fixture(({config})=>{
  process.env.OPENCRAWL_TOKEN='fixture-secret-must-not-appear';
  const unit=systemdUnit({...config,command:['/owned path/oc%$"binary']}),plist=launchAgent(config),task=windowsTaskScript({...config,command:['C:\\Owned path\\opencrawl.exe']});
  expect(unit).toContain('ExecStart=:"/owned path/oc%%$\\"binary"');expect(unit).toContain('Restart=always');expect(unit).toContain('UMask=0077');
  expect(systemdUnit({...config,harnesses:[]})).toContain('Restart=on-failure');
  expect(systemdUnit({...config,disabled:true,harnesses:[],backgroundStartup:true})).toContain('Restart=always');
  expect(plist).toContain('<key>KeepAlive</key><true/>');
  expect(task).toContain("-Execute 'C:\\Owned path\\opencrawl.exe'");expect(task).toContain('-LogonType Interactive -RunLevel Limited');
  expect(task).toContain('-RestartInterval (New-TimeSpan -Minutes 1)');expect(task).toContain('-MultipleInstances IgnoreNew');
  expect(task).toContain('--worker-environment');expect(task).toContain('Description -ne $description');
  for(const text of [unit,plist,task]){expect(text).not.toContain('fixture-secret-must-not-appear');expect(text).toContain('XDG_CACHE_HOME');expect(text).toContain('XDG_DATA_HOME');}
  expect(()=>windowsTaskScript({...config,command:['C:\\custom.cmd']})).toThrow('native executable');
}));

const windowsRecoveryCases:{name:string,changes:Partial<CaptureConfig>,supervised:boolean,recovery:boolean}[]=[
  {name:'capture-on',changes:{},supervised:true,recovery:true},
  {name:'startup-only',changes:{disabled:true,harnesses:[],backgroundStartup:true},supervised:true,recovery:true},
  {name:'fully paused',changes:{disabled:true,backgroundStartup:false},supervised:false,recovery:false},
  {name:'queue-only drain',changes:{harnesses:[],backgroundStartup:false},supervised:true,recovery:false},
];
for(const {name,changes,supervised,recovery} of windowsRecoveryCases)test(`Windows recovery respects ${name} consent and retains queued data`,()=>fixture(async f=>{
  const config={...f.config,...changes,command:['C:\\Owned path\\opencrawl.exe']};atomicJson(join(captureDir(),'config.json'),config);
  const queued=join(captureDir(),'queue','retained.json'),saved=join(configDir(),'setup.json');mkdirSync(dirname(queued),{recursive:true});
  writeFileSync(queued,'retained');writeFileSync(saved,JSON.stringify({selections:[{client:'claude-code',plugin:true,forward:name==='capture-on',history:false}]}));
  const configBefore=readFileSync(join(captureDir(),'config.json'),'utf8'),setupBefore=readFileSync(saved,'utf8');
  // A paused reconfiguration must remove this same task, not create a recovery trigger.
  atomicJson(f.receipt,{kind:'task-scheduler',status:'installed',label:f.label});
  const scripts:string[]=[];
  const run=runner((command,args)=>{expect(command).toBe('powershell.exe');scripts.push(args.at(-1)!);return outcome();});
  const result=await installCaptureDaemon(config,{home:f.root,platform:'win32',run});
  expect(result.supervised).toBe(supervised);expect(scripts).toHaveLength(1);
  const script=scripts[0]!;
  if(supervised){
    expect(script).toContain('New-ScheduledTaskTrigger -AtLogOn -User $user');
    expect(script).toContain("-Execute 'C:\\Owned path\\opencrawl.exe'");
    expect(script).toContain('-LogonType Interactive -RunLevel Limited');
    expect(script).toContain('-MultipleInstances IgnoreNew');
    expect(script).toContain("Description -ne $description");
    expect(script).not.toContain('-RepetitionDuration');
    const recurring='$triggers+=New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 1)';
    expect(script.includes(recurring)).toBe(recovery);
    if(recovery)expect(script).toContain('-Trigger $triggers -Settings $settings');
    expect(script.match(/New-ScheduledTaskTrigger/g)?.length).toBe(recovery?2:1);
    uninstallCaptureDaemon(f.root,{platform:'win32',run});
  }else{
    expect(result).toMatchObject({kind:'not-required',queuedDataPreserved:true});
    expect(script).not.toContain('New-ScheduledTaskTrigger');
  }
  expect(scripts.at(-1)).toContain('Capture task ownership changed');
  expect(scripts.at(-1)).toContain('Unregister-ScheduledTask');
  expect(existsSync(f.receipt)).toBe(false);
  expect(readFileSync(join(captureDir(),'config.json'),'utf8')).toBe(configBefore);
  expect(readFileSync(saved,'utf8')).toBe(setupBefore);
  expect(readFileSync(queued,'utf8')).toBe('retained');
}));

test('worker environment rejects wrong commands, secrets and relative paths without mutation',()=>fixture(()=>{
  const before={...process.env};
  for(const args of [
    ['search','--worker-environment','{}'],['session','start','--worker-environment','{}'],
    ['collect','daemon','--worker-environment','{"OPENCRAWL_TOKEN":"secret"}'],
    ['collect','daemon','--worker-environment','null'],['collect','daemon','--worker-environment','[]'],
    ['collect','daemon','--worker-environment','{"XDG_DATA_HOME":"relative"}'],
    ['collect','daemon','--worker-environment','{"XDG_CACHE_HOME":"/path\\u0000tail"}'],
  ])expect(()=>applyDaemonEnvironment(args)).toThrow();
  expect(process.env.OPENCRAWL_CONFIG_HOME).toBe(before.OPENCRAWL_CONFIG_HOME);
  expect(process.env.XDG_DATA_HOME).toBe(before.XDG_DATA_HOME);
}));

test('stale configuration and foreign unit ownership refuse before any service mutation',()=>fixture(async f=>{
  await expect(installCaptureDaemon({...f.config,installationId:'stale'},{home:f.root,platform:'linux',run:forbidden})).rejects.toThrow('configuration changed');
  for(const platform of ['linux','darwin'] as const){
    const path=f.unit(platform);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,'foreign service');
    await expect(installCaptureDaemon(f.config,{home:f.root,platform,run:forbidden})).rejects.toThrow('belongs to another');
    expect(readFileSync(path,'utf8')).toBe('foreign service');
  }
  expect(existsSync(join(captureDir(),'daemon','generation.json'))).toBe(false);expect(existsSync(f.receipt)).toBe(false);
}));

test('external supervisor result carries exact isolated worker environment and never claims supervision',()=>fixture(async f=>{
  const calls:string[][]=[];
  const result=await installCaptureDaemon(f.config,{home:f.root,platform:'linux',run:runner((command,args)=>{expect(command).toBe('systemctl');calls.push(args);return outcome(1);})});
  expect(result).toMatchObject({kind:'external',status:'required',supervised:false});
  if(!('command' in result))throw Error('Missing bound command');
  expect(result.command.slice(0,-1)).toEqual([...f.config.command,'collect','daemon','--api',f.config.api,'--worker-environment']);
  const env=JSON.parse(result.command.at(-1)!);expect(env).toEqual({OPENCRAWL_CONFIG_HOME:dirname(configDir()),OPENCRAWL_NO_UPDATE:'1',XDG_CACHE_HOME:join(f.root,'cache'),XDG_DATA_HOME:join(f.root,'data')});
  expect(calls).toEqual([['--user','show-environment']]);
  await ensureCaptureDaemon(f.config,{platform:'linux',launch:(()=>{throw Error('must not spawn fallback');}) as typeof spawn});
  uninstallCaptureDaemon(f.root,{platform:'linux',run:forbidden});
  expect(existsSync(f.unit('linux'))).toBe(false);expect(existsSync(f.receipt)).toBe(false);
}));

test('startup-only supervisor preserves disabled capture, selections and queued bytes',()=>fixture(async f=>{
  const config={...f.config,disabled:true,harnesses:[],backgroundStartup:true};atomicJson(join(captureDir(),'config.json'),config);
  mkdirSync(join(captureDir(),'queue'));writeFileSync(join(captureDir(),'queue','retained.json'),'retained');
  const before=readFileSync(join(captureDir(),'config.json'),'utf8'),calls:string[][]=[];
  const result=await installCaptureDaemon(config,{home:f.root,platform:'linux',run:runner((command,args)=>{expect(command).toBe('systemctl');calls.push(args);return outcome();})});
  expect(result).toMatchObject({kind:'systemd',status:'installed',supervised:true});
  expect(calls.map(args=>args[1])).toEqual(['show-environment','stop','daemon-reload','enable']);
  expect(readFileSync(f.unit('linux'),'utf8')).toContain('Restart=always');
  expect(readFileSync(join(captureDir(),'config.json'),'utf8')).toBe(before);
  expect(readFileSync(join(captureDir(),'queue','retained.json'),'utf8')).toBe('retained');
}));

for(const stage of ['stop','active','query','reload'] as const)test(`Linux ${stage} uncertainty retains owned unit, queue and recovery receipt`,()=>fixture(f=>{
  const path=f.unit('linux'),bytes=ownedUnit(path,f.config,'linux');
  atomicJson(f.receipt,{kind:'systemd',status:'installed',label:f.label,path});
  mkdirSync(join(captureDir(),'queue'));writeFileSync(join(captureDir(),'queue','retained.json'),'retained');
  const run=runner((_command,args)=>{
    if(args[1]==='disable')return outcome(stage==='stop'?1:0);
    if(args[1]==='show')return outcome(stage==='query'?1:0,stage==='active'?'active':'inactive');
    if(args[1]==='daemon-reload')return outcome(stage==='reload'?1:0);
    throw Error('Unexpected command');
  });
  expect(()=>uninstallCaptureDaemon(f.root,{platform:'linux',run})).toThrow('preserved');
  expect(readFileSync(path,'utf8')).toBe(bytes);expect(JSON.parse(readFileSync(f.receipt,'utf8'))).toMatchObject({kind:'systemd',status:'stop-failed',supervised:false});
  expect(readFileSync(join(captureDir(),'queue','retained.json'),'utf8')).toBe('retained');
}));

test('verified Linux stop removes only owned service files and preserves queue/config',()=>fixture(f=>{
  const path=f.unit('linux');ownedUnit(path,f.config,'linux');atomicJson(f.receipt,{kind:'systemd',status:'installed',label:f.label,path});
  const before=readFileSync(join(captureDir(),'config.json'),'utf8');
  mkdirSync(join(captureDir(),'queue'));writeFileSync(join(captureDir(),'queue','retained.json'),'retained');
  const calls:string[][]=[];
  uninstallCaptureDaemon(f.root,{platform:'linux',run:runner((_command,args)=>{calls.push(args);return outcome(0,args[1]==='show'?'inactive':'');})});
  expect(calls.map(args=>args[1])).toEqual(['disable','show','daemon-reload']);expect(existsSync(path)).toBe(false);expect(existsSync(f.receipt)).toBe(false);
  expect(readFileSync(join(captureDir(),'config.json'),'utf8')).toBe(before);expect(readFileSync(join(captureDir(),'queue','retained.json'),'utf8')).toBe('retained');
}));

test('Windows uncertain removal retains receipt and command has explicit ownership refusal',()=>fixture(f=>{
  atomicJson(f.receipt,{kind:'task-scheduler',status:'installed',label:f.label});
  let script='';
  expect(()=>uninstallCaptureDaemon(f.root,{platform:'win32',run:runner((command,args)=>{expect(command).toBe('powershell.exe');script=args.at(-1)!;return outcome(1);})})).toThrow('preserved');
  expect(script).toContain('Capture task ownership changed');expect(script).toContain('-ErrorAction Stop');
  expect(JSON.parse(readFileSync(f.receipt,'utf8')).status).toBe('stop-failed');
  uninstallCaptureDaemon(f.root,{platform:'win32',run:runner(()=>outcome())});expect(existsSync(f.receipt)).toBe(false);
}));

for(const timeout of [false,true])test(`Mac bootstrap ${timeout?'timeout':'exit'} reports safe supervision diagnostics and retains failed enrollment`,()=>fixture(async f=>{
  const uid=Object.getOwnPropertyDescriptor(process,'getuid');Object.defineProperty(process,'getuid',{configurable:true,value:()=>501});
  try{
    const before=readFileSync(join(captureDir(),'config.json'),'utf8');
    const queued=join(captureDir(),'queue','retained.json');mkdirSync(dirname(queued));writeFileSync(queued,'retained');
    const secret='private-service-stderr-and-error-message';
    const failure:SpawnSyncReturns<Buffer>=timeout?{...outcome(),status:null,signal:'SIGTERM',error:Object.assign(Error(secret),{code:'ETIMEDOUT'})}:outcome(5,secret,secret);
    const calls:string[]=[];let caught:unknown;
    try{await installCaptureDaemon(f.config,{home:f.root,platform:'darwin',run:runner((command,args)=>{expect(command).toBe('launchctl');calls.push(args[0]!);return args[0]==='bootstrap'?failure:outcome(113,'','Could not find service');})});}catch(error){caught=error;}
    expect(caught).toBeInstanceOf(CliError);expect(caught).toMatchObject({code:'CAPTURE_SUPERVISION_FAILED',exitCode:1});
    const expected={operation:'bootstrap',exitStatus:timeout?null:5,signal:timeout?'SIGTERM':null,errorCode:timeout?'ETIMEDOUT':null};
    const receipt=JSON.parse(readFileSync(f.receipt,'utf8'));
    expect(receipt).toMatchObject({kind:'launchd',status:'failed',supervised:false,operations:[{operation:'print',exitStatus:113,signal:null,errorCode:null},expected]});
    expect(JSON.parse(readFileSync(join(captureDir(),'last-error.json'),'utf8')).code).toBe('CAPTURE_SUPERVISION_FAILED');
    expect((caught as Error).message).toContain('launchctl bootstrap');
    expect((caught as Error).message).toContain(`exit=${expected.exitStatus??'none'}, signal=${expected.signal??'none'}, error=${expected.errorCode??'none'}`);
    for(const text of [JSON.stringify(receipt),(caught as Error).message]){expect(text).not.toContain(secret);expect(text).not.toContain('login');}
    expect(calls).toEqual(['print','bootstrap']);
    expect(readFileSync(join(captureDir(),'config.json'),'utf8')).toBe(before);expect(readFileSync(queued,'utf8')).toBe('retained');
  }finally{if(uid)Object.defineProperty(process,'getuid',uid);else delete process.getuid;}
}));

test('main JSON preserves a real launchd supervision failure without login guidance or raw output',()=>fixture(async f=>{
  const module=(name:string)=>JSON.stringify(resolve(import.meta.dir,'../src/'+name));
  const code=`import {mock} from 'bun:test';
import * as setup from ${module('setup/command.ts')};
import {installCaptureDaemon} from ${module('capture/daemon-service.ts')};
Object.defineProperty(process,'getuid',{configurable:true,value:()=>501});
const config=${JSON.stringify(f.config)},secret='private-launchctl-output';
const run=(_command,args)=>({pid:0,output:[null,Buffer.from(secret),Buffer.from(secret)],stdout:Buffer.from(secret),stderr:Buffer.from(args[0]==='print'?'Could not find service':secret),status:args[0]==='bootstrap'?5:113,signal:null});
mock.module(${module('setup/command.ts')},()=>({...setup,setupCommand:async()=>installCaptureDaemon(config,{home:${JSON.stringify(f.root)},platform:'darwin',run})}));
globalThis.fetch=()=>{throw Error('Unexpected network');};
const {main}=await import(${module('cli.ts')});process.exitCode=await main(['setup','resume','--api',config.api,'--json']);`;
  const child=Bun.spawn([process.execPath,'-e',code],{env:{...process.env,OPENCRAWL_TOKEN:'',OPENCRAWL_SESSIONS_TOKEN:'',OPENCRAWL_AUTH:''},stdout:'pipe',stderr:'pipe'});
  const timer=setTimeout(()=>child.kill(),5000);
  try{
    const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(exit).toBe(1);expect(stderr).toBe('');
    const json=JSON.parse(stdout);expect(json).toMatchObject({schemaVersion:1,error:{code:'CAPTURE_SUPERVISION_FAILED'}});
    expect(json.error.message).toContain('launchctl bootstrap');expect(json.error.message).toContain('exit=5, signal=none, error=none');
    expect(stdout).not.toContain('private-launchctl-output');expect(stdout).not.toContain('login');
    expect(JSON.parse(readFileSync(f.receipt,'utf8'))).toMatchObject({status:'failed',supervised:false});
  }finally{clearTimeout(timer);child.kill();await child.exited;}
}));

test('Mac stop uncertainty preserves state; verified service absence permits cleanup',()=>fixture(f=>{
  // The platform and launchctl are injected; the UID must be independent of the
  // host too (Windows has no process.getuid). Restore the exact property after.
  const uid=Object.getOwnPropertyDescriptor(process,'getuid');
  Object.defineProperty(process,'getuid',{configurable:true,value:()=>501});
  try{
    const path=f.unit('darwin'),bytes=ownedUnit(path,f.config,'darwin');atomicJson(f.receipt,{kind:'launchd',status:'installed',label:f.label,path});
    const run=(absent:boolean)=>runner((command,args)=>{expect(command).toBe('launchctl');expect(args[1]).toBe('gui/501/'+f.label);return absent&&args[0]==='print'?outcome(113,'','Could not find service'):outcome(1);});
    expect(()=>uninstallCaptureDaemon(f.root,{platform:'darwin',run:run(false)})).toThrow('preserved');
    expect(readFileSync(path,'utf8')).toBe(bytes);expect(JSON.parse(readFileSync(f.receipt,'utf8')).status).toBe('stop-failed');
    uninstallCaptureDaemon(f.root,{platform:'darwin',run:run(true)});
    expect(existsSync(path)).toBe(false);expect(existsSync(f.receipt)).toBe(false);
  }finally{if(uid)Object.defineProperty(process,'getuid',uid);else delete process.getuid;}
}));

test('paused no-startup installation remains stopped and detached spawn errors propagate',()=>fixture(async f=>{
  const paused={...f.config,disabled:true,backgroundStartup:false};atomicJson(join(captureDir(),'config.json'),paused);
  expect(await installCaptureDaemon(paused,{home:f.root,platform:'linux',run:forbidden})).toMatchObject({kind:'not-required',supervised:false});
  atomicJson(join(captureDir(),'config.json'),f.config);
  const launch=(()=>{const child=new ChildProcess();queueMicrotask(()=>child.emit('error',Error('fixture spawn failed')));return child;}) as typeof spawn;
  await expect(ensureCaptureDaemon(f.config,{platform:'linux',launch})).rejects.toThrow('fixture spawn failed');
}));

test('source CLI worker environment selects paused profile before reading a different active profile',()=>fixture(async f=>{
  const selected=join(f.root,'selected profile'),capture=join(selected,'opencrawl','capture');mkdirSync(capture,{recursive:true});
  const paused={...f.config,disabled:true,backgroundStartup:false,installationId:'selected-paused'};
  atomicJson(join(capture,'config.json'),paused);
  const beforeDefault=readFileSync(join(captureDir(),'config.json'),'utf8'),beforeSelected=readFileSync(join(capture,'config.json'),'utf8');
  const child=Bun.spawn([process.execPath,join(import.meta.dir,'../src/cli.ts'),'collect','daemon','--worker-environment',JSON.stringify({OPENCRAWL_CONFIG_HOME:selected,XDG_CACHE_HOME:join(f.root,'child-cache'),XDG_DATA_HOME:join(f.root,'child-data')})],
    {env:{...process.env,OPENCRAWL_API_URL:'http://127.0.0.1:1',OPENCRAWL_TOKEN:'',OPENCRAWL_SESSIONS_TOKEN:'',OPENCRAWL_AUTH:''},stdout:'pipe',stderr:'pipe'});
  const timeout=setTimeout(()=>child.kill(),2000);
  try{
    const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(code).toBe(0);expect(stdout).toBe('');expect(stderr).toBe('');
    expect(readFileSync(join(captureDir(),'config.json'),'utf8')).toBe(beforeDefault);
    expect(readFileSync(join(capture,'config.json'),'utf8')).toBe(beforeSelected);
    expect(existsSync(join(captureDir(),'daemon','status.json'))).toBe(false);
    expect(existsSync(join(capture,'daemon','status.json'))).toBe(false);
  }finally{clearTimeout(timeout);child.kill();await child.exited;}
}));


for(const mode of ['capture','startup','queue'] as const)test(`Mac repeat ${mode} setup restarts its owned definition without removing it`,()=>fixture(async f=>{
 const uid=Object.getOwnPropertyDescriptor(process,'getuid');Object.defineProperty(process,'getuid',{configurable:true,value:()=>501});
 try{
  const config={...f.config,...(mode==='startup'?{disabled:true,harnesses:[],backgroundStartup:true}:mode==='queue'?{harnesses:[],backgroundStartup:false}:{})};
  atomicJson(join(captureDir(),'config.json'),config);const configBytes=readFileSync(join(captureDir(),'config.json'),'utf8');
  const queued=join(captureDir(),'queue','retained.json');mkdirSync(dirname(queued));writeFileSync(queued,'retained');
  const calls:string[][]=[];let loaded=false;
  const run=runner((_command,args)=>{calls.push(args);if(args[0]==='print')return loaded?outcome(0,'path = '+f.unit('darwin')):outcome(113,'','Could not find service');if(args[0]==='bootstrap'){expect(loaded).toBe(false);loaded=true;return outcome();}if(args[0]==='kickstart'){expect(loaded).toBe(true);expect(args).toEqual(['kickstart','-k','gui/501/'+f.label]);return outcome();}throw Error('Must not remove a matching service');});
  await installCaptureDaemon(config,{home:f.root,platform:'darwin',run});
  const plist=readFileSync(f.unit('darwin'),'utf8'),generation=readFileSync(join(captureDir(),'daemon','generation.json'),'utf8');
  // A stable managed entry may select newer binary bytes. Always restart it;
  // neither an identical plist nor an old running status proves current code.
  mkdirSync(dirname(config.command[0]!),{recursive:true});writeFileSync(config.command[0]!,'new wrapper target');
  expect(await installCaptureDaemon(config,{home:f.root,platform:'darwin',run})).toMatchObject({kind:'launchd',status:'installed',supervised:true});
  expect(calls.map(args=>args[0])).toEqual(['print','bootstrap','print','kickstart']);
  expect(readFileSync(f.unit('darwin'),'utf8')).toBe(plist);expect(readFileSync(join(captureDir(),'daemon','generation.json'),'utf8')).toBe(generation);
  expect(readFileSync(join(captureDir(),'config.json'),'utf8')).toBe(configBytes);expect(readFileSync(queued,'utf8')).toBe('retained');
 }finally{if(uid)Object.defineProperty(process,'getuid',uid);else delete process.getuid;}
}));

test('Mac missing job with stale receipt bootstraps; changed owned definition explicitly replaces',()=>fixture(async f=>{
 const uid=Object.getOwnPropertyDescriptor(process,'getuid');Object.defineProperty(process,'getuid',{configurable:true,value:()=>501});
 try{
  const path=f.unit('darwin');ownedUnit(path,f.config,'darwin');atomicJson(f.receipt,{kind:'launchd',status:'installed',label:f.label,path});
  atomicJson(join(captureDir(),'daemon','status.json'),{state:'running',pid:123});
  const calls:string[]=[];let loaded=false;
  const run=runner((_command,args)=>{calls.push(args[0]!);if(args[0]==='print')return loaded?outcome(0,'path = '+path):outcome(113,'','Could not find service');if(args[0]==='bootstrap'){loaded=true;return outcome();}if(args[0]==='bootout'){loaded=false;return outcome();}throw Error('Unexpected command');});
  await installCaptureDaemon(f.config,{home:f.root,platform:'darwin',run});expect(calls).toEqual(['print','bootstrap']);
  const next={...f.config,command:[join(f.root,'new selected CLI')]};atomicJson(join(captureDir(),'config.json'),next);calls.length=0;
  await installCaptureDaemon(next,{home:f.root,platform:'darwin',run});expect(calls).toEqual(['print','bootout','print','bootstrap']);expect(readFileSync(path,'utf8')).toBe(launchAgent(next));
 }finally{if(uid)Object.defineProperty(process,'getuid',uid);else delete process.getuid;}
}));

for(const timeout of [false,true])test(`Mac kickstart ${timeout?'timeout':'exit'} retains exact registration and safe actionable diagnostics`,()=>fixture(async f=>{
 const uid=Object.getOwnPropertyDescriptor(process,'getuid');Object.defineProperty(process,'getuid',{configurable:true,value:()=>501});
 try{
  const path=f.unit('darwin'),bytes=ownedUnit(path,f.config,'darwin');atomicJson(f.receipt,{kind:'launchd',status:'installed',label:f.label,path});
  const calls:string[]=[];const generation=join(captureDir(),'daemon','generation.json');atomicJson(generation,{generation:'existing-worker'});const generationBefore=readFileSync(generation,'utf8');
  await expect(installCaptureDaemon(f.config,{home:f.root,platform:'darwin',run:runner((_command,args)=>{calls.push(args[0]!);return args[0]==='print'?outcome(0,'path = '+path):timeout?{...outcome(),status:null,signal:'SIGTERM',error:Object.assign(Error('private-error'),{code:'ETIMEDOUT'})}:outcome(5,'private-output','private-error');})})).rejects.toMatchObject({code:'CAPTURE_SUPERVISION_FAILED'});
  expect(calls).toEqual(['print','kickstart']);expect(readFileSync(path,'utf8')).toBe(bytes);expect(readFileSync(generation,'utf8')).toBe(generationBefore);
  const receipt=readFileSync(f.receipt,'utf8');expect(JSON.parse(receipt)).toMatchObject({status:'failed',supervised:false,operations:[{operation:'print',exitStatus:0},{operation:'kickstart',exitStatus:timeout?null:5,signal:timeout?'SIGTERM':null,errorCode:timeout?'ETIMEDOUT':null}]});expect(receipt).not.toContain('private-');
 }finally{if(uid)Object.defineProperty(process,'getuid',uid);else delete process.getuid;}
}));

for(const mode of ['unknown','foreign','changed-config','changed-generation'] as const)test(`Mac ${mode} state cannot replace or claim a service`,()=>fixture(async f=>{
 const uid=Object.getOwnPropertyDescriptor(process,'getuid');Object.defineProperty(process,'getuid',{configurable:true,value:()=>501});
 try{
  const path=f.unit('darwin'),bytes=ownedUnit(path,f.config,'darwin');atomicJson(f.receipt,{kind:'launchd',status:'installed',label:f.label,path});
  const generation=join(captureDir(),'daemon','generation.json');atomicJson(generation,{generation:'before'});const before=readFileSync(f.receipt,'utf8'),calls:string[]=[];
  const code=mode==='unknown'?'CAPTURE_SUPERVISION_FAILED':mode==='foreign'?'CAPTURE_SUPERVISION_CONFLICT':'CAPTURE_CONFIG_CHANGED';
  await expect(installCaptureDaemon(f.config,{home:f.root,platform:'darwin',run:runner((_command,args)=>{
   calls.push(args[0]!);
   if(args[0]==='print'){
    if(mode==='unknown')return outcome(1,'','permission denied');
    if(mode==='changed-config')atomicJson(join(captureDir(),'config.json'),{...f.config,disabled:true});
    return outcome(0,'path = '+(mode==='foreign'?'/foreign/service.plist':path));
   }
   if(args[0]==='kickstart'&&mode==='changed-generation'){atomicJson(generation,{generation:'successor'});return outcome();}
   throw Error('Unexpected mutation');
  })})).rejects.toMatchObject({code});
  expect(readFileSync(path,'utf8')).toBe(bytes);
  if(mode!=='changed-generation')expect(JSON.parse(readFileSync(generation,'utf8')).generation).toBe('before');
  else expect(JSON.parse(readFileSync(generation,'utf8')).generation).toBe('successor');
  if(mode!=='unknown')expect(readFileSync(f.receipt,'utf8')).toBe(before);
  expect(calls).toEqual(mode==='changed-generation'?['print','kickstart']:['print']);
 }finally{if(uid)Object.defineProperty(process,'getuid',uid);else delete process.getuid;}
}));

test('staged launchd bootstrap validates the legacy config while installing the daemon candidate',()=>fixture(async f=>{
  const uid=Object.getOwnPropertyDescriptor(process,'getuid');Object.defineProperty(process,'getuid',{value:()=>501,configurable:true});
  try{
  const before={...f.config};delete before.captureWorker;
  atomicJson(join(captureDir(),'config.json'),before);
  const operations:string[]=[];
  const run=runner((_command,args)=>{operations.push(args[0]!);return args[0]==='print'?outcome(113,'','Could not find service'):outcome();});
  expect(await installCaptureDaemon(f.config,{expectedConfig:before,platform:'darwin',home:f.root,run})).toMatchObject({supervised:true});
  expect(JSON.parse(readFileSync(join(captureDir(),'config.json'),'utf8'))).toEqual(before);
  expect(operations).toEqual(['print','bootstrap']);
  }finally{if(uid)Object.defineProperty(process,'getuid',uid);else delete process.getuid;}
}));

async function macReplacement(run:(f:{config:CaptureConfig,path:string,receipt:string,generation:string,queue:string,label:string,home:string,original:string,receiptBefore:string,generationBefore:string})=>Promise<void>){
  return fixture(async f=>{
    const uid=Object.getOwnPropertyDescriptor(process,'getuid');Object.defineProperty(process,'getuid',{configurable:true,value:()=>501});
    try{
      const path=f.unit('darwin'),original=ownedUnit(path,f.config,'darwin');
      atomicJson(f.receipt,{kind:'launchd',status:'installed',supervised:true,label:f.label,path});
      const generation=join(captureDir(),'daemon','generation.json');atomicJson(generation,{generation:'old-worker'});
      const queue=join(captureDir(),'queue','retained.json');mkdirSync(dirname(queue));writeFileSync(queue,'retained-private-queue');
      const config={...f.config,command:[join(f.root,'versions','new','opencrawl')]};atomicJson(join(captureDir(),'config.json'),config);
      await run({config,path,receipt:f.receipt,generation,queue,label:f.label,home:f.root,original,receiptBefore:readFileSync(f.receipt,'utf8'),generationBefore:readFileSync(generation,'utf8')});
    }finally{if(uid)Object.defineProperty(process,'getuid',uid);else delete process.getuid;}
  });
}

test('Mac changed executable waits for exact service removal and real kernel release before one bootstrap',()=>macReplacement(async f=>{
  let release!:()=>void,ready!:()=>void;const started=new Promise<void>(r=>{ready=r;});
  const oldWorker=withSessionLock('capture:daemon',async()=>{ready();await new Promise<void>(r=>{release=r;});},0);
  await started;
  let stopping=false,observations=0,bootstrapLock:Promise<boolean>|undefined;const calls:string[]=[];
  const before=readFileSync(join(captureDir(),'config.json'),'utf8');
  try{
    const service=await installCaptureDaemon(f.config,{home:f.home,platform:'darwin',run:runner((_command,args)=>{
      calls.push(args[0]!);
      if(args[0]==='print'){
        if(!stopping)return outcome(0,'path = '+f.path);
        observations++;
        expect(readFileSync(f.path,'utf8')).toBe(f.original);expect(readFileSync(f.generation,'utf8')).toBe(f.generationBefore);
        if(observations===4)release();
        return observations<=2?outcome(0,'path = '+f.path+'\nstate = removing'):outcome(113,'','Could not find service');
      }
      if(args[0]==='bootout'){stopping=true;return outcome();}
      if(args[0]==='bootstrap'){
        expect(observations).toBeGreaterThanOrEqual(4);
        expect(readFileSync(f.path,'utf8')).toBe(launchAgent(f.config));
        // Try the real lock at the exact bootstrap call, not only after install.
        bootstrapLock=withSessionLock('capture:daemon',async()=>{},0).then(()=>true,()=>false);
        return outcome();
      }
      throw Error('Unexpected supervisor command');
    })});
    expect(service.supervised).toBe(true);expect(await bootstrapLock).toBe(true);
    expect(calls.filter(x=>x==='bootout')).toHaveLength(1);expect(calls.filter(x=>x==='bootstrap')).toHaveLength(1);
    expect(readFileSync(f.generation,'utf8')).not.toBe(f.generationBefore);
    expect(readFileSync(join(captureDir(),'config.json'),'utf8')).toBe(before);
    expect(readFileSync(f.queue,'utf8')).toBe('retained-private-queue');
  }finally{release();await oldWorker;}
}));

for(const failure of ['bootout','unknown','signaled','wrong-absence','foreign'] as const)test(`Mac replacement ${failure} cannot bootstrap or rotate the old generation`,()=>macReplacement(async f=>{
  let stopping=false;const calls:string[]=[];
  const code=failure==='foreign'?'CAPTURE_SUPERVISION_CONFLICT':'CAPTURE_SUPERVISION_FAILED';
  await expect(installCaptureDaemon(f.config,{home:f.home,platform:'darwin',run:runner((_command,args)=>{
    calls.push(args[0]!);
    if(args[0]==='print'){
      if(!stopping)return outcome(0,'path = '+f.path);
      if(failure==='foreign')return outcome(0,'path = /unrelated/foreign.plist');
      if(failure==='signaled')return {...outcome(113,'','Could not find service'),signal:'SIGTERM'};
      if(failure==='wrong-absence')return outcome(113,'','Private unrelated error');
      return {...outcome(),status:null,error:Object.assign(Error('private-error'),{code:'ETIMEDOUT'})};
    }
    if(args[0]==='bootout'){stopping=true;return outcome(failure==='bootout'?5:0);}
    throw Error('Must not bootstrap');
  })})).rejects.toMatchObject({code});
  expect(calls).toEqual(failure==='bootout'?['print','bootout']:['print','bootout','print']);
  expect(readFileSync(f.path,'utf8')).toBe(f.original);expect(readFileSync(f.generation,'utf8')).toBe(f.generationBefore);
  expect(readFileSync(f.queue,'utf8')).toBe('retained-private-queue');
  const receipt=readFileSync(f.receipt,'utf8');expect(receipt).not.toContain('private-error');expect(receipt).not.toContain('Private unrelated error');
  if(failure==='foreign')expect(receipt).toBe(f.receiptBefore);else expect(JSON.parse(receipt)).toMatchObject({status:'failed',supervised:false});
}));

for(const changed of ['consent','owner','roots','generation','plist','receipt'] as const)test(`Mac replacement preserves a concurrent ${changed} change while removal is pending`,()=>macReplacement(async f=>{
  let stopping=false,modified=false;const calls:string[]=[];
  await expect(installCaptureDaemon(f.config,{home:f.home,platform:'darwin',run:runner((_command,args)=>{
    calls.push(args[0]!);
    if(args[0]==='bootout'){stopping=true;return outcome();}
    if(args[0]!=='print')throw Error('Must not bootstrap');
    if(stopping&&!modified){modified=true;queueMicrotask(()=>{
      if(changed==='generation')atomicJson(f.generation,{generation:'successor'});
      else if(changed==='plist')writeFileSync(f.path,'successor-owned-service');
      else if(changed==='receipt')atomicJson(f.receipt,{kind:'successor'});
      else atomicJson(join(captureDir(),'config.json'),{...f.config,...(changed==='consent'?{disabled:true,backgroundStartup:false}:changed==='owner'?{owner:{tenantId:'other',userId:'other'}}:{roots:{...f.config.roots,codex:join(f.home,'other-root')}})});
    });}
    return outcome(0,'path = '+f.path);
  })})).rejects.toMatchObject({code:changed==='plist'||changed==='receipt'?'CAPTURE_SUPERVISION_CONFLICT':'CAPTURE_CONFIG_CHANGED'});
  expect(calls).toEqual(['print','bootout','print']);expect(modified).toBe(true);
  expect(readFileSync(f.path,'utf8')).toBe(changed==='plist'?'successor-owned-service':f.original);
  expect(readFileSync(f.generation,'utf8')).toBe(changed==='generation'?JSON.stringify({generation:'successor'})+'\n':f.generationBefore);
  expect(readFileSync(f.receipt,'utf8')).toBe(changed==='receipt'?JSON.stringify({kind:'successor'})+'\n':f.receiptBefore);
  expect(readFileSync(f.queue,'utf8')).toBe('retained-private-queue');
}));

test('Mac replacement never starts through a worker that retains the singleton',()=>macReplacement(async f=>{
  let release!:()=>void,ready!:()=>void;const started=new Promise<void>(r=>{ready=r;});
  const oldWorker=withSessionLock('capture:daemon',async()=>{ready();await new Promise<void>(r=>{release=r;});},0);await started;
  let stopping=false,observations=0;
  try{
    const startedAt=performance.now();
    await expect(installCaptureDaemon(f.config,{home:f.home,platform:'darwin',run:runner((_command,args)=>{
      if(args[0]==='bootout'){stopping=true;return outcome();}
      if(args[0]!=='print')throw Error('Must not bootstrap over a live worker');
      if(stopping)observations++;
      return stopping?outcome(113,'','Could not find service'):outcome(0,'path = '+f.path);
    })})).rejects.toMatchObject({code:'CAPTURE_SUPERVISION_TIMEOUT'});
    expect(performance.now()-startedAt).toBeGreaterThanOrEqual(30_000);expect(observations).toBeGreaterThan(1);
    expect(readFileSync(f.path,'utf8')).toBe(f.original);expect(readFileSync(f.generation,'utf8')).toBe(f.generationBefore);
    expect(JSON.parse(readFileSync(f.receipt,'utf8'))).toMatchObject({status:'failed',supervised:false});
    expect(readFileSync(f.queue,'utf8')).toBe('retained-private-queue');
  }finally{release();await oldWorker;}
}),35_000);

for(const foreign of [false,true])(process.platform==='win32'?test.skip:test)(`Mac service ownership ${foreign?'rejects a different file with identical content':'accepts canonical aliases of the same plist'}`,()=>fixture(async f=>{
  const uid=Object.getOwnPropertyDescriptor(process,'getuid');Object.defineProperty(process,'getuid',{value:()=>501,configurable:true});
  try{
    const path=f.unit('darwin'),bytes=ownedUnit(path,f.config,'darwin');
    const aliasHome=join(f.root,'home-alias');symlinkSync(f.root,aliasHome,'dir');
    const aliasPath=join(aliasHome,'Library','LaunchAgents',f.label+'.plist');
    const loadedPath=foreign?join(f.root,'other.plist'):aliasPath;
    if(foreign)writeFileSync(loadedPath,bytes);
    atomicJson(f.receipt,{kind:'launchd',status:'installed',label:f.label,path:aliasPath});
    const before=readFileSync(f.receipt,'utf8'),calls:string[]=[];
    const run=runner((_command,args)=>{calls.push(args[0]!);if(args[0]==='print')return outcome(0,'path = '+loadedPath);if(args[0]==='kickstart')return outcome();throw Error('Unexpected service replacement');});
    if(foreign){
      await expect(installCaptureDaemon(f.config,{home:f.root,platform:'darwin',run})).rejects.toMatchObject({code:'CAPTURE_SUPERVISION_CONFLICT'});
      expect(calls).toEqual(['print']);expect(readFileSync(f.receipt,'utf8')).toBe(before);
    }else{
      expect(await installCaptureDaemon(f.config,{home:f.root,platform:'darwin',run})).toMatchObject({supervised:true});
      expect(calls).toEqual(['print','kickstart']);
    }
    expect(readFileSync(path,'utf8')).toBe(bytes);
  }finally{if(uid)Object.defineProperty(process,'getuid',uid);else delete process.getuid;}
}));

test('Mac repeat setup accepts a restart acknowledgement after the short inspection deadline',()=>fixture(async f=>{
  const uid=Object.getOwnPropertyDescriptor(process,'getuid');Object.defineProperty(process,'getuid',{configurable:true,value:()=>501});
  try{
    const path=f.unit('darwin'),bytes=ownedUnit(path,f.config,'darwin');atomicJson(f.receipt,{kind:'launchd',status:'installed',label:f.label,path});
    const generation=join(captureDir(),'daemon','generation.json');atomicJson(generation,{generation:'existing'});
    const beforeGeneration=readFileSync(generation,'utf8'),beforeConfig=readFileSync(join(captureDir(),'config.json'),'utf8');
    const calls:string[]=[];let elapsed=0;
    const service=await installCaptureDaemon(f.config,{home:f.root,platform:'darwin',run:runner((command,args,options)=>{
      expect(command).toBe('launchctl');calls.push(args[0]!);
      if(args[0]==='print'){expect(options?.timeout).toBe(5000);return outcome(0,'path = '+path);}
      if(args[0]!=='kickstart')throw Error('An identical definition must not be removed');
      expect(args).toEqual(['kickstart','-k','gui/501/'+f.label]);
      // A real disposable process acknowledges after six seconds. Forward the
      // actual production deadline: the former five-second limit kills it.
      const started=performance.now();
      const result=executeSync(process.execPath,['-e','setTimeout(()=>process.stdout.write("ready"),6000)'],{stdio:'pipe',timeout:options?.timeout});
      elapsed=performance.now()-started;expect(result.stdout.toString()).toBe('ready');return result;
    })});
    expect(service).toMatchObject({status:'installed',supervised:true});expect(elapsed).toBeGreaterThan(5000);
    expect(calls).toEqual(['print','kickstart']);expect(readFileSync(path,'utf8')).toBe(bytes);
    expect(readFileSync(generation,'utf8')).toBe(beforeGeneration);expect(readFileSync(join(captureDir(),'config.json'),'utf8')).toBe(beforeConfig);
  }finally{if(uid)Object.defineProperty(process,'getuid',uid);else delete process.getuid;}
}),15_000);
