import {test, expect} from 'bun:test';
import {mkdtempSync, rmSync, statSync, readFileSync, existsSync, writeFileSync, mkdirSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {saveSession, sessionFile, accessToken, readSession, logout,withSessionLock} from '../src/session.ts';

test('separate deployments, restrictive permissions, concurrent refresh and logout', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencrawl-session-'));
  const previous = process.env.OPENCRAWL_CONFIG_HOME;
  process.env.OPENCRAWL_CONFIG_HOME = directory;
  try {
    const api = 'https://api.example';
    await saveSession(api, {auth: {clientId: 'public', deviceAuthorizationEndpoint: 'https://auth.example/device', tokenEndpoint: 'https://auth.example/token'}, accessToken: 'expired', refreshToken: 'refresh-1', expiresAt: 0});
    if (process.platform !== 'win32') expect(statSync(sessionFile(api)).mode & 0o777).toBe(0o600);
    expect(readSession('https://different.example')).toBeNull();
    let calls = 0;
    const fetcher: any = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 20)); return new Response(JSON.stringify({access_token: 'fresh', refresh_token: 'refresh-2', expires_in: 300})); };
    expect(await Promise.all([accessToken(api, undefined, fetcher), accessToken(api, undefined, fetcher)])).toEqual(['fresh', 'fresh']);
    expect(calls).toBe(1);
    expect(JSON.parse(readFileSync(sessionFile(api), 'utf8')).refreshToken).toBe('refresh-2');
    await logout(api);
    expect(readSession(api)).toBeNull();
    await expect(accessToken(api)).rejects.toMatchObject({code: 'AUTH_REQUIRED'});
  } finally {
    if (previous === undefined) delete process.env.OPENCRAWL_CONFIG_HOME; else process.env.OPENCRAWL_CONFIG_HOME = previous;
    rmSync(directory, {recursive: true, force: true});
  }
});


test('simultaneous processes recover a killed owner without admitting two critical sections',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'opencrawl-lock-crash-'));
 const module=resolve(import.meta.dir,'../src/session.ts'),exclusive=join(directory,'exclusive'),ready=join(directory,'ready');
 const env={...process.env,OPENCRAWL_CONFIG_HOME:directory};
 const children:ReturnType<typeof Bun.spawn>[]=[];
 const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
 const waitFor=async(fn:()=>boolean)=>{const deadline=Date.now()+5000;while(!fn()){if(Date.now()>deadline)throw Error('lock probe timed out');await sleep(10);}};
 const spawn=(code:string)=>{const c=Bun.spawn([process.execPath,'-e',code],{env,stdout:'ignore',stderr:'pipe'});children.push(c);return c;};
 try{
  const owner=spawn(`import {withSessionLock} from ${JSON.stringify(module)};import{writeFileSync}from'node:fs';await withSessionLock('crash',async()=>{writeFileSync(${JSON.stringify(ready)},'ready');await new Promise(()=>{});});`);
  await waitFor(()=>existsSync(ready));owner.kill('SIGKILL');await owner.exited;
  const contenders=Array.from({length:16},()=>spawn(`import {withSessionLock} from ${JSON.stringify(module)};import{openSync,closeSync,unlinkSync}from'node:fs';for(let n=0;n<3;n++)await withSessionLock('crash',async()=>{const fd=openSync(${JSON.stringify(exclusive)},'wx');await new Promise(r=>setTimeout(r,4));closeSync(fd);unlinkSync(${JSON.stringify(exclusive)});});`));
  expect(await Promise.all(contenders.map(c=>c.exited))).toEqual(Array(16).fill(0));
  expect(existsSync(exclusive)).toBe(false);
 }finally{for(const child of children){child.kill();await child.exited;}rmSync(directory,{recursive:true,force:true});}
},15000);

test('a crash while publishing a PID marker never leaves an empty legacy lock',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'opencrawl-marker-crash-')),previous=process.env.OPENCRAWL_CONFIG_HOME;
 const module=resolve(import.meta.dir,'../src/session.ts');process.env.OPENCRAWL_CONFIG_HOME=directory;
 try{
  for(const timing of ['before','after']){
   const key='marker-'+timing,marker=sessionFile(key)+'.lock',reached=join(directory,'reached-'+timing);
   const code=`
    import {mock} from 'bun:test';
    import * as fs from 'node:fs';
    const original={...fs},paths=new Map();
    const marker=${JSON.stringify(marker)},timing=${JSON.stringify(timing)};
    const crash=()=>{original.writeFileSync(${JSON.stringify(reached)},timing);process.kill(process.pid,'SIGKILL');};
    mock.module('node:fs',()=>({...original,
      openSync:(path,...args)=>{const fd=original.openSync(path,...args);paths.set(fd,String(path));return fd;},
      writeFileSync:(target,...args)=>{
        const path=typeof target==='number'?paths.get(target):String(target);
        const matches=path===marker||path?.startsWith(marker+'.');
        if(matches&&timing==='before')crash();
        const result=original.writeFileSync(target,...args);
        if(matches&&timing==='after')crash();
        return result;
      }
    }));
    const {withSessionLock}=await import(${JSON.stringify(module)});
    await withSessionLock(${JSON.stringify(key)},async()=>{});
   `;
   const child=Bun.spawn([process.execPath,'-e',code],{env:process.env,stdout:'ignore',stderr:'pipe'});
   try{
    expect(await child.exited).not.toBe(0);
    expect(readFileSync(reached,'utf8')).toBe(timing);
    expect(existsSync(marker)&&readFileSync(marker,'utf8')==='').toBe(false);
    let acquired=false;await withSessionLock(key,async()=>{acquired=true;},1000);expect(acquired).toBe(true);
   }finally{child.kill();await child.exited;}
  }
 }finally{if(previous===undefined)delete process.env.OPENCRAWL_CONFIG_HOME;else process.env.OPENCRAWL_CONFIG_HOME=previous;rmSync(directory,{recursive:true,force:true});}
});

test('process exit releases ownership and a live legacy owner is never evicted',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'opencrawl-lock-exit-')),previous=process.env.OPENCRAWL_CONFIG_HOME;
 process.env.OPENCRAWL_CONFIG_HOME=directory;
 const module=resolve(import.meta.dir,'../src/session.ts');
 try{
  const child=Bun.spawn([process.execPath,'-e',`import{withSessionLock}from ${JSON.stringify(module)};await withSessionLock('exit',async()=>process.exit(0));`],{env:process.env,stdout:'ignore',stderr:'pipe'});
  expect(await child.exited).toBe(0);
  expect(existsSync(sessionFile('exit')+'.lock')).toBe(false);
  const {withSessionLock}=await import('../src/session.ts');
  await withSessionLock('exit',async()=>{});
  const legacy=sessionFile('legacy')+'.lock';mkdirSync(join(legacy,'..'),{recursive:true});writeFileSync(legacy,String(process.pid));
  await expect(withSessionLock('legacy',async()=>{},0)).rejects.toMatchObject({code:'SESSION_BUSY'});
  expect(readFileSync(legacy,'utf8')).toBe(String(process.pid));unlinkSync(legacy);
  const replacement=sessionFile('replacement')+'.lock';
  await withSessionLock('replacement',async()=>{unlinkSync(replacement);writeFileSync(replacement,'replacement');});
  expect(readFileSync(replacement,'utf8')).toBe('replacement');
 }finally{if(previous===undefined)delete process.env.OPENCRAWL_CONFIG_HOME;else process.env.OPENCRAWL_CONFIG_HOME=previous;rmSync(directory,{recursive:true,force:true});}
});
