import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,lstatSync,readlinkSync,realpathSync,symlinkSync,renameSync,rmSync,accessSync,constants,existsSync} from 'node:fs';
import {basename,dirname,join,resolve,delimiter} from 'node:path';
import cmdShim from 'cmd-shim';
import {cacheRoot,installBinary,nativeRoot,read,stable,version} from './distribution.ts';
import {atomicJson,withFileLock} from './session.ts';

// Exact source hashes from the published Node launcher history. A changed
// launcher is a user customization, even if its package name still matches.
const launchers=new Set([
  '692998dc320dfd0caf99ed95e0b424ad39cff6cf6cd51b80d3a94061adef615d', // c07622dd
  'a91eaef546eb5a5122d38662af8c371911e347cb5506a289e58022fba3cafbb8', // c0729872
  '3a874ec00bbf7b7ca76148e3bb50679f3b72289ba0bd8d5c7c069e341e291f4b', // 363b8fd5
  '737389267ee68305707f5d579ed7a6979973075b6fd3aa5619206bf745fc1422', // 890dc750
  'e42bf51047dad4bd69f841c7bcc37468d51994ba6f52febdef33c57eecb0ac12', // 2ce5f82c
  'e74cea8fbb2a6de997bdc1a12b7c6dcaeeedbb4fa5427c2ca9afd8fe2a4fe229', // 21b394d0
  '30604b511ca1071bfdc0e02e3a5bc8a4870bcbb3bf3c6ab687dfdfcbe2993b97', // 1d286b62
  '0a1505eae193210d43f5c527dd49135f3059f4381356891f5b8b2649fd4cc9d3', // fc94977e
  '1301abe7d7545111f19e7e91b2ca0065513dbdce9c1dbfcdaa7a1eda15aecba2', // 6b022611
  'a08e5bac95c76445f34583e0885cc56414d6a28af4b3f080248f2d9bbd8f6ced', // d199b38a
  '5c6acd874e4b46bca803d039f8cafb6975fe2cf30a520ab29cf585554a3e2be0', // 7f0892ba
  '0c150ab0bbac8a7c61415ebc9e0c6faf40128552dfd5919f5c5d92090d562278', // 78a17d78
]);

export function legacyRoot(launcher:string):string|undefined {
  try {
    if(basename(launcher)!=='opencrawl.cjs')return;
    const root=dirname(dirname(launcher)),pkg=read(join(root,'package.json'));
    const bin=typeof pkg?.bin==='string'?pkg.bin:pkg?.bin?.opencrawl;
    if(pkg?.name!=='@getopencrawl/cli'||!stable(pkg.version)||bin!=='bin/opencrawl.cjs')return;
    if(!launchers.has(createHash('sha256').update(readFileSync(launcher)).digest('hex')))return;
    return root;
  }catch{return;}
}

// Early bootstraps launched the cached bridge in another Node process without
// retaining the original launcher environment. Discover the installed command
// too, rather than migrating only the cache's private .bin directory.
export function findLegacyLaunchers(hints:(string|undefined)[],path=process.env.PATH??''){
  const candidates=new Set(hints.filter((value):value is string=>Boolean(value)));
  for(const directory of path.split(delimiter).filter(Boolean)){
    if(process.platform==='win32'){
      if(!['','.exe','.cmd','.ps1'].some(suffix=>existsSync(join(directory,'opencrawl'+suffix))))continue;
      for(const file of [join(directory,'node_modules/@getopencrawl/cli/bin/opencrawl.cjs'),join(dirname(directory),'@getopencrawl/cli/bin/opencrawl.cjs')])if(legacyRoot(file))candidates.add(file);
      break;
    }else{
      try{accessSync(join(directory,'opencrawl'),constants.X_OK);const file=realpathSync(join(directory,'opencrawl'));if(legacyRoot(file))candidates.add(file);break;}catch{}
    }
  }
  return [...candidates];
}

type Outcome='migrated'|'current'|'absent'|'conflict';
function stat(file:string){try{return lstatSync(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}}
function fingerprint(file:string){
  const info=stat(file);if(!info)return;
  if(info.isSymbolicLink())return 'link:'+readlinkSync(file);
  if(info.isFile())return 'sha256:'+createHash('sha256').update(readFileSync(file)).digest('hex');
}
function unchanged(receipt:{commands?:Record<string,string>}){
  try{return receipt.commands&&Object.keys(receipt.commands).length>0&&Object.entries(receipt.commands).every(([file,value])=>fingerprint(file)===value);}catch{return false;}
}
export async function migrateShim(entry:string,launcher:string,nativeEntry:string,nativeExecutable:string,windows=process.platform==='win32'):Promise<Outcome> {
  if(!windows){
    const info=stat(entry);if(!info)return 'absent';
    if(!info.isSymbolicLink())return 'conflict';
    const original=readlinkSync(entry);
    if(resolve(dirname(entry),original)===resolve(nativeEntry))return 'current';
    try{if(realpathSync(entry)!==realpathSync(launcher))return 'conflict';}catch{return 'conflict';}
    const temporary=entry+'.'+randomUUID()+'.tmp';
    try{
      symlinkSync(nativeEntry,temporary);
      if(!lstatSync(entry).isSymbolicLink()||readlinkSync(entry)!==original)return 'conflict';
      renameSync(temporary,entry);
    }finally{rmSync(temporary,{force:true});}
    return 'migrated';
  }
  const suffixes=['','.cmd','.ps1'];
  const present=suffixes.filter(suffix=>stat(entry+suffix));
  if(!present.length)return 'absent';
  if(present.some(suffix=>!lstatSync(entry+suffix).isFile()))return 'conflict';
  const old=new Map(present.map(suffix=>[suffix,readFileSync(entry+suffix)]));
  // Render npm's exact shims alongside the originals, so relative targets are
  // identical. cmd-shim 6 (npm 10) and 8 (npm 11) use identical renderers.
  // Never let its unlink/write operations touch a user's live command.
  const before=entry+'.'+randomUUID()+'.before',after=entry+'.'+randomUUID()+'.after';
  try{
    await cmdShim(launcher,before);await cmdShim(nativeExecutable,after);
    if(present.some(suffix=>!old.get(suffix)!.equals(readFileSync(before+suffix))&&!old.get(suffix)!.equals(readFileSync(after+suffix))))return 'conflict';
    if(present.every(suffix=>old.get(suffix)!.equals(readFileSync(after+suffix))))return 'current';
    for(const suffix of present){
      if(!lstatSync(entry+suffix).isFile()||!readFileSync(entry+suffix).equals(old.get(suffix)!))return 'conflict';
      renameSync(after+suffix,entry+suffix);
    }
    return 'migrated';
  }finally{for(const name of [before,after])for(const suffix of suffixes)rmSync(name+suffix,{force:true});}
}

export async function migrateLegacyLauncher({launcher=process.env.OPENCRAWL_LAUNCHER,source=process.execPath,release=version,windows=process.platform==='win32'}:{launcher?:string;source?:string;release?:string;windows?:boolean}={}) {
  const receiptFile=join(cacheRoot(),'native-migration.json'),previous=read(receiptFile);
  launcher??=previous?.launcher;
  if(!launcher||!stable(release))return;
  const original=resolve(launcher),root=legacyRoot(original);if(!root)return;
  if(previous?.launcher===original&&previous.complete&&unchanged(previous))return;
  return withFileLock(join(cacheRoot(),'native-migration.lock'),async()=>{
    const prior=read(receiptFile);
    if(prior?.launcher===original&&prior.complete&&unchanged(prior))return;
    // Persist before mutation so a denied directory or interrupted Windows shim
    // replacement can be retried by a subsequent native invocation.
    atomicJson(receiptFile,{launcher:original,version:release,complete:false});
    const installed=await installBinary(source,release);
    const executable=join(nativeRoot(),'versions',installed.version,windows?'opencrawl.exe':'opencrawl');
    const modules=dirname(dirname(root));
    const entries=[join(modules,'.bin','opencrawl')];
    if(windows)entries.push(join(dirname(modules),'opencrawl'));
    else if(basename(dirname(modules))==='lib')entries.push(join(dirname(dirname(modules)),'bin','opencrawl'));
    const results:Record<string,Outcome>={};
    for(const entry of entries)results[entry]=await migrateShim(entry,original,installed.path,executable,windows);
    const complete=!Object.values(results).includes('conflict');
    const commands:Record<string,string>={};
    for(const [entry,outcome] of Object.entries(results))if(outcome==='migrated'||outcome==='current'){
      for(const suffix of windows?['','.cmd','.ps1']:['']){const value=fingerprint(entry+suffix);if(value)commands[entry+suffix]=value;}
    }
    atomicJson(receiptFile,{launcher:original,version:release,complete,results,commands});
    return {complete,results};
  },0);
}
