import {existsSync,readFileSync,mkdirSync,mkdtempSync,renameSync,rmSync,chmodSync} from 'node:fs';
import {join,dirname,basename} from 'node:path';
import {createHash,timingSafeEqual} from 'node:crypto';
import {withFileLock} from './session.ts';
import {retryWindowsSharing} from './filesystem.ts';
import * as distribution from './distribution.ts';

const PACKAGE='@getopencrawl/cli',REGISTRY='https://registry.npmjs.org';
const MAX_ARCHIVE=160*1024*1024,MAX_UNPACKED=512*1024*1024;
const stages=new Set<string>();
// Hard hook deadlines and signals must not leave subprocesses behind. All
// automatic installation runs here, using the embedded runtime, with no children.
process.once('exit',()=>{for(const stage of stages)try{rmSync(stage,{recursive:true,force:true});}catch{}});
type Launcher={cacheRoot:()=>string;target:()=>string;stable:(v:string)=>boolean;activeRoot:()=>string;
  updateDue:(state:unknown)=>boolean;
  automaticUpdate:(options:{signal?:AbortSignal;install:(version:string)=>Promise<void>})=>Promise<unknown>};
function installedLauncher():Launcher|undefined {
  if(!distribution.compiled())return;
  return {...distribution,automaticUpdate:async options=>{
    try{return await distribution.update({...options,install:options.install});}
    catch(error){
      const {atomicJson}=await import('./session.ts');
      try{atomicJson(join(distribution.cacheRoot(),'update.json'),{nextCheckAt:Date.now()+15*60_000});}catch{}
      if(!options.signal?.aborted)throw error;
    }
  }};
}
export async function updateCli(){
  if(!distribution.compiled())throw new Error('Run update from the installed native executable.');
  const launcher=installedLauncher()!;
  return withFileLock(join(distribution.cacheRoot(),'update.lock'),()=>distribution.update({force:true,install:v=>installNativeRelease(v,{launcher})}));
}
function readState(file:string):unknown {try{return JSON.parse(readFileSync(file,'utf8'));}catch{return null;}}
async function bytes(response:Response,limit:number,signal?:AbortSignal) {
  if(!response.ok||!response.body)throw new Error('Update download failed');
  if(Number(response.headers.get('content-length'))>limit)throw new Error('Update download too large');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try {for(;;){signal?.throwIfAborted();const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new Error('Update download too large');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});}
  return Buffer.concat(chunks);
}

/** The two immutable npm artifacts have no runtime dependencies beyond the
 * platform package. Verify npm SHA-512 integrity, materialize only regular files
 * at allowlisted paths, then publish the same cache layout as the npm installer.
 * Never execute package scripts, archive links, npm, or an updater subprocess. */
export async function installNativeRelease(version:string,{launcher,signal,registry=REGISTRY,fetcher=fetch}: {
  launcher:Launcher;signal?:AbortSignal;registry?:string;fetcher?:typeof fetch;
}) {
  if(!launcher.stable(version))throw new Error('Invalid update version');
  const origin=new URL(registry);
  if(registry!==REGISTRY&&!(origin.protocol==='http:'&&['127.0.0.1','localhost'].includes(origin.hostname)))throw new Error('Invalid update registry');
  const target=launcher.target(),platformName=PACKAGE+'-'+target;
  const releases=join(launcher.cacheRoot(),'releases'),destination=join(releases,version);
  mkdirSync(releases,{recursive:true,mode:0o700});
  // The shared launcher validates a pre-existing complete publication.
  if(existsSync(destination))return;
  const stage=mkdtempSync(join(releases,'.stage-'));stages.add(stage);
  try {
    for(const name of [PACKAGE,platformName]) {
      signal?.throwIfAborted();
      const metadata=JSON.parse((await bytes(await fetcher(registry+'/'+encodeURIComponent(name)+'/'+version,{redirect:'error',signal}),1024*1024,signal)).toString());
      if(metadata.name!==name||metadata.version!==version||typeof metadata.dist?.integrity!=='string'||!/^sha512-[A-Za-z0-9+/]{86}==$/.test(metadata.dist.integrity))throw new Error('Invalid update metadata');
      const url=new URL(metadata.dist.tarball);
      if(url.origin!==origin.origin||url.username||url.password)throw new Error('Invalid update download origin');
      const archive=await bytes(await fetcher(url,{redirect:'error',signal}),MAX_ARCHIVE,signal);
      if(!timingSafeEqual(createHash('sha512').update(archive).digest(),Buffer.from(metadata.dist.integrity.slice(7),'base64')))throw new Error('Update integrity mismatch');
      signal?.throwIfAborted();
      const files=await new Bun.Archive(archive).files();
      const executable=name===PACKAGE?'bin/opencrawl.cjs':'bin/'+(target.startsWith('win32-')?'opencrawl.exe':'opencrawl');
      const allowed=new Set(['package.json',executable,'runtime/opencrawl.js','README.md','LICENSE','THIRD_PARTY_NOTICES.txt',...(name===PACKAGE?['bin/opencrawl.exe','install.cjs']:[])]);
      let size=0;
      for(const [path,file] of files) {
        if(!path.startsWith('package/')||!allowed.has(path.slice(8))||(size+=file.size)>MAX_UNPACKED)throw new Error('Invalid update archive');
      }
      for(const required of ['package.json',executable,'runtime/opencrawl.js','LICENSE','THIRD_PARTY_NOTICES.txt'])if(!files.has('package/'+required))throw new Error('Incomplete update archive');
      const manifest=JSON.parse(await files.get('package/package.json')!.text());
      if(manifest.name!==name||manifest.version!==version||Object.keys(manifest.dependencies??{}).length||name===PACKAGE&&manifest.optionalDependencies?.[platformName]!==version)throw new Error('Invalid update package');
      const directory=join(stage,'node_modules',...name.split('/'));
      for(const [path,file] of files) {
        signal?.throwIfAborted();const relative=path.slice(8),output=join(directory,relative);
        mkdirSync(dirname(output),{recursive:true,mode:0o700});
        await Bun.write(output,file);chmodSync(output,relative===executable?0o755:0o600);
      }
    }
    signal?.throwIfAborted();
    // Legacy npm updates can race native updates. Only complete releases become
    // visible; each native invocation selects the highest valid version.
    retryWindowsSharing(()=>{
      signal?.throwIfAborted();
      try{renameSync(stage,destination);}catch(error){if(!existsSync(destination))throw error;}
    });
  }finally{retryWindowsSharing(()=>rmSync(stage,{recursive:true,force:true}));stages.delete(stage);}
}

export async function refreshCli({signal,launcher=installedLauncher(),install}: {signal?:AbortSignal;launcher?:Launcher;install?:(version:string)=>Promise<void>}={}) {
  if(process.env.OPENCRAWL_NO_UPDATE==='1'||!launcher?.updateDue)return;
  const state=join(launcher.cacheRoot(),'update.json');
  if(!launcher.updateDue(readState(state)))return;
  try {await withFileLock(join(launcher.cacheRoot(),'update.lock'),async()=>{
    signal?.throwIfAborted();
    // Another command may have completed while this one reached the lock.
    if(!launcher.updateDue(readState(state)))return;
    await launcher.automaticUpdate({signal,install:install??(version=>installNativeRelease(version,{launcher,signal}))});
  },0,signal);}catch{} // A busy cache, sandbox or offline registry never blocks capture.
}

export function scheduleCliUpdate() {
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),90_000);timeout.unref();
  const done=refreshCli({signal:controller.signal}).catch(()=>{}).finally(()=>clearTimeout(timeout));
  return {stop:async()=>{controller.abort();await done;}};
}
