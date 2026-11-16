import {existsSync,lstatSync,readFileSync,writeFileSync,renameSync,unlinkSync,chmodSync,statSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {atomicFile,atomicJson,configDir,withSessionLock} from '../session.ts';
import {readCaptureConfig,type CaptureConfig} from '../capture/runtime.ts';
import {reconcileHookEntries,reconcileHookGroups} from '../hook-config.ts';
import {retryWindowsSharing} from '../filesystem.ts';
import {CliError} from '../oauth.ts';
import {hookRunner,quote} from '../hook-runner.ts';
import {searchContextMarker} from '../search-context.ts';
import type {SetupScope} from './state.ts';

type RecordValue=Record<string,unknown>;
const record=(value:unknown):value is RecordValue=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const matchesScope=(config:CaptureConfig,scope:SetupScope)=>config.api===scope.api&&config.owner.tenantId===scope.tenantId&&config.owner.userId===scope.userId;
function runnerCommand(command:unknown,area:'capture'|'startup',client:string):boolean {
 if(typeof command!=='string')return false;
 const runner=hookRunner(area,[]),file=runner.file;
 const prefixes=new Set([runner.invocation(client).command,(process.platform==='win32'?'':'/bin/sh ')+quote(file)]);
 if(/^[\w@%+=:,./-]+$/.test(file))prefixes.add((process.platform==='win32'?'':'/bin/sh ')+file);
 const arguments_:string[][]=area==='startup'?[['session','start','--harness',client],['session','start','--harness',client,'--after-tool'],['search-context','--harness',client]]
  :[['collect','hook','--harness',client],['collect','hook','--managed','--harness',client],...['SessionStart','PostToolUse','PostInvocation','Stop'].map(event=>['collect','hook','--harness',client,'--event',event])];
 const suffixes=arguments_.flatMap(args=>[args.join(' '),args.slice(0,2).join(' ')+' '+args.slice(2).map(quote).join(' ')]);
 return [...prefixes].some(prefix=>suffixes.some(suffix=>command===prefix+' '+suffix));
}
function ownedHook(value:unknown,client:string):boolean{return record(value)&&(['capture','startup'] as const).some(area=>(client==='cursor'||value.statusMessage==='OpenCrawl session '+area||area==='startup'&&value.statusMessage===searchContextMarker)&&runnerCommand(value.command,area,client));}
function foreignCodexKeysUnchanged(before:Record<string,unknown[]>,after:Record<string,unknown[]>):boolean{
 return Object.entries(before).every(([event,groups])=>groups.every((group,g)=>{
  if(!record(group)||!Array.isArray(group.hooks))return isDeepStrictEqual(group,after[event]?.[g]);
  const next=after[event]?.[g];
  return group.hooks.every((hook,h)=>ownedHook(hook,'codex')||record(next)&&Array.isArray(next.hooks)&&isDeepStrictEqual(hook,next.hooks[h]));
 }));
}
function nextHooks(config:RecordValue,client:string):RecordValue {
 if(client==='antigravity'){
  const next={...config};
  for(const area of ['capture','startup'] as const){
   const name='opencrawl-'+area,bundle=config[name];if(!record(bundle))continue;
   // Keep disabled native choices; remove only matching entries from mixed bundles.
   if(bundle.enabled===false)continue;
   let removed=0;
   const strip=(entries:unknown[]):unknown[]=>entries.flatMap(entry=>{
    if(!record(entry))return [entry];
    if(runnerCommand(entry.command,area,client)){removed++;return [];}
    if(Array.isArray(entry.hooks)){const hooks=strip(entry.hooks);return hooks.length||!entry.hooks.length?[{...entry,hooks}]:[];}
    return [entry];
   });
   const cleaned=Object.fromEntries(Object.entries(bundle).map(([event,value])=>[event,Array.isArray(value)?strip(value):value]));
   if(removed)next[name]=cleaned;
  }
  return next;
 }
 if(config.hooks===undefined)return config;
 if(!record(config.hooks)||Object.values(config.hooks).some(value=>!Array.isArray(value)))throw new CliError('PLUGIN_HOOK_MIGRATION_INVALID','Existing native hooks are invalid; no legacy hooks were removed.');
 const owned=(value:unknown)=>ownedHook(value,client);
 const hooks=config.hooks as Record<string,unknown[]>;
 return {...config,hooks:client==='cursor'?reconcileHookEntries(hooks,{},owned):reconcileHookGroups(hooks,{},owned)};
}
function replace(file:string,bytes:string|Buffer,mode:number){
 const temp=file+'.'+randomUUID()+'.tmp';
 try{writeFileSync(temp,bytes,{mode:0o600,flag:'wx'});chmodSync(temp,mode);retryWindowsSharing(()=>renameSync(temp,file));}finally{try{unlinkSync(temp);}catch{}}
}
function referencesRunner(config:CaptureConfig,file:string):boolean{
 const spellings=[file,file.replace(/'/g,"'\\''"),file.replace(/'/g,"''"),file.replace(/%/g,'%%')];
 const references=(value:unknown):boolean=>{if(Array.isArray(value))return value.some(references);if(!record(value))return false;const command=value.command;return typeof command==='string'&&spellings.some(path=>command.includes(path))||Object.values(value).some(references);};
 return ['claude-code','codex','cursor','antigravity'].some(client=>{
  const root=config.roots[client as keyof CaptureConfig['roots']];if(!root)return false;
  const path=client==='antigravity'?join(root,'config','hooks.json'):join(root,client==='claude-code'?'settings.json':'hooks.json');
  if(!existsSync(path))return false;
  try{return references(JSON.parse(readFileSync(path,'utf8')));}catch{throw new CliError('PLUGIN_HOOK_MIGRATION_INVALID','Existing native hooks are invalid; no legacy runner was changed.');}
 });
}

export type LegacyPluginMigration={installationId:string;command:string[];runners:{file:string;before:Buffer;after:string;mode:number}[]};
/** Preflight before setup writes any state. Never redirect an unknown legacy
 * runner, even if its filename looks owned. */
export function prepareLegacyPluginMigration(scope:SetupScope,previous:CaptureConfig|null,command:string[]):LegacyPluginMigration|null{
 if(!previous||previous.hookOwnership==='plugin')return null;
 if(!matchesScope(previous,scope))throw new CliError('SETUP_SCOPE_CHANGED','This collector belongs to a different destination. Preserve its queue and use a separate CLI profile for this deployment.');
 const runners:LegacyPluginMigration['runners']=[];
 for(const area of ['capture','startup'] as const){
  const old=hookRunner(area,previous.command),next=hookRunner(area,command);
  if(referencesRunner(previous,join(configDir(),area,'runner.cjs')))throw new CliError('PLUGIN_HOOK_MIGRATION_INVALID','An older runner needs an explicit legacy upgrade before plugin migration. Existing recording is unchanged.');
  if(!existsSync(old.file))continue;
  if(lstatSync(old.file).isSymbolicLink())throw new CliError('PLUGIN_HOOK_MIGRATION_INVALID','A legacy runner is a symbolic link; existing recording is unchanged.');
  const before=readFileSync(old.file);
  if(before.toString()!==old.script&&before.toString()!==next.script)throw new CliError('PLUGIN_HOOK_MIGRATION_INVALID','A legacy runner does not match this CLI profile. Preserve it and resolve the conflict before plugin migration; existing recording is unchanged.');
  runners.push({file:old.file,before,after:next.script,mode:statSync(old.file).mode&0o777});
 }
 return {installationId:previous.installationId,command,runners};
}
/** Switch only after every selected native bundle can load. Global definitions
 * and their trust keys stay unchanged while old runners enter the guarded CLI.
 * Roll back the profile-local scripts and ownership together if a write fails. */
export async function activatePluginOwnership(scope:SetupScope,migration:LegacyPluginMigration|null){
 if(!migration)return;
 await withSessionLock('capture:configuration',()=>withSessionLock('skills:installation',async()=>{
  const current=readCaptureConfig();
  if(!current||!matchesScope(current,scope)||current.installationId!==migration.installationId)throw new CliError('SETUP_SCOPE_CHANGED','The collector changed before native plugin activation.');
  for(const runner of migration.runners)if(lstatSync(runner.file).isSymbolicLink()||!readFileSync(runner.file).equals(runner.before))throw new CliError('PLUGIN_HOOK_MIGRATION_INVALID','A legacy runner changed during setup; existing recording was preserved. Resume after resolving the concurrent change.');
  const configFile=join(configDir(),'capture','config.json'),before=readFileSync(configFile),changed:LegacyPluginMigration['runners']=[];
  const backup=join(configDir(),'setup','legacy-runner-backups',randomUUID());mkdirSync(backup,{recursive:true,mode:0o700});atomicFile(join(backup,'config.json'),before);
  for(const [index,runner] of migration.runners.entries())atomicFile(join(backup,index+'.runner'),runner.before);
  atomicFile(join(backup,'manifest.json'),JSON.stringify({files:migration.runners.map((runner,index)=>({file:runner.file,backup:index+'.runner',mode:runner.mode}))},null,2)+'\n');
  try{
   for(const runner of migration.runners){if(runner.before.toString()===runner.after)continue;replace(runner.file,runner.after,runner.mode);changed.push(runner);}
   atomicJson(configFile,{...current,hookOwnership:'plugin',command:migration.command});
  }catch(error){for(const runner of changed.reverse())replace(runner.file,runner.before,runner.mode);atomicFile(configFile,before);throw error;}
 }));
}

/** Called only after a native plugin binding is validated, or a client is turned
 * off. The old destination must match, and every command must bind this exact
 * profile runner. Native trust, foreign profiles and queued data are untouched. */
export async function retireLegacySetupHooks(scope:SetupScope,previous:CaptureConfig|null,clients:string[]){
 if(!previous||!matchesScope(previous,scope))return {files:[] as string[],preserved:[] as string[]};
 return withSessionLock('capture:configuration',()=>withSessionLock('skills:installation',async()=>{
  const current=readCaptureConfig();
  if(!current||!matchesScope(current,scope)||current.installationId!==previous.installationId||current.hookOwnership!=='plugin')throw new CliError('SETUP_SCOPE_CHANGED','The collector changed before native plugin migration; no legacy hooks were removed.');
  const changes:{file:string;before:Buffer;after:string;mode:number}[]=[],preserved:string[]=[];
  for(const client of new Set(clients)){
   if(!['claude-code','codex','cursor','antigravity'].includes(client))continue;
   const root=previous.roots[client as keyof CaptureConfig['roots']];if(!root)continue;
   const file=client==='antigravity'?join(root,'config','hooks.json'):join(root,client==='claude-code'?'settings.json':'hooks.json');
   if(!existsSync(file))continue;
   if(lstatSync(file).isSymbolicLink())throw new CliError('PLUGIN_HOOK_MIGRATION_INVALID','A native hook file is a symbolic link; preserve it and resolve the conflict before retrying.');
   const before=readFileSync(file);let config:unknown;
   try{config=JSON.parse(before.toString());}catch{throw new CliError('PLUGIN_HOOK_MIGRATION_INVALID','Existing native hooks are invalid; no legacy hooks were removed.');}
   if(!record(config))throw new CliError('PLUGIN_HOOK_MIGRATION_INVALID','Existing native hooks are invalid; no legacy hooks were removed.');
   const after=nextHooks(config,client);if(isDeepStrictEqual(config,after))continue;
   // Codex trust includes event/group/hook indices. Preserve the whole file if
   // removal would move any foreign key; plugin-owned runtime ignores the old
   // global callbacks, so preserving native trust cannot duplicate delivery.
   if(client==='codex'&&!foreignCodexKeysUnchanged((config.hooks??{}) as Record<string,unknown[]>,(after.hooks??{}) as Record<string,unknown[]>)){preserved.push(client);continue;}
   const text=before.toString(),indent=/\n([ \t]+)\S/.exec(text)?.[1]??(text.trim()&&!text.includes('\n')?'':'  ');
   changes.push({file,before,after:JSON.stringify(after,null,indent)+'\n',mode:statSync(file).mode&0o777});
  }
  const backup=join(configDir(),'setup','legacy-hook-backups',randomUUID());
  if(changes.length)mkdirSync(backup,{recursive:true,mode:0o700});
  // Back up every affected file before the first replacement. This is profile-
  // local recovery material and may contain unrelated native settings.
  for(const [index,change] of changes.entries())atomicFile(join(backup,index+'.json'),change.before);
  if(changes.length)atomicFile(join(backup,'manifest.json'),JSON.stringify({files:changes.map((change,index)=>({file:change.file,backup:index+'.json',mode:change.mode}))},null,2)+'\n');
  const changed:typeof changes=[];
  try{for(const change of changes){replace(change.file,change.after,change.mode);changed.push(change);}}
  catch(error){for(const change of changed.reverse())replace(change.file,change.before,change.mode);throw error;}
  return {files:changes.map(change=>change.file),preserved};
 }));
}
