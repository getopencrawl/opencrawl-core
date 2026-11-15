import {existsSync, lstatSync, readFileSync, mkdirSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {atomicFile, atomicJson, withSessionLock} from '../session.ts';
import {apiOrigin, CliError} from '../oauth.ts';
import {version} from '../distribution.ts';
import {setupAgentGuide} from './agent-guide.ts';
import {skillFiles,startupInstruction} from '../skills.ts';

export type PluginClient = 'claude-code' | 'codex' | 'cursor' | 'antigravity';
export type PluginHumanTask = {id:string;kind:'mcp_auth'|'restart'|'plugin_install';client:PluginClient;title:string;instruction:string;url?:string};
export type PluginResult = {client:PluginClient;status:'installed'|'unchanged'|'pending'|'error';message?:string;pluginId?:string;directory?:string};
type CommandResult = {code:number;stdout?:string};
export type PluginOptions = {home?:string;env?:NodeJS.ProcessEnv;which?:(name:string)=>string|null;runner?:(command:string,args:string[],env:NodeJS.ProcessEnv)=>Promise<CommandResult>};
const clients:PluginClient[] = ['claude-code','codex','cursor','antigravity'];
const labels:Record<PluginClient,string> = {'claude-code':'Claude Code',codex:'Codex',cursor:'Cursor',antigravity:'Antigravity'};
const marker = '.opencrawl-setup-plugin.json';
const hash = (text:string) => createHash('sha256').update(text).digest('hex');
const json = (value:unknown) => JSON.stringify(value,null,2)+'\n';
function context(options:PluginOptions) { return {home:options.home??homedir(),env:options.env??process.env,which:options.which??Bun.which}; }
export function pluginInventory(options:PluginOptions={}) {
  const {home,env,which}=context(options);
  return clients.map(id=>{
    const roots = id==='codex' ? [env.CODEX_HOME||join(home,'.codex')]
      : id==='claude-code' ? [env.CLAUDE_CONFIG_DIR||join(home,'.claude')]
      : id==='cursor' ? [env.CURSOR_CONFIG_DIR||join(home,'.cursor')]
      : ['antigravity-cli','antigravity-app','antigravity-ide'].map(surface=>join(env.ANTIGRAVITY_HOME||join(home,'.gemini'),surface));
    const command=id==='claude-code'?'claude':id==='antigravity'?'agy':id;
    return {id,label:labels[id],supported:true,detected:roots.some(existsSync)||Boolean(which(command))||id==='cursor'&&Boolean(which('cursor-agent'))};
  });
}
/** Bundled in the executable: no network install scripts or hosted account dependency. */
export function setupPluginFiles(client:PluginClient,api:string):Record<string,string> {
  const origin=apiOrigin(api),url=origin+'/mcp';
  const base={name:'opencrawl',version,description:'Search shared knowledge and finish OpenCrawl setup with your agent.',author:{name:'OpenCrawl'},license:'MIT'};
  const guide=setupAgentGuide(client,origin);
  const files:Record<string,string>={...Object.fromEntries(Object.entries(skillFiles(guide)).map(([name,content])=>['skills/opencrawl/'+name,content])),'skills/opencrawl-setup/SKILL.md':guide,'README.md':'# OpenCrawl\n\nContinue setup with your agent. The CLI owns saved choices; native hook trust and MCP authentication remain yours.\n'};
  if(client==='codex') {
    files['plugin.json']=json({...base,extensions:{'com.openai':{onboardingSkill:'./skills/opencrawl-setup/SKILL.md',interface:{displayName:'OpenCrawl',shortDescription:'Search knowledge and finish setup',defaultPrompt:['Continue my OpenCrawl setup.']}}}});
    files['mcp.json']=json({mcpServers:{opencrawl:{type:'streamable-http',url}}});
  } else if(client==='claude-code') {
    files['.claude-plugin/plugin.json']=json(base);
    files['.mcp.json']=json({mcpServers:{opencrawl:{type:'http',url}}});
  } else if(client==='cursor') {
    files['.cursor-plugin/plugin.json']=json(base);
    files['mcp.json']=json({mcpServers:{opencrawl:{url}}});
    files['rules/opencrawl.mdc']=`---
description: Use the OpenCrawl skill and native board notifications.
alwaysApply: true
---

${startupInstruction()}

For an enrolled session, read the participation instructions and attach one native
Shell board watch with block_until_ms:0 and notify_on_output. Use the receipt's
session and server. Keep output attached and end the turn normally; matching output
resumes the idle agent. Registration alone is not listening. If native notifications
are unavailable, state that limitation and use work-boundary reads. Do not run board
diagnostics unless requested.
`;
  } else {
    files['plugin.json']=json({...base,$schema:'https://antigravity.google/schemas/v1/plugin.json',displayName:'OpenCrawl',suggestedPrompts:['Continue my OpenCrawl setup.']});
    files['mcp_config.json']=json({mcpServers:{opencrawl:{url}}});
  }
  // Capture hooks remain owned by the CLI collector; plugin discovery cannot
  // silently enable recording or introduce a second capture owner.
  return files;
}
function stat(path:string) {try{return lstatSync(path);}catch(error:any){if(error.code==='ENOENT')return null;throw error;}}
function safeDirectory(path:string) {
  const existing=stat(path);
  if(existing){if(!existing.isDirectory()||existing.isSymbolicLink())throw new CliError('PLUGIN_PATH_CONFLICT','The plugin path is not an ordinary directory. Preserve it and choose another installation path.');return;}
  safeDirectory(dirname(path));mkdirSync(path,{mode:0o700});
}
function writeBundle(directory:string,files:Record<string,string>,api:string) {
  const existing=stat(directory);
  if(existing&&!existsSync(join(directory,marker)))throw new CliError('PLUGIN_PATH_CONFLICT','An unmanaged OpenCrawl plugin already occupies the setup path. Keep it and resolve the conflict before retrying.');
  safeDirectory(directory);
  for(const [name,content] of Object.entries(files)) {
    const file=join(directory,name);safeDirectory(dirname(file));
    if(stat(file)?.isSymbolicLink())throw new CliError('PLUGIN_PATH_CONFLICT','A managed plugin file is a symbolic link; no target was modified.');
    atomicFile(file,content);
  }
  atomicJson(join(directory,marker),{schemaVersion:1,api,version,digest:hash(json(files))});
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
function isOpenCrawl(row:Record<string,unknown>) {return row.name==='opencrawl'||[row.id,row.pluginId].some(id=>typeof id==='string'&&(id==='opencrawl'||id.startsWith('opencrawl@')));}
function isManaged(row:Record<string,unknown>,client:PluginClient) {return client==='antigravity'?isOpenCrawl(row):[row.id,row.pluginId].includes('opencrawl@opencrawl-cli');}
function nativeEndpointMatches(row:Record<string,unknown>,client:PluginClient,directory:string,api:string,cachePath?:string) {
  if(client==='codex') {
    const source=row.source as {source?:unknown;path?:unknown}|undefined;
    return source?.source==='local'&&typeof source.path==='string'&&resolve(source.path)===resolve(directory)
      &&(!cachePath||read(join(cachePath,'mcp.json'))?.mcpServers?.opencrawl?.url===api+'/mcp');
  }
  if(client==='claude-code') {
    const servers=row.mcpServers as {opencrawl?:{url?:unknown}}|undefined;
    return servers?.opencrawl?.url===api+'/mcp'&&(row.readFromFolder===undefined||typeof row.readFromFolder==='string'&&resolve(row.readFromFolder)===resolve(directory));
  }
  // Antigravity currently confirms enabled installation but does not expose an
  // effective MCP endpoint in its supported native inventory. MCP proof stays
  // separate; do not invent a field or treat installation as authentication.
  return true;
}
export async function installSetupPlugins(api:string,selected:string[],options:PluginOptions={}) {
  if(selected.some(client=>!clients.includes(client as PluginClient)))throw new CliError('INVALID_USAGE','Choose claude-code, codex, cursor, or antigravity plugins.',64);
  const origin=apiOrigin(api),{home,env,which}=context(options),runner=options.runner??run;
  const config=join(env.OPENCRAWL_CONFIG_HOME||env.XDG_CONFIG_HOME||join(home,'.config'),'opencrawl');
  // Each native client has one active local marketplace. Keep its registered
  // source stable when the user explicitly chooses a different deployment.
  const root=join(config,'setup-plugins');
  const results:PluginResult[]=[],humanTasks:PluginHumanTask[]=[];
  const perform=async()=>{
    for(const client of [...new Set(selected)] as PluginClient[]) {
      const bundle=setupPluginFiles(client,origin);
      const directory=client==='cursor'?join(env.CURSOR_CONFIG_DIR||join(home,'.cursor'),'plugins','local','opencrawl'):join(root,client,'opencrawl');
      const receipt=join(root,client,'installed.json'),digest=hash(json(bundle));
      const prior=read(receipt);
      try {
        const binary=client==='codex'?which('codex'):client==='claude-code'?which('claude'):client==='antigravity'?which('agy'):null;
        let nativeInstalled=false,nativeBound=false;
        if(binary){
          const listing=await runner(binary,['plugin','list','--json'],{...env,HOME:home,USERPROFILE:home});
          if(listing.code!==0){results.push({client,status:'pending',message:'The client could not report its plugin state. Resolve its sign-in or policy before retrying.'});humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Check '+labels[client]+' plugin access',instruction:'Guide the user through this client’s sign-in or policy issue, then resume OpenCrawl setup. Do not assume plugin installation succeeded.'});continue;}
          const rows=pluginRows(listing.stdout??'');
          if(!rows){results.push({client,status:'pending',message:'The client returned an unsupported plugin inventory. Update its CLI and retry.'});humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Update '+labels[client],instruction:'Use the client’s supported update path, then resume OpenCrawl setup to install its plugin.'});continue;}
          const matches=rows.filter(isOpenCrawl),owned=matches.find(row=>isManaged(row,client));
          if(matches.some(row=>!isManaged(row,client))||(client==='antigravity'&&owned&&!prior)){
            results.push({client,status:'pending',message:'An OpenCrawl plugin from another installation already exists. It was preserved.'});
            humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Review the existing OpenCrawl plugin',instruction:'Show the user the existing plugin and its server endpoint in native client controls. Ask whether to keep it or replace it with the selected setup endpoint; do not install a duplicate or remove it automatically. Resume setup after the native conflict is resolved.'});continue;
          }
          if(owned&&typeof owned==='object'&&'enabled' in owned&&owned.enabled===false){results.push({client,status:'pending',message:'The OpenCrawl plugin is disabled in this client. Its existing choice was preserved.'});humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Review the disabled OpenCrawl plugin',instruction:'Ask whether to enable the existing disabled plugin. Use the client’s native controls only after that explicit choice, then resume setup.'});continue;}
          nativeInstalled=Boolean(owned);
          nativeBound=Boolean(owned&&nativeEndpointMatches(owned,client,directory,origin,typeof prior?.cachePath==='string'?prior.cachePath:undefined));
        }
        if((client==='cursor'||nativeInstalled&&nativeBound)&&prior?.api===origin&&prior?.digest===digest&&Object.entries(bundle).every(([name,text])=>{try{return !stat(join(directory,name))?.isSymbolicLink()&&readFileSync(join(directory,name),'utf8')===text;}catch{return false;}})) {
          results.push({client,status:'unchanged',pluginId:prior.pluginId,directory});
        } else {
          writeBundle(directory,bundle,origin);
          if(client!=='cursor'&&!binary) {
            results.push({client,status:'pending',message:`${labels[client]}'s plugin installer is unavailable.`,directory});
            humanTasks.push({id:`${client}:plugin_install`,kind:'plugin_install',client,title:`Install the ${labels[client]} plugin`,instruction:`Use ${labels[client]}'s supported local plugin installation with ${directory}, or install its CLI and resume OpenCrawl setup. Do not substitute an unverified skill-only installation.`});
            continue;
          }
          const marketplace='opencrawl-cli';
          let commands:string[][]=[];
          if(client==='codex'||client==='claude-code') {
            const marketRoot=dirname(directory);
            const file=client==='codex'?'.agents/plugins/marketplace.json':'.claude-plugin/marketplace.json';
            const entry=client==='codex'?{name:'opencrawl',source:{source:'local',path:'./opencrawl'},policy:{installation:'AVAILABLE',authentication:'ON_USE'},category:'Productivity'}:{name:'opencrawl',source:'./opencrawl'};
            safeDirectory(dirname(join(marketRoot,file)));
            atomicJson(join(marketRoot,file),{name:marketplace,owner:{name:'OpenCrawl'},plugins:[entry]});
            commands=client==='codex'?[['plugin','marketplace','add',marketRoot,'--json'],['plugin','add',`opencrawl@${marketplace}`,'--json']]:[['plugin','marketplace','add',marketRoot,'--json'],['plugin','install',`opencrawl@${marketplace}`,'--scope','user','--json']];
          } else if(client==='antigravity')commands=[['plugin','install',directory]];
          let success=true,cachePath:string|undefined;
          for(const args of commands){
            const commandResult=await runner(binary!,args,{...env,HOME:home,USERPROFILE:home});
            if(commandResult.code!==0){success=false;break;}
            if(client==='codex'&&args[1]==='add')try{const installed=JSON.parse(commandResult.stdout??'');if(typeof installed.installedPath==='string')cachePath=installed.installedPath;}catch{}
          }
          if(!success){results.push({client,status:'error',message:`${labels[client]} did not confirm plugin installation. Its policy or sign-in may need attention.`,directory});humanTasks.push({id:`${client}:plugin_install`,kind:'plugin_install',client,title:`Finish ${labels[client]} plugin installation`,instruction:`Review ${labels[client]}'s plugin installation status with the user, then resume setup. Preserve native policy and trust decisions.`});continue;}
          if(binary){
            const confirmed=await runner(binary,['plugin','list','--json'],{...env,HOME:home,USERPROFILE:home});
            const row=confirmed.code===0?pluginRows(confirmed.stdout??'')?.find(value=>isManaged(value,client)):undefined;
            if(!row||row.enabled===false||row.installed===false||!nativeEndpointMatches(row,client,directory,origin,cachePath)){results.push({client,status:'pending',message:'The install command finished, but the client has not confirmed an enabled plugin at the selected endpoint.',directory});humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Confirm '+labels[client]+' plugin installation',instruction:'Inspect the native plugin list, its source and MCP endpoint, and finish any reported policy or enablement step with the user. Resume setup after the client confirms the selected endpoint.'});continue;}
          }
          const pluginId=client==='codex'||client==='claude-code'?`opencrawl@${marketplace}`:'opencrawl';
          safeDirectory(dirname(receipt));atomicJson(receipt,{api:origin,digest,pluginId,...(cachePath?{cachePath}:{})});
          results.push({client,status:'installed',pluginId,directory});
        }
        humanTasks.push({id:`${client}:restart`,kind:'restart',client,title:`Load OpenCrawl in ${labels[client]}`,instruction:client==='cursor'?'Reload Cursor to discover the installed local plugin. Organization policy and an existing marketplace plugin can affect whether it loads; verify the active components before continuing.':`Open or reload ${labels[client]} so its installed OpenCrawl plugin is available. Continue the saved setup there.`});
        humanTasks.push({id:`${client}:mcp_auth`,kind:'mcp_auth',client,title:`Connect OpenCrawl in ${labels[client]}`,instruction:`In ${labels[client]}, use the OpenCrawl plugin's native connection flow for ${origin}. Guide the user through authentication if requested, then run this client's native verification. Do not copy CLI credentials.`,url:origin+'/mcp'});
      } catch(error) {
        results.push({client,status:'error',message:error instanceof CliError?error.message:'Could not install the plugin. Check access to the selected client configuration and retry.'});
        humanTasks.push({id:client+':plugin_install',kind:'plugin_install',client,title:'Resolve '+labels[client]+' plugin installation',instruction:'Read the reported installation error, preserve existing plugins and configuration, and guide the user through the specific required access or conflict before retrying.'});
      }
    }
    return {results,humanTasks};
  };
  // The setup engine serializes apply; this lock also protects direct repairs.
  return withSessionLock('setup:plugins',perform);
}
