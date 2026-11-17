import {existsSync, lstatSync, readFileSync, mkdirSync, unlinkSync} from 'node:fs';
import {join, dirname, resolve, isAbsolute, posix} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {atomicFile, atomicJson, withSessionLock} from '../session.ts';
import {apiOrigin, CliError, DEFAULT_API_ORIGIN} from '../oauth.ts';
import {version} from '../distribution.ts';
import {setupAgentGuide} from './agent-guide.ts';
import {skillFiles} from '../skills.ts';
import {retrievalInstruction} from '../retrieval-instruction.ts';
import {setupCommandForSelf,profileSetupCommand} from './invocation.ts';
import {reconcileCursorNativeHooks} from './cursor-native-hooks.ts';
import {pluginHookFiles} from './plugin-hooks.ts';
import {pluginActivationMatches,verifyPluginBundle,sessionsPlugin,sessionsPluginRoot,sessionsActivationMatches,writeSessionsReceipt,isSessionsClient,type SessionsClient} from './plugin-context.ts';

export type PluginClient = 'claude-code' | 'codex' | 'cursor' | 'antigravity' | 'devin';
/** Claude Code and Codex install plugins/opencrawl-sessions natively; these clients still get a generated bundle. */
export type GeneratedPluginClient = Exclude<PluginClient,SessionsClient>;
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
/** Bundled in the executable: these plugins own hooks, MCP and agent guidance. */
export function setupPluginFiles(client:GeneratedPluginClient,api:string,options:BundleOptions={}):Record<string,string> {
  const identity=setupPluginIdentity(api),origin=identity.api,url=origin+'/mcp';
  const command=options.command??setupCommandForSelf(),configHome=(client==='devin'?posix: {resolve}).resolve(options.configHome??process.env.OPENCRAWL_CONFIG_HOME??process.env.XDG_CONFIG_HOME??join(homedir(),'.config'));
  const base={name:identity.name,version,description:'Search knowledge and finish OpenCrawl setup at '+origin+'.',author:{name:'OpenCrawl'},license:'MIT'};
  const guideCommand=client==='devin'?['/usr/bin/env','OPENCRAWL_AUTH=devin-cloud','OPENCRAWL_CONFIG_HOME='+configHome,'OPENCRAWL_API_URL='+origin,'PATH=/usr/local/bin:/usr/bin:/bin',...command]:profileSetupCommand(command,configHome,options.env);
  const guide=setupAgentGuide(client,origin,guideCommand,client==='devin'?'linux':process.platform,client==='devin'?{name:identity.name,url}:undefined)+`\nThis plugin is \`${identity.name}\`, bound to ${origin}. Use this plugin's native MCP namespace for setup and search; preserve other OpenCrawl deployments.\n`;
  const files:Record<string,string>={...Object.fromEntries(Object.entries(skillFiles()).map(([name,content])=>['skills/opencrawl/'+name,content])),'skills/opencrawl-setup/SKILL.md':guide,'README.md':'# OpenCrawl\n\nContinue setup at '+origin+' with this plugin. The CLI owns saved choices and history workers; native startup and capture use this deployment’s owned hooks.\n'};
  if(client==='cursor') {
    files['.cursor-plugin/plugin.json']=json(base);
    files['mcp.json']=json({mcpServers:{opencrawl:{url}}});
    files['rules/opencrawl.mdc']=`---
description: Use OpenCrawl workspace knowledge and native board notifications.
alwaysApply: true
---

${retrievalInstruction}

Use the opencrawl skill bundled with this plugin, ${identity.name}, for ${origin}.
For CLI commands, follow this plugin's setup guide so its exact command, profile
and server stay bound to this installation. Preserve other OpenCrawl deployments.

For an enrolled session, use the OpenCrawl sessionStart or first-tool receipt as
the native board identity. Read the bundled skill's participation instructions,
set your name and task if unset, and attach one native Shell board watch with
block_until_ms:0 and notify_on_output. Use the receipt's session and server.
Keep the task output attached and end the turn normally; matching output resumes
the idle agent. Registration alone is not listening. If the receipt is missing,
follow this plugin's registration fallback. If native notifications are unavailable,
state that limitation and use work-boundary reads. Do not run board diagnostics
unless requested.
`;
  } else if(client==='devin') {
    files['.devin-plugin/plugin.json']=json({...base,platforms:['cloud']});
    files['.mcp.json']=json({mcpServers:{[identity.name]:{command:'/bin/sh',args:['${PLUGIN_ROOT}/scripts/opencrawl-hook.sh','mcp','--api',origin]}}});
    files['.opencrawl-devin.json']=json({schemaVersion:1,api:origin,configHome,command,recording:options.recording===true});
    files['AGENTS.md']=`${retrievalInstruction}\n\nUse the opencrawl skill bundled with ${identity.name} for ${origin}. Native startup uses this Cloud session's renewable identity and the bundle's explicit recording choice. Installation alone is not capture or MCP proof. Read the opencrawl-setup skill if startup reports a problem; never copy a human credential or start browser login in this VM. Preserve recording opt-outs and other deployments.\n\nUse the startup receipt's native session handle for board participation. Read the skill's participation instructions and set a name/task if unset. This Cloud integration has no verified idle notification facility: read the inbox at meaningful work boundaries. A detached shell does not establish pushed notifications. Do not reconstruct missing history or claim first-turn completeness.\n`;
  } else {
    files['plugin.json']=json({...base,$schema:'https://antigravity.google/schemas/v1/plugin.json',displayName:'OpenCrawl ('+new URL(origin).host+')',suggestedPrompts:['Continue my OpenCrawl setup at '+origin+'.']});
    files['mcp_config.json']=json({mcpServers:{opencrawl:{url}}});
  }
  const hookFiles=pluginHookFiles(client,{command,configHome,api:origin,pluginName:identity.name,env:options.env},client==='devin'?'linux':process.platform);
  if(client==='cursor'){
    hookFiles['scripts/cursor-native-hooks.json']=hookFiles['hooks/hooks.json']!;delete hookFiles['hooks/hooks.json'];
    // Old in-memory plugin callbacks must not execute the new user-hook runner.
    const old=process.platform==='win32'?'scripts/opencrawl-hook.cmd':'scripts/opencrawl-hook.sh';
    hookFiles[old.replace('opencrawl-hook','opencrawl-cursor-native')]=hookFiles[old]!;delete hookFiles[old];
  }
  return {...files,...hookFiles};
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
  const literal=(value:string)=>"'"+value.replaceAll("'","''")+"'";
  return [join(env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command','& '+[command,...args].map(literal).join(' ')+'; exit $LASTEXITCODE']];
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
function isManaged(row:Record<string,unknown>,identity:ReturnType<typeof setupPluginIdentity>) {return row.name===identity.name;}
function nativeRoot(row:Record<string,unknown>):string|undefined {
  return typeof row.path==='string'?resolve(row.path):undefined;
}
function nativeProfileMatches(row:Record<string,unknown>,client:GeneratedPluginClient,api:string,pluginName:string,configHome:string) {
  // The current native source is authoritative. A saved receipt can outlive a
  // different CLI profile taking ownership of this deployment-specific plugin.
  const root=nativeRoot(row);if(!root)return false;
  try{verifyPluginBundle({api,client,pluginName,configHome,nativeRoot:root});return true;}catch{return false;}
}
function nativeBindingMatches(client:GeneratedPluginClient,api:string,name:string,digest:string,configHome:string,root?:string) {
  if(!root)return false;
  try{if(verifyPluginBundle({api,client,pluginName:name,configHome,nativeRoot:root}).digest!==digest)return false;}catch{return false;}
  return read(join(root,client==='antigravity'?'mcp_config.json':'mcp.json'))?.mcpServers?.opencrawl?.url===api+'/mcp';
}
function bundleMatches(directory:string,bundle:Record<string,string>,digest:string,client:GeneratedPluginClient,api:string,pluginName:string,configHome:string) {
  try {
    const existing=stat(directory);
    if(!existing?.isDirectory()||existing.isSymbolicLink())return false;
    return verifyPluginBundle({api,client,pluginName,configHome,nativeRoot:directory}).digest===digest&&Object.entries(bundle).every(([name,text])=>readFileSync(join(directory,name),'utf8')===text);
  }catch{return false;}
}

type Outcome={result:PluginResult;humanTasks:PluginHumanTask[]};
type SessionsInstall={client:SessionsClient;origin:string;home:string;env:NodeJS.ProcessEnv;binary:string|null;run:(args:string[])=>Promise<CommandResult>};
const sessionsSparse:Record<SessionsClient,string[]>={'claude-code':['--sparse','.claude-plugin','plugins/opencrawl-sessions'],codex:['--sparse','.agents/plugins','--sparse','plugins/opencrawl-sessions']};
/** Both harnesses install this repository's plugin directory through their own
 * marketplace commands. OPENCRAWL_PLUGIN_SOURCE names another checkout, fork or
 * pinned ref; a local path is read in place and needs no sparse checkout. */
export function sessionsMarketplaceArgs(client:SessionsClient,env:NodeJS.ProcessEnv):string[] {
  const source=env.OPENCRAWL_PLUGIN_SOURCE||'getopencrawl/opencrawl-core';
  return ['plugin','marketplace','add',source,...(isAbsolute(source)?[]:sessionsSparse[client]),'--json'];
}
function sessionsRow(output:string|undefined):Record<string,unknown>|undefined {
  return pluginRows(output??'')?.find(row=>[row.id,row.pluginId].includes(sessionsPlugin.id)&&row.installed!==false);
}
function sessionsRoot(row:Record<string,unknown>,{client,home,env}:SessionsInstall):string|null {
  // Claude Code reads a local marketplace in place. Codex always runs its cached copy.
  const candidates=client==='claude-code'?[row.readFromFolder,row.installPath]
    :[row.installedPath,typeof row.version==='string'?join(env.CODEX_HOME||join(home,'.codex'),'plugins','cache',sessionsPlugin.marketplace,sessionsPlugin.name,row.version):undefined];
  for(const candidate of candidates){
    const root=typeof candidate==='string'?sessionsPluginRoot(client,resolve(candidate)):null;
    if(root&&read(join(root,'.mcp.json'))?.mcpServers?.opencrawl?.url===DEFAULT_API_ORIGIN+'/mcp')return root;
  }
  return null;
}
/** The plugin always names the cloud address. Another server gets its own
 * user-level entry called opencrawl; nothing else in the client is rewritten. */
async function selfHostedMcp({client,origin,home,env,run}:SessionsInstall):Promise<boolean> {
  const url=origin+'/mcp';
  if(client==='codex'){
    // Codex resolves servers by name: this entry replaces the plugin's. Its
    // per-plugin switch also keeps the cloud entry off if the name ever differs.
    if((await run(['mcp','add','opencrawl','--url',url])).code!==0)return false;
    const file=join(env.CODEX_HOME||join(home,'.codex'),'config.toml'),header=`[plugins."${sessionsPlugin.id}".mcp_servers.opencrawl]`;
    const text=existsSync(file)?readFileSync(file,'utf8'):'';
    if(!text.includes(header))atomicFile(file,text+(text&&!text.endsWith('\n')?'\n':'')+'\n'+header+'\nenabled = false\n');
    return true;
  }
  // Claude Code refuses to replace an existing name, so the saved address decides.
  const saved=()=>read(join(env.CLAUDE_CONFIG_DIR||home,'.claude.json'))?.mcpServers?.opencrawl?.url===url;
  if(saved())return true;
  await run(['mcp','add','--transport','http','--scope','user','opencrawl',url]);
  return saved();
}
async function installSessionsPlugin(install:SessionsInstall):Promise<Outcome> {
  const {client,origin,binary,run}=install,label=labels[client],pluginId=sessionsPlugin.id;
  const pending=(message:string,title:string,instruction:string,status:'pending'|'error'='pending'):Outcome=>({result:{client,status,message},humanTasks:[{id:client+':plugin_install',kind:'plugin_install',client,title,instruction}]});
  if(!binary)return pending(label+"'s native plugin installer is unavailable.",'Install '+label+' plugin support','Install or update the native client CLI, then resume setup. Preserve existing plugins and authentication.');
  const listing=await run(['plugin','list','--json']);
  if(listing.code!==0||!pluginRows(listing.stdout??''))return pending('The client could not report its plugin state. Resolve its sign-in, version or policy before retrying.','Check '+label+' plugin access','Inspect the native client plugin inventory and its reported policy or sign-in issue. Resume setup after it can report its installed plugins.');
  let native=sessionsRow(listing.stdout);const present=Boolean(native);
  if(native?.enabled===false)return pending('The OpenCrawl plugin is disabled. Its native choice was preserved.','Review the OpenCrawl plugin','Use native controls to review this plugin’s disabled state. Preserve policy and the user’s choice before resuming.');
  if(!native){
    for(const args of [sessionsMarketplaceArgs(client,install.env),client==='codex'?['plugin','add',pluginId,'--json']:['plugin','install',pluginId,'--scope','user','--json']])
      if((await run(args)).code!==0)return pending(label+' did not confirm plugin installation.','Finish '+label+' plugin installation','Review the native installation error and resolve its policy, access or sign-in requirement before resuming.','error');
    const confirmed=await run(['plugin','list','--json']);
    native=confirmed.code===0?sessionsRow(confirmed.stdout):undefined;
  }
  const root=native&&native.enabled!==false?sessionsRoot(native,install):null;
  if(!root)return pending('The client has not confirmed this enabled plugin at its expected source and endpoint.','Confirm '+label+' plugin source','Inspect the native plugin source and endpoint. Preserve unrelated plugins and finish the reported policy or installation step before resuming.');
  const selfHosted=origin!==DEFAULT_API_ORIGIN;
  if(selfHosted&&!await selfHostedMcp(install))return pending(label+' did not confirm an opencrawl MCP server for '+origin+'.','Add the '+origin+' MCP server in '+label,`Add a user-level MCP server named opencrawl for ${origin}/mcp with native controls. If another server already uses that name, have the user rename or remove it first, then resume setup.`);
  writeSessionsReceipt(client,origin,root);
  const active=sessionsActivationMatches(client,root),humanTasks:PluginHumanTask[]=[];
  if(!active)humanTasks.push({id:client+':restart',kind:'restart',client,title:'Load OpenCrawl in '+label,instruction:`Open or reload ${label} so it loads the ${sessionsPlugin.name} plugin. ${client==='codex'?'Review its hooks once in /hooks (or desktop Settings > Hooks); installing does not grant hook trust. ':''}Resume setup after its native startup hook runs. Do not use a session-only --plugin-dir override as installation proof.`});
  const connect=!selfHosted?`Use the ${sessionsPlugin.name} plugin's native connection flow for ${origin}.`
    :client==='codex'?`Connect the user-level opencrawl MCP server for ${origin}. It replaces the plugin's cloud entry, which setup turned off.`
    :`Connect the user-level opencrawl MCP server for ${origin}. The plugin also lists the OpenCrawl cloud server as plugin:${sessionsPlugin.name}:opencrawl; Claude Code can only turn that one off per project, in /mcp, so disable it there and leave it signed out.`;
  humanTasks.push({id:client+':mcp_auth',kind:'mcp_auth',client,title:'Connect OpenCrawl in '+label,instruction:connect+' Complete requested MCP authentication in this client and run its native verification. Preserve other deployments and never copy CLI credentials.',url:origin+'/mcp'});
  return {result:{client,status:active?(present?'unchanged':'installed'):'prepared',pluginId,directory:root,...(!active?{message:'Plugin prepared; waiting for its native startup hook to confirm activation.'}:{})},humanTasks};
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
      if(isSessionsClient(client)){
        try {
          const binary=which(client==='claude-code'?'claude':client);
          const outcome=await installSessionsPlugin({client,origin,home,env,binary,run:args=>runner(binary!,args,{...env,HOME:home,USERPROFILE:home})});
          results.push(outcome.result);humanTasks.push(...outcome.humanTasks);
        }catch(error){results.push({client,status:'error',message:error instanceof CliError?error.message:'Could not install the plugin. Check native access and retry.'});humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Resolve '+labels[client]+' plugin installation',instruction:'Read the reported installation error, preserve existing configuration, and resolve only the required access or conflict before retrying.'});}
        continue;
      }
      const bundle=setupPluginFiles(client,origin,{command,configHome,env});
      const marketRoot=join(root,client,identity.key),pathRoot=client==='cursor'?resolve(env.CURSOR_CONFIG_DIR||join(home,'.cursor')):configHome;
      const directory=client==='cursor'?join(pathRoot,'plugins','local',identity.name):join(marketRoot,identity.name);
      const receipt=join(marketRoot,'installed.json'),digest=hash(json(bundle)),saved=read(receipt);
      const prior=saved?.schemaVersion===2&&saved.api===origin&&saved.client===client&&saved.pluginName===identity.name&&saved.directory===directory?saved:null;
      const pluginId=identity.name;
      try {
        const binary=client==='cursor'?null:which('agy');
        let native:Record<string,unknown>|undefined,loadedRoot:string|undefined;
        if(binary){
          const listing=await runner(binary,['plugin','list','--json'],{...env,HOME:home,USERPROFILE:home});
          const rows=listing.code===0?pluginRows(listing.stdout??''):null;
          if(!rows){results.push({client,status:'pending',message:'The client could not report its plugin state. Resolve its sign-in, version or policy before retrying.'});humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Check '+labels[client]+' plugin access',instruction:'Inspect the native client plugin inventory and its reported policy or sign-in issue. Resume setup after it can report its installed plugins.'});continue;}
          const matches=rows.filter(row=>matchesName(row,identity.name));native=matches.find(row=>isManaged(row,identity));
          const ownedSource=read(join(directory,marker));
          const managedSource=ownedSource?.schemaVersion===2&&ownedSource.api===origin&&ownedSource.client===client&&ownedSource.pluginName===identity.name&&ownedSource.configHome===configHome;
          if(matches.some(row=>!isManaged(row,identity))||native&&!prior&&!managedSource){
            results.push({client,status:'pending',message:'Another installation owns this deployment-specific plugin. It was preserved.'});
            humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Review this deployment plugin',instruction:'Inspect the existing deployment-specific plugin and source in native controls. Preserve it until the user chooses to repair or replace that installation; unrelated OpenCrawl plugins can remain enabled.'});continue;
          }
          if(native&&(native.enabled===false||native.installed===false)){results.push({client,status:'pending',message:'The deployment plugin is disabled or unavailable. Its native choice was preserved.'});humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Review the deployment plugin',instruction:'Use native controls to review this plugin’s disabled or unavailable state. Preserve policy and the user’s choice before resuming.'});continue;}
          if(native&&!nativeProfileMatches(native,client,origin,identity.name,configHome)){
            results.push({client,status:'pending',message:'The native plugin belongs to another CLI profile or its current source could not be verified. It was preserved.'});
            humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Review the active OpenCrawl profile',instruction:'Inspect this deployment plugin’s current native source and CLI profile. Continue setup with the owning profile, or have the user explicitly resolve that conflict before retrying; an older installation receipt cannot replace it.'});continue;
          }
          if(native)loadedRoot=nativeRoot(native);
        }
        const unchanged=bundleMatches(directory,bundle,digest,client,origin,identity.name,configHome);
        if(client==='cursor')await reconcileCursorNativeHooks(pathRoot,directory,join(marketRoot,'native-hooks.json'),bundle['scripts/cursor-native-hooks.json'],true);
        if(!unchanged)writeBundle(directory,bundle,client,origin,identity.name,configHome,pathRoot);
        if(client==='cursor') {
          // Supported persistent local discovery; policy can still prevent loading.
          // Activation is observed from this deployment's native user hook, not inferred
          // from files or an unrelated marketplace plugin with another name.
          await reconcileCursorNativeHooks(pathRoot,directory,join(marketRoot,'native-hooks.json'),bundle['scripts/cursor-native-hooks.json']);
          loadedRoot=directory;
        } else {
          if(!binary){results.push({client,status:'pending',message:labels[client]+"'s native plugin installer is unavailable.",directory});humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Install '+labels[client]+' plugin support',instruction:'Install or update the native client CLI, then resume setup. Preserve existing plugins and authentication.'});continue;}
          if(!native||!unchanged||!nativeBindingMatches(client,origin,identity.name,digest,configHome,loadedRoot)) {
            const result=await runner(binary,['plugin','install',directory],{...env,HOME:home,USERPROFILE:home});
            if(result.code!==0){results.push({client,status:'error',message:labels[client]+' did not confirm plugin installation.',directory});humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Finish '+labels[client]+' plugin installation',instruction:'Review the native installation error and resolve its policy, access or sign-in requirement before resuming.'});continue;}
            const confirmed=await runner(binary,['plugin','list','--json'],{...env,HOME:home,USERPROFILE:home});
            native=confirmed.code===0?pluginRows(confirmed.stdout??'')?.find(row=>isManaged(row,identity)):undefined;
            loadedRoot=native?nativeRoot(native):undefined;
            if(!native||native.enabled===false||native.installed===false||!nativeBindingMatches(client,origin,identity.name,digest,configHome,loadedRoot)) {results.push({client,status:'pending',message:'The client has not confirmed this enabled plugin at the selected source and endpoint.',directory});humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Confirm '+labels[client]+' plugin source',instruction:'Inspect the native plugin source and endpoint. Preserve unrelated plugins and finish the reported policy or installation step before resuming.'});continue;}
          }
        }
        safeDirectory(dirname(receipt),configHome);atomicJson(receipt,{schemaVersion:2,api:origin,client,pluginName:identity.name,configHome,digest,pluginId,directory,nativeRoot:loadedRoot});
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
