import {existsSync,readFileSync,readdirSync,statSync,lstatSync,realpathSync,mkdirSync,mkdtempSync,copyFileSync,chmodSync,renameSync,rmSync,symlinkSync,readlinkSync,constants} from 'node:fs';
import {join,dirname,basename,resolve} from 'node:path';
import {homedir} from 'node:os';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {atomicJson,atomicFile,withFileLock} from './session.ts';
import {CliError} from './oauth.ts';

declare const OPENCRAWL_VERSION:string;
export const version=typeof OPENCRAWL_VERSION==='string'?OPENCRAWL_VERSION:'0.2.0-dev';
export const PACKAGE='@getopencrawl/cli',REGISTRY='https://registry.npmjs.org',CHANNEL='next';
export const cacheRoot=()=>join(process.env.XDG_CACHE_HOME||join(homedir(),'.cache'),'opencrawl');
export const nativeRoot=()=>join(process.env.XDG_DATA_HOME||join(homedir(),'.local','share'),'opencrawl');
export const nativeBin=()=>join(process.env.OPENCRAWL_INSTALL_DIR||join(homedir(),'.local','bin'),process.platform==='win32'?'opencrawl.cmd':'opencrawl');
export const stable=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v);
export function compare(a:string,b:string){if(!stable(a)||!stable(b))throw new Error('Invalid release version');const aa=a.split('.').map(BigInt),bb=b.split('.').map(BigInt);for(let i=0;i<3;i++)if(aa[i]!==bb[i])return aa[i]>bb[i]?1:-1;return 0;}
export function read(file:string):any{try{return JSON.parse(readFileSync(file,'utf8'));}catch{return null;}}
export function target(platform=process.platform,arch=process.arch){const key=platform+'-'+arch;if(!['darwin-arm64','darwin-x64','linux-arm64','linux-x64','win32-x64'].includes(key))throw new CliError('UNSUPPORTED_PLATFORM','No OpenCrawl executable for '+key);return key;}
export const releaseRoot=(v:string)=>join(cacheRoot(),'releases',v,'node_modules','@getopencrawl','cli');
export function binary(root:string){const name=PACKAGE+'-'+target(),manifest=createRequire(join(root,'package.json')).resolve(name+'/package.json'),pkg=read(manifest);if(pkg?.name!==name||pkg.version!==read(join(root,'package.json'))?.version)throw new Error('Platform package mismatch');return join(dirname(manifest),'bin',process.platform==='win32'?'opencrawl.exe':'opencrawl');}
export function validRelease(root:string,v:string){try{return read(join(root,'package.json'))?.name===PACKAGE&&read(join(root,'package.json'))?.version===v&&statSync(join(root,'bin/opencrawl.cjs')).isFile()&&statSync(binary(root)).isFile();}catch{return false;}}
const versions=(directory:string)=>{try{return readdirSync(directory).filter(stable).sort((a,b)=>compare(b,a));}catch{return [];}};
export function validNative(v:string){
  const directory=join(nativeRoot(),'versions',v),receipt=read(join(directory,'installation.json'));
  try{return stable(v)&&receipt?.version===v&&receipt.platform===target()&&[process.platform==='win32'?'opencrawl.exe':'opencrawl','LICENSE','THIRD_PARTY_NOTICES.txt','runtime/opencrawl.js'].every(file=>statSync(join(directory,file)).isFile());}catch{return false;}
}
export function activeRoot(){return versions(join(cacheRoot(),'releases')).map(releaseRoot).find(root=>validRelease(root,read(join(root,'package.json'))?.version))||'';}
export function selectedBinary(current=version):{version:string;file:string}{
  let selected={version:current,file:process.execPath};if(!stable(current))return selected;
  const cached=activeRoot(),pkg=cached?read(join(cached,'package.json')):null;
  if(pkg&&compare(pkg.version,selected.version)>0)selected={version:pkg.version,file:binary(cached)};
  for(const v of versions(join(nativeRoot(),'versions'))){if(compare(v,selected.version)<=0)break;if(validNative(v)){selected={version:v,file:join(nativeRoot(),'versions',v,process.platform==='win32'?'opencrawl.exe':'opencrawl')};break;}}
  return selected;
}
// Source and replaceable-runtime development runs must never install the Bun
// interpreter as if it were the compiled application.
export const compiled=()=>stable(version)&&!/\.[cm]?[jt]s$/.test(process.argv[1]||'')&&!/^bun(?:\.exe)?$/.test(basename(process.execPath));
export function commandForBinary(){
  const receipt=read(join(nativeRoot(),'installation.json'));
  return receipt?.managed&&stable(receipt.version)&&compare(receipt.version,version)>=0&&receipt.entry===nativeBin()&&existsSync(receipt.entry)?receipt.entry:process.execPath;
}
export function delegateToNewest(args:string[]):number|undefined{
  if(!compiled())return;const selected=selectedBinary();if(selected.version===version)return;
  // exec preserves the harness-owned PID and stdin on Unix. Windows has no exec;
  // wait for the child and propagate its status without starting a Node runtime.
  if(process.platform!=='win32'){if(!process.execve)throw new Error('Native exec is unavailable');process.execve(selected.file,[selected.file,...args],process.env);}
  const child=spawnSync(selected.file,args,{stdio:'inherit',windowsHide:true});
  if(child.error)throw child.error;return child.signal==='SIGINT'?130:child.status??1;
}
export const HOUR=60*60*1000;
export function updateDue(state:any,now=Date.now()){const next=Number.isFinite(state?.nextCheckAt)?state.nextCheckAt:(state?.checkedAt||0)+6*HOUR;return !state||next<=now||next>now+6*HOUR;}
export async function update({force=false,fetcher=fetch,install,signal,now=Date.now,random=Math.random,current=version}:{force?:boolean;fetcher?:typeof fetch;install:(v:string)=>Promise<void>;signal?:AbortSignal;now?:()=>number;random?:()=>number;current?:string}){
  const stateFile=join(cacheRoot(),'update.json'),before=selectedBinary(current).version;
  if(!force&&!updateDue(read(stateFile),now()))return {updated:false,version:before};
  const response=await fetcher(REGISTRY+'/@getopencrawl%2fcli/'+CHANNEL,{redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10_000)]):AbortSignal.timeout(10_000)});
  if(!response.ok)throw new CliError('UPDATE_UNAVAILABLE','Could not check the OpenCrawl release channel. Retry opencrawl update.');
  const latest=await response.json() as {name?:string;version?:string};
  if(latest.name!==PACKAGE||!stable(latest.version))throw new Error('Invalid release metadata');
  if(compare(latest.version,before)>0){await install(latest.version);signal?.throwIfAborted();if(!validRelease(releaseRoot(latest.version),latest.version))throw new Error('Incomplete release');}
  const selected=selectedBinary(current);
  atomicJson(join(cacheRoot(),'current.json'),{version:selected.version});
  if(read(join(nativeRoot(),'installation.json'))?.managed===true&&selected.version!==before)await installBinary(selected.file,selected.version);
  const checkedAt=now();atomicJson(stateFile,{checkedAt,nextCheckAt:checkedAt+3*HOUR+Math.floor(random()*3*HOUR)});
  return {updated:compare(selected.version,before)>0,version:selected.version};
}

/** Install an already verified executable alongside older versions. Never modify
 * a running executable, a custom launcher, credentials, transcripts or queues. */
export async function installBinary(source=process.execPath,v=version){
  if(!stable(v))throw new CliError('INSTALL_UNAVAILABLE','Build or download a released OpenCrawl executable before installing.');
  return withFileLock(join(nativeRoot(),'install.lock'),async()=>{
    const directory=join(nativeRoot(),'versions',v),file=join(directory,process.platform==='win32'?'opencrawl.exe':'opencrawl');
    if(!existsSync(directory)){
      mkdirSync(dirname(directory),{recursive:true,mode:0o700});const stage=mkdtempSync(join(dirname(directory),'.stage-'));
      try{
        copyFileSync(source,join(stage,basename(file)),constants.COPYFILE_FICLONE);chmodSync(join(stage,basename(file)),0o755);
        const support=dirname(dirname(source));
        for(const relative of ['LICENSE','THIRD_PARTY_NOTICES.txt','runtime/opencrawl.js']){
          const from=join(support,relative);if(!existsSync(from))throw new Error('Native installation is missing '+relative);
          mkdirSync(dirname(join(stage,relative)),{recursive:true,mode:0o700});copyFileSync(from,join(stage,relative),constants.COPYFILE_FICLONE);
        }
        atomicJson(join(stage,'installation.json'),{version:v,platform:target()});renameSync(stage,directory);
      }finally{rmSync(stage,{recursive:true,force:true});}
    }
    if(!validNative(v))throw new Error('Incomplete native installation');
    const entry=nativeBin(),receiptFile=join(nativeRoot(),'installation.json'),prior=read(receiptFile);
    const candidates=versions(join(nativeRoot(),'versions')).filter(validNative);
    const selected=candidates[0]||v,selectedFile=join(nativeRoot(),'versions',selected,basename(file));
    // Only replace a path this installer owns. Keep a hand-written wrapper intact.
    let owned=false;
    try{owned=process.platform==='win32'?prior?.entry===entry&&readFileSync(entry,'utf8')===prior.launcher:lstatSync(entry).isSymbolicLink()&&readlinkSync(entry).startsWith(join(nativeRoot(),'versions')+'/');}catch(error:any){if(error.code!=='ENOENT')throw error;}
    if(existsSync(entry)&&!owned)throw new CliError('INSTALL_CONFLICT','A custom command already exists at '+entry+'. Move it aside before running opencrawl install.');
    mkdirSync(dirname(entry),{recursive:true});
    const launcher=process.platform==='win32'?`@echo off\r\n"${selectedFile.replace(/%/g,'%%')}" %*\r\n`:undefined;
    if(launcher)atomicFile(entry,launcher);else{const temporary=entry+'.'+randomUUID()+'.tmp';try{symlinkSync(selectedFile,temporary);renameSync(temporary,entry);}finally{rmSync(temporary,{force:true});}}
    atomicJson(receiptFile,{managed:true,entry,version:selected,...launcher?{launcher}:{}});
    return {version:selected,path:entry,installed:true};
  });
}
