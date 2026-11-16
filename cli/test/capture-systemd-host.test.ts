import {test,expect} from 'bun:test';
import {hostServiceCommand,installHostService,stopHostService,verifyHostService,type HostService} from '../src/capture/systemd-host.ts';

const service:HostService={profileHash:'a'.repeat(64),label:'com.getopencrawl.capture.'+'a'.repeat(12),uid:1000,continuous:true,command:['/home/ubuntu/.local/bin/opencrawl','collect','daemon','--worker-environment',JSON.stringify({OPENCRAWL_AUTH:'devin-cloud',OPENCRAWL_CONFIG_HOME:'/profile with % and $HOME',PATH:'/helper/bin:/usr/bin:/bin'})]};
const absent={status:1,stdout:'LoadState=not-found\nActiveState=inactive\nMainPID=0\nUser=\nTransient=no\nDescription=\n'};
const state=(overrides:Record<string,string>={})=>({status:0,stdout:Object.entries({LoadState:'loaded',ActiveState:'active',MainPID:'100',User:'1000',Transient:'yes',Description:'OpenCrawl capture profile '+service.profileHash,...overrides}).map(([key,value])=>key+'='+value).join('\n')});
function machine(initial=absent){
  let current=initial,failStop=false,failStart=false,retainAfterStop=false;
  const calls:Array<[string,string[]]>=[];
  return {calls,set:(next:ReturnType<typeof state>)=>{current=next;},failStop:()=>{failStop=true;},failStart:()=>{failStart=true;},retainAfterStop:()=>{retainAfterStop=true;},
    invoke:(command:string,args:string[])=>{
      calls.push([command,args]);
      if(command==='/usr/bin/systemctl')return current;
      expect(command).toBe('/usr/bin/sudo');expect(args.slice(0,2)).toEqual(['-n','--']);
      if(args[2]==='/usr/bin/systemctl'){
        expect(args.slice(3)).toEqual(['--system','--no-ask-password','stop',service.label+'.service']);
        if(failStop)return {status:1,stdout:''};
        current=retainAfterStop?state({ActiveState:'inactive',MainPID:'0'}):absent;
        return {status:0,stdout:''};
      }
      expect(args[2]).toBe('/usr/bin/systemd-run');
      if(failStart)return {status:1,stdout:''};
      current=state();return {status:0,stdout:''};
    }};
}

test('host supervision runs the shared command as the ordinary UID with literal arguments on systemd 249',()=>{
  const [command,args]=hostServiceCommand(service);
  expect(command).toBe('/usr/bin/sudo');expect(args).toContain('--uid=1000');expect(args).toContain('--service-type=exec');
  expect(args).toContain('--collect');expect(args).toContain('--property=Restart=always');expect(args).toContain('--property=NoNewPrivileges=yes');
  expect(args).toContain('--property=TimeoutStopSec=30');expect(args).toContain('--property=UMask=0077');
  expect(args).not.toContain('--expand-environment=no');expect(args).not.toContain('--scope');expect(args).not.toContain('--no-block');
  expect(args.slice(-service.command.length)).toEqual(service.command.map(arg=>arg.replaceAll('$',()=>'$$')));
  expect(args.at(-1)).toContain('%');expect(args.at(-1)).toContain('$$HOME');
  expect(hostServiceCommand({...service,continuous:false})[1]).toContain('--property=Restart=on-failure');
  for(const invalid of [{uid:0},{uid:-1},{label:'another.service'},{profileHash:'bad'},{command:['relative']},{command:['/path/$executable']}])expect(()=>hostServiceCommand({...service,...invalid})).toThrow();
});

test('fresh setup, replacement and resume use one bound transient service; cleanup confirms collection',()=>{
  const host=machine();
  verifyHostService(service,host.invoke);expect(host.calls.every(([command])=>command==='/usr/bin/systemctl')).toBe(true);
  const receipt=installHostService(service,host.invoke);
  expect(receipt).toMatchObject({kind:'systemd-host',status:'installed',supervised:true,uid:1000,transient:true,recreateOnHook:true});
  expect(host.calls.filter(([,args])=>args[2]==='/usr/bin/systemd-run')).toHaveLength(1);
  installHostService(service,host.invoke);
  expect(host.calls.filter(([,args])=>args[2]==='/usr/bin/systemctl')).toHaveLength(1);
  expect(host.calls.filter(([,args])=>args[2]==='/usr/bin/systemd-run')).toHaveLength(2);
  stopHostService(service,host.invoke);
  const before=host.calls.length;stopHostService(service,host.invoke);expect(host.calls.length-before).toBe(1);
  // A VM reboot removes transient units; the same binding can be recreated.
  expect(installHostService(service,host.invoke)).toEqual(receipt);
});

test('foreign, missing and unavailable ownership evidence never stops or starts a host service',()=>{
  for(const initial of [state({User:'0'}),state({User:'1001'}),state({Description:'another profile'}),state({Transient:'no'}),state({LoadState:'error'}),{status:1,stdout:''},{status:1,stdout:'LoadState=not-found\n'}]){
    const host=machine(initial);
    expect(()=>verifyHostService(service,host.invoke)).toThrow();expect(()=>installHostService(service,host.invoke)).toThrow();expect(()=>stopHostService(service,host.invoke)).toThrow();
    expect(host.calls.every(([command])=>command==='/usr/bin/systemctl')).toBe(true);
  }
});

test('failed stop, incomplete collection and failed start never report installed supervision',()=>{
  for(const failure of ['stop','collect','start'] as const){
    const host=machine(state());
    if(failure==='stop')host.failStop();if(failure==='collect')host.retainAfterStop();if(failure==='start')host.failStart();
    expect(()=>installHostService(service,host.invoke)).toThrow();
    expect(host.calls.filter(([,args])=>args[2]==='/usr/bin/systemd-run')).toHaveLength(failure==='start'?1:0);
  }
  const calls:Array<[string,string[]]>=[];
  const invoke=(command:string,args:string[])=>{calls.push([command,args]);return command==='/usr/bin/systemctl'?absent:{status:0,stdout:''};};
  expect(()=>installHostService(service,invoke)).toThrow('startup is unconfirmed');
});
