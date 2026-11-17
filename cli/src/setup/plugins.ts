import {manifests,extraAssets} from '../../../plugins/opencrawl-sessions/assets.ts';
import {existsSync, lstatSync, readFileSync, mkdirSync, unlinkSync} from 'node:fs';
import {join, dirname, resolve, isAbsolute, posix} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {atomicFile, atomicJson, withSessionLock} from '../session.ts';
import {apiOrigin, CliError} from '../oauth.ts';
import {version} from '../distribution.ts';
import {setupCommandForSelf,profileSetupCommand} from './invocation.ts';
import {retireCursorSetupHooks} from './cursor-native-hooks.ts';
import {pluginHookFiles} from './plugin-hooks.ts';
import {powershellQuote} from '../hook-runner.ts';
import {pluginActivationMatches,verifyPluginBundle} from './plugin-context.ts';

export type PluginClient = 'claude-code' | 'codex' | 'cursor' | 'antigravity' | 'devin';
export type PluginHumanTask = {id:string;kind:'mcp_auth'|'restart'|'plugin_install';client:PluginClient;title:string;instruction:string;url?:string};
export type PluginResult = {client:PluginClient;status:'installed'|'unchanged'|'prepared'|'pending'|'error';message?:string;pluginId?:string;directory?:string};
type CommandResult = {code:number;stdout?:string};
export type PluginOptions = {command?:string[];home?:string;env?:NodeJS.ProcessEnv;which?:(name:string)=>string|null;runner?:(command:string,args:string[],env:NodeJS.ProcessEnv)=>Promise<CommandResult>};
const clients:PluginClient[] = ['claude-code','codex','cursor','antigravity','devin'];
const labels:Record<PluginClient,string> = {'claude-code':'Claude Code',codex:'Codex',cursor:'Cursor',antigravity:'Antigravity',devin:'Devin Cloud'};
const marker = '.opencrawl-setup-plugin.json';
const hash = (text:string) => createHash('sha256').update(text).digest('hex');
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
export function setupPluginIdentity(api:string) {
  const origin=apiOrigin(api),key=hash(origin).slice(0,12);
  return {api:origin,key,name:'opencrawl-'+key,marketplace:'opencrawl-cli-'+key};
}
type BundleOptions={command?:string[];configHome?:string;env?:NodeJS.ProcessEnv;recording?:boolean};
/** Bundled in the executable: native plugins own hooks, MCP and agent guidance. */
export function setupPluginFiles(client:PluginClient,api:string,options:BundleOptions={}):Record<string,string> {
  const identity=setupPluginIdentity(api),origin=identity.api,url=origin+'/mcp';
  const command=options.command??setupCommandForSelf(),configHome=(client==='devin'?posix: {resolve}).resolve(options.configHome??process.env.OPENCRAWL_CONFIG_HOME??process.env.XDG_CONFIG_HOME??join(homedir(),'.config'));
  const definition=manifests[client];
  const files:Record<string,string>={
    ...pluginHookFiles(client,{command,configHome,api:origin,pluginName:identity.name,env:options.env},client==='devin'?'linux':process.platform),
    [definition.path]:json({...definition.value,name:identity.name,version}),
    'README.md':extraAssets.readme,
  };
  if(client==='devin'){
    files['.mcp.json']=json({mcpServers:{[identity.name]:{command:'/bin/sh',args:['${PLUGIN_ROOT}/scripts/opencrawl-hook.sh','mcp']}}});
    files['.opencrawl-devin.json']=json({schemaVersion:1,api:origin,configHome,command,recording:options.recording===true});
    files['AGENTS.md']=extraAssets.devinGuide;
  }else{
    const file=client==='codex'||client==='claude-code'?'.mcp.json':client==='antigravity'?'mcp_config.json':'mcp.json';
    files[file]=json({mcpServers:{[client==='codex'?identity.name:'opencrawl']:{...(client==='codex'||client==='claude-code'?{type:'http'}:{}),url}}});
  }
  if(client==='cursor')files['rules/opencrawl.mdc']=extraAssets.cursorRule;
  return files;
}

/** Export only public configuration. Every fresh Cloud VM binds its own owner
 * and installation at runtime; no local installation or token enters the bundle. */
export function writeDevinPlugin(directory:string,api:string,options:Required<Pick<BundleOptions,'command'|'configHome'|'recording'>>){
  if(!isAbsolute(directory)||!posix.isAbsolute(options.configHome)||options.command.length!==1||!posix.isAbsolute(options.command[0]!))throw new CliError('INVALID_PLUGIN_BINDING','Supply an absolute bundle directory, Linux native command and Cloud configuration home.');
  const identity=setupPluginIdentity(api),files=setupPluginFiles('devin',identity.api,options);
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
function obsoleteBundleFiles(directory:string,owned:ReturnType<typeof read>,files:Record<string,string>):string[] {
  if(!owned)return [];
  if(!owned.files||typeof owned.files!=='object'||Array.isArray(owned.files)||Object.keys(owned.files).length>128)throw new CliError('PLUGIN_PATH_CONFLICT','The previous plugin file inventory is invalid; preserve it and repair the installation before retrying.');
  const obsolete:string[]=[];
  for(const [name,digest] of Object.entries(owned.files)){
    if(name in files)continue;
    if(!name||isAbsolute(name)||name.includes('\\')||name.split('/').some(part=>!part||part==='.'||part==='..')||name===marker||typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))throw new CliError('PLUGIN_PATH_CONFLICT','The previous plugin file inventory is invalid; no obsolete file was removed.');
    let file=directory,missing=false;const parts=name.split('/');
    for(const [index,part] of parts.entries()){
      file=join(file,part);const value=stat(file);if(!value){missing=true;break;}
      if(value.isSymbolicLink()||(index<parts.length-1?!value.isDirectory():!value.isFile()||value.size>2_000_000))throw new CliError('PLUGIN_PATH_CONFLICT','An obsolete plugin path is not an ordinary managed file; preserve it before retrying.');
    }
    if(missing)continue;
    if(hash(readFileSync(file,'utf8'))!==digest)throw new CliError('PLUGIN_PATH_CONFLICT','An obsolete plugin file was modified; preserve it and resolve the conflict before retrying.');
    obsolete.push(file);
  }
  return obsolete;
}
function writeBundle(directory:string,files:Record<string,string>,client:PluginClient,api:string,pluginName:string,configHome:string,pathRoot:string) {
  const existing=stat(directory),owned=read(join(directory,marker));
  if(existing&&(!owned||owned.schemaVersion!==2||owned.api!==api||owned.client!==client||owned.pluginName!==pluginName||owned.configHome!==configHome))throw new CliError('PLUGIN_PATH_CONFLICT','Another plugin occupies the setup path. Preserve it and resolve the conflict before retrying.');
  const obsolete=obsoleteBundleFiles(directory,owned,files);
  safeDirectory(directory,pathRoot);
  for(const [name,content] of Object.entries(files)) {
    const file=join(directory,name);safeDirectory(dirname(file),pathRoot);
    if(stat(file)?.isSymbolicLink())throw new CliError('PLUGIN_PATH_CONFLICT','A managed plugin file is a symbolic link; no target was modified.');
    atomicFile(file,content);
  }
  for(const file of obsolete)unlinkSync(file);
  atomicJson(join(directory,marker),{schemaVersion:2,api,client,pluginName,configHome,version,digest:hash(json(files)),files:Object.fromEntries(Object.entries(files).map(([name,content])=>[name,hash(content)]))});
}
export function pluginCommand(command:string,args:string[],env:NodeJS.ProcessEnv,platform=process.platform):[string,string[]] {
  if(platform!=='win32'||!/[.](cmd|bat)$/i.test(command))return [command,args];
  return [join(env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command','& '+[command,...args].map(powershellQuote).join(' ')+'; exit $LASTEXITCODE']];
}
async function run(command:string,args:string[],env:NodeJS.ProcessEnv):Promise<CommandResult> {
  const [executable,arguments_]=pluginCommand(command,args,env);
  return new Promise(resolve=>execFile(executable,arguments_,{env,timeout:45_000,maxBuffer:1024*1024,windowsHide:true},(error,stdout)=>resolve({code:error?typeof error.code==='number'?error.code:1:0,stdout})));
}
function read(path:string):any {try{return JSON.parse(readFileSync(path,'utf8'));}catch{return null;}}
function pluginRows(output:string):Record<string,unknown>[]|null {
  let value:unknown;try{value=JSON.parse(output);}catch{return null;}
  const rows=Array.isArray(value)?value:value&&typeof value==='object'&&'installed' in value?value.installed:value&&typeof value==='object'&&'plugins' in value?value.plugins:null;
  return Array.isArray(rows)?rows.filter((row):row is Record<string,unknown>=>Boolean(row&&typeof row==='object')):null;
}
function matchesName(row:Record<string,unknown>,name:string) {return row.name===name||[row.id,row.pluginId].some(id=>typeof id==='string'&&(id===name||id.startsWith(name+'@')));}
function isManaged(row:Record<string,unknown>,client:PluginClient,identity:ReturnType<typeof setupPluginIdentity>) {return client==='antigravity'?row.name===identity.name:[row.id,row.pluginId].includes(identity.name+'@'+identity.marketplace);}
function nativeRoot(row:Record<string,unknown>,client:PluginClient,cachePath?:string):string|undefined {
  const value=client==='codex'?row.installedPath??row.installPath??cachePath:client==='claude-code'?row.readFromFolder??row.installPath:row.path;
  return typeof value==='string'?resolve(value):undefined;
}
function nativeProfileMatches(row:Record<string,unknown>,client:PluginClient,api:string,pluginName:string,configHome:string) {
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
  try{for(const nativeRoot of roots)verifyPluginBundle({api,client,pluginName,configHome,nativeRoot});return true;}catch{return false;}

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
  return server?.url===api+'/mcp'&&(client!=='codex'||Object.keys(servers).length===1&&server.type==='http');
}
function bundleMatches(directory:string,bundle:Record<string,string>,digest:string,client:PluginClient,api:string,pluginName:string,configHome:string) {
  try {
    const existing=stat(directory);
    if(!existing?.isDirectory()||existing.isSymbolicLink())return false;
    return verifyPluginBundle({api,client,pluginName,configHome,nativeRoot:directory}).digest===digest&&Object.entries(bundle).every(([name,text])=>readFileSync(join(directory,name),'utf8')===text);
  }catch{return false;}
}
export async function installSetupPlugins(api:string,selected:string[],options:PluginOptions={}) {
  if(selected.some(client=>!clients.includes(client as PluginClient)))throw new CliError('INVALID_USAGE','Choose a supported client from setup inventory.',64);
  const identity=setupPluginIdentity(api),origin=identity.api,{home,env,which}=context(options),runner=options.runner??run;
  const configHome=resolve(env.OPENCRAWL_CONFIG_HOME||env.XDG_CONFIG_HOME||join(home,'.config')),root=join(configHome,'opencrawl','setup-plugins');
  const command=options.command??setupCommandForSelf(),results:PluginResult[]=[],humanTasks:PluginHumanTask[]=[];
  const perform=async()=>{
    profileSetupCommand(command,configHome,env,true);
    for(const client of [...new Set(selected)] as PluginClient[]) {
      if(client==='devin'){
        const result=await (await import('./devin-plugin.ts')).adoptDevinPlugin(origin,{configHome,env});
        results.push(result);continue;
      }
      const bundle=setupPluginFiles(client,origin,{command,configHome,env});
      const marketRoot=join(root,client,identity.key),pathRoot=client==='cursor'?resolve(env.CURSOR_CONFIG_DIR||join(home,'.cursor')):configHome;
      const directory=client==='cursor'?join(pathRoot,'plugins','local',identity.name):join(marketRoot,identity.name);
      const receipt=join(marketRoot,'installed.json'),digest=hash(json(bundle)),saved=read(receipt);
      const prior=saved?.schemaVersion===2&&saved.api===origin&&saved.client===client&&saved.pluginName===identity.name&&saved.directory===directory?saved:null;
      const pluginId=client==='codex'||client==='claude-code'?identity.name+'@'+identity.marketplace:identity.name;
      try {
        const binary=client==='cursor'?null:which(client==='claude-code'?'claude':client==='antigravity'?'agy':client);
        let native:Record<string,unknown>|undefined,loadedRoot:string|undefined,cachePath=typeof prior?.cachePath==='string'?prior.cachePath:undefined;
        if(binary){
          const listing=await runner(binary,['plugin','list','--json'],{...env,HOME:home,USERPROFILE:home});
          const rows=listing.code===0?pluginRows(listing.stdout??''):null;
          if(!rows){results.push({client,status:'pending',message:'The client could not report its plugin state. Resolve its sign-in, version or policy before retrying.'});humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Check '+labels[client]+' plugin access',instruction:'Inspect the native client plugin inventory and its reported policy or sign-in issue. Resume setup after it can report its installed plugins.'});continue;}
          const matches=rows.filter(row=>matchesName(row,identity.name));native=matches.find(row=>isManaged(row,client,identity));
          const ownedSource=read(join(directory,marker));
          const managedSource=ownedSource?.schemaVersion===2&&ownedSource.api===origin&&ownedSource.client===client&&ownedSource.pluginName===identity.name&&ownedSource.configHome===configHome;
          if(matches.some(row=>!isManaged(row,client,identity))||native&&!prior&&!managedSource){
            results.push({client,status:'pending',message:'Another installation owns this deployment-specific plugin. It was preserved.'});
            humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Review this deployment plugin',instruction:'Inspect the existing deployment-specific plugin and source in native controls. Preserve it until the user chooses to repair or replace that installation; unrelated OpenCrawl plugins can remain enabled.'});continue;
          }
          if(native&&(native.enabled===false||native.installed===false)){results.push({client,status:'pending',message:'The deployment plugin is disabled or unavailable. Its native choice was preserved.'});humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Review the deployment plugin',instruction:'Use native controls to review this plugin’s disabled or unavailable state. Preserve policy and the user’s choice before resuming.'});continue;}
          if(native&&!nativeProfileMatches(native,client,origin,identity.name,configHome)){
            results.push({client,status:'pending',message:'The native plugin belongs to another CLI profile or its current source could not be verified. It was preserved.'});
            humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Review the active OpenCrawl profile',instruction:'Inspect this deployment plugin’s current native source and CLI profile. Continue setup with the owning profile, or have the user explicitly resolve that conflict before retrying; an older installation receipt cannot replace it.'});continue;
          }
          if(native)loadedRoot=nativeRoot(native,client,cachePath);
        }
        if(client==='cursor')await retireCursorSetupHooks(origin,pathRoot,true);
        const unchanged=bundleMatches(directory,bundle,digest,client,origin,identity.name,configHome);
        if(!unchanged)writeBundle(directory,bundle,client,origin,identity.name,configHome,pathRoot);
        if(client==='cursor') {
          // Supported persistent local discovery; policy can still prevent loading.
          // Activation is observed from this deployment's trusted plugin hook, not inferred
          // from files or an unrelated marketplace plugin with another name.
          await retireCursorSetupHooks(origin,pathRoot);
          loadedRoot=directory;
        } else {
          if(!binary){results.push({client,status:'pending',message:labels[client]+"'s native plugin installer is unavailable.",directory});humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Install '+labels[client]+' plugin support',instruction:'Install or update the native client CLI, then resume setup. Preserve existing plugins and authentication.'});continue;}
          if(!native||!unchanged||!nativeBindingMatches(native,client,directory,origin,identity.name,digest,configHome,loadedRoot)) {
            let commands:string[][]=[];
            if(client==='codex'||client==='claude-code') {
              const file=client==='codex'?'.agents/plugins/marketplace.json':'.claude-plugin/marketplace.json';
              const entry=client==='codex'?{name:identity.name,source:{source:'local',path:'./'+identity.name},policy:{installation:'AVAILABLE',authentication:'ON_USE'},category:'Productivity'}:{name:identity.name,source:'./'+identity.name};
              safeDirectory(dirname(join(marketRoot,file)),configHome);atomicJson(join(marketRoot,file),{name:identity.marketplace,owner:{name:'OpenCrawl'},plugins:[entry]});
              commands=client==='codex'?[['plugin','marketplace','add',marketRoot,'--json'],['plugin','add',pluginId,'--json']]:[['plugin','marketplace','add',marketRoot,'--json'],['plugin','install',pluginId,'--scope','user','--json']];
            } else commands=[['plugin','install',directory]];
            let success=true;
            for(const args of commands){const result=await runner(binary,args,{...env,HOME:home,USERPROFILE:home});if(result.code!==0){success=false;break;}if(client==='codex'&&args[1]==='add')try{const installed=JSON.parse(result.stdout??'');if(typeof installed.installedPath==='string')cachePath=installed.installedPath;}catch{}}
            if(!success){results.push({client,status:'error',message:labels[client]+' did not confirm plugin installation.',directory});humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Finish '+labels[client]+' plugin installation',instruction:'Review the native installation error and resolve its policy, access or sign-in requirement before resuming.'});continue;}
            const confirmed=await runner(binary,['plugin','list','--json'],{...env,HOME:home,USERPROFILE:home});
            native=confirmed.code===0?pluginRows(confirmed.stdout??'')?.find(row=>isManaged(row,client,identity)):undefined;
            loadedRoot=native?nativeRoot(native,client,cachePath):undefined;
            if(!native||native.enabled===false||native.installed===false||!nativeBindingMatches(native,client,directory,origin,identity.name,digest,configHome,loadedRoot)) {results.push({client,status:'pending',message:'The client has not confirmed this enabled plugin at the selected source and endpoint.',directory});humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Confirm '+labels[client]+' plugin source',instruction:'Inspect the native plugin source and endpoint. Preserve unrelated plugins and finish the reported policy or installation step before resuming.'});continue;}
          }
        }
        safeDirectory(dirname(receipt),configHome);atomicJson(receipt,{schemaVersion:2,api:origin,client,pluginName:identity.name,configHome,digest,pluginId,directory,nativeRoot:loadedRoot,...(client==='codex'&&loadedRoot?{cachePath:loadedRoot}:{})});
        const active=Boolean(loadedRoot&&pluginActivationMatches({api:origin,client,pluginName:identity.name,digest,nativeRoot:loadedRoot,configHome}));
        results.push({client,status:active?(unchanged?'unchanged':'installed'):'prepared',pluginId,directory,...(!active?{message:'Plugin prepared; waiting for its native startup hook to confirm activation.'}:{})});
        if(!active)humanTasks.push({id:client+':restart',kind:'restart',client,title:'Load OpenCrawl in '+labels[client],instruction:`Open or reload ${labels[client]} and select the ${identity.name} plugin for ${origin}. Review any native plugin-hook trust request. ${client==='cursor'?'In Customize or /plugin list, confirm this deployment-specific local plugin loads; if local imports are blocked, ask the administrator to allow it. ':''}Resume setup after its native startup hook runs. Do not use a session-only --plugin-dir override as installation proof.`});
        humanTasks.push({id:client+':mcp_auth',kind:'mcp_auth',client,title:'Connect OpenCrawl in '+labels[client],instruction:`Use the ${identity.name} plugin's native connection flow for ${origin}. Complete requested MCP authentication in this client and run its native verification. Preserve other deployments and never copy CLI credentials.`,url:origin+'/mcp'});
      }catch(error){results.push({client,status:'error',message:error instanceof CliError?error.message:'Could not install the plugin. Check native access and retry.'});humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Resolve '+labels[client]+' plugin installation',instruction:'Read the reported installation error, preserve existing configuration, and resolve only the required access or conflict before retrying.'});}
    }
    return {results,humanTasks};
  };
  return withSessionLock('setup:plugins',perform);
}
