import {spawnSync} from 'node:child_process';
import {isAbsolute} from 'node:path';

type Result={status:number|null,stdout:string};
type Invoke=(command:string,args:string[])=>Result;
export type HostBinding={label:string,profileHash:string,uid:number};
export type HostService=HostBinding&{command:string[],continuous:boolean};
const execute:Invoke=(command,args)=>{const result=spawnSync(command,args,{stdio:'pipe',encoding:'utf8',timeout:command==='/usr/bin/systemctl'?5000:35_000,maxBuffer:64*1024,env:{PATH:'/usr/bin:/bin',LANG:'C'}});return {status:result.status,stdout:result.stdout??''};};
const description=(service:HostBinding)=>'OpenCrawl capture profile '+service.profileHash;
function validate(service:HostBinding){
  if(!/^[a-f0-9]{64}$/.test(service.profileHash)||service.label!=='com.getopencrawl.capture.'+service.profileHash.slice(0,12)||!Number.isSafeInteger(service.uid)||service.uid<=0)
    throw Error('Invalid capture host service binding');
}
/** systemd-run in the Cloud image is v249: the newer --expand-environment=no
 * flag is unavailable. Its D-Bus argv needs only dollar expansion escaped;
 * unlike a textual unit file, percent and quote characters remain literal. */
export function hostServiceCommand(service:HostService):[string,string[]]{
  validate(service);
  if(!service.command.length||!isAbsolute(service.command[0]!)||service.command[0]!.includes('$')||service.command.some(arg=>arg.includes('\0')))throw Error('Capture host service requires an absolute executable without dollar characters');
  return ['/usr/bin/sudo',['-n','--','/usr/bin/systemd-run','--system','--no-ask-password','--quiet','--collect',
    '--unit='+service.label+'.service','--description='+description(service),'--uid='+service.uid,'--service-type=exec',
    '--property=Restart='+(service.continuous?'always':'on-failure'),'--property=RestartSec=10',
    '--property=StartLimitIntervalSec=0','--property=TimeoutStopSec=30','--property=UMask=0077','--property=NoNewPrivileges=yes',
    '--',...service.command.map(arg=>arg.replaceAll('$',()=>'$$'))]];
}
function inspect(service:HostBinding,invoke:Invoke){
  const result=invoke('/usr/bin/systemctl',['--system','--no-pager','show',service.label+'.service','--property=LoadState,ActiveState,MainPID,User,Transient,Description']);
  const state=Object.fromEntries(result.stdout.trim().split('\n').map(line=>{const equals=line.indexOf('=');return [line.slice(0,equals),line.slice(equals+1)];}));
  // systemctl can return nonzero for a missing unit. Require its full negative
  // state, never treat a command failure or an empty response as absence.
  if(state.LoadState==='not-found'&&state.ActiveState==='inactive'&&state.MainPID==='0')return null;
  if(result.status!==0||state.LoadState!=='loaded'||!state.ActiveState||!/^\d+$/.test(state.MainPID??''))throw Error('Could not verify the capture host service; existing state is preserved');
  if(state.User!==String(service.uid)||state.Transient!=='yes'||state.Description!==description(service))throw Error('Capture host service ownership changed; existing state is preserved');
  return state;
}
export function verifyHostService(service:HostService,invoke:Invoke=execute){hostServiceCommand(service);inspect(service,invoke);}
export function stopHostService(service:HostBinding,invoke:Invoke=execute){
  validate(service);
  if(!inspect(service,invoke))return;
  const stopped=invoke('/usr/bin/sudo',['-n','--','/usr/bin/systemctl','--system','--no-ask-password','stop',service.label+'.service']);
  if(stopped.status!==0)throw Error('Could not stop the capture host service; its receipt and queued data are preserved');
  const remaining=inspect(service,invoke);
  if(remaining&&(!['inactive','failed'].includes(remaining.ActiveState!)||remaining.MainPID!=='0'))throw Error('Capture host service stop is unconfirmed; local state is preserved');
  // --collect owns removal of transient units. A still-loaded unit cannot be
  // replaced safely; let setup retry after the manager has collected it.
  if(remaining)throw Error('Capture host service is still being collected; its receipt and queued data are preserved');
}
export function installHostService(service:HostService,invoke:Invoke=execute){
  const command=hostServiceCommand(service);
  stopHostService(service,invoke);
  if(invoke(...command).status!==0)throw Error('Could not start the capture host service; rerun setup to repair supervision');
  const started=inspect(service,invoke);
  if(!started||started.ActiveState!=='active'||started.MainPID==='0')throw Error('Capture host service startup is unconfirmed; rerun setup to repair supervision');
  return {kind:'systemd-host',status:'installed',supervised:true,label:service.label,uid:service.uid,transient:true,recreateOnHook:true};
}
