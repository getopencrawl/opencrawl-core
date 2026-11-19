import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,symlinkSync,cpSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {pluginHookContext,recordPluginActivation,pluginActivationMatches} from '../src/setup/plugin-context.ts';
import {pluginCommand,pluginInventory,recordingInstallState,setupPluginFiles,setupPluginIdentity,installSetupPlugins,type PluginOptions} from '../src/setup/plugins.ts';
import {scopedPluginIdentity} from '../src/setup/plugin-identity.ts';

const origin='https://selfhost.example',identity=setupPluginIdentity(origin);
const read=(file:string)=>JSON.parse(readFileSync(file,'utf8'));
const save=(file:string,value:unknown)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(value));};
async function fixture(run:(home:string,options:PluginOptions,calls:string[][])=>Promise<void>) {
 const home=mkdtempSync(join(tmpdir(),'opencrawl-setup-plugin-')),prior=process.env.OPENCRAWL_CONFIG_HOME;
 process.env.OPENCRAWL_CONFIG_HOME=join(home,'config');
 const calls:string[][]=[],installed:Record<string,Record<string,unknown>[]>= {},markets:Record<string,string>={};
 const options:PluginOptions={home,command:[join(home,'private cli','opencrawl')],env:{OPENCRAWL_CONFIG_HOME:join(home,'config')},which:name=>'/client/'+name,runner:async(command,args)=>{
  calls.push([command,...args]);
  if(args[1]==='marketplace'&&args[2]==='add')markets[command]=args[3];
  if(args[1]==='remove'||args[1]==='uninstall'){
   installed[command]=(installed[command]??[]).filter(row=>row.pluginId!==args[2]);
   return {code:0,stdout:'{}'};
  }
  if(args[1]==='add'||args[1]==='install'||args[1]==='update'){
   const agy=command.endsWith('/agy'),codex=command.endsWith('/codex'),directory=agy?args[2]:join(markets[command],args[2].split('@')[0]);
   const manifest=read(join(directory,agy?'plugin.json':codex?'.codex-plugin/plugin.json':'.claude-plugin/plugin.json'));
   const cache=join(home,'cache',command.split('/').at(-1)!,manifest.name);cpSync(directory,cache,{recursive:true});
   const row={name:manifest.name,scope:'user',version:manifest.version,pluginId:agy?manifest.name:args[2],enabled:true,source:{source:'local',path:directory},readFromFolder:directory,...(codex?{}:{installPath:cache}),path:cache};
   installed[command]=[...(installed[command]??[]).filter(r=>r.name!==manifest.name),row];
   return {code:0,stdout:JSON.stringify({installedPath:cache})};
  }
  return {code:0,stdout:JSON.stringify({installed:installed[command]??[]})};
 }};
 try{await run(home,options,calls);}finally{if(prior===undefined)delete process.env.OPENCRAWL_CONFIG_HOME;else process.env.OPENCRAWL_CONFIG_HOME=prior;rmSync(home,{recursive:true,force:true});}
}
const receipt=(home:string,client:string,api=origin)=>join(home,'config/opencrawl/setup-plugins',client,setupPluginIdentity(api).key,'installed.json');

async function installOld(home:string,client:'claude-code'|'codex'|'cursor'|'antigravity',options:PluginOptions){
 const old=scopedPluginIdentity(origin),configHome=join(home,'config'),market=dirname(receipt(home,client));
 const directory=client==='cursor'?join(home,'.cursor/plugins/local',old.name):join(market,old.name);
 const files=setupPluginFiles(client,origin,{command:options.command,configHome});
 const manifest=client==='claude-code'?'.claude-plugin/plugin.json':client==='codex'?'.codex-plugin/plugin.json':client==='cursor'?'.cursor-plugin/plugin.json':'plugin.json';
 const setJson=(file:string,value:unknown)=>{files[file]=JSON.stringify(value,null,2)+'\n';};
 setJson(manifest,{...JSON.parse(files[manifest]!),name:old.name});
 setJson('.opencrawl-binding.json',{...JSON.parse(files['.opencrawl-binding.json']!),pluginName:old.name});
 if(client==='codex')setJson('.mcp.json',{mcpServers:{[old.name]:{type:'http',url:origin+'/mcp'}}});
 for(const [name,data] of Object.entries(files)){mkdirSync(dirname(join(directory,name)),{recursive:true});writeFileSync(join(directory,name),data);}
 const hash=(value:string)=>createHash('sha256').update(value).digest('hex'),digest=hash(JSON.stringify(files,null,2)+'\n');
 save(join(directory,'.opencrawl-setup-plugin.json'),{schemaVersion:2,api:origin,client,pluginName:old.name,configHome,digest,files:Object.fromEntries(Object.entries(files).map(([name,bytes])=>[name,hash(bytes)]))});
 const pluginId=client==='codex'||client==='claude-code'?old.name+'@'+old.marketplace:old.name;
 let nativeRoot=directory;
 if(client!=='cursor'){
  const cmd=client==='claude-code'?'/client/claude':client==='codex'?'/client/codex':'/client/agy';
  await options.runner!(cmd,['plugin','marketplace','add',market],options.env!);
  const result=await options.runner!(cmd,['plugin',client==='codex'?'add':'install',client==='antigravity'?directory:pluginId],options.env!);
  if(client!=='claude-code')nativeRoot=JSON.parse(result.stdout!).installedPath;
 }
 save(receipt(home,client),{schemaVersion:2,api:origin,client,configHome,pluginId,pluginName:old.name,digest,directory,nativeRoot,...(client==='codex'?{cachePath:nativeRoot}:{})});
 return {directory,nativeRoot,pluginId};
}

for(const client of ['codex','claude-code','cursor','antigravity'] as const)test(client+' upgrades the owned suffixed plugin to one plain native registration',()=>fixture(async(home,options,calls)=>{
 const old=await installOld(home,client,options);
 const updated=await installSetupPlugins(origin,[client],options);
 expect(updated.results[0]).toMatchObject({status:'prepared',pluginId:client==='codex'||client==='claude-code'?'opencrawl@opencrawl-cli':'opencrawl'});
 expect(read(receipt(home,client)).pluginName).toBe('opencrawl');
 if(client==='cursor')expect(existsSync(old.directory)).toBe(false);
 else expect(calls.filter(call=>['remove','uninstall'].includes(call[2]!)&&call[3]===old.pluginId)).toHaveLength(1);
 expect((await installSetupPlugins(origin,[client],options)).results[0]?.status).toBe('prepared');
}));

test('a failed native removal is retried from the old receipt after the new plugin is installed',()=>fixture(async(home,options)=>{
 const old=await installOld(home,'codex',options),run=options.runner!;
 options.runner=async(cmd,args,env)=>args[1]==='remove'?{code:1}:run(cmd,args,env);
 expect((await installSetupPlugins(origin,['codex'],options)).results[0]?.status).toBe('error');
 expect(read(receipt(home,'codex')).pluginId).toBe(old.pluginId);
 options.runner=run;
 expect((await installSetupPlugins(origin,['codex'],options)).results[0]?.pluginId).toBe('opencrawl@opencrawl-cli');
}));

test('an interrupted old install with a missing managed asset can be reinstalled under the plain name',()=>fixture(async(home,options)=>{
 const old=await installOld(home,'codex',options);
 for(const root of [old.directory,old.nativeRoot])rmSync(join(root,'skills/opencrawl/SKILL.md'));
 const result=await installSetupPlugins(origin,['codex'],options);
 expect(result.results[0]).toMatchObject({status:'prepared',pluginId:'opencrawl@opencrawl-cli'});
 expect(existsSync(join(read(receipt(home,'codex')).nativeRoot,'skills/opencrawl/SKILL.md'))).toBe(true);
}));

test('inventory detects supported clients without creating configuration',()=>{
 const home=mkdtempSync(join(tmpdir(),'opencrawl-plugin-inventory-'));
 try{
  expect(pluginInventory({home,env:{},which:()=>null}).every(row=>!row.detected)).toBe(true);mkdirSync(join(home,'.codex'));
  expect(pluginInventory({home,env:{},which:()=>null}).filter(row=>row.detected).map(row=>row.id)).toEqual(['codex']);expect(existsSync(join(home,'.config'))).toBe(false);
 }finally{rmSync(home,{recursive:true,force:true});}
});
test('desktop plugin names are stable and private receipt paths remain deployment-specific',()=>{
 expect(setupPluginIdentity(origin+'/')).toEqual(identity);
 expect(identity.name).toBe('opencrawl');expect(identity.marketplace).toBe('opencrawl-cli');
 expect(setupPluginIdentity('https://other.example')).toMatchObject({name:identity.name,marketplace:identity.marketplace});
 expect(setupPluginIdentity('https://other.example').key).not.toBe(identity.key);
});
test('all four bundles contain native hooks bound to the exact profile, command and endpoint',()=>{
 for(const client of ['claude-code','codex','cursor','antigravity'] as const){
  const files=setupPluginFiles(client,origin,{command:[join(tmpdir(),'private cli','opencrawl')],configHome:join(tmpdir(),'private profile')});
  const mcp=Object.entries(files).find(([name])=>['mcp.json','.mcp.json','mcp_config.json'].includes(name))!;
  expect(mcp[1]).toContain(origin+'/mcp');expect(mcp[1]).not.toContain('app.getopencrawl.com');
  expect(files[client==='antigravity'?'hooks.json':'hooks/hooks.json']).toBeDefined();
  const runner=files['.opencrawl-binding.json'];
  expect(runner).toContain(identity.name);expect(runner).toContain('configHome');expect(runner).toContain('private profile');expect(runner).toContain('private cli');
  expect(files['skills/opencrawl-setup/SKILL.md']).toContain('.opencrawl-binding.json');
  expect(files['skills/opencrawl/SKILL.md']).toContain('Search is lexical');
  expect(Object.keys(files).some(name=>name.startsWith('skills/opencrawl/references/'))).toBe(false);
  if(client==='codex'){const manifest=JSON.parse(files['.codex-plugin/plugin.json']);expect(manifest).toMatchObject({hooks:'./hooks/hooks.json',mcpServers:'./.mcp.json',skills:'./skills/'});expect(JSON.parse(files['.mcp.json']).mcpServers).toEqual({[identity.name]:{type:'http',url:origin+'/mcp'}});expect(files['plugin.json']).toBeUndefined();expect(files['mcp.json']).toBeUndefined();}
 }
});
test('the four embedded desktop bundles include their native listing fields and icon',()=>{
 for(const [client,path] of [
  ['codex','.codex-plugin/plugin.json'],['claude-code','.claude-plugin/plugin.json'],
  ['cursor','.cursor-plugin/plugin.json'],['antigravity','plugin.json'],
 ] as const){
  const files=setupPluginFiles(client,origin,{command:[join(tmpdir(),'opencrawl')],configHome:tmpdir()});
  const manifest=JSON.parse(files[path]!);
  const listing=client==='codex'?manifest.interface:manifest;
  expect(manifest.name).toBe('opencrawl');
  expect(manifest.description).toContain('OpenCrawl');
  if(client!=='cursor')expect(listing.displayName).toBe('OpenCrawl');
  if(client==='codex'){
   expect(listing.shortDescription).toBe('Multiplayer for coding agents');
   expect(listing.composerIcon).toBe(listing.logo);
  }
  expect(files[(listing.logo??listing.icon).replace(/^\.\//,'')]).toContain('<svg');
 }
});
test('Claude upgrades its cached user installation when the local marketplace version changes',()=>fixture(async(home,options,calls)=>{
 const files=setupPluginFiles('claude-code',origin,{command:options.command,configHome:join(home,'config')});
 const manifestPath='.claude-plugin/plugin.json', manifest=JSON.parse(files[manifestPath]!);
 const install=(version:string)=>installSetupPlugins(origin,['claude-code'],{...options,bundles:{'claude-code':{
  files:{...files,[manifestPath]:JSON.stringify({...manifest,version})},
  source:{repository:'fixture',ref:'fixture',path:'local/claude-code',name:'opencrawl-local-claude-code',version},
  captureAvailable:true,daemonHandoff:true,
 }}});
 expect((await install('0.2.1')).results[0]?.status).toBe('installed');
 calls.length=0;
 expect((await install('0.2.2')).results[0]?.status).toBe('installed');
 expect(calls).toContainEqual(['/client/claude','plugin','update','opencrawl@opencrawl-cli','--scope','user','--json']);
 calls.length=0;
 expect((await install('0.2.2')).results[0]?.status).toBe('unchanged');
 expect(calls.some(call=>call.includes('update'))).toBe(false);
}));
test('canonical Cursor rule delivers retrieval and native notifications for its bound deployment',()=>{
 const command=[join(tmpdir(),'private cli','opencrawl')],files=setupPluginFiles('cursor',origin,{command,configHome:join(tmpdir(),'private profile')});
 const rule=files['rules/opencrawl.mdc'];
 for(const phrase of ['alwaysApply: true','.opencrawl-binding.json','exact command, profile','first-tool receipt','notify_on_output','block_until_ms:0','alone is not listening','Do not run board diagnostics','use OpenCrawl search'])expect(rule).toContain(phrase);
 expect(rule).not.toContain('app.getopencrawl.com');expect(rule).not.toContain('opencrawl_search');
 expect(files['skills/opencrawl/SKILL.md']).toContain('## Coordination');
});
test('native registration prepares a plugin and resumes without reinstalling before activation',()=>fixture(async(home,options,calls)=>{
 const first=await installSetupPlugins(origin,['codex'],options);expect(first.results[0]?.status).toBe('prepared');
 expect(calls.filter(c=>c[2]==='list').map(c=>c.slice(1))).toEqual(Array(2).fill(['plugin','list','--marketplace',identity.marketplace,'--json']));
 expect(calls.map(c=>c.slice(1,3))).toEqual([['plugin','list'],['plugin','marketplace'],['plugin','add'],['plugin','list']]);
 const directory=first.results[0]!.directory!,marketplace=read(join(directory,'../.agents/plugins/marketplace.json'));
 expect(marketplace.name).toBe(identity.marketplace);expect(marketplace.plugins[0].policy.authentication).toBe('ON_USE');
 const metadata=read(join(directory,'.opencrawl-setup-plugin.json'));
 expect(metadata).toMatchObject({schemaVersion:2,api:origin,client:'codex',pluginName:identity.name,configHome:join(home,'config')});
 expect(metadata.files).not.toHaveProperty('.opencrawl-setup-plugin.json');expect(metadata.files['hooks/hooks.json']).toMatch(/^[a-f0-9]{64}$/);
 expect(read(receipt(home,'codex')).nativeRoot).toBe(join(home,'cache/codex',identity.name));
 calls.length=0;expect((await installSetupPlugins(origin,['codex'],options)).results[0]?.status).toBe('prepared');expect(calls).toHaveLength(1);
 expect(existsSync(join(home,'.claude'))).toBe(false);expect(existsSync(join(home,'.cursor'))).toBe(false);expect(existsSync(join(home,'.codex/hooks.json'))).toBe(false);
}));
test('all native installers require activation independently of MCP authentication',()=>fixture(async(home,options)=>{
 const result=await installSetupPlugins(origin,['claude-code','antigravity'],options);
 expect(result.results.map(row=>row.status)).toEqual(['prepared','prepared']);
 expect(result.humanTasks.filter(task=>task.kind==='restart')).toHaveLength(2);expect(result.humanTasks.filter(task=>task.kind==='mcp_auth')).toHaveLength(2);
 expect(read(receipt(home,'claude-code')).nativeRoot).toBe(result.results[0]!.directory);expect(read(receipt(home,'antigravity')).nativeRoot).toBe(join(home,'cache/agy',identity.name));
}));
test('recording picker checks native inventory and local files for both catalog clients',()=>fixture(async(_home,options)=>{
 for(const client of ['claude-code','codex'] as const){
  expect(await recordingInstallState(origin,client,undefined,options)).toBe('new');
  await installSetupPlugins(origin,[client],options);
  expect(await recordingInstallState(origin,client,'installed',options)).toBe('installed');
  const inspect=(stdout:string,code=0)=>recordingInstallState(origin,client,'installed',{...options,runner:async()=>({code,stdout})});
  expect(await inspect('[]')).toBe('repair');
  expect(await inspect('',1)).toBe('review');
  expect(await inspect(JSON.stringify([{pluginId:'opencrawl@opencrawl-cli',enabled:false}]))).toBe('review');
 }
}));
test('disabled deployment plugin is preserved without reinstallation or implicit enabling',()=>fixture(async(home,options,calls)=>{
 await installSetupPlugins(origin,['claude-code'],options);calls.length=0;
 options.runner=async(command,args)=>{calls.push([command,...args]);return {code:0,stdout:JSON.stringify({installed:[{name:identity.name,id:identity.name+'@'+identity.marketplace,enabled:false}]})};};
 const before=readFileSync(receipt(home,'claude-code'),'utf8'),result=await installSetupPlugins(origin,['claude-code'],options);
 expect(result.results[0]?.status).toBe('pending');expect(calls).toHaveLength(1);expect(readFileSync(receipt(home,'claude-code'),'utf8')).toBe(before);
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
 expect(existsSync(join(home,'.cursor/hooks.json'))).toBe(false);expect(result.humanTasks.map(task=>task.kind)).toEqual(['restart','mcp_auth']);
 expect(result.humanTasks[0]?.instruction).toContain('/plugin list');expect(result.humanTasks[0]?.instruction).toContain(identity.name);expect(result.humanTasks[0]?.instruction).toContain('local imports are blocked');
 expect(readFileSync(production,'utf8')).toBe(before);
}));
test('scoped Codex inventory preserves a conflicting marketplace in the local config',()=>fixture(async(home,options,calls)=>{
 mkdirSync(join(home,'.codex'),{recursive:true});
 writeFileSync(join(home,'.codex','config.toml'),'[plugins."'+identity.name+'@foreign"]\nenabled = true\n');
 const result=await installSetupPlugins(origin,['codex'],options);
 expect(result.results[0]?.status).toBe('pending');
 expect(result.results[0]?.message).toContain('Another installation owns');
 expect(calls.map(call=>call.slice(1))).toEqual([['plugin','list','--marketplace',identity.marketplace,'--json']]);
}));

test('Codex inventory timeouts name the operation without suggesting that access was denied',()=>fixture(async(_home,options)=>{
 const progress:string[]=[];
 const result=await installSetupPlugins(origin,['codex'],{...options,onProgress:line=>progress.push(line),runner:async()=>({code:1,timedOut:true})});
 expect(result.results[0]?.message).toContain('more than 45 seconds to list plugins');
 expect(progress).toContain('Reading the Codex plugin inventory.');
}));

test('foreign same-deployment identity is preserved, unrelated named plugins do not shadow new identity',()=>fixture(async(_home,options,calls)=>{
 const native=options.runner!;
 options.runner=async(command,args,env)=>{const result=await native(command,args,env);if(args[1]==='list'){const body=JSON.parse(result.stdout!);body.installed.push({id:'unrelated@synced',enabled:true});return {...result,stdout:JSON.stringify(body)};}return result;};
 expect((await installSetupPlugins(origin,['claude-code'],options)).results[0]?.status).toBe('prepared');calls.length=0;
 options.runner=async(command,args)=>{calls.push([command,...args]);return {code:0,stdout:JSON.stringify([{id:identity.name+'@foreign-market',enabled:true}])};};
 expect((await installSetupPlugins(origin,['claude-code'],options)).results[0]?.status).toBe('pending');expect(calls).toHaveLength(1);
}));
test('zero native install exit without inventory confirmation remains pending',()=>fixture(async(home,options)=>{
 options.runner=async()=>({code:0,stdout:JSON.stringify({installed:[]})});const result=await installSetupPlugins(origin,['codex'],options);
 expect(result.results[0]?.status).toBe('pending');expect(result.humanTasks.some(task=>task.kind==='mcp_auth')).toBe(false);expect(existsSync(receipt(home,'codex'))).toBe(false);
}));
test('an occupied native plugin stays bound to the original deployment',()=>fixture(async(_home,options,calls)=>{
 const a=await installSetupPlugins('https://endpoint-a.example',['codex','claude-code'],options),b=await installSetupPlugins('https://endpoint-b.example',['codex','claude-code'],options);
 expect(a.results.every(row=>row.status==='prepared')).toBe(true);expect(b.results.every(row=>row.status==='pending')).toBe(true);
 expect(b.results.map(row=>row.directory)).not.toEqual(a.results.map(row=>row.directory));
 for(const client of ['codex','claude'])expect(new Set(calls.filter(call=>call[0]==='/client/'+client&&call[2]==='marketplace').map(call=>call[4])).size).toBe(1);
 expect((await installSetupPlugins('https://endpoint-a.example',['codex','claude-code'],options)).results.map(row=>row.status)).toEqual(['prepared','prepared']);
}));
test('native cache endpoint and source must match before writing an installation receipt',()=>fixture(async(home,options)=>{
 const native=options.runner!;options.runner=async(command,args,env)=>{const result=await native(command,args,env);if(args[1]==='add')save(join(home,'cache/codex',identity.name,'.mcp.json'),{mcpServers:{opencrawl:{url:'https://stale.example/mcp'}}});return result;};
 const result=await installSetupPlugins(origin,['codex'],options);expect(result.results[0]?.status).toBe('pending');expect(existsSync(receipt(home,'codex'))).toBe(false);
}));
test('Windows npm shims retain literal argument boundaries without shell expansion',()=>{
 const command="C:\\User's Files\\codex.cmd",args=['plugin','add','literal$(command)&other'];const [program,actual]=pluginCommand(command,args,{SystemRoot:'C:\\Windows'},'win32');
 expect(program).toEndWith('powershell.exe');expect(actual.at(-1)).toBe("& 'C:\\User''s Files\\codex.cmd' 'plugin' 'add' 'literal$(command)&other'; exit $LASTEXITCODE");expect(pluginCommand('/bin/codex',args,{},'linux')).toEqual(['/bin/codex',args]);
});

function activate(home:string,client:'claude-code'|'codex'|'cursor'|'antigravity') {
 const installed=read(receipt(home,client)),configHome=join(home,'config');
 save(join(configHome,'opencrawl/capture/config.json'),{schemaVersion:1,hookOwnership:'plugin',api:origin,installationId:'fixture-installation',owner:{tenantId:'fixture-tenant',userId:'fixture-user'},installedAt:new Date().toISOString(),roots:{'claude-code':join(home,'.claude'),codex:join(home,'.codex')},command:[join(home,'private cli','opencrawl')],harnesses:[]});
 const context=pluginHookContext(origin,client,{OPENCRAWL_CONFIG_HOME:configHome,OPENCRAWL_PLUGIN_API:origin,OPENCRAWL_PLUGIN_CLIENT:client,OPENCRAWL_PLUGIN_NAME:identity.name,OPENCRAWL_PLUGIN_ROOT:installed.nativeRoot});
 recordPluginActivation(context,client==='antigravity'?{hookEventName:'SessionStart',conversationId:'fixture-session'}:{hook_event_name:client==='cursor'?'sessionStart':'SessionStart',session_id:'fixture-session',source:'startup'});
}
test('native hook activation advances every prepared client on resume even with recording off',()=>fixture(async(home,options)=>{
 for(const client of ['claude-code','codex','cursor','antigravity'] as const){
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
 expect(readFileSync(join(home,'.cursor/plugins/local',identity.name,'.opencrawl-binding.json'),'utf8')).toContain('new private cli');
}));
test('interrupted receipt write recovers only the exact owned enabled source through native install',()=>fixture(async(home,options,calls)=>{
 await installSetupPlugins(origin,['codex'],options);rmSync(receipt(home,'codex'));calls.length=0;
 expect((await installSetupPlugins(origin,['codex'],options)).results[0]?.status).toBe('prepared');
 expect(calls.some(call=>call[2]==='add')).toBe(true);expect(existsSync(receipt(home,'codex'))).toBe(true);
}));
test('an ancestor symlink cannot redirect plugin file writes outside the intended native directory',()=>fixture(async(home,options)=>{
 const native=join(home,'.cursor'),elsewhere=join(home,'elsewhere');mkdirSync(elsewhere);symlinkSync(elsewhere,native,'dir');
 expect((await installSetupPlugins(origin,['cursor'],options)).results[0]?.status).toBe('error');expect(existsSync(join(elsewhere,'plugins'))).toBe(false);
}));

function legacyCodexBundle(directory:string) {
 const markerFile=join(directory,'.opencrawl-setup-plugin.json'),metadata=read(markerFile),files:Record<string,string>={};
 for(const name of Object.keys(metadata.files))if(!['.codex-plugin/plugin.json','.mcp.json'].includes(name))files[name]=readFileSync(join(directory,name),'utf8');
 const manifest=read(join(directory,'.codex-plugin/plugin.json'));
 files['plugin.json']=JSON.stringify({name:manifest.name,version:manifest.version,extensions:{'com.openai':{hooks:'./hooks/hooks.json'}}})+'\n';
 files['mcp.json']=JSON.stringify({mcpServers:{opencrawl:{type:'streamable-http',url:origin+'/mcp'}}})+'\n';
 rmSync(join(directory,'.codex-plugin/plugin.json'));rmSync(join(directory,'.mcp.json'));
 for(const name of ['plugin.json','mcp.json'])writeFileSync(join(directory,name),files[name]);
 const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
 save(markerFile,{...metadata,digest:digest(JSON.stringify(files,null,2)+'\n'),files:Object.fromEntries(Object.entries(files).map(([name,text])=>[name,digest(text)]))});
}
function obsoleteCodexMcp(directory:string) {
 const markerFile=join(directory,'.opencrawl-setup-plugin.json'),metadata=read(markerFile);
 save(join(directory,'.mcp.json'),{mcpServers:{obsolete:{type:'http',url:origin+'/mcp'}}});
 const files=Object.fromEntries(Object.keys(metadata.files).map(name=>[name,readFileSync(join(directory,name),'utf8')]));
 const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
 save(markerFile,{...metadata,digest:hash(JSON.stringify(files,null,2)+'\n'),files:Object.fromEntries(Object.entries(files).map(([name,text])=>[name,hash(text)]))});
 return read(markerFile);
}
test('owned obsolete Codex MCP migrates without changing hooks, manual MCP, auth or trust',()=>fixture(async(home,options,calls)=>{
 const first=await installSetupPlugins(origin,['codex'],options),directory=first.results[0]!.directory!;
 activate(home,'codex');
 const activationFile=join(dirname(receipt(home,'codex')),'activation.json');
 const native=read(receipt(home,'codex')),hooksBefore=readFileSync(join(native.nativeRoot,'hooks/hooks.json'),'utf8');
 const runnerFile=process.platform==='win32'?'scripts/opencrawl-hook.cmd':'scripts/opencrawl-hook.sh',runnerBefore=readFileSync(join(native.nativeRoot,runnerFile),'utf8');
 obsoleteCodexMcp(directory);const old=obsoleteCodexMcp(native.nativeRoot);save(receipt(home,'codex'),{...native,digest:old.digest});
 save(activationFile,{...read(activationFile),digest:old.digest});const activationBefore=readFileSync(activationFile,'utf8');
 const preserved={
  'config.toml':'[mcp_servers.opencrawl]\nurl = "https://manual.example/mcp"\n',
  'auth.json':'synthetic-auth-sentinel',
  'hooks-trust.json':'synthetic-trust-sentinel',
 };
 for(const [name,text] of Object.entries(preserved)){mkdirSync(join(home,'.codex'),{recursive:true});writeFileSync(join(home,'.codex',name),text);}
 expect(pluginActivationMatches({...native,digest:old.digest})).toBe(false);calls.length=0;
 const migrated=await installSetupPlugins(origin,['codex'],options);expect(migrated.results[0]?.status).toBe('prepared');
 expect(calls.filter(call=>call[2]==='add').map(call=>call[3])).toEqual([identity.name+'@'+identity.marketplace]);
 for(const root of [directory,native.nativeRoot])expect(read(join(root,'.mcp.json')).mcpServers).toEqual({[identity.name]:{type:'http',url:origin+'/mcp'}});
 expect(readFileSync(join(native.nativeRoot,'hooks/hooks.json'),'utf8')).toBe(hooksBefore);expect(readFileSync(join(native.nativeRoot,runnerFile),'utf8')).toBe(runnerBefore);
 for(const [name,text] of Object.entries(preserved))expect(readFileSync(join(home,'.codex',name),'utf8')).toBe(text);
 expect(readFileSync(activationFile,'utf8')).toBe(activationBefore);expect(pluginActivationMatches(read(receipt(home,'codex')))).toBe(false);
 activate(home,'codex');expect((await installSetupPlugins(origin,['codex'],options)).results[0]?.status).toBe('unchanged');
}));
test('Codex format upgrade removes only byte-matching obsolete owned manifests before native reinstallation',()=>fixture(async(home,options)=>{
 const first=await installSetupPlugins(origin,['codex'],options),directory=first.results[0]!.directory!;legacyCodexBundle(directory);writeFileSync(join(directory,'user-notes.txt'),'foreign extra');
 const next=await installSetupPlugins(origin,['codex'],options);expect(next.results[0]?.status).toBe('prepared');
 expect(existsSync(join(directory,'plugin.json'))).toBe(false);expect(existsSync(join(directory,'mcp.json'))).toBe(false);
 expect(read(join(directory,'.codex-plugin/plugin.json')).mcpServers).toBe('./.mcp.json');expect(readFileSync(join(directory,'user-notes.txt'),'utf8')).toBe('foreign extra');
 expect(read(receipt(home,'codex')).digest).toBe(read(join(directory,'.opencrawl-setup-plugin.json')).digest);
}));
test('modified or symlink obsolete manifests fail before new bundle files are written',()=>fixture(async(home,options)=>{
 const first=await installSetupPlugins(origin,['codex'],options),directory=first.results[0]!.directory!;legacyCodexBundle(directory);
 writeFileSync(join(directory,'plugin.json'),'user modified');
 expect((await installSetupPlugins(origin,['codex'],options)).results[0]?.status).toBe('pending');expect(existsSync(join(directory,'.codex-plugin/plugin.json'))).toBe(false);expect(readFileSync(join(directory,'plugin.json'),'utf8')).toBe('user modified');
 rmSync(join(directory,'plugin.json'));const target=join(home,'user-plugin.json');writeFileSync(target,'private user file');symlinkSync(target,join(directory,'plugin.json'));
 expect((await installSetupPlugins(origin,['codex'],options)).results[0]?.status).toBe('pending');expect(existsSync(join(directory,'.codex-plugin/plugin.json'))).toBe(false);expect(readFileSync(target,'utf8')).toBe('private user file');
}));

// Each native installer is an independent ownership boundary. Keep each fixture
// under its own unchanged test budget instead of aggregating three disk installs.
for(const client of ['codex','claude-code','antigravity'] as const)test(`a stale receipt cannot rebind ${client} owned by another CLI profile`,()=>fixture(async(home,options,calls)=>{
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
for(const client of ['codex','claude-code','antigravity'] as const)test(`matching native profile ownership permits ordinary command upgrades for ${client}`,()=>fixture(async(home,options)=>{
  await installSetupPlugins(origin,[client],options);const prior=read(receipt(home,client));options.command=[join(home,'upgraded cli',client,'opencrawl')];
  expect((await installSetupPlugins(origin,[client],options)).results[0]?.status).toBe('prepared');expect(read(receipt(home,client)).digest).not.toBe(prior.digest);
}));

test('current Codex cache inventory takes precedence over a stale saved path and rejects another profile',()=>fixture(async(home,options,calls)=>{
 await installSetupPlugins(origin,['codex'],options);const before=read(receipt(home,'codex')),current=join(home,'new-current-codex-cache');cpSync(before.nativeRoot,current,{recursive:true});
 const native=options.runner!;options.runner=async(command,args,env)=>{const response=await native(command,args,env);if(args[1]==='list'){const result=JSON.parse(response.stdout!);for(const row of result.installed)row.installedPath=current;return {...response,stdout:JSON.stringify(result)};}return response;};
 calls.length=0;expect((await installSetupPlugins(origin,['codex'],options)).results[0]?.status).toBe('prepared');expect(calls).toHaveLength(1);
 expect(read(receipt(home,'codex'))).toMatchObject({nativeRoot:current,cachePath:current});
 const markerFile=join(current,'.opencrawl-setup-plugin.json');save(markerFile,{...read(markerFile),configHome:join(home,'other-config')});
 const receiptBefore=readFileSync(receipt(home,'codex'),'utf8');calls.length=0;
 expect((await installSetupPlugins(origin,['codex'],options)).results[0]?.status).toBe('pending');expect(calls).toHaveLength(1);expect(readFileSync(receipt(home,'codex'),'utf8')).toBe(receiptBefore);
 expect(read(markerFile).configHome).toBe(join(home,'other-config'));
}));

test('Cursor installs hooks exclusively in its plugin and preserves unrelated user hooks',()=>fixture(async(home,options)=>{
 const file=join(home,'.cursor/hooks.json'),native={version:1,hooks:{stop:[{command:'user-owned',enabled:false}]}};save(file,native);
 const initial=await installSetupPlugins(origin,['cursor'],options),directory=initial.results[0]!.directory!;
 expect(existsSync(join(directory,'hooks/hooks.json'))).toBe(true);
 expect(read(file)).toEqual(native);await installSetupPlugins(origin,['cursor'],options);expect(read(file)).toEqual(native);
}));

test('Cursor migration retires exact old user entries and refuses changed or disabled choices',()=>fixture(async(home,options)=>{
 const file=join(home,'.cursor/hooks.json'),directory=join(home,'.cursor/plugins/local',identity.name),marker=join(home,'config/opencrawl/setup-plugins/cursor',identity.key,'native-hooks.json');
 const old={command:'old-owned-runner',timeout:3},foreign={command:'user-owned',enabled:false};
 save(marker,{file,directory:join(dirname(directory),'opencrawl-'+identity.key),hooks:{stop:[old]}});save(file,{version:1,hooks:{stop:[{...old,enabled:false},foreign]}});
 const before=readFileSync(file,'utf8');expect((await installSetupPlugins(origin,['cursor'],options)).results[0]?.status).toBe('error');expect(readFileSync(file,'utf8')).toBe(before);expect(existsSync(directory)).toBe(false);
 save(file,{version:1,hooks:{stop:[old,foreign]}});
 expect((await installSetupPlugins(origin,['cursor'],options)).results[0]?.status).toBe('prepared');expect(read(file).hooks.stop).toEqual([foreign]);expect(read(marker).hooks).toEqual({});
}));
