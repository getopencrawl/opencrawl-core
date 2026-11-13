import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,readdirSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {installBinary,nativeBin,nativeRoot,selectedBinary,update,cacheRoot} from '../src/distribution.ts';
const {install}=createRequire(import.meta.url)('../install.cjs');

async function fixture(run:(directory:string)=>Promise<void>){
  const dir=mkdtempSync(join(tmpdir(),'opencrawl-native-')),saved={...process.env};
  Object.assign(process.env,{XDG_DATA_HOME:join(dir,'data'),XDG_CACHE_HOME:join(dir,'cache'),OPENCRAWL_INSTALL_DIR:join(dir,'bin')});
  try{await run(dir);}finally{for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);rmSync(dir,{recursive:true,force:true});}
}
function executable(directory:string){
  mkdirSync(join(directory,'bin'),{recursive:true});mkdirSync(join(directory,'runtime'));
  const file=join(directory,'bin',process.platform==='win32'?'opencrawl.exe':'opencrawl');
  writeFileSync(file,'verified fixture executable');
  for(const name of ['LICENSE','THIRD_PARTY_NOTICES.txt','runtime/opencrawl.js'])writeFileSync(join(directory,name),'fixture support');
  return file;
}
test('native installation publishes complete versions, keeps older files and never downgrades the launcher',()=>fixture(async dir=>{
  const source=executable(join(dir,'download'));
  await installBinary(source,'1.1.0');const initial=nativeBin();expect(existsSync(initial)).toBe(true);
  await installBinary(source,'1.2.0');
  expect(selectedBinary('1.0.0').version).toBe('1.2.0');
  expect((await installBinary(source,'1.1.0')).version).toBe('1.2.0');
  expect(readdirSync(join(nativeRoot(),'versions'))).toEqual(['1.1.0','1.2.0']);
  expect(readFileSync(join(nativeRoot(),'versions/1.2.0/runtime/opencrawl.js'),'utf8')).toBe('fixture support');
}));
test('a custom command is preserved; an interrupted installation cannot become selected',()=>fixture(async dir=>{
  const source=executable(join(dir,'download'));mkdirSync(join(dir,'bin'));writeFileSync(nativeBin(),'user wrapper');
  await expect(installBinary(source,'1.0.0')).rejects.toMatchObject({code:'INSTALL_CONFLICT'});
  expect(readFileSync(nativeBin(),'utf8')).toBe('user wrapper');
  mkdirSync(join(nativeRoot(),'versions','9.0.0'));writeFileSync(join(nativeRoot(),'versions','9.0.0','installation.json'),JSON.stringify({version:'9.0.0',platform:process.platform+'-'+process.arch}));
  expect(selectedBinary('2.0.0').version).toBe('2.0.0');
  rmSync(nativeBin());
  expect((await installBinary(source,'1.0.0')).version).toBe('1.0.0');
}));
test('native update selection keeps a newer installation and persists its check without npm',()=>fixture(async dir=>{
  await installBinary(executable(join(dir,'download')),'1.2.0');let installs=0;
  const result=await update({force:true,current:'1.0.0',fetcher:Object.assign(async()=>Response.json({name:'@getopencrawl/cli',version:'1.1.0'}),{preconnect:()=>{}}),install:async()=>{installs++;}});
  expect(result).toEqual({updated:false,version:'1.2.0'});expect(installs).toBe(0);
  expect(JSON.parse(readFileSync(join(cacheRoot(),'update.json'),'utf8')).nextCheckAt).toBeGreaterThan(Date.now());
}));
test('npm postinstall places the exact platform executable and rejects mismatched packages before replacement',()=>fixture(async dir=>{
  const root=join(dir,'node_modules','@getopencrawl','cli'),platform=process.platform+'-'+process.arch;
  mkdirSync(join(root,'bin'),{recursive:true});const name='@getopencrawl/cli-'+platform;
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'@getopencrawl/cli',version:'1.0.0',optionalDependencies:{[name]:'1.0.0'}}));
  const native=join(dir,'node_modules','@getopencrawl','cli-'+platform);const file=executable(native);
  writeFileSync(join(native,'package.json'),JSON.stringify({name,version:'1.0.0'}));
  writeFileSync(join(root,'bin/opencrawl.exe'),'placeholder');install(root);
  expect(readFileSync(join(root,'bin/opencrawl.exe'))).toEqual(readFileSync(file));
  writeFileSync(join(native,'package.json'),JSON.stringify({name,version:'2.0.0'}));
  expect(()=>install(root)).toThrow('mismatch');
  expect(readFileSync(join(root,'bin/opencrawl.exe'),'utf8')).toBe('verified fixture executable');
}));
