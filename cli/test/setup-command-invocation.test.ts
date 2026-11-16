import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync,statSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {formatSetupCommand} from '../src/setup/command.ts';
import {commandForSelf} from '../src/capture/runtime.ts';

test('ordinary and source invocation use the current CLI with readable simple arguments',()=>{
 expect(formatSetupCommand(['setup','status'],['/home/person/.local/bin/opencrawl'],'linux')).toBe('/home/person/.local/bin/opencrawl setup status');
 expect(formatSetupCommand(['setup','status'])).toBe(formatSetupCommand(['setup','status'],commandForSelf()));
 expect(formatSetupCommand(['setup'],['/opt/bun','/repo with spaces/cli/main.ts'],'linux')).toBe("/opt/bun '/repo with spaces/cli/main.ts' setup");
});

test('Windows handoff uses PowerShell literals for paths and shell-sensitive arguments',()=>{
 expect(formatSetupCommand(['setup','apply','--plugins','codex,cursor','--api',"https://example.test/a?$x='value'"],["C:\\Private install's\\opencrawl.cmd"],'win32'))
  .toBe("& 'C:\\Private install''s\\opencrawl.cmd' setup apply --plugins 'codex,cursor' --api 'https://example.test/a?$x=''value'''");
});

test('displayed command runs its launcher with exact arguments despite another opencrawl on PATH',()=>{
 const dir=mkdtempSync(join(tmpdir(),'opencrawl-handoff-'));
 try{
  const privateDir=join(dir,"private install's bin"),otherDir=join(dir,'other');mkdirSync(privateDir);mkdirSync(otherDir);
  const windows=process.platform==='win32',launcher=join(privateDir,windows?'opencrawl.ps1':'opencrawl');
  writeFileSync(launcher,windows?'ConvertTo-Json -InputObject @($args) -Compress':'#!/bin/sh\nprintf \'%s\\0\' "$@"\n',{mode:0o755});
  writeFileSync(join(otherDir,windows?'opencrawl.cmd':'opencrawl'),windows?'@exit /b 99':'#!/bin/sh\nexit 99\n',{mode:0o755});
  const args=['setup','status','--api',"https://example.test/path?x=$HOME&v='quoted'",'--plugins','codex,cursor','--empty',''];
  const shell=windows?join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'):'/bin/sh';
  const formatted=formatSetupCommand(args,[launcher]);
  // Verify command fidelity, allowing a bounded cold Windows PowerShell start.
  const run=spawnSync(shell,windows?['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',formatted]:['-c',formatted],{encoding:'utf8',env:{...process.env,PATH:otherDir},timeout:windows?15_000:5000});
  expect(run.error).toBeUndefined();expect(run.status).toBe(0);
  expect(windows?JSON.parse(run.stdout):run.stdout.split('\0').slice(0,-1)).toEqual(args);
 }finally{rmSync(dir,{recursive:true,force:true});}
},process.platform==='win32'?20_000:5000);


test('packaged runtime guides reuse the managed entry or matching package executable and leave source runs intact',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'opencrawl-setup-runtime-')));
 try{
  const root=join(dir,"runtime package's"),runtime=join(root,'runtime','opencrawl.js'),entry=join(dir,'resolver.ts'),installDir=join(dir,"private launcher's bin"),data=join(dir,'data');
  mkdirSync(dirname(runtime),{recursive:true});mkdirSync(join(root,'bin'));mkdirSync(installDir);mkdirSync(join(data,'opencrawl'),{recursive:true});
  const release='0.4.63',manifest=join(root,'package.json'),executable=join(root,'bin','opencrawl.exe'),platformExecutable=join(root,'bin',process.platform==='win32'?'opencrawl.exe':'opencrawl');
  writeFileSync(entry,'import {setupCommandForSelf} from '+JSON.stringify(resolve(import.meta.dir,'../src/setup/invocation.ts'))+'; console.log(JSON.stringify(setupCommandForSelf()));\n');
  const build=await Bun.build({entrypoints:[entry],outdir:dirname(runtime),naming:'opencrawl.js',target:'bun',define:{OPENCRAWL_VERSION:JSON.stringify(release)}});
  expect(build.success).toBe(true);
  const env={HOME:dir,USERPROFILE:dir,PATH:dirname(process.execPath),SystemRoot:process.env.SystemRoot,XDG_DATA_HOME:data,XDG_CACHE_HOME:join(dir,'cache'),OPENCRAWL_CONFIG_HOME:join(dir,'config'),OPENCRAWL_INSTALL_DIR:installDir};
  const invoke=(script=runtime)=>{const run=spawnSync(process.execPath,[script],{env,encoding:'utf8',timeout:5000});expect(run.status).toBe(0);expect(run.stderr).toBe('');return JSON.parse(run.stdout);};
  // Windows may preserve an 8.3 alias in fs.realpathSync while Bun argv uses
  // the long spelling. Verify each executable/script is the same actual file.
  const expectInvocation=(actual:string[],expected:string[])=>{
   expect(actual).toHaveLength(expected.length);
   for(let index=0;index<expected.length;index++){
    const observed=statSync(actual[index]),wanted=statSync(expected[index]);
    expect(observed.ino).toBeGreaterThan(0);expect(wanted.ino).toBeGreaterThan(0);
    expect({dev:observed.dev,ino:observed.ino}).toEqual({dev:wanted.dev,ino:wanted.ino});
   }
  };
  const fallback=[process.execPath,runtime];
  writeFileSync(manifest,JSON.stringify({name:'@getopencrawl/cli',version:release}));writeFileSync(executable,'fixture executable',{mode:0o755});
  expectInvocation(invoke(),[executable]);
  if(process.platform==='win32')expect(invoke()).toEqual([realpathSync.native(executable)]);
  writeFileSync(manifest,JSON.stringify({name:'@getopencrawl/cli-'+process.platform+'-'+process.arch,version:release}));writeFileSync(platformExecutable,'fixture executable',{mode:0o755});
  expectInvocation(invoke(),[platformExecutable]);
  if(process.platform==='win32')expect(invoke()).toEqual([realpathSync.native(platformExecutable)]);
  writeFileSync(manifest,JSON.stringify({name:'unrelated-package',version:release}));expectInvocation(invoke(),fallback);
  writeFileSync(manifest,JSON.stringify({name:'@getopencrawl/cli',version:'0.4.62'}));expectInvocation(invoke(),fallback);
  writeFileSync(manifest,JSON.stringify({name:'@getopencrawl/cli',version:release}));rmSync(executable);expectInvocation(invoke(),fallback);
  const managed=join(installDir,process.platform==='win32'?'opencrawl.cmd':'opencrawl'),receipt=join(data,'opencrawl','installation.json');
  writeFileSync(managed,'fixture private launcher',{mode:0o755});
  writeFileSync(receipt,JSON.stringify({managed:true,version:release,entry:managed}));expect(invoke()).toEqual([managed]);
  // A source checkout must not silently turn into the installed released CLI.
  expectInvocation(invoke(entry),[process.execPath,entry]);
  writeFileSync(receipt,JSON.stringify({managed:true,version:'0.4.62',entry:managed}));expectInvocation(invoke(),fallback);
  writeFileSync(receipt,JSON.stringify({managed:true,version:release,entry:join(dir,'unrelated')}));expectInvocation(invoke(),fallback);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
