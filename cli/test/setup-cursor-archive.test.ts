import {expect,test} from 'bun:test';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {basename,join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileHash} from '../src/setup/plugin-bundle.ts';
import {pluginRelease,type PluginRelease} from '../src/setup/plugin-release.ts';
import {installPublishedSetupPlugins,loadPublishedPackage,packageRelease} from '../src/setup/published-plugins.ts';
import {canInstallRecordingPlugin,setupPluginIdentity,type PluginOptions} from '../src/setup/plugins.ts';
import {setupInventory} from '../src/setup/inventory.ts';
import {nextSetupAction} from '../src/setup/next.ts';
import type {SetupState} from '../src/setup/state.ts';

const api='https://cursor-fixture.example',scope={api,tenantId:'fixture-tenant',userId:'fixture-user'};
const installationId='cursor-fixture-installation';
const platform='darwin-arm64';
const entry=packageRelease('cursor')!;
const pin=entry.archives![platform]!;
const realDir=process.env.OPENCRAWL_TEST_CURSOR_RELEASE_DIR;
const archive=readFileSync(realDir?join(realDir,basename(pin.url)):new URL('./fixtures/published-cursor-test.zip',import.meta.url));
const metadata=realDir?readFileSync(join(realDir,basename(pin.metadataUrl))):Buffer.from(JSON.stringify({
 schemaVersion:1,harness:'cursor',name:entry.name,version:entry.version,platform,filename:basename(pin.url),
 sha256:fileHash(archive),executable:'bin/opencrawl-hook',source:['auth.mjs','capture.mjs','io.mjs','lifecycle.mjs','main.mjs','privacy.mjs','redact.mjs','THIRD_PARTY_NOTICES.txt'].map(name=>'runtime/'+name)
}));
const release:PluginRelease=realDir?pluginRelease:{...pluginRelease,packages:[{...entry,archives:{[platform]:{...pin,sha256:fileHash(archive),metadataSha256:fileHash(metadata)}}}]};
const read=(path:string)=>JSON.parse(readFileSync(path,'utf8'));

async function fixture(run:(f:ReturnType<typeof environment>)=>Promise<void>){
 const home=mkdtempSync(join(tmpdir(),'oc-cursor-package-')),previous=process.env.OPENCRAWL_CONFIG_HOME;
 const f=environment(home);process.env.OPENCRAWL_CONFIG_HOME=f.configHome;
 try{await run(f);}finally{
  if(previous===undefined)delete process.env.OPENCRAWL_CONFIG_HOME;else process.env.OPENCRAWL_CONFIG_HOME=previous;
  rmSync(home,{recursive:true,force:true});
 }
}

function environment(home:string){
 const configHome=join(home,'config'),root=join(home,'.cursor'),cache=join(home,'cache');
 const dir=join(root,'plugins','local',setupPluginIdentity(api).name);
 const capture=join(configHome,'opencrawl','capture');mkdirSync(capture,{recursive:true});
 const owner={tenantId:scope.tenantId,userId:scope.userId};
 writeFileSync(join(capture,'config.json'),JSON.stringify({schemaVersion:1,api,owner,installationId,harnesses:['cursor'],historyHarnesses:[],roots:{cursor:root,'claude-code':join(home,'.claude'),codex:join(home,'.codex'),antigravity:join(home,'.gemini')},hookOwnership:'plugin',installedAt:new Date().toISOString()}));
 const settings={version:entry.minimumHarnessVersion!,corrupt:false};
 const loadPackage:typeof loadPublishedPackage=(client)=>loadPublishedPackage(client,{release,cache:settings.corrupt?cache+'-bad':cache,platform,
  fetcher:Object.assign(async(url:RequestInfo|URL)=>{
   if(String(url)===pin.metadataUrl)return new Response(metadata);
   if(String(url)!==pin.url)throw Error('Unexpected request');
   return new Response(settings.corrupt?Buffer.from('damaged ZIP'):archive);
  },{preconnect:()=>{}}) as typeof fetch});
 const calls:string[][]=[];
 const options={
  home,env:{OPENCRAWL_CONFIG_HOME:configHome,CURSOR_CONFIG_DIR:root},command:[join(home,'opencrawl')],loadPackage,
  which:(command:string)=>command==='cursor-agent'?join(home,'cursor-agent'):null,
  runner:async(command:string,args:string[])=>{
   calls.push([command,...args]);expect(command).toBe(join(home,'cursor-agent'));expect(args).toEqual(['--version']);
   return {code:0,stdout:settings.version};
  }
 };
 const install=(extra:PluginOptions={})=>installPublishedSetupPlugins(api,['cursor'],{...options,...extra});
 return {home,root,dir,configHome,owner,options,settings,install,calls};
}

test('Cursor offers use the same native version requirement as the archive installer',()=>fixture(async f=>{
 mkdirSync(f.root,{recursive:true});
 expect(await canInstallRecordingPlugin('cursor',{...f.options,which:name=>name==='cursor'?'/fixture/editor':null},'darwin')).toBe(false);
 expect(f.calls).toEqual([]);
 f.settings.version='2026.11.16-0000000';
 expect(await canInstallRecordingPlugin('cursor',f.options,'darwin')).toBe(false);
 f.settings.version=entry.minimumHarnessVersion!;
 expect(await canInstallRecordingPlugin('cursor',f.options,'darwin')).toBe(true);
 expect(existsSync(f.dir)).toBe(false);
}));

test('Cursor selection installs the pinned archive offline, binds both MCP files and resumes on current capture',()=>fixture(async f=>{
 const inventory=setupInventory({...f.options,api,platform:'darwin'});
 expect(inventory.find(row=>row.id==='cursor')).toMatchObject({detected:true,plugin:true,forward:true});
 expect(entry.version).toBe('0.2.2');
 const first=await f.install(),row=first.results[0]!;
 expect(row).toMatchObject({client:'cursor',status:'prepared',captureAvailable:true,daemonHandoff:true,source:{ref:entry.ref,version:entry.version}});
 expect(first.humanTasks.map(task=>task.kind)).toEqual(['restart','mcp_auth']);
 for(const name of ['mcp.json','.mcp.json'])expect(read(join(f.dir,name)).mcpServers.opencrawl.url).toBe(api+'/mcp');
 expect(read(join(f.dir,'.opencrawl-binding.json'))).toEqual({schemaVersion:1,api,client:'cursor',owner:f.owner,installationId,configHome:f.configHome,captureMode:'hook'});
 expect(read(join(f.dir,'.cursor-plugin/plugin.json'))).toMatchObject({name:setupPluginIdentity(api).name,hooks:'./hooks/hooks.json',mcpServers:'./mcp.json'});
 for(const alias of ['oc-incognito','oc-private','opencrawl-private','oc-readonly'])expect(readFileSync(join(f.dir,'skills',alias,'SKILL.md'),'utf8')).toContain('MUST NOT communicate with other agents');
 expect(readFileSync(join(f.dir,'skills/oc-import-memories/SKILL.md'),'utf8')).toContain('name: oc-import-memories');
 const listing=read(join(f.dir,'.cursor-plugin/plugin.json'));
 expect(listing.name).toBe('opencrawl');
 expect(listing.description).toContain('OpenCrawl');
 expect(readFileSync(join(f.dir,listing.logo),'utf8')).toContain('<svg');
 const binary=join(f.dir,'bin','opencrawl-hook'),initial=statSync(binary);
 if(process.platform!=='win32')expect(initial.mode&0o777).toBe(0o755);
 expect(existsSync(join(f.root,'hooks.json'))).toBe(false);
 const observedAt=new Date(Date.parse(row.preparedAt!)+1000).toISOString();
 for(const cursorCapture of [undefined,{installationId:'other',observedAt},{installationId,observedAt:'2000-01-01T00:00:00Z'}]){
  expect((await f.install({cursorCapture})).results[0]).toMatchObject({status:'prepared',preparedAt:row.preparedAt});
 }
 expect(statSync(binary).ino).toBe(initial.ino);
 const state:SetupState={schemaVersion:1,scope,installationId,selections:{plugins:{cursor:true},forward:{cursor:true},history:{}},acceptedAt:'now',pluginResults:[row]};
 const server={scope,firstWin:null,installations:[{installationId,clients:[{client:'cursor',installed:true,captureObservedAt:'2000-01-01T00:00:00Z',mcp:{state:'authenticated'},proof:{state:'verified'},humanTasks:[]}]}]};
 expect(nextSetupAction(state,server).kind).toBe('review_setup');
 server.installations[0]!.clients[0]!.captureObservedAt=observedAt;
 expect(nextSetupAction(state,server).kind).toBe('reconcile_activation');
 const confirmed=await f.install({cursorCapture:{installationId,observedAt}});
 expect(confirmed.results[0]?.status).toBe('unchanged');expect((await f.install()).results[0]?.status).toBe('unchanged');
 expect(nextSetupAction({...state,pluginResults:confirmed.results},server).kind).toBe('complete');
 expect((await f.install({captureMode:'daemon',cursorCapture:{installationId,observedAt}})).results[0]?.status).toBe('prepared');
 expect(read(join(f.dir,'.opencrawl-binding.json')).captureMode).toBe('daemon');
}),60000);

test('Cursor version checks and bad bytes preserve the existing plugin',()=>fixture(async f=>{
 for(const version of ['2026.11.16-0000000','2026.11.17-1234567','2026.11.18','2026.99.99-1234567','3.30.0']){
  f.settings.version=version;expect((await f.install()).results[0]?.status).toBe('pending');expect(existsSync(f.dir)).toBe(false);
 }
 f.settings.version='2026.11.18-1234567';
 const custom=join(f.home,'custom-cursor-data');
 expect((await f.install({env:{...f.options.env,CURSOR_CONFIG_DIR:custom}})).results[0]).toMatchObject({status:'prepared',directory:f.dir});
 expect(existsSync(join(custom,'plugins','local'))).toBe(false);
 const marker=join(f.dir,'.opencrawl-setup-plugin.json'),before=readFileSync(marker);
 const binary=statSync(join(f.dir,'bin/opencrawl-hook')),calls=f.calls.length;
 f.settings.corrupt=true;await expect(f.install()).rejects.toMatchObject({code:'PLUGIN_PACKAGE_INVALID'});
 expect(f.calls).toHaveLength(calls);expect(readFileSync(marker)).toEqual(before);
 expect(statSync(join(f.dir,'bin/opencrawl-hook')).ino).toBe(binary.ino);
}),60000);

test('Cursor migrates only its unchanged legacy hooks and preserves a disabled choice',()=>fixture(async f=>{
 const hooks=join(f.root,'hooks.json'),other={command:'another-plugin'},foreign={version:1,hooks:{stop:[other]}};
 mkdirSync(f.root,{recursive:true});writeFileSync(hooks,JSON.stringify(foreign));
 const entry={command:'legacy-cursor-runner',timeout:3};
 const receiptDir=join(f.configHome,'opencrawl','setup-plugins','cursor',setupPluginIdentity(api).key);
 mkdirSync(receiptDir,{recursive:true});
 writeFileSync(join(receiptDir,'native-hooks.json'),JSON.stringify({file:hooks,directory:f.dir,hooks:{sessionStart:[entry]}}));
 writeFileSync(hooks,JSON.stringify({version:1,hooks:{...foreign.hooks,sessionStart:[entry]}}));
 const legacy=readFileSync(hooks,'utf8'),disabled=JSON.parse(legacy);disabled.hooks.sessionStart[0].enabled=false;
 writeFileSync(hooks,JSON.stringify(disabled));expect((await f.install()).results[0]?.status).toBe('error');
 expect(read(hooks)).toEqual(disabled);expect(existsSync(join(f.dir,'bin/opencrawl-hook'))).toBe(false);
 writeFileSync(hooks,legacy);expect((await f.install()).results[0]?.status).toBe('prepared');
 expect(read(hooks)).toEqual(foreign);expect(existsSync(join(f.dir,'hooks/hooks.json'))).toBe(true);
 expect(existsSync(join(f.dir,'scripts/cursor-native-hooks.json'))).toBe(false);
}),60000);
