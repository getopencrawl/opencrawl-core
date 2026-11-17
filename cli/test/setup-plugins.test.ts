import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,symlinkSync,cpSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {pluginHookContext,recordPluginActivation,pluginActivationMatches,recordSessionsActivation,sessionsPlugin} from '../src/setup/plugin-context.ts';
import {pluginCommand,pluginInventory,setupPluginFiles,setupPluginIdentity,installSetupPlugins,sessionsMarketplaceArgs,type PluginOptions} from '../src/setup/plugins.ts';

const origin='https://selfhost.example',cloud='https://app.getopencrawl.com',identity=setupPluginIdentity(origin);
const repositoryPlugins=join(import.meta.dir,'../../plugins/opencrawl-sessions');
const read=(file:string)=>JSON.parse(readFileSync(file,'utf8'));
const save=(file:string,value:unknown)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(value));};
async function fixture(run:(home:string,options:PluginOptions,calls:string[][])=>Promise<void>) {
 const home=mkdtempSync(join(tmpdir(),'opencrawl-setup-plugin-')),prior=process.env.OPENCRAWL_CONFIG_HOME;
 process.env.OPENCRAWL_CONFIG_HOME=join(home,'config');
 const calls:string[][]=[],installed:Record<string,Record<string,unknown>[]>= {};
 const options:PluginOptions={home,command:[join(home,'private cli','opencrawl')],env:{OPENCRAWL_CONFIG_HOME:join(home,'config')},which:name=>'/client/'+name,runner:async(command,args)=>{
  calls.push([command,...args]);
  const agy=command.endsWith('/agy'),codex=command.endsWith('/codex');
  if(args[0]==='mcp'){
   // Like Claude Code, an existing name is refused and left alone.
   if(!codex){const file=join(home,'.claude.json'),current=existsSync(file)?read(file):{};if(current.mcpServers?.opencrawl)return {code:1};save(file,{...current,mcpServers:{...current.mcpServers,opencrawl:{type:'http',url:args.at(-1)}}});}
   return {code:0};
  }
  if(agy&&args[1]==='install'){
   const directory=args[2],manifest=read(join(directory,'plugin.json'));
   const cache=join(home,'cache/agy',manifest.name);cpSync(directory,cache,{recursive:true});
   installed[command]=[...(installed[command]??[]).filter(r=>r.name!==manifest.name),{name:manifest.name,pluginId:manifest.name,enabled:true,path:cache}];
   return {code:0};
  }
  if(!agy&&(args[1]==='add'||args[1]==='install')){
   // The native clients copy the repository's plugin directory into their own cache.
   const cache=codex?join(home,'.codex/plugins/cache',sessionsPlugin.marketplace,sessionsPlugin.name,'0.1.0'):join(home,'cache/claude',sessionsPlugin.name);
   cpSync(join(repositoryPlugins,codex?'codex':'claude-code'),cache,{recursive:true});
   installed[command]=[codex?{pluginId:args[2],name:sessionsPlugin.name,version:'0.1.0',installed:true,enabled:true}:{id:args[2],version:'0.1.0',enabled:true,installPath:cache}];
   return {code:0,stdout:JSON.stringify(codex?{pluginId:args[2],installedPath:cache}:{outcome:'ok'})};
  }
  return {code:0,stdout:JSON.stringify({installed:installed[command]??[]})};
 }};
 try{await run(home,options,calls);}finally{if(prior===undefined)delete process.env.OPENCRAWL_CONFIG_HOME;else process.env.OPENCRAWL_CONFIG_HOME=prior;rmSync(home,{recursive:true,force:true});}
}
const receipt=(home:string,client:string,api=origin)=>join(home,'config/opencrawl/setup-plugins',client,setupPluginIdentity(api).key,'installed.json');

test('inventory detects supported clients without creating configuration',()=>{
 const home=mkdtempSync(join(tmpdir(),'opencrawl-plugin-inventory-'));
 try{
  expect(pluginInventory({home,env:{},which:()=>null}).every(row=>!row.detected)).toBe(true);mkdirSync(join(home,'.codex'));
  expect(pluginInventory({home,env:{},which:()=>null}).filter(row=>row.detected).map(row=>row.id)).toEqual(['codex']);expect(existsSync(join(home,'.config'))).toBe(false);
 }finally{rmSync(home,{recursive:true,force:true});}
});
test('identity is canonical and separate for each deployment',()=>{
 expect(setupPluginIdentity(origin+'/')).toEqual(identity);
 expect(identity.name).toBe('opencrawl-'+createHash('sha256').update(origin).digest('hex').slice(0,12));
 expect(setupPluginIdentity('https://other.example').name).not.toBe(identity.name);
});
test('generated bundles contain native hooks bound to the exact profile, command and endpoint',()=>{
 for(const client of ['cursor','antigravity'] as const){
  const files=setupPluginFiles(client,origin,{command:[join(tmpdir(),'private cli','opencrawl')],configHome:join(tmpdir(),'private profile')});
  const mcp=Object.entries(files).find(([name])=>['mcp.json','.mcp.json','mcp_config.json'].includes(name))!;
  expect(mcp[1]).toContain(origin+'/mcp');expect(mcp[1]).not.toContain('app.getopencrawl.com');
  expect(files[client==='antigravity'?'hooks.json':client==='cursor'?'scripts/cursor-native-hooks.json':'hooks/hooks.json']).toBeDefined();
  const runner=files['scripts/'+(client==='cursor'?'opencrawl-cursor-native':'opencrawl-hook')+(process.platform==='win32'?'.cmd':'.sh')];
  expect(runner).toContain(identity.name);expect(runner).toContain('OPENCRAWL_CONFIG_HOME');expect(runner).toContain('private profile');expect(runner).toContain('private cli');
  expect(files['skills/opencrawl-setup/SKILL.md']).toContain(identity.name);expect(files['skills/opencrawl-setup/SKILL.md']).toContain('Never switch to a separate "test MCP" prompt');
  expect(files['skills/opencrawl/SKILL.md']).toContain('Search is lexical');
  expect(Object.keys(files).some(name=>name.startsWith('skills/opencrawl/references/'))).toBe(false);
 }
});
test('generated Cursor rule delivers retrieval and native notifications for its bound deployment',()=>{
 const command=[join(tmpdir(),'private cli','opencrawl')],files=setupPluginFiles('cursor',origin,{command,configHome:join(tmpdir(),'private profile')});
 const rule=files['rules/opencrawl.mdc'];
 for(const phrase of ['alwaysApply: true',identity.name,origin,'exact command, profile','first-tool receipt','notify_on_output','block_until_ms:0','Registration alone is not listening','Do not run board diagnostics','use OpenCrawl search'])expect(rule).toContain(phrase);
 expect(rule).not.toContain('app.getopencrawl.com');expect(rule).not.toContain('opencrawl_search');
 expect(files['skills/opencrawl/SKILL.md']).toContain('## Coordination');
});
const sessionsReceipt=(home:string,client:string)=>join(home,'config/opencrawl/setup-plugins',client,'sessions.json');
test('Claude Code and Codex install the repository plugin through their native marketplace commands',()=>fixture(async(home,options,calls)=>{
 const first=await installSetupPlugins(cloud,['claude-code','codex'],options);
 expect(first.results.map(row=>[row.status,row.pluginId])).toEqual([['prepared',sessionsPlugin.id],['prepared',sessionsPlugin.id]]);
 expect(calls).toEqual([
  ['/client/claude','plugin','list','--json'],
  ['/client/claude','plugin','marketplace','add','getopencrawl/opencrawl-core','--sparse','.claude-plugin','plugins/opencrawl-sessions','--json'],
  ['/client/claude','plugin','install',sessionsPlugin.id,'--scope','user','--json'],
  ['/client/claude','plugin','list','--json'],
  ['/client/codex','plugin','list','--json'],
  ['/client/codex','plugin','marketplace','add','getopencrawl/opencrawl-core','--sparse','.agents/plugins','--sparse','plugins/opencrawl-sessions','--json'],
  ['/client/codex','plugin','add',sessionsPlugin.id,'--json'],
  ['/client/codex','plugin','list','--json'],
 ]);
 // Nothing is generated: the receipt names the copy the client itself installed.
 expect(read(sessionsReceipt(home,'claude-code'))).toMatchObject({api:cloud,pluginId:sessionsPlugin.id,nativeRoot:first.results[0]!.directory});
 expect(read(sessionsReceipt(home,'codex')).nativeRoot).toEndWith(join('.codex/plugins/cache',sessionsPlugin.marketplace,sessionsPlugin.name,'0.1.0'));
 for(const client of ['claude-code','codex'])expect(existsSync(join(home,'config/opencrawl/setup-plugins',client,setupPluginIdentity(cloud).key))).toBe(false);
 expect(first.humanTasks.map(task=>task.id)).toEqual(['claude-code:restart','claude-code:mcp_auth','codex:restart','codex:mcp_auth']);
 expect(first.humanTasks[2]!.instruction).toContain('/hooks');expect(first.humanTasks[0]!.instruction).not.toContain('/hooks');
 expect(existsSync(join(home,'.codex/hooks.json'))).toBe(false);expect(existsSync(join(home,'.codex/config.toml'))).toBe(false);expect(existsSync(join(home,'.claude.json'))).toBe(false);
 calls.length=0;expect((await installSetupPlugins(cloud,['claude-code','codex'],options)).results.map(row=>row.status)).toEqual(['prepared','prepared']);
 expect(calls.map(call=>call.slice(1))).toEqual([['plugin','list','--json'],['plugin','list','--json']]);
}));
test('another plugin source is a local checkout read in place or a repository cloned sparsely',()=>{
 expect(sessionsMarketplaceArgs('codex',{OPENCRAWL_PLUGIN_SOURCE:'/work/opencrawl-core'})).toEqual(['plugin','marketplace','add','/work/opencrawl-core','--json']);
 expect(sessionsMarketplaceArgs('claude-code',{OPENCRAWL_PLUGIN_SOURCE:'fork/opencrawl-core'})).toEqual(['plugin','marketplace','add','fork/opencrawl-core','--sparse','.claude-plugin','plugins/opencrawl-sessions','--json']);
});
test('a self-hosted server gets its own Codex MCP entry and turns the plugin entry off without touching other configuration',()=>fixture(async(home,options,calls)=>{
 const config=join(home,'.codex/config.toml'),existing='[mcp_servers.other]\nurl = "https://manual.example/mcp"';
 mkdirSync(dirname(config),{recursive:true});writeFileSync(config,existing);
 const result=await installSetupPlugins(origin,['codex'],options);expect(result.results[0]?.status).toBe('prepared');
 expect(calls).toContainEqual(['/client/codex','mcp','add','opencrawl','--url',origin+'/mcp']);
 const section=`\n[plugins."${sessionsPlugin.id}".mcp_servers.opencrawl]\nenabled = false\n`;
 expect(readFileSync(config,'utf8')).toBe(existing+'\n'+section);
 expect(result.humanTasks.find(task=>task.kind==='mcp_auth')).toMatchObject({url:origin+'/mcp'});
 await installSetupPlugins(origin,['codex'],options);expect(readFileSync(config,'utf8')).toBe(existing+'\n'+section);
 // The plugin itself is unchanged and still names the cloud.
 expect(read(join(read(sessionsReceipt(home,'codex')).nativeRoot,'.mcp.json')).mcpServers.opencrawl.url).toBe(cloud+'/mcp');
}));
test('a self-hosted server gets its own Claude Code MCP entry and reports that the plugin entry stays listed',()=>fixture(async(home,options,calls)=>{
 const result=await installSetupPlugins(origin,['claude-code'],options);expect(result.results[0]?.status).toBe('prepared');
 expect(calls).toContainEqual(['/client/claude','mcp','add','--transport','http','--scope','user','opencrawl',origin+'/mcp']);
 const task=result.humanTasks.find(task=>task.kind==='mcp_auth')!;
 expect(task.instruction).toContain('plugin:'+sessionsPlugin.name+':opencrawl');expect(task.instruction).toContain('/mcp');expect(task.url).toBe(origin+'/mcp');
 calls.length=0;expect((await installSetupPlugins(origin,['claude-code'],options)).results[0]?.status).toBe('prepared');
 expect(calls.some(call=>call[1]==='mcp')).toBe(false);
}));
test('an existing Claude Code opencrawl server for another address is preserved and setup stays pending',()=>fixture(async(home,options)=>{
 save(join(home,'.claude.json'),{mcpServers:{opencrawl:{type:'http',url:'https://manual.example/mcp'}}});
 const result=await installSetupPlugins(origin,['claude-code'],options);
 expect(result.results[0]?.status).toBe('pending');expect(result.humanTasks.map(task=>task.kind)).toEqual(['plugin_install']);
 expect(read(join(home,'.claude.json')).mcpServers.opencrawl.url).toBe('https://manual.example/mcp');expect(existsSync(sessionsReceipt(home,'claude-code'))).toBe(false);
}));
test('all native installers require activation independently of MCP authentication',()=>fixture(async(home,options)=>{
 const result=await installSetupPlugins(origin,['claude-code','antigravity'],options);
 expect(result.results.map(row=>row.status)).toEqual(['prepared','prepared']);
 expect(result.humanTasks.filter(task=>task.kind==='restart')).toHaveLength(2);expect(result.humanTasks.filter(task=>task.kind==='mcp_auth')).toHaveLength(2);
 expect(read(sessionsReceipt(home,'claude-code')).nativeRoot).toBe(result.results[0]!.directory);expect(read(receipt(home,'antigravity')).nativeRoot).toBe(join(home,'cache/agy',identity.name));
}));
test('a disabled plugin is preserved without reinstallation or implicit enabling',()=>fixture(async(home,options,calls)=>{
 await installSetupPlugins(cloud,['claude-code'],options);calls.length=0;
 options.runner=async(command,args)=>{calls.push([command,...args]);return {code:0,stdout:JSON.stringify([{id:sessionsPlugin.id,enabled:false}])};};
 const before=readFileSync(sessionsReceipt(home,'claude-code'),'utf8'),result=await installSetupPlugins(cloud,['claude-code'],options);
 expect(result.results[0]?.status).toBe('pending');expect(calls).toHaveLength(1);expect(readFileSync(sessionsReceipt(home,'claude-code'),'utf8')).toBe(before);
}));
test('missing native executable and unreadable native inventory cannot become installed',()=>fixture(async(_home,options)=>{
 options.which=()=>null;expect((await installSetupPlugins(origin,['antigravity'],options)).results[0]?.status).toBe('pending');
 options.which=name=>'/client/'+name;options.runner=async()=>({code:1});expect((await installSetupPlugins(origin,['codex'],options)).results[0]?.status).toBe('pending');
}));
test('Cursor bundle never overwrites an unmanaged directory or follows a link',()=>fixture(async(home,options)=>{
 const directory=join(home,'.cursor/plugins/local',identity.name);mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'keep.txt'),'user plugin');
 expect((await installSetupPlugins(origin,['cursor'],options)).results[0]?.status).toBe('error');expect(readFileSync(join(directory,'keep.txt'),'utf8')).toBe('user plugin');
 rmSync(directory,{recursive:true});const elsewhere=join(home,'elsewhere');mkdirSync(elsewhere);symlinkSync(elsewhere,directory,'dir');
 expect((await installSetupPlugins(origin,['cursor'],options)).results[0]?.status).toBe('error');expect(existsSync(join(elsewhere,'.cursor-plugin'))).toBe(false);
}));
test('Cursor local discovery is prepared and names the exact plugin while preserving production cache',()=>fixture(async(home,options,calls)=>{
 const production=join(home,'.cursor/plugins/cache/opencrawl/opencrawl/prior/mcp.json');save(production,{mcpServers:{opencrawl:{url:'https://app.getopencrawl.com/mcp'}}});
 const before=readFileSync(production,'utf8'),result=await installSetupPlugins(origin,['cursor'],options);
 expect(result.results[0]?.status).toBe('prepared');expect(calls).toHaveLength(0);expect(existsSync(join(home,'.cursor/plugins/local',identity.name,'.cursor-plugin/plugin.json'))).toBe(true);
 expect(existsSync(join(home,'.cursor/hooks.json'))).toBe(true);expect(result.humanTasks.map(task=>task.kind)).toEqual(['restart','mcp_auth']);
 expect(result.humanTasks[0]?.instruction).toContain('/plugin list');expect(result.humanTasks[0]?.instruction).toContain(identity.name);expect(result.humanTasks[0]?.instruction).toContain('local imports are blocked');
 expect(readFileSync(production,'utf8')).toBe(before);
}));
test('a same-named plugin from another marketplace is not adopted as the installed plugin',()=>fixture(async(home,options,calls)=>{
 const native=options.runner!;
 options.runner=async(command,args,env)=>{const result=await native(command,args,env);if(args[1]==='list'){const body=JSON.parse(result.stdout!);body.installed.push({id:sessionsPlugin.name+'@foreign-market',enabled:true,installPath:join(home,'foreign')});return {...result,stdout:JSON.stringify(body)};}return result;};
 expect((await installSetupPlugins(cloud,['claude-code'],options)).results[0]?.status).toBe('prepared');
 expect(calls.some(call=>call[2]==='install'&&call[3]===sessionsPlugin.id)).toBe(true);
}));
test('zero native install exit without inventory confirmation remains pending',()=>fixture(async(home,options)=>{
 options.runner=async()=>({code:0,stdout:JSON.stringify({installed:[]})});const result=await installSetupPlugins(cloud,['codex'],options);
 expect(result.results[0]?.status).toBe('pending');expect(result.humanTasks.some(task=>task.kind==='mcp_auth')).toBe(false);expect(existsSync(sessionsReceipt(home,'codex'))).toBe(false);
}));
test('a failed native command is an error and writes no receipt',()=>fixture(async(home,options)=>{
 const native=options.runner!;options.runner=async(command,args,env)=>args[1]==='add'?{code:1}:native(command,args,env);
 const result=await installSetupPlugins(cloud,['codex'],options);expect(result.results[0]?.status).toBe('error');expect(existsSync(sessionsReceipt(home,'codex'))).toBe(false);
}));
test('the installed copy must be this plugin naming the cloud endpoint before a receipt is written',()=>fixture(async(home,options)=>{
 const native=options.runner!;options.runner=async(command,args,env)=>{const result=await native(command,args,env);if(args[1]==='add')save(join(home,'.codex/plugins/cache',sessionsPlugin.marketplace,sessionsPlugin.name,'0.1.0/.mcp.json'),{mcpServers:{opencrawl:{url:'https://stale.example/mcp'}}});return result;};
 const result=await installSetupPlugins(cloud,['codex'],options);expect(result.results[0]?.status).toBe('pending');expect(existsSync(sessionsReceipt(home,'codex'))).toBe(false);
}));
test('Windows npm shims retain literal argument boundaries without shell expansion',()=>{
 const command="C:\\User's Files\\codex.cmd",args=['plugin','add','literal$(command)&other'];const [program,actual]=pluginCommand(command,args,{SystemRoot:'C:\\Windows'},'win32');
 expect(program).toEndWith('powershell.exe');expect(actual.at(-1)).toBe("& 'C:\\User''s Files\\codex.cmd' 'plugin' 'add' 'literal$(command)&other'; exit $LASTEXITCODE");expect(pluginCommand('/bin/codex',args,{},'linux')).toEqual(['/bin/codex',args]);
});

function activateSessions(home:string,client:'claude-code'|'codex') {
 const prior=process.env.OPENCRAWL_SESSIONS_PLUGIN_ROOT;process.env.OPENCRAWL_SESSIONS_PLUGIN_ROOT=read(sessionsReceipt(home,client)).nativeRoot;
 try{recordSessionsActivation(client,{hook_event_name:'SessionStart',session_id:'fixture-session',source:'startup'});}
 finally{if(prior===undefined)delete process.env.OPENCRAWL_SESSIONS_PLUGIN_ROOT;else process.env.OPENCRAWL_SESSIONS_PLUGIN_ROOT=prior;}
}
test('the repository plugin’s own startup hook advances Claude Code and Codex on resume',()=>fixture(async(home,options,calls)=>{
 for(const client of ['claude-code','codex'] as const){
  expect((await installSetupPlugins(cloud,[client],options)).results[0]?.status).toBe('prepared');
  // An event the client could not have sent, or a copy that is not the installed one, proves nothing.
  recordSessionsActivation(client,{hook_event_name:'SessionStart',session_id:'fixture-session',source:'startup'});
  expect((await installSetupPlugins(cloud,[client],options)).results[0]?.status).toBe('prepared');
  activateSessions(home,client);calls.length=0;
  const result=await installSetupPlugins(cloud,[client],options);expect(result.results[0]?.status).toBe('unchanged');
  expect(result.humanTasks.map(task=>task.kind)).toEqual(['mcp_auth']);expect(calls).toHaveLength(1);
 }
}));
function activate(home:string,client:'cursor'|'antigravity') {
 const installed=read(receipt(home,client)),configHome=join(home,'config');
 save(join(configHome,'opencrawl/capture/config.json'),{schemaVersion:1,hookOwnership:'plugin',api:origin,installationId:'fixture-installation',owner:{tenantId:'fixture-tenant',userId:'fixture-user'},installedAt:new Date().toISOString(),roots:{'claude-code':join(home,'.claude'),codex:join(home,'.codex')},command:[join(home,'private cli','opencrawl')],harnesses:[]});
 const context=pluginHookContext(origin,client,{OPENCRAWL_CONFIG_HOME:configHome,OPENCRAWL_PLUGIN_API:origin,OPENCRAWL_PLUGIN_CLIENT:client,OPENCRAWL_PLUGIN_NAME:identity.name,OPENCRAWL_PLUGIN_ROOT:installed.nativeRoot});
 recordPluginActivation(context,client==='antigravity'?{hookEventName:'SessionStart',conversationId:'fixture-session'}:{hook_event_name:client==='cursor'?'sessionStart':'SessionStart',session_id:'fixture-session',source:'startup'});
}
test('native hook activation advances every generated client on resume even with recording off',()=>fixture(async(home,options)=>{
 for(const client of ['cursor','antigravity'] as const){
  expect((await installSetupPlugins(origin,[client],options)).results[0]?.status).toBe('prepared');activate(home,client);
  const before=read(receipt(home,client));expect(pluginActivationMatches(before)).toBe(true);
  const result=await installSetupPlugins(origin,[client],options);expect(result.results[0]?.status).toBe('unchanged');
  expect(result.humanTasks.map(task=>task.kind)).toEqual(['mcp_auth']);
 }
}));
test('activation from another enrollment cannot advance a current installation',()=>fixture(async(home,options)=>{
 await installSetupPlugins(origin,['cursor'],options);activate(home,'cursor');
 const file=join(home,'config/opencrawl/capture/config.json'),config=read(file);save(file,{...config,installationId:'different-installation'});
 expect((await installSetupPlugins(origin,['cursor'],options)).results[0]?.status).toBe('prepared');
}));
test('changing the private CLI invalidates old activation and binds the updated bundle',()=>fixture(async(home,options)=>{
 await installSetupPlugins(origin,['cursor'],options);activate(home,'cursor');
 options.command=[join(home,'new private cli','opencrawl')];
 expect((await installSetupPlugins(origin,['cursor'],options)).results[0]?.status).toBe('prepared');
 expect(readFileSync(join(home,'.cursor/plugins/local',identity.name,process.platform==='win32'?'scripts/opencrawl-cursor-native.cmd':'scripts/opencrawl-cursor-native.sh'),'utf8')).toContain('new private cli');
}));
test('an ancestor symlink cannot redirect plugin file writes outside the intended native directory',()=>fixture(async(home,options)=>{
 const native=join(home,'.cursor'),elsewhere=join(home,'elsewhere');mkdirSync(elsewhere);symlinkSync(elsewhere,native,'dir');
 expect((await installSetupPlugins(origin,['cursor'],options)).results[0]?.status).toBe('error');expect(existsSync(join(elsewhere,'plugins'))).toBe(false);
}));

// Each native installer is an independent ownership boundary. Keep each fixture
// under its own unchanged test budget instead of aggregating three disk installs.
for(const client of ['antigravity'] as const)test(`a stale receipt cannot rebind ${client} owned by another CLI profile`,()=>fixture(async(home,options,calls)=>{
  const first=await installSetupPlugins(origin,[client],options),directory=first.results[0]!.directory!,before=readFileSync(receipt(home,client),'utf8'),sourceBefore=readFileSync(join(directory,'.opencrawl-setup-plugin.json'),'utf8');
  const foreignConfig=join(home,'other-profile/config'),foreignRoot=join(home,'other-native-source',client),bundle=setupPluginFiles(client,origin,{command:options.command,configHome:foreignConfig});
  for(const [name,content] of Object.entries(bundle)){mkdirSync(dirname(join(foreignRoot,name)),{recursive:true});writeFileSync(join(foreignRoot,name),content);}
  const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
  save(join(foreignRoot,'.opencrawl-setup-plugin.json'),{schemaVersion:2,api:origin,client,pluginName:identity.name,configHome:foreignConfig,digest:hash(JSON.stringify(bundle,null,2)+'\n'),files:Object.fromEntries(Object.entries(bundle).map(([name,text])=>[name,hash(text)]))});
  const native=options.runner!;options.runner=async(command,args,env)=>{const response=await native(command,args,env);if(args[1]==='list'){const result=JSON.parse(response.stdout!);for(const row of result.installed){row.source={source:'local',path:foreignRoot};row.readFromFolder=foreignRoot;row.path=foreignRoot;}return {...response,stdout:JSON.stringify(result)};}return response;};
  calls.length=0;const result=await installSetupPlugins(origin,[client],options);
  expect(result.results[0]?.status).toBe('pending');expect(result.results[0]?.message).toContain('another CLI profile');expect(calls).toHaveLength(1);
  expect(readFileSync(receipt(home,client),'utf8')).toBe(before);expect(readFileSync(join(directory,'.opencrawl-setup-plugin.json'),'utf8')).toBe(sourceBefore);
  expect(read(join(foreignRoot,'.opencrawl-setup-plugin.json')).configHome).toBe(foreignConfig);options.runner=native;
}));
for(const client of ['antigravity'] as const)test(`matching native profile ownership permits ordinary command upgrades for ${client}`,()=>fixture(async(home,options)=>{
  await installSetupPlugins(origin,[client],options);const prior=read(receipt(home,client));options.command=[join(home,'upgraded cli',client,'opencrawl')];
  expect((await installSetupPlugins(origin,[client],options)).results[0]?.status).toBe('prepared');expect(read(receipt(home,client)).digest).not.toBe(prior.digest);
}));

test('Cursor upgrade removes obsolete executable plugin hooks and keeps one native user delivery path',()=>fixture(async(home,options)=>{
 const initial=await installSetupPlugins(origin,['cursor'],options),directory=initial.results[0]!.directory!;
 const current=setupPluginFiles('cursor',origin,{command:options.command,configHome:join(home,'config'),env:options.env});
 const suffix=process.platform==='win32'?'.cmd':'.sh',old={...current};
 old['hooks/hooks.json']=old['scripts/cursor-native-hooks.json']!;delete old['scripts/cursor-native-hooks.json'];
 old['scripts/opencrawl-hook'+suffix]=old['scripts/opencrawl-cursor-native'+suffix]!;delete old['scripts/opencrawl-cursor-native'+suffix];
 for(const file of Object.keys(current))if(!(file in old))rmSync(join(directory,file));
 for(const [file,text] of Object.entries(old)){mkdirSync(dirname(join(directory,file)),{recursive:true});writeFileSync(join(directory,file),text);}
 const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
 save(join(directory,'.opencrawl-setup-plugin.json'),{...read(join(directory,'.opencrawl-setup-plugin.json')),digest:digest(JSON.stringify(old,null,2)+'\n'),files:Object.fromEntries(Object.entries(old).map(([file,text])=>[file,digest(text)]))});
 const resumed=await installSetupPlugins(origin,['cursor'],options);expect(resumed.results[0]?.status).toBe('prepared');
 expect(existsSync(join(directory,'hooks/hooks.json'))).toBe(false);expect(existsSync(join(directory,'scripts/opencrawl-hook'+suffix))).toBe(false);
 const native=read(join(home,'.cursor/hooks.json'));
 expect(native.hooks.sessionStart).toHaveLength(2);expect(native.hooks.afterAgentResponse).toHaveLength(1);
 expect(native.hooks.sessionStart[0].command).toContain('opencrawl-cursor-native');
 await installSetupPlugins(origin,['cursor'],options);expect(read(join(home,'.cursor/hooks.json'))).toEqual(native);
}));
