import {expect,test} from 'bun:test';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const modulePath=join(import.meta.dir,'../src/install-path.ts');
test.skipIf(process.platform==='win32')('reinstall preserves startup files and the shell resolves the literal custom install path',()=>{
 const home=mkdtempSync(join(tmpdir(),'opencrawl-path-'));
 try{
  const bin=join(home,"cli's $dollar bin"),entry=join(bin,'opencrawl');
  mkdirSync(bin);writeFileSync(entry,'#!/bin/sh\necho fixture\n',{mode:0o755});
  const shells=['/bin/bash','/bin/zsh'].filter(existsSync);
  for(const shell of shells){
   const bash=shell.endsWith('bash'),profile=join(home,bash?'.bashrc':'.zshrc');
   const env={HOME:home,SHELL:shell,PATH:'/usr/bin:/bin',ZDOTDIR:home};
   writeFileSync(profile,'# user setting');
   if(bash)writeFileSync(join(home,'.bash_profile'),'# existing login profile\n');
   const install=()=>Bun.spawnSync([process.execPath,'-e',"import {configureShellPath} from "+JSON.stringify(modulePath)+";console.log(configureShellPath(process.argv[1]));",entry],{env});
   expect(install().exitCode).toBe(0);
   const before=readFileSync(profile,'utf8');
   expect(before.startsWith('# user setting\n')).toBe(true);
   expect(install().exitCode).toBe(0);expect(readFileSync(profile,'utf8')).toBe(before);
   if(bash)expect(readFileSync(join(home,'.bash_profile'),'utf8')).toContain('# OpenCrawl CLI');
   const resolved=Bun.spawnSync([shell,'-ic','command -v opencrawl && opencrawl'],{env});
   expect(resolved.exitCode).toBe(0);
   expect(resolved.stdout.toString().trim().split('\n').slice(-2)).toEqual([entry,'fixture']);
  }
 }finally{rmSync(home,{recursive:true,force:true});}
});

test.skipIf(process.platform!=='darwin')('unset SHELL configures the macOS account login shell in a fresh home',()=>{
 const account=Bun.spawnSync(['/usr/bin/dscacheutil','-q','user','-a','uid',String(process.getuid?.())]).stdout.toString();
 const shell=account.match(/^shell:\s*(\/[^\r\n]+)$/m)?.[1];
 if(shell!=='/bin/zsh'&&shell!=='/bin/bash')return;
 const home=mkdtempSync(join(tmpdir(),'oc-login-shell-')),entry=join(home,'bin','opencrawl');
 try{
  mkdirSync(join(home,'bin'));writeFileSync(entry,'#!/bin/sh\nexit 0\n',{mode:0o755});
  const env={HOME:home,ZDOTDIR:home,PATH:'/usr/bin:/bin',SHELL:undefined};
  const install=Bun.spawnSync([process.execPath,'-e','import {configureShellPath} from '+JSON.stringify(modulePath)+'; configureShellPath(process.argv[1]);',entry],{env});
  expect(install.exitCode).toBe(0);
  const lookup=Bun.spawnSync([shell,'-ic','command -v opencrawl'],{env});
  expect(lookup.stdout.toString().trim().split('\n').at(-1)).toBe(entry);
 }finally{rmSync(home,{recursive:true,force:true});}
});
