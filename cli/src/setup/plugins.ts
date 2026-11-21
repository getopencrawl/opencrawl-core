import {isRegistrationMcp} from './registration-mcp.ts';
import {devinManifest,readme,devinGuide} from '../../../plugins/opencrawl-sessions/assets.ts';
import {existsSync, lstatSync, readFileSync, mkdirSync, unlinkSync, chmodSync, renameSync, mkdtempSync} from 'node:fs';
import {join, dirname, resolve, isAbsolute, posix} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {atomicFile, atomicJson, configDir, withSessionLock} from '../session.ts';
import {apiOrigin, CliError} from '../oauth.ts';
import {version} from '../distribution.ts';
import {setupCommandForSelf,profileSetupCommand} from './invocation.ts';
import {installCursorArchive,retireCursorSetupHooks} from './cursor-native-hooks.ts';
import {pluginRelease} from './plugin-release.ts';
import {pluginHookFiles} from './plugin-hooks.ts';
import {powershellQuote} from '../hook-runner.ts';
import {pluginActivationMatches,verifyPluginBundle,checkRepairablePluginBundle} from './plugin-context.ts';
import {setupPluginIdentity,scopedPluginIdentity} from './plugin-identity.ts';
import {installParticipation} from './participation.ts';
export {setupPluginIdentity} from './plugin-identity.ts';
import type {PublishedPackage,CaptureMode,LocalPluginClient} from './published-plugins.ts';
import {bundleManifest,MAX_PLUGIN_BINARY,MAX_PLUGIN_TEXT,type BundleFiles} from './plugin-bundle.ts';

export type PluginClient = 'claude-code' | 'codex' | 'cursor' | 'antigravity' | 'devin';
export type PluginHumanTask = {id:string;kind:'mcp_auth'|'restart'|'plugin_install';client:PluginClient;title:string;instruction:string;url?:string};
export type PluginResult = {client:PluginClient;status:'installed'|'unchanged'|'prepared'|'pending'|'error';message?:string;pluginId?:string;directory?:string;preparedAt?:string;captureAvailable?:boolean;daemonHandoff?:boolean;source?:PublishedPackage['source']};
type CommandResult = {code:number;stdout?:string;timedOut?:boolean};
export type PluginOptions = {onProgress?:(message:string)=>void;validateBinding?:()=>void;cursorCapture?:{installationId:string;observedAt:string};captureMode?:CaptureMode;bundles?:Partial<Record<LocalPluginClient,PublishedPackage | {files:Record<string,string>;source?:undefined}>>;command?:string[];home?:string;env?:NodeJS.ProcessEnv;which?:(name:string)=>string|null;runner?:(command:string,args:string[],env:NodeJS.ProcessEnv)=>Promise<CommandResult>};
const clients:PluginClient[] = ['claude-code','codex','cursor','antigravity','devin'];
export const labels:Record<PluginClient,string> = {'claude-code':'Claude Code',codex:'Codex',cursor:'Cursor',antigravity:'Antigravity',devin:'Devin Cloud'};
const marker = '.opencrawl-setup-plugin.json';
const hash = (text:string|Buffer) => createHash('sha256').update(text).digest('hex');
const json = (value:unknown) => JSON.stringify(value,null,2)+'\n';
function context(options:PluginOptions) { return {home:options.home??homedir(),env:options.env??process.env,which:options.which??Bun.which}; }
export function pluginInventory(options:PluginOptions={}) {
  const {home,env,which}=context(options);
  return clients.filter(id=>id!=='devin'||env.OPENCRAWL_AUTH==='devin-cloud').map(id=>{
    if(id==='devin')return {id,label:labels[id],supported:true,detected:true};
    const roots = id==='codex' ? [env.CODEX_HOME||join(home,'.codex')]
      : id==='claude-code' ? [env.CLAUDE_CONFIG_DIR||join(home,'.claude')]
      : id==='cursor' ? [env.CURSOR_CONFIG_DIR||join(home,'.cursor')]
      : ['antigravity-cli','antigravity-app','antigravity-ide'].map(surface=>join(env.ANTIGRAVITY_HOME||join(home,'.gemini'),surface));
    const command=id==='claude-code'?'claude':id==='antigravity'?'agy':id;
    return {id,label:labels[id],supported:true,detected:roots.some(existsSync)||Boolean(which(command))||id==='cursor'&&Boolean(which('cursor-agent'))};
  });
}
const installerCommands:Record<LocalPluginClient,string>={'claude-code':'claude',codex:'codex',cursor:'cursor-agent',antigravity:'agy'};

/** The recording picker uses the same native command and version rule as installation. */
export async function canInstallRecordingPlugin(id:string,options:PluginOptions={},platform:NodeJS.Platform=process.platform){
  const release=pluginRelease.packages.find(entry=>entry.harness===id);
  if(!release?.captureAvailable||release.archives&&!release.archives[platform+'-'+process.arch])return false;
  const {which,env,home}=context(options);
  const binary=which(installerCommands[release.harness]);
  if(!binary)return false;
  if(!release.minimumHarnessVersion)return true;
  const nativeEnv={...env,HOME:home,USERPROFILE:home};
  const version=options.runner?await options.runner(binary,['--version'],nativeEnv):await runPluginCommand(binary,['--version'],nativeEnv,5000);
  return version.code===0&&!version.timedOut&&supportsMinimumVersion(release.harness,version.stdout?.trim()??'',release.minimumHarnessVersion);
}
function hasSetupPluginFiles(api:string,client:string){
  const identity=setupPluginIdentity(api);
  if(existsSync(join(configDir(),'setup-plugins',client,identity.key)))return true;
  if(client!=='cursor')return false;
  return [process.env.CURSOR_CONFIG_DIR,join(homedir(),'.cursor')].some(root=>root&&
    [identity.name,scopedPluginIdentity(api).name].some(name=>existsSync(join(root,'plugins','local',name))));
}
export type RecordingInstallState = 'new' | 'installed' | 'repair' | 'review';

function inventoryArgs(client:LocalPluginClient,marketplace:string) {
  return client==='codex'?['plugin','list','--marketplace',marketplace,'--json']:['plugin','list','--json'];
}

/** Inspect local installation only. Activation, hook trust and recording proof are separate. */
export async function recordingInstallState(api:string,client:LocalPluginClient,priorStatus?:string,options:PluginOptions={}):Promise<RecordingInstallState> {
  const identity=setupPluginIdentity(api),configHome=dirname(configDir());
  const receipt=read(join(configDir(),'setup-plugins',client,identity.key,'installed.json'));
  if(!receipt) {
    if(hasSetupPluginFiles(api,client)||['installed','unchanged','prepared'].includes(priorStatus??''))return 'repair';
    return 'new';
  }
  if(receipt.schemaVersion!==2||receipt.api!==identity.api||receipt.client!==client||receipt.configHome!==configHome||
    receipt.pluginName!==identity.name||typeof receipt.digest!=='string'||typeof receipt.directory!=='string'||typeof receipt.nativeRoot!=='string')return 'review';
  const {which,env,home}=context(options);
  if(client!=='cursor'){
    const binary=which(installerCommands[client]);
    if(!binary)return 'review';
    const list=await (options.runner??runPluginCommand)(binary,inventoryArgs(client,identity.marketplace),{...env,HOME:home,USERPROFILE:home},5000);
    const rows=list.code===0&&!list.timedOut?pluginRows(list.stdout??''):null;
    if(!rows)return 'review';
    const matches=rows.filter(row=>matchesName(row,identity.name));
    if(!matches.length)return 'repair';
    const [row]=matches;
    if(matches.length!==1||!row||!isManaged(row,client,identity)||row.enabled===false||row.installed===false)return 'review';
    if(nativeRoot(row,client,receipt.cachePath)!==receipt.nativeRoot)return 'review';
    if(client==='codex'){
      const source=row.source as {source?:unknown;path?:unknown}|undefined;
      if(source?.source!=='local'||typeof source.path!=='string'||resolve(source.path)!==receipt.directory)return 'review';
    }
  }
  try{
    for(const nativeRoot of new Set<string>([receipt.directory,receipt.nativeRoot])){
      const bundle=verifyPluginBundle({api:identity.api,client,pluginName:identity.name,configHome,nativeRoot});
      if(bundle.digest!==receipt.digest)return 'repair';
    }
    return 'installed';
  }catch{return 'repair';}
}
type BundleOptions={command?:string[];configHome?:string;env?:NodeJS.ProcessEnv;recording?:boolean};
function devinPluginFiles(api:string,options:Required<Pick<BundleOptions,'command'|'configHome'|'recording'>>) {
  const identity=scopedPluginIdentity(api);
  return {
    ...pluginHookFiles('devin',{command:options.command,configHome:options.configHome,api:identity.api,pluginName:identity.name},'linux'),
    [devinManifest.path]:json({...devinManifest.value,name:identity.name,version}),
    'README.md':readme,
    '.mcp.json':json({mcpServers:{[identity.name]:{command:'/bin/sh',args:['${PLUGIN_ROOT}/scripts/opencrawl-hook.sh','mcp']}}}),
    '.opencrawl-devin.json':json({schemaVersion:1,api:identity.api,configHome:options.configHome,command:options.command,recording:options.recording}),
    'AGENTS.md':devinGuide,
  };
}

/** Export only public configuration. Every fresh Cloud VM binds its own owner
 * and installation at runtime; no local installation or token enters the bundle. */
export function writeDevinPlugin(directory:string,api:string,options:Required<Pick<BundleOptions,'command'|'configHome'|'recording'>>){
  if(!isAbsolute(directory)||!posix.isAbsolute(options.configHome)||options.command.length!==1||!posix.isAbsolute(options.command[0]!))throw new CliError('INVALID_PLUGIN_BINDING','Supply an absolute bundle directory, Linux native command and Cloud configuration home.');
  const identity=scopedPluginIdentity(api),files=devinPluginFiles(identity.api,options);
  writeBundle(resolve(directory),files,'devin',identity.api,identity.name,posix.resolve(options.configHome),dirname(resolve(directory)));
  return {client:'devin' as const,api:identity.api,pluginName:identity.name,directory:resolve(directory),digest:hash(json(files)),recording:options.recording,installed:false};
}
function stat(path:string) {try{return lstatSync(path);}catch(error:any){if(error.code==='ENOENT')return null;throw error;}}
function safeDirectory(path:string,base:string) {
  const existing=stat(path),parent=dirname(path);
  if(path!==base)safeDirectory(parent,base);
  if(existing){if(!existing.isDirectory()||existing.isSymbolicLink())throw new CliError('PLUGIN_PATH_CONFLICT','The plugin path is not an ordinary directory. Preserve it and choose another installation path.');return;}
  mkdirSync(path,{mode:0o700,...(path===base?{recursive:true}:{})});
}
function obsoleteBundleFiles(directory:string,owned:ReturnType<typeof read>,files:BundleFiles):string[] {
  if(!owned)return [];
  if(!owned.files||typeof owned.files!=='object'||Array.isArray(owned.files)||Object.keys(owned.files).length>128)throw new CliError('PLUGIN_PATH_CONFLICT','The previous plugin file inventory is invalid; preserve it and repair the installation before retrying.');
  const obsolete:string[]=[];
  for(const [name,digest] of Object.entries(owned.files)){
    if(name in files)continue;
    if(!name||isAbsolute(name)||name.includes('\\')||name.split('/').some(part=>!part||part==='.'||part==='..')||name===marker||typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))throw new CliError('PLUGIN_PATH_CONFLICT','The previous plugin file inventory is invalid; no obsolete file was removed.');
    let file=directory,missing=false;const parts=name.split('/');
    for(const [index,part] of parts.entries()){
      file=join(file,part);const value=stat(file);if(!value){missing=true;break;}
      if(value.isSymbolicLink()||(index<parts.length-1?!value.isDirectory():!value.isFile()||value.size>(owned.schemaVersion===3&&name===owned.executable?MAX_PLUGIN_BINARY:MAX_PLUGIN_TEXT)))throw new CliError('PLUGIN_PATH_CONFLICT','An obsolete plugin path is not an ordinary managed file; preserve it before retrying.');
    }
    if(missing)continue;
    if(hash(readFileSync(file))!==digest)throw new CliError('PLUGIN_PATH_CONFLICT','An obsolete plugin file was modified; preserve it and resolve the conflict before retrying.');
    obsolete.push(file);
  }
  return obsolete;
}
function writeBundle(directory:string,files:BundleFiles,client:PluginClient,api:string,pluginName:string,configHome:string,pathRoot:string,executable?:string) {
  const existing=stat(directory),owned=read(join(directory,marker));
  if(existing&&(!owned||![2,3].includes(owned.schemaVersion)||owned.api!==api||owned.client!==client||owned.pluginName!==pluginName||owned.configHome!==configHome))throw new CliError('PLUGIN_PATH_CONFLICT','Another plugin occupies the setup path. Preserve it and resolve the conflict before retrying.');
  const inventory=bundleManifest(files,executable);
  const obsolete=obsoleteBundleFiles(directory,owned,files);
  safeDirectory(directory,pathRoot);
  for(const [name,content] of Object.entries(files)) {
    const file=join(directory,name);safeDirectory(dirname(file),pathRoot);
    if(stat(file)?.isSymbolicLink())throw new CliError('PLUGIN_PATH_CONFLICT','A managed plugin file is a symbolic link; no target was modified.');
    atomicFile(file,content);
    if(name===executable)chmodSync(file,0o755);
  }
  for(const file of obsolete)unlinkSync(file);
  atomicJson(join(directory,marker),{...inventory,api,client,pluginName,configHome,version});
}
export function pluginCommand(command:string,args:string[],env:NodeJS.ProcessEnv,platform=process.platform):[string,string[]] {
  if(platform!=='win32'||!/[.](cmd|bat)$/i.test(command))return [command,args];
  return [join(env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command','& '+[command,...args].map(powershellQuote).join(' ')+'; exit $LASTEXITCODE']];
}
export async function runPluginCommand(command:string,args:string[],env:NodeJS.ProcessEnv,timeout=45_000):Promise<CommandResult> {
  const [executable,arguments_]=pluginCommand(command,args,env);
  return new Promise(resolve=>execFile(executable,arguments_,{env,timeout,maxBuffer:1024*1024,windowsHide:true},(error,stdout)=>resolve({code:error?typeof error.code==='number'?error.code:1:0,stdout,timedOut:error?.killed===true&&error.signal==='SIGTERM'})));
}
function read(path:string):any {try{return JSON.parse(readFileSync(path,'utf8'));}catch{return null;}}
function pluginRows(output:string):Record<string,unknown>[]|null {
  let value:unknown;try{value=JSON.parse(output);}catch{return null;}
  const rows=Array.isArray(value)?value:value&&typeof value==='object'&&'installed' in value?value.installed:value&&typeof value==='object'&&'plugins' in value?value.plugins:null;
  return Array.isArray(rows)?rows.filter((row):row is Record<string,unknown>=>Boolean(row&&typeof row==='object')):null;
}
// A marketplace-scoped inventory omits plugins from other marketplaces. Keep
// protecting explicitly configured plugins with the same deployment name.
function otherCodexOwner(home:string,env:NodeJS.ProcessEnv,name:string,pluginId:string){
 try{
  const config=Bun.TOML.parse(readFileSync(join(env.CODEX_HOME||join(home,'.codex'),'config.toml'),'utf8'));
  const plugins='plugins' in config&&config.plugins&&typeof config.plugins==='object'?config.plugins:{};
  return Object.keys(plugins).some(id=>id.startsWith(name+'@')&&id!==pluginId);
 }catch(error){
  if((error as NodeJS.ErrnoException).code==='ENOENT')return false;
  throw new CliError('PLUGIN_CONFIG_UNREADABLE','Could not read the Codex plugin configuration. Review it before retrying setup.');
 }
}
function matchesName(row:Record<string,unknown>,name:string) {return row.name===name||[row.id,row.pluginId].some(id=>typeof id==='string'&&(id===name||id.startsWith(name+'@')));}
function isManaged(row:Record<string,unknown>,client:PluginClient,identity:ReturnType<typeof setupPluginIdentity>) {return client==='antigravity'?row.name===identity.name:[row.id,row.pluginId].includes(identity.name+'@'+identity.marketplace);}
function nativeRoot(row:Record<string,unknown>,client:PluginClient,cachePath?:string):string|undefined {
  const value=client==='codex'?row.installedPath??row.installPath??cachePath:client==='claude-code'?row.readFromFolder??row.installPath:row.path;
  return typeof value==='string'?resolve(value):undefined;
}
function nativeProfileMatches(row:Record<string,unknown>,client:PluginClient,api:string,pluginName:string,configHome:string,replacements:BundleFiles) {
  // The current native source is authoritative. A saved receipt can outlive a
  // different CLI profile taking ownership of this deployment-specific plugin.
  const roots:string[]=[];
  if(client==='codex'){
    const source=row.source as {source?:unknown;path?:unknown}|undefined;
    if(source?.source!=='local'||typeof source.path!=='string')return false;
    roots.push(resolve(source.path));
    const installed=row.installedPath??row.installPath;
    if(installed!==undefined){if(typeof installed!=='string')return false;roots.push(resolve(installed));}
  }else{const root=nativeRoot(row,client);if(!root)return false;roots.push(root);}
  try{for(const nativeRoot of roots)checkRepairablePluginBundle({api,client,pluginName,configHome,nativeRoot},replacements);return true;}catch{return false;}

}
function nativeBindingMatches(row:Record<string,unknown>,client:PluginClient,directory:string,api:string,name:string,digest:string,configHome:string,root?:string) {
  if(!root)return false;
  if(client==='codex') {
    const source=row.source as {source?:unknown;path?:unknown}|undefined;
    if(source?.source!=='local'||typeof source.path!=='string'||resolve(source.path)!==resolve(directory))return false;
  }
  try{if(verifyPluginBundle({api,client,pluginName:name,configHome,nativeRoot:root}).digest!==digest)return false;}catch{return false;}
  const file=client==='claude-code'||client==='codex'?'.mcp.json':client==='antigravity'?'mcp_config.json':'mcp.json';
  const servers=read(join(root,file))?.mcpServers,server=servers?.[client==='codex'?name:'opencrawl'];
  if(Object.keys(servers??{}).length===1&&isRegistrationMcp(server,api,configHome))return true;
  return server?.url===api+'/mcp'&&(client!=='codex'||Object.keys(servers).length===1&&server.type==='http');
}
/** Keep the old receipt until the new installation has been verified and its
 * predecessor retired. Both steps can be retried after a process interruption. */
async function prepareDesktopRename(client:LocalPluginClient,api:string,configHome:string,marketRoot:string,pathRoot:string,
  saved:ReturnType<typeof read>,bundle:BundleFiles,run:(args:string[])=>Promise<CommandResult>){
  const old=scopedPluginIdentity(api);
  if(saved?.pluginName!==old.name)return;
  const catalogClient=client==='claude-code'||client==='codex';
  const pluginId=catalogClient?old.name+'@'+old.marketplace:old.name;
  const directory=client==='cursor'?join(pathRoot,'plugins','local',old.name):join(marketRoot,old.name);
  const conflict=()=>new CliError('PLUGIN_MIGRATION_CONFLICT','The previous OpenCrawl plugin changed or is disabled. Review its installation in '+labels[client]+' before running setup again.');
  if(saved.schemaVersion!==2||saved.api!==api||saved.client!==client||saved.configHome!==configHome||saved.pluginId!==pluginId||saved.directory!==directory)throw conflict();
  const verify=(root:string)=>{
    if(checkRepairablePluginBundle({api,client,pluginName:old.name,configHome,nativeRoot:root},bundle).digest!==saved.digest)throw conflict();
  };
  if(client==='cursor'){
    const check=()=>{if(saved.nativeRoot!==directory||stat(directory)?.isSymbolicLink())throw conflict();verify(directory);};
    if(stat(directory))check();
    return {directory,retire:()=>{
      if(!stat(directory))return;
      check();
      // Move out of discovery while preserving any user-added files on the same filesystem.
      const archive=mkdtempSync(join(pathRoot,'.opencrawl-previous-plugin-'));
      renameSync(directory,join(archive,old.name));
    }};
  }
  const registered=async()=>{
    const listing=await run(client==='codex'?['plugin','list','--marketplace',old.marketplace,'--json']:['plugin','list','--json']);
    const rows=listing.code===0?pluginRows(listing.stdout??''):null;
    if(!rows)throw conflict();
    const row=rows.find(row=>isManaged(row,client,old));
    if(!row)return false;
    const source=row.source as {path?:string}|undefined;
    if(row.enabled===false||row.installed===false||client==='codex'&&source?.path!==directory||
      !nativeProfileMatches(row,client,api,old.name,configHome,bundle)||nativeRoot(row,client,saved.cachePath)!==saved.nativeRoot)throw conflict();
    verify(saved.nativeRoot);
    return true;
  };
  await registered();
  return {directory,retire:async()=>{
    if(await registered()){
      const args=client==='codex'?['plugin','remove',pluginId,'--json']:client==='claude-code'?['plugin','uninstall',pluginId,'--scope','user','--keep-data','--json']:['plugin','uninstall',pluginId];
      if((await run(args)).code!==0||await registered())throw new CliError('PLUGIN_MIGRATION_PENDING','The new OpenCrawl plugin is installed. Run setup again to finish removing the previous registration.');
    }
    if(!catalogClient)return;
    // Only remove the single-entry local catalog that setup originally registered.
    const catalog=read(join(marketRoot,client==='codex'?'.agents/plugins/marketplace.json':'.claude-plugin/marketplace.json'));
    if(catalog?.name!==old.marketplace||catalog.plugins?.length!==1||catalog.plugins[0]?.name!==old.name)return;
    const listed=await run(['plugin','marketplace','list','--json']);
    if(listed.code!==0)throw conflict();
    const data=JSON.parse(listed.stdout??''),rows=client==='codex'?data.marketplaces:data;
    if(!Array.isArray(rows))throw conflict();
    const row=rows.find(row=>row?.name===old.marketplace);
    if(!row)return;
    const local=client==='codex'?row.marketplaceSource?.sourceType==='local'&&row.marketplaceSource.source:row.source==='directory'&&row.path;
    if(typeof local!=='string'||resolve(local)!==marketRoot)return;
    const removed=await run(['plugin','marketplace','remove',old.marketplace,...(client==='claude-code'?['--scope','user']:[]),'--json']);
    if(removed.code!==0)throw conflict();
  }};
}
function bundleMatches(directory:string,bundle:BundleFiles,digest:string,client:PluginClient,api:string,pluginName:string,configHome:string) {
  try {
    const existing=stat(directory);
    if(!existing?.isDirectory()||existing.isSymbolicLink())return false;
    return verifyPluginBundle({api,client,pluginName,configHome,nativeRoot:directory}).digest===digest&&Object.entries(bundle).every(([name,bytes])=>readFileSync(join(directory,name)).equals(Buffer.from(bytes)));
  }catch{return false;}
}

function supportsMinimumVersion(client:PluginClient,version:string,minimum:string):boolean {
  if(client==='cursor'){
    // Builds on the same day have unordered Git revisions.
    const dated=/^(\d{4}\.\d{2}\.\d{2})-([a-f0-9]{7,40})$/;
    const actual=dated.exec(version),required=dated.exec(minimum);
    if(!actual||!required)return false;
    const day=actual[1]!.replaceAll('.','-'),date=new Date(day+'T00:00:00Z');
    if(!Number.isFinite(date.valueOf())||!date.toISOString().startsWith(day+'T'))return false;
    return version===minimum||actual[1]!>required[1]!;
  }
  const pattern=client==='codex'?/^codex-cli (\d+)\.(\d+)\.(\d+)(?:\s|$)/:/^(\d+)\.(\d+)\.(\d+)(?:\s|$)/;
  const actual=version.match(pattern),required=minimum.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return Boolean(actual&&required&&actual.slice(1).map(Number).reduce((difference,value,index)=>difference||value-Number(required[index+1]),0)>=0);
}

function cursorPreparation(prior:{digest?:string;configHome?:string;preparedAt?:string;captureConfirmed?:boolean}|null,
  unchanged:boolean,digest:string,configHome:string,installationId:string,observation:PluginOptions['cursorCapture']){
  if(!unchanged||prior?.digest!==digest||prior.configHome!==configHome||!prior.preparedAt||!Number.isFinite(Date.parse(prior.preparedAt))){
    return {preparedAt:new Date().toISOString(),captureConfirmed:false};
  }
  const fresh=observation?.installationId===installationId&&Date.parse(observation.observedAt)>=Date.parse(prior.preparedAt);
  return {preparedAt:prior.preparedAt,captureConfirmed:prior.captureConfirmed===true||fresh};
}
export async function installSetupPlugins(api:string,selected:string[],options:PluginOptions={}) {
  if(selected.some(client=>!clients.includes(client as PluginClient)))throw new CliError('INVALID_USAGE','Choose a supported client from setup inventory.',64);
  const identity=setupPluginIdentity(api),origin=identity.api,{home,env,which}=context(options),runner=options.runner??runPluginCommand;
  const configHome=resolve(env.OPENCRAWL_CONFIG_HOME||env.XDG_CONFIG_HOME||join(home,'.config')),root=join(configHome,'opencrawl','setup-plugins');
  const command=options.command??setupCommandForSelf(),results:PluginResult[]=[],humanTasks:PluginHumanTask[]=[];
  const perform=async()=>{
    options.validateBinding?.();
    profileSetupCommand(command,configHome,env,true);
    for(const client of [...new Set(selected)] as PluginClient[]) {
      if(client==='devin'){
        const result=await (await import('./devin-plugin.ts')).adoptDevinPlugin(origin,{configHome,env});
        results.push(result);continue;
      }
      const prepared=options.bundles?.[client];
      if(!prepared)throw new CliError('PLUGIN_PACKAGE_INVALID','A verified package is required for '+client+'.');
      const published=prepared.source?prepared:undefined;
      const bundle:BundleFiles={...prepared.files,...published?.binaries};
      const cursorArchive=client==='cursor'&&Boolean(published?.source.archive);
      const cursorProfile=resolve(env.CURSOR_CONFIG_DIR||join(home,'.cursor'));
      const marketRoot=join(root,client,identity.key),pathRoot=client==='cursor'?(cursorArchive?resolve(home,'.cursor'):cursorProfile):configHome;
      // Keep the old marketplace readable until the new registration is confirmed.
      const marketSource=join(marketRoot,'marketplace');
      const directory=client==='cursor'?join(pathRoot,'plugins','local',identity.name):join(marketSource,identity.name);
      const receipt=join(marketRoot,'installed.json'),digest=bundleManifest(bundle,published?.executable).digest,saved=read(receipt);
      const prior=saved?.schemaVersion===2&&saved.api===origin&&saved.client===client&&saved.pluginName===identity.name&&saved.directory===directory?saved:null;
      const pluginId=client==='codex'||client==='claude-code'?identity.name+'@'+identity.marketplace:identity.name;
      try {
        const binary=which(installerCommands[client]);
        const nativeEnv={...env,HOME:home,USERPROFILE:home};
        const listArgs=inventoryArgs(client,identity.marketplace);
        const inventory=async(executable:string)=>{
          options.onProgress?.('Reading the '+labels[client]+' plugin inventory.');
          const result=await runner(executable,listArgs,nativeEnv);
          if(result.timedOut)throw new CliError('PLUGIN_INVENTORY_TIMEOUT',labels[client]+' took more than 45 seconds to list plugins. Retry when the client is ready.');
          return result;
        };
        if(published?.minimumHarnessVersion){
          if(!binary)throw new CliError('PLUGIN_CLIENT_MISSING','Setup could not find '+installerCommands[client]+' on PATH. Install the '+labels[client]+' CLI or add it to PATH, then retry.');
          options.onProgress?.('Checking the '+labels[client]+' version.');
          const result=await runner(binary,['--version'],nativeEnv);
          if(result.timedOut)throw new CliError('PLUGIN_VERSION_TIMEOUT',labels[client]+' took more than 45 seconds to report its version. Retry when the client is ready.');
          if(result?.code!==0||!supportsMinimumVersion(client,result.stdout?.trim()??'',published.minimumHarnessVersion)){
            const message=labels[client]+' '+published.minimumHarnessVersion+' or later is required. Update the client, then run setup again.';
            results.push({client,status:'pending',message});
            humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Update '+labels[client],instruction:message});continue;
          }
        }
        let native:Record<string,unknown>|undefined,loadedRoot:string|undefined,cachePath=typeof prior?.cachePath==='string'?prior.cachePath:undefined;
        const previousPlugin=await prepareDesktopRename(client,origin,configHome,marketRoot,pathRoot,saved,bundle,
          async args=>binary?runner(binary,args,nativeEnv):{code:1});
        if(binary&&client!=='cursor'){
          const listing=await inventory(binary);
          const rows=listing.code===0?pluginRows(listing.stdout??''):null;
          if(!rows){results.push({client,status:'pending',message:'The client could not report its plugin state. Resolve its sign-in, version or policy before retrying.'});humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Check '+labels[client]+' plugin access',instruction:'Inspect the native client plugin inventory and its reported policy or sign-in issue. Run setup again after it can report its installed plugins.'});continue;}
          const matches=rows.filter(row=>matchesName(row,identity.name));native=matches.find(row=>isManaged(row,client,identity));
          const ownedSource=read(join(directory,marker));
          const managedSource=[2,3].includes(ownedSource?.schemaVersion)&&ownedSource.api===origin&&ownedSource.client===client&&ownedSource.pluginName===identity.name&&ownedSource.configHome===configHome;
          if(matches.some(row=>!isManaged(row,client,identity))||native&&!prior&&!managedSource||client==='codex'&&otherCodexOwner(home,env,identity.name,pluginId)){
            results.push({client,status:'pending',message:'Another installation owns this deployment-specific plugin. It was preserved.'});
            humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Review this deployment plugin',instruction:'Inspect the existing deployment-specific plugin and source in native controls. Preserve it until the user chooses to repair or replace that installation; unrelated OpenCrawl plugins can remain enabled.'});continue;
          }
          if(native&&(native.enabled===false||native.installed===false)){results.push({client,status:'pending',message:'The deployment plugin is disabled or unavailable. Its native choice was preserved.'});humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Review the deployment plugin',instruction:'Use native controls to review this plugin’s disabled or unavailable state. Preserve policy and the user’s choice before retrying.'});continue;}
          if(native&&!nativeProfileMatches(native,client,origin,identity.name,configHome,bundle)){
            results.push({client,status:'pending',message:'The native plugin belongs to another CLI profile or its current source could not be verified. It was preserved.'});
            humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Review the active OpenCrawl profile',instruction:'Inspect this deployment plugin’s current native source and CLI profile. Continue setup with the owning profile, or have the user explicitly resolve that conflict before retrying; an older installation receipt cannot replace it.'});continue;
          }
          if(native)loadedRoot=nativeRoot(native,client,cachePath);
        }
        const existingCapabilities=published&&!published.captureAvailable?read(join(directory,'capabilities.json')):null;
        if(published&&!published.captureAvailable&&stat(directory)&&(!read(join(directory,'.opencrawl-source.json'))||existingCapabilities?.capture?.minimum===true&&!['stub','development'].includes(existingCapabilities?.status))){
          results.push({client,status:'pending',message:'The published package cannot capture yet. The existing working plugin was preserved.',directory});continue;
        }
        const unchanged=bundleMatches(directory,bundle,digest,client,origin,identity.name,configHome);
        const cursorHooksReceipt=join(marketRoot,'native-hooks.json');
        if(cursorArchive&&pathRoot!==cursorProfile&&stat(join(cursorProfile,'plugins','local',identity.name)))
          throw new CliError('CURSOR_PLUGIN_LOCATION','A deployment plugin already exists under the custom Cursor configuration path. Resolve its location before installing in the Cursor CLI local plugins folder.');
        if(client==='cursor'&&!published)await retireCursorSetupHooks(origin,pathRoot,true);
        options.validateBinding?.();
        const install=()=>{if(!unchanged)writeBundle(directory,bundle,client,origin,identity.name,configHome,pathRoot,published?.executable);};
        if(cursorArchive)await installCursorArchive(pathRoot,directory,cursorHooksReceipt,unchanged,install,previousPlugin?.directory);
        else install();
        if(client==='cursor') {
          // Supported persistent local discovery; policy can still prevent loading.
          // Activation is observed from this deployment's trusted plugin hook, not inferred
          // from files or an unrelated marketplace plugin with another name.
          if(!published)await retireCursorSetupHooks(origin,pathRoot);
          loadedRoot=directory;
        } else {
          if(!binary){results.push({client,status:'pending',message:labels[client]+"'s native plugin installer is unavailable.",directory});humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Install '+labels[client]+' plugin support',instruction:'Install or update the native client CLI, then run setup again. Preserve existing plugins and authentication.'});continue;}
          // Claude reads local marketplaces in place, but its installed version and fallback cache
          // are updated only by the native update command.
          const refreshClaudeCache=client==='claude-code'&&native?.scope==='user'&&typeof native.version==='string'&&published!==undefined&&native.version!==published.source.version;
          if(refreshClaudeCache||!native||!unchanged||!nativeBindingMatches(native,client,directory,origin,identity.name,digest,configHome,loadedRoot)) {
            let commands:string[][]=[];
            if(client==='codex'||client==='claude-code') {
              const file=client==='codex'?'.agents/plugins/marketplace.json':'.claude-plugin/marketplace.json';
              const entry=client==='codex'?{name:identity.name,source:{source:'local',path:'./'+identity.name},policy:{installation:'AVAILABLE',authentication:'ON_USE'},category:'Productivity'}:{name:identity.name,source:'./'+identity.name,description:JSON.parse(String(bundle['.claude-plugin/plugin.json'])).description};
              safeDirectory(dirname(join(marketSource,file)),configHome);atomicJson(join(marketSource,file),{name:identity.marketplace,owner:{name:'OpenCrawl'},plugins:[entry]});
              commands=client==='codex'?[['plugin','marketplace','add',marketSource,'--json'],['plugin','add',pluginId,'--json']]:[['plugin','marketplace','add',marketSource,'--json'],['plugin',refreshClaudeCache?'update':'install',pluginId,'--scope','user','--json']];
            } else commands=[['plugin','install',directory]];
            let success=true;
            for(const args of commands){options.validateBinding?.();options.onProgress?.(args[1]==='marketplace'?'Adding the OpenCrawl marketplace in '+labels[client]+'.':'Installing the OpenCrawl plugin in '+labels[client]+'.');const result=await runner(binary,args,nativeEnv);if(result.timedOut)throw new CliError('PLUGIN_INSTALL_TIMEOUT',labels[client]+' took more than 45 seconds to confirm installation. Retry to check its current state.');if(result.code!==0){success=false;break;}if(client==='codex'&&args[1]==='add')try{const installed=JSON.parse(result.stdout??'');if(typeof installed.installedPath==='string')cachePath=installed.installedPath;}catch{}}
            if(!success){results.push({client,status:'error',message:labels[client]+' did not confirm plugin installation.',directory});humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Finish '+labels[client]+' plugin installation',instruction:'Review the native installation error and resolve its policy, access or sign-in requirement before retrying.'});continue;}
            const confirmed=await inventory(binary);
            native=confirmed.code===0?pluginRows(confirmed.stdout??'')?.find(row=>isManaged(row,client,identity)):undefined;
            loadedRoot=native?nativeRoot(native,client,cachePath):undefined;
            if(!native||native.enabled===false||native.installed===false||(refreshClaudeCache&&native.version!==published!.source.version)||!nativeBindingMatches(native,client,directory,origin,identity.name,digest,configHome,loadedRoot)) {results.push({client,status:'pending',message:'The client has not confirmed this enabled plugin at the selected source and endpoint.',directory});humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Confirm '+labels[client]+' plugin source',instruction:'Inspect the native plugin source and endpoint. Preserve unrelated plugins and finish the reported policy or installation step before retrying.'});continue;}
          }
        }
        options.validateBinding?.();
        await previousPlugin?.retire();
        if(client==='claude-code'||client==='codex') {
          const profile=client==='claude-code'?(env.CLAUDE_CONFIG_DIR||join(home,'.claude')):(env.CODEX_HOME||join(home,'.codex'));
          await withSessionLock('capture:configuration',async()=>installParticipation(client,resolve(profile),origin,marketRoot));
        }
        const cursor=cursorArchive?cursorPreparation(prior,unchanged,digest,configHome,JSON.parse(published!.files['.opencrawl-binding.json']!).installationId,options.cursorCapture):undefined;
        safeDirectory(dirname(receipt),configHome);atomicJson(receipt,{schemaVersion:2,api:origin,client,pluginName:identity.name,configHome,digest,pluginId,directory,nativeRoot:loadedRoot,...(client==='codex'&&loadedRoot?{cachePath:loadedRoot}:{}),...cursor});
        const active=cursor?.captureConfirmed??published?.captureAvailable??Boolean(loadedRoot&&pluginActivationMatches({api:origin,client,pluginName:identity.name,digest,nativeRoot:loadedRoot,configHome}));
        const waiting=cursor?'Plugin files installed. Waiting for this workspace to observe capture from Cursor.':published?'Package installed; capture is unavailable in this pinned version.':'Plugin prepared; waiting for its native startup hook to confirm activation.';
        results.push({client,status:active?(unchanged?'unchanged':'installed'):'prepared',pluginId,directory,...(cursor?{preparedAt:cursor.preparedAt}:{}),...(!active?{message:waiting}:{})});
        if(cursor&&!active)humanTasks.push({id:'cursor:restart',kind:'restart',client,title:'Open Cursor',instruction:`Start a new Cursor session and select ${identity.name} for ${origin}. Use its OpenCrawl setup skill to finish verification.`});
        if(!active&&!published)humanTasks.push({id:client+':restart',kind:'restart',client,title:'Load OpenCrawl in '+labels[client],instruction:`Open or reload ${labels[client]} and select the ${identity.name} plugin for ${origin}. Review any native plugin-hook trust request. ${client==='cursor'?'In Customize or /plugin list, confirm this deployment-specific local plugin loads; if local imports are blocked, ask the administrator to allow it. ':''}Run setup again after its native startup hook runs. Do not use a session-only --plugin-dir override as installation proof.`});
        const mcpFile=client==='cursor'?'mcp.json':client==='antigravity'?'mcp_config.json':'.mcp.json';
        const boundMcp=read(join(directory,mcpFile))?.mcpServers?.[client==='codex'?identity.name:'opencrawl'];
        if(!isRegistrationMcp(boundMcp,origin,configHome))humanTasks.push({id:client+':mcp_auth',kind:'mcp_auth',client,title:'Connect OpenCrawl in '+labels[client],instruction:`Use the ${identity.name} plugin's native connection flow for ${origin}. Complete requested MCP authentication in this client and run its native verification. Preserve other deployments and never copy CLI credentials.`,url:origin+'/mcp'});
      }catch(error){results.push({client,status:'error',message:error instanceof CliError?error.message:'Could not install the plugin. Check native access and retry.'});humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Resolve '+labels[client]+' plugin installation',instruction:'Read the reported installation error, preserve existing configuration, and resolve only the required access or conflict before retrying.'});}
    }
    return {results:results.map(row=>{const source=row.client==='devin'?undefined:options.bundles?.[row.client];return source?.source?{...row,captureAvailable:source.captureAvailable,daemonHandoff:source.daemonHandoff,source:source.source}:row;}),humanTasks};
  };
  return withSessionLock('setup:plugins',perform);
}
