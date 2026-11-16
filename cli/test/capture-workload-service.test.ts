import {test,expect} from 'bun:test';
import {ChildProcess,type spawn,type spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,delimiter,dirname} from 'node:path';
import {createServer} from 'node:http';
import {captureDaemonCommand,launchAgent,systemdUnit,windowsTaskScript,installCaptureDaemon,ensureCaptureDaemon,uninstallCaptureDaemon} from '../src/capture/daemon-service.ts';
import {applyDaemonEnvironment} from '../src/capture/daemon-environment.ts';
import {recordNativeDaemonHook} from '../src/capture/daemon-handoff.ts';
import {type CaptureConfig} from '../src/capture/runtime.ts';
import {withEnvironmentTokenOrigin} from '../src/environment-token.ts';
import {hash} from '../src/capture/parse.ts';

const config:CaptureConfig={schemaVersion:1,captureWorker:'daemon-v1',api:'https://cloud-fixture.example',installationId:'fixture-install',owner:{tenantId:'fixture-org',userId:'fixture-worker'},installedAt:'2026-11-16T00:00:00Z',harnesses:['devin'],roots:{'claude-code':'/unused/claude',codex:'/unused/codex',devin:'/unused/devin'},command:['/fixture/opencrawl']};
async function environment(run:()=>Promise<void>){
  const before={...process.env};
  delete process.env.OPENCRAWL_TOKEN;delete process.env.OPENCRAWL_SESSIONS_TOKEN;
  try{await run();}finally{for(const key of Object.keys(process.env))if(!(key in before))delete process.env[key];Object.assign(process.env,before);}
}

test('service launch persists only the selected workload mode, destination and helper path',()=>environment(async()=>{
  Object.assign(process.env,{OPENCRAWL_AUTH:'devin-cloud',OPENCRAWL_CONFIG_HOME:'/fixture/profile',PATH:['/fixture/helpers','/usr/bin','/bin'].join(delimiter),DEVIN_OIDC_TOKEN_FILE:'/private/never-copy',DEVIN_OIDC_EXCHANGE_URL:'https://private-never-copy',UNRELATED_SECRET:'never-copy-value'});
  await withEnvironmentTokenOrigin(config.api,async()=>{
    for(const mode of ['devin-cloud','replicas-workspace']){
      process.env.OPENCRAWL_AUTH=mode;
      const command=captureDaemonCommand(config),settings=JSON.parse(command.at(-1)!);
      expect(command.slice(0,-1)).toEqual([...config.command,'collect','daemon','--api',config.api,'--worker-environment']);
      expect(settings.OPENCRAWL_AUTH).toBe(mode);expect(settings.PATH).toBe(process.env.PATH);
      for(const artifact of [JSON.stringify(command),systemdUnit(config),launchAgent(config),windowsTaskScript({...config,command:['C:\\fixture\\opencrawl.exe']})]){
        expect(artifact).toContain(mode);expect(artifact).toContain(config.api);expect(artifact).not.toContain('never-copy');expect(artifact).not.toContain('DEVIN_OIDC');
      }
    }
    process.env.OPENCRAWL_TOKEN='never-copy-token';expect(()=>captureDaemonCommand(config)).toThrow('Remove shared human tokens');delete process.env.OPENCRAWL_TOKEN;
    expect(()=>captureDaemonCommand({...config,api:'https://different.example'})).toThrow('different deployment');
    process.env.PATH='relative';expect(()=>captureDaemonCommand(config)).toThrow('absolute helper search path');
  });
}));

test('worker launch rejects unknown modes, credential paths and mixed identities before applying settings',()=>environment(async()=>{
  delete process.env.OPENCRAWL_AUTH;
  const initial=process.env.OPENCRAWL_CONFIG_HOME;
  const apply=(values:Record<string,string>)=>applyDaemonEnvironment(['collect','daemon','--worker-environment',JSON.stringify({OPENCRAWL_CONFIG_HOME:'/must-not-apply',...values})]);
  const invalid:Array<Record<string,string>>=[{OPENCRAWL_AUTH:'unknown'},{OPENCRAWL_AUTH:''},{OPENCRAWL_AUTH:'devin-cloud',DEVIN_OIDC_TOKEN_FILE:'/secret'},{PATH:'/usr/bin'},{OPENCRAWL_AUTH:'devin-cloud',PATH:'.'},{OPENCRAWL_AUTH:'devin-cloud',PATH:'/usr/bin'+delimiter}];
  for(const values of invalid){
    expect(()=>apply(values)).toThrow();expect(process.env.OPENCRAWL_CONFIG_HOME).toBe(initial);expect(process.env.OPENCRAWL_AUTH).toBeUndefined();
  }
  process.env.OPENCRAWL_SESSIONS_TOKEN='never-use-human';expect(()=>apply({OPENCRAWL_AUTH:'devin-cloud'})).toThrow('Remove shared human tokens');delete process.env.OPENCRAWL_SESSIONS_TOKEN;
  process.env.OPENCRAWL_AUTH='replicas-workspace';expect(()=>apply({OPENCRAWL_AUTH:'devin-cloud'})).toThrow('does not match');
  expect(process.env.OPENCRAWL_CONFIG_HOME).toBe(initial);expect(process.env.OPENCRAWL_AUTH).toBe('replicas-workspace');
}));

test.skipIf(process.platform==='win32')('a clean worker process mints its identity, refreshes a rejection and resumes the same profile without saved credentials',()=>environment(async()=>{
  const dir=mkdtempSync(join(tmpdir(),'opencrawl-cloud-service-')),profile=join(dir,'profile'),capture=join(profile,'opencrawl','capture'),bin=join(dir,'helper bin'),helper=join(bin,'devin-oidc');
  mkdirSync(bin);mkdirSync(capture,{recursive:true});
  const batches:Array<{events:Array<{data?:{content?:unknown}}>}> = [],authorizations:string[]=[];
  let initial='',accepted='',rejected=0,changedOwner=false;
  const server=createServer(async(req,res)=>{
    const authorization=req.headers.authorization??'';authorizations.push(authorization);
    if(authorization==='Bearer '+initial){rejected++;writeFileSync(helper+'.token',accepted,{mode:0o600});res.writeHead(401);res.end('{}');return;}
    if(authorization!=='Bearer '+accepted){res.writeHead(403);res.end('{}');return;}
    const send=(data:unknown)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data}));};
    if(req.url==='/api/sessions/identity'){send({principal:changedOwner?{...config.owner,userId:'different-worker'}:config.owner,capabilities:{harnesses:['devin']}});return;}
    if(req.url==='/api/sessions/batches'){
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks).toString('utf8');batches.push(JSON.parse(body));send({stored:true,batchId:hash(body)});return;
    }
    res.writeHead(404);res.end('{}');
  });
  let child:ReturnType<typeof Bun.spawn>|undefined;
  const stop=async()=>{if(!child)return;const worker=child;child=undefined;worker.kill('SIGTERM');const timer=setTimeout(()=>worker.kill('SIGKILL'),3000);try{await worker.exited;}finally{clearTimeout(timer);}};
  const until=async(check:()=>boolean)=>{const deadline=Date.now()+17_000;while(!check()){if(Date.now()>deadline)throw Error('Cloud worker did not drain its isolated queue');await Bun.sleep(20);}};
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const api='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const token=(nonce:string)=>['synthetic',Buffer.from(JSON.stringify({iss:'https://app.devin.ai',aud:api,exp:Math.floor(Date.now()/1000)+120,nonce})).toString('base64url'),'signature'].join('.');
  try{
    initial=token('rejected');accepted=token('accepted');writeFileSync(helper,'#!/bin/sh\nprintf ".\\n" >> "$0.calls"\n/bin/cat "$0.token"\n',{mode:0o700});writeFileSync(helper+'.token',initial,{mode:0o600});
    Object.assign(process.env,{OPENCRAWL_AUTH:'devin-cloud',OPENCRAWL_CONFIG_HOME:profile,PATH:bin+':/usr/bin:/bin'});
    const selected:CaptureConfig={...config,api,roots:{...config.roots,devin:dir},command:[process.execPath,resolve(import.meta.dir,'../src/cli.ts')]};
    writeFileSync(join(capture,'config.json'),JSON.stringify(selected));
    const command=withEnvironmentTokenOrigin(api,()=>captureDaemonCommand(selected));
    const outputs:Array<Promise<string>>=[];
    const start=()=>{const worker=Bun.spawn(command,{env:{HOME:dir,USERPROFILE:dir,PATH:'/usr/bin:/bin'},stdout:'pipe',stderr:'pipe'});child=worker;outputs.push(new Response(worker.stdout).text(),new Response(worker.stderr).text());};
    const notice=(prompt:string)=>recordNativeDaemonHook('devin',{session_id:'devin-worker-service',hook_event_name:'UserPromptSubmit',prompt});
    notice('first cloud worker turn');start();await until(()=>batches.some(batch=>JSON.stringify(batch).includes('first cloud worker turn')));await stop();
    expect(rejected).toBe(1);expect(readFileSync(helper+'.calls','utf8').trim().split('\n')).toHaveLength(2);
    accepted=token('after-restart');writeFileSync(helper+'.token',accepted,{mode:0o600});notice('resumed cloud worker turn');start();await until(()=>batches.some(batch=>JSON.stringify(batch).includes('resumed cloud worker turn')));await stop();
    expect(authorizations).toContain('Bearer '+accepted);expect(readFileSync(helper+'.calls','utf8').trim().split('\n')).toHaveLength(3);
    expect(JSON.parse(readFileSync(join(capture,'config.json'),'utf8')).installationId).toBe(config.installationId);
    const completed=batches.length;changedOwner=true;initial=token('changed-owner-rejected');accepted=token('changed-owner-refreshed');writeFileSync(helper+'.token',initial,{mode:0o600});notice('must remain with its original owner');start();
    await until(()=>existsSync(join(capture,'last-error.json'))&&JSON.parse(readFileSync(join(capture,'last-error.json'),'utf8')).code==='CAPTURE_DESTINATION_CHANGED');await stop();
    expect(rejected).toBe(2);expect(batches).toHaveLength(completed);expect(readdirSync(join(capture,'queue')).length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(join(capture,'config.json'),'utf8')).owner).toEqual(config.owner);
    const contents=(path:string):string=>readdirSync(path,{withFileTypes:true}).map(entry=>entry.isDirectory()?contents(join(path,entry.name)):readFileSync(join(path,entry.name),'utf8')).join('\n');
    const persisted=contents(profile);expect(persisted).not.toContain('synthetic.');expect(existsSync(join(capture,'last-upload.json'))).toBe(true);
    expect((await Promise.all(outputs)).join('')).toBe('');
  }finally{await stop();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));rmSync(dir,{recursive:true,force:true});}
}),45_000);


test('Devin host supervision preserves exact ownership and rechecks binding before detached wake',()=>environment(async()=>{
 const root=mkdtempSync(join(tmpdir(),'opencrawl-devin-host-service-')),profile=join(root,'profile'),capture=join(profile,'opencrawl','capture');mkdirSync(capture,{recursive:true});
 const uid=Object.getOwnPropertyDescriptor(process,'getuid');Object.defineProperty(process,'getuid',{configurable:true,value:()=>501});
 Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:profile,OPENCRAWL_AUTH:'devin-cloud',PATH:dirname(process.execPath),XDG_CONFIG_HOME:join(root,'xdg')});
 const selected:CaptureConfig={...config,command:[join(root,'opencrawl')],roots:{...config.roots,devin:root}},file=join(capture,'config.json'),receipt=join(capture,'daemon','service.json');
 const save=()=>writeFileSync(file,JSON.stringify(selected));save();
 const profileHash=hash(join(profile,'opencrawl')),label='com.getopencrawl.capture.'+profileHash.slice(0,12);
 let active=false;const hostCalls:string[][]=[],launches:string[][]=[];
 const hostRun=(command:string,args:string[])=>{
  hostCalls.push([command,...args]);
  if(command==='/usr/bin/systemctl')return {status:0,stdout:active?`LoadState=loaded\nActiveState=active\nMainPID=901\nUser=501\nTransient=yes\nDescription=OpenCrawl capture profile ${profileHash}\n`:'LoadState=not-found\nActiveState=inactive\nMainPID=0\n'};
  expect(command).toBe('/usr/bin/sudo');if(args.includes('/usr/bin/systemd-run'))active=true;else{expect(args).toContain('stop');active=false;}return {status:0,stdout:''};
 };
 const run=((command:string,args:string[])=>{expect(command).toBe('systemctl');expect(args).toEqual(['--user','show-environment']);return {status:1,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};}) as typeof spawnSync;
 const launch=((command:string,args:string[])=>{launches.push([command,...args]);return new ChildProcess();}) as typeof spawn;
 try{await withEnvironmentTokenOrigin(config.api,async()=>{
  const installed=await installCaptureDaemon(selected,{home:root,platform:'linux',run,hostRun});
  expect(installed).toMatchObject({kind:'systemd-host',status:'installed',supervised:true,label,uid:501,transient:true,recreateOnHook:true});
  expect(hostCalls.some(call=>call.includes('--uid=501'))).toBe(true);expect(hostCalls.some(call=>call.includes('--api')&&call.includes(config.api))).toBe(true);
  const originalReceipt=readFileSync(receipt,'utf8');
  await ensureCaptureDaemon(selected,{platform:'linux',launch});expect(launches).toHaveLength(1);expect(launches[0][0]).toBe('/usr/bin/sudo');expect(launches[0]).toContain('--unit='+label+'.service');
  // No disabled, foreign owner/install, or mismatched receipt can launch.
  writeFileSync(file,JSON.stringify({...selected,disabled:true}));await ensureCaptureDaemon({...selected,disabled:true},{platform:'linux',launch});save();
  for(const changed of [{installationId:'foreign'},{api:'https://foreign.example'},{owner:{tenantId:'foreign',userId:'foreign'}}])await ensureCaptureDaemon({...selected,...changed},{platform:'linux',launch});
  writeFileSync(receipt,JSON.stringify({...installed,uid:502}));await ensureCaptureDaemon(selected,{platform:'linux',launch});writeFileSync(receipt,originalReceipt);
  process.env.OPENCRAWL_AUTH='replicas-workspace';await ensureCaptureDaemon(selected,{platform:'linux',launch});process.env.OPENCRAWL_AUTH='devin-cloud';
  let guards=0;await expect(ensureCaptureDaemon(selected,{platform:'linux',launch,validateBinding:()=>{if(++guards===2)throw Error('plugin binding revoked');}})).rejects.toThrow('plugin binding revoked');expect(guards).toBe(2);expect(launches).toHaveLength(1);
  expect(readFileSync(receipt,'utf8')).toBe(originalReceipt);
  uninstallCaptureDaemon(root,{platform:'linux',run,hostRun});expect(active).toBe(false);expect(existsSync(receipt)).toBe(false);expect(JSON.parse(readFileSync(file,'utf8'))).toEqual(selected);
 });}finally{if(uid)Object.defineProperty(process,'getuid',uid);else delete process.getuid;rmSync(root,{recursive:true,force:true});}
}));
