import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {refreshCli,installNativeRelease} from '../src/update.ts';
const require=createRequire(import.meta.url),cli=require('../bin/opencrawl.cjs');
const {makePackage}=require('./fixtures/launcher-update.cjs');
const HOUR=60*60*1000;

async function fixture(run:(f:{dir:string;root:string;cache:string;launcher:any})=>Promise<void>) {
  const dir=mkdtempSync(join(tmpdir(),'opencrawl-auto-update-')),previous={...process.env};
  process.env.XDG_CACHE_HOME=join(dir,'cache');delete process.env.OPENCRAWL_NO_UPDATE;
  const root=makePackage(join(dir,'installed'),'0.1.0'),cache=cli.cacheRoot();
  const launcher={...cli,activeRoot:()=>cli.activeRoot(root),automaticUpdate:(options:object)=>cli.automaticUpdate({...options,root})};
  try{await run({dir,root,cache,launcher});}finally{
    for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);
    rmSync(dir,{recursive:true,force:true});
  }
}
function registry(version='0.2.0',change:(name:string,files:Record<string,string>,metadata:any)=>void=()=>{}) {
  const origin='http://127.0.0.1:9345',target=cli.target(),name='@getopencrawl/cli';
  const data=new Map<string,{metadata:any;files:Record<string,string>}>();
  for(const pkg of [name,name+'-'+target]) {
    const manifest={name:pkg,version,...pkg===name?{optionalDependencies:{[name+'-'+target]:version}}:{}};
    const files:Record<string,string>={'package/package.json':JSON.stringify(manifest),['package/'+(pkg===name?'bin/opencrawl.cjs':'bin/'+(target.startsWith('win32-')?'opencrawl.exe':'opencrawl'))]:'synthetic executable fixture',
      'package/runtime/opencrawl.js':'synthetic runtime','package/LICENSE':'fixture','package/THIRD_PARTY_NOTICES.txt':'fixture'};
    const metadata={...manifest,dist:{tarball:origin+'/'+encodeURIComponent(pkg)+'.tgz',integrity:''}};
    change(pkg,files,metadata);data.set(pkg,{metadata,files});
  }
  let requests=0;
  const fetcher=Object.assign(async(input:RequestInfo|URL)=>{
    requests++;const path=decodeURIComponent(new URL(String(input)).pathname).slice(1);
    const tar=path.endsWith('.tgz'),item=data.get(tar?path.slice(0,-4):path.slice(0,-version.length-1));
    if(!item)return new Response('',{status:404});
    const bytes=await new Bun.Archive(item.files,{compress:'gzip'}).bytes();
    if(tar)return new Response(bytes);
    return Response.json({...item.metadata,dist:{...item.metadata.dist,integrity:item.metadata.dist.integrity||'sha512-'+createHash('sha512').update(bytes).digest('base64')}});
  },{preconnect:()=>{}}) as typeof fetch;
  return {origin,fetcher,get requests(){return requests;}};
}

test('successful checks persist one jittered 3–6 hour deadline and migrate daily receipts',async()=>fixture(async({root,cache})=>{
  const now=Date.now();let requests=0;
  const fetcher=async()=>{requests++;return Response.json({name:'@getopencrawl/cli',version:'0.1.0'});};
  for(const random of [0,0.5,0.999999]) {
    await cli.update({force:true,root,fetcher,now:()=>now,random:()=>random});
    const state=JSON.parse(readFileSync(join(cache,'update.json'),'utf8'));
    expect(state.nextCheckAt-now).toBeGreaterThanOrEqual(3*HOUR);expect(state.nextCheckAt-now).toBeLessThanOrEqual(6*HOUR);
    expect(cli.updateDue(state,state.nextCheckAt-1)).toBe(false);expect(cli.updateDue(state,state.nextCheckAt)).toBe(true);
    const before=requests;await cli.update({root,fetcher,now:()=>now});expect(requests).toBe(before);
  }
  expect(cli.updateDue({checkedAt:now-5*HOUR},now)).toBe(false);
  expect(cli.updateDue({checkedAt:now-6*HOUR},now)).toBe(true);
  expect(cli.updateDue({nextCheckAt:now+25*HOUR},now)).toBe(true);
}));

test('one opportunistic updater owns the shared cache and failure backs off without changing the installed version',async()=>fixture(async({root,cache,launcher})=>{
  let calls=0,release!:()=>void;
  const gate=new Promise<void>(r=>release=r);
  launcher.automaticUpdate=(options:object)=>cli.automaticUpdate({...options,root,fetcher:async()=>{calls++;await gate;throw new Error('offline');}});
  const first=refreshCli({launcher});await Bun.sleep(20);
  await Promise.all(Array.from({length:12},()=>refreshCli({launcher})));expect(calls).toBe(1);
  release();await first;
  const state=JSON.parse(readFileSync(join(cache,'update.json'),'utf8'));
  expect(state.checkedAt).toBeUndefined();expect(state.nextCheckAt-Date.now()).toBeGreaterThan(14*60*1000);
  await refreshCli({launcher});expect(calls).toBe(1);expect(cli.activeRoot(root)).toBe(root);
}));

test('automatic installer verifies and publishes both packages without subprocesses',async()=>fixture(async({root,cache,launcher})=>{
  const r=registry();
  await installNativeRelease('0.2.0',{launcher,registry:r.origin,fetcher:r.fetcher});
  expect(r.requests).toBe(4);
  expect(cli.activeRoot(root)).toBe(join(cache,'releases/0.2.0/node_modules/@getopencrawl/cli'));
  expect(readFileSync(cli.binary(cli.activeRoot(root)),'utf8')).toBe('synthetic executable fixture');
  expect(readdirSync(join(cache,'releases'))).toEqual(['0.2.0']);
}));

test('bad integrity, external tarballs, unexpected files and mismatched manifests cannot publish an update',async()=>fixture(async({root,cache,launcher})=>{
  for(const mutate of [
    (_:string,_files:Record<string,string>,meta:any)=>{meta.dist.integrity='sha512-'+'A'.repeat(86)+'==';},
    (_:string,_files:Record<string,string>,meta:any)=>{meta.dist.tarball='https://foreign.example/package.tgz';},
    (_:string,files:Record<string,string>)=>{files['package/../../escape']='bad';},
    (_:string,files:Record<string,string>)=>{files['package/unexpected']='bad';},
    (_:string,files:Record<string,string>)=>{files['package/package.json']='{"name":"wrong","version":"0.2.0"}';},
  ]) {
    const r=registry('0.2.0',mutate);
    await expect(installNativeRelease('0.2.0',{launcher,registry:r.origin,fetcher:r.fetcher})).rejects.toThrow();
    expect(cli.activeRoot(root)).toBe(root);expect(readdirSync(join(cache,'releases'))).toEqual([]);
  }
}));

test('cancellation discards staging and explicit opt-out prevents any automatic work',async()=>fixture(async({cache,launcher})=>{
  const r=registry(),controller=new AbortController();let calls=0;
  const fetcher=Object.assign(async(...args:Parameters<typeof fetch>)=>{const result=await r.fetcher(...args);if(++calls===3)controller.abort();return result;},{preconnect:()=>{}}) as typeof fetch;
  await expect(installNativeRelease('0.2.0',{launcher,registry:r.origin,fetcher,signal:controller.signal})).rejects.toThrow();
  expect(readdirSync(join(cache,'releases'))).toEqual([]);
  process.env.OPENCRAWL_NO_UPDATE='1';launcher.automaticUpdate=()=>{throw new Error('must not run');};
  await refreshCli({launcher});expect(existsSync(join(cache,'update.json'))).toBe(false);
}));

test('development hook entrypoints do not load an npm launcher or start update subprocesses',async()=>fixture(async({dir})=>{
  const file=join(dir,'forbidden.cjs');writeFileSync(file,"throw new Error('Node launcher must not load')");
  const code=resolve(import.meta.dir,'../src/cli.ts');
  for(const args of [['collect','hook','--harness','codex'],['collect','hook','--managed','--harness','codex'],['collect','worker']]) {
    const child=Bun.spawn([process.execPath,code,...args],{env:{...process.env,OPENCRAWL_LAUNCHER:file,OPENCRAWL_CONFIG_HOME:join(dir,'config')},stdin:new Blob(['{}']),stdout:'ignore',stderr:'pipe'});
    expect(await child.exited).toBe(0);
  }
}));
