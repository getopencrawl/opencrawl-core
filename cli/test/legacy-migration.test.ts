import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,readlinkSync,existsSync,readdirSync,chmodSync,realpathSync} from 'node:fs';
import {join,dirname,delimiter} from 'node:path';
import {tmpdir} from 'node:os';
import cmdShim from 'cmd-shim';
import {legacyRoot,migrateLegacyLauncher,migrateShim,findLegacyLaunchers} from '../src/legacy-migration.ts';
import {nativeBin,cacheRoot} from '../src/distribution.ts';

const original=readFileSync(new URL('./fixtures/legacy-launcher-0.4.60.cjs',import.meta.url));
async function fixture(run:(dir:string,launcher:string,entry:string,source:string)=>Promise<void>){
  const dir=mkdtempSync(join(tmpdir(),'opencrawl legacy ')),saved={...process.env};
  Object.assign(process.env,{XDG_DATA_HOME:join(dir,'data'),XDG_CACHE_HOME:join(dir,'cache'),OPENCRAWL_INSTALL_DIR:join(dir,'native bin')});
  const prefix=join(dir,'npm'),modules=join(prefix,...process.platform==='win32'?['node_modules']:['lib','node_modules']);
  const root=join(modules,'@getopencrawl','cli'),launcher=join(root,'bin/opencrawl.cjs');
  const entry=join(prefix,...process.platform==='win32'?['opencrawl']:['bin','opencrawl']);
  mkdirSync(join(root,'bin'),{recursive:true});mkdirSync(join(prefix,'bin'),{recursive:true});
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'@getopencrawl/cli',version:'0.4.60',bin:{opencrawl:'bin/opencrawl.cjs'}}));
  writeFileSync(launcher,original);chmodSync(launcher,0o755);
  if(process.platform==='win32')await cmdShim(launcher,entry);else symlinkSync(launcher,entry);
  const download=join(dir,'download'),source=join(download,'bin',process.platform==='win32'?'opencrawl.exe':'opencrawl');
  mkdirSync(join(download,'bin'),{recursive:true});mkdirSync(join(download,'runtime'));
  writeFileSync(source,'native fixture');
  for(const name of ['LICENSE','THIRD_PARTY_NOTICES.txt','runtime/opencrawl.js'])writeFileSync(join(download,name),'support fixture');
  try{await run(dir,launcher,entry,source);}finally{for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);rmSync(dir,{recursive:true,force:true});}
}

test('automatic migration changes the existing npm command without altering its legacy bridge or user data',()=>fixture(async(dir,launcher,entry,source)=>{
  const data=join(dir,'credential-and-queue-sentinel');writeFileSync(data,'keep exact private state');
  const result=await migrateLegacyLauncher({launcher,source,release:'0.4.63'});
  expect(result?.complete).toBe(true);expect(Object.values(result!.results)).toContain('migrated');
  expect(readFileSync(launcher)).toEqual(original);expect(readFileSync(data,'utf8')).toBe('keep exact private state');
  if(process.platform==='win32')expect(readFileSync(entry+'.cmd','utf8')).not.toContain('opencrawl.cjs');
  else expect(readlinkSync(entry)).toBe(nativeBin());
  expect(await migrateLegacyLauncher({launcher,source,release:'0.4.63'})).toBeUndefined();
  expect(await migrateLegacyLauncher({launcher,source,release:'0.4.64'})).toBeUndefined();
  // Reinstalling an old npm version restores its original shim. Detect that
  // change instead of treating an old successful receipt as permanent authority.
  if(process.platform==='win32')await cmdShim(launcher,entry);else{rmSync(entry);symlinkSync(launcher,entry);}
  expect((await migrateLegacyLauncher({launcher,source,release:'0.4.64'}))?.complete).toBe(true);
  expect(JSON.parse(readFileSync(join(cacheRoot(),'native-migration.json'),'utf8')).complete).toBe(true);
}));

test('modified launchers and custom commands survive automatic migration',()=>fixture(async(_dir,launcher,entry,source)=>{
  writeFileSync(launcher,Buffer.concat([original,Buffer.from('\n// local customization\n')]));
  expect(legacyRoot(launcher)).toBeUndefined();
  expect(await migrateLegacyLauncher({launcher,source,release:'0.4.63'})).toBeUndefined();
  expect(existsSync(nativeBin())).toBe(false);
  writeFileSync(launcher,original);
  if(process.platform==='win32')writeFileSync(entry+'.cmd','@echo custom command\r\n');
  else{rmSync(entry);writeFileSync(entry,'custom command');}
  expect((await migrateLegacyLauncher({launcher,source,release:'0.4.63'}))?.complete).toBe(false);
  expect(readFileSync(entry+(process.platform==='win32'?'.cmd':''),'utf8')).toContain('custom command');
}));

test('bootstrap discovery finds the original npm command and respects a preferred custom command',()=>fixture(async(dir,launcher,entry)=>{
  expect(findLegacyLaunchers([],dirname(entry)).map(file=>realpathSync(file))).toContain(realpathSync(launcher));
  const custom=join(dir,'custom');mkdirSync(custom);writeFileSync(join(custom,'opencrawl'+(process.platform==='win32'?'.cmd':'')),'custom');chmodSync(join(custom,'opencrawl'+(process.platform==='win32'?'.cmd':'')),0o755);
  expect(findLegacyLaunchers([],custom+delimiter+dirname(entry))).toEqual([]);
}));

test('Windows shim migration requires exact npm ownership for the whole command family',()=>fixture(async(dir,launcher,_entry,source)=>{
  const entry=join(dir,'windows command');await cmdShim(launcher,entry);
  const before=readFileSync(entry+'.cmd');
  writeFileSync(entry+'.ps1',readFileSync(entry+'.ps1','utf8')+'Write-Output custom\n');
  expect(await migrateShim(entry,launcher,'unused',source,true)).toBe('conflict');
  expect(readFileSync(entry+'.cmd')).toEqual(before);
  await cmdShim(launcher,entry);
  expect(await migrateShim(entry,launcher,'unused',source,true)).toBe('migrated');
  for(const suffix of ['','.cmd','.ps1'])expect(readFileSync(entry+suffix,'utf8')).not.toContain('opencrawl.cjs');
  expect(await migrateShim(entry,launcher,'unused',source,true)).toBe('current');
  expect(readdirSync(dir).some(name=>/\.(before|after)/.test(name))).toBe(false);
}));

test('the legacy entrypoint creates npm executable before linking without a separate install script',()=>fixture(async(dir,_launcher,_entry,source)=>{
  const root=join(dir,'package'),bin=join(root,'bin');mkdirSync(bin,{recursive:true});
  const command=join(bin,'opencrawl.cjs');
  writeFileSync(command,readFileSync(new URL('../bin/opencrawl.cjs',import.meta.url)));
  const platform=process.platform+'-'+process.arch,name='@getopencrawl/cli-'+platform;
  const native=join(root,'node_modules',name);mkdirSync(join(native,'bin'),{recursive:true});
  writeFileSync(join(native,'package.json'),JSON.stringify({name,version:'0.4.63'}));
  writeFileSync(join(native,'bin',process.platform==='win32'?'opencrawl.exe':'opencrawl'),readFileSync(source));
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'@getopencrawl/cli',version:'0.4.63',optionalDependencies:{[name]:'0.4.63'}}));
  const child=Bun.spawnSync([Bun.which('node')!,command,'--internal-npm-install'],{stdout:'pipe',stderr:'pipe'});
  expect(child.stderr.toString()).toBe('');expect(child.exitCode).toBe(0);
  expect(readFileSync(join(bin,'opencrawl.exe'),'utf8')).toBe('native fixture');
}));
