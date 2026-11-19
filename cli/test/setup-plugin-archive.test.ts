import {test,expect} from 'bun:test';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,cpSync,statSync,chmodSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileHash,MAX_PLUGIN_BINARY} from '../src/setup/plugin-bundle.ts';
import {loadPublishedPackage,bindPublishedPackage} from '../src/setup/published-plugins.ts';
import {readPluginArchive,validateArtifact} from '../src/setup/plugin-archive.ts';
import type {ArchivePin,PackageRelease,PluginRelease} from '../src/setup/plugin-release.ts';
import {installSetupPlugins,setupPluginIdentity} from '../src/setup/plugins.ts';
import {verifyPluginBundle} from '../src/setup/plugin-context.ts';
import {nextSetupAction} from '../src/setup/next.ts';

const bytes=readFileSync(new URL('./fixtures/published-claude-development.zip',import.meta.url));
function fixture(archive=bytes,patch:Record<string,unknown>={}){
 const metadata=Buffer.from(JSON.stringify({schemaVersion:1,harness:'claude-code',name:'opencrawl-local-claude-code',version:'0.1.0',platform:'darwin-arm64',filename:'opencrawl-local-claude-code-0.1.0-darwin-arm64.zip',sha256:fileHash(archive),executable:'bin/opencrawl-hook',source:['auth.mjs','capture.mjs','io.mjs','lifecycle.mjs','main.mjs','redact.mjs','THIRD_PARTY_NOTICES.txt'].map(name=>'runtime/'+name),...patch}));
 const base='https://github.com/getopencrawl/opencrawl-plugins/releases/download/fixture/',pin:ArchivePin={url:base+'opencrawl-local-claude-code-0.1.0-darwin-arm64.zip',sha256:fileHash(archive),metadataUrl:base+'artifact.json',metadataSha256:fileHash(metadata)};
 const entry:PackageRelease={harness:'claude-code',name:'opencrawl-local-claude-code',path:'local/claude-code',version:'0.1.0',capabilities:'capabilities.json',captureAvailable:false,daemonHandoff:false,archives:{'darwin-arm64':pin}};
 const release:PluginRelease={repository:'getopencrawl/opencrawl-plugins',ref:'980bd60afb4d969a979802d80fe73ace508da1e7',schemaVersion:1,bindingSchemaVersion:1,packages:[entry]};
 return {archive,metadata,pin,entry,release};
}
const fetcher=(run:(url:string,options?:RequestInit)=>Response|Promise<Response>)=>Object.assign((url:RequestInfo|URL,options?:RequestInit)=>run(String(url),options),{preconnect:()=>{}}) as typeof fetch;
test('Codex archive uses only its own native manifest and cannot accept a Claude ZIP',async()=>{
 const f=fixture(),entry:PackageRelease={...f.entry,harness:'codex',name:'opencrawl-local-codex',path:'local/codex'};
 const data={...JSON.parse(f.metadata.toString()),harness:'codex',name:entry.name,filename:'opencrawl-local-codex-0.1.0-darwin-arm64.zip'};
 const metadata=Buffer.from(JSON.stringify(data)),pin={...f.pin,metadataSha256:fileHash(metadata)};
 const result=validateArtifact(data,entry,'darwin-arm64',pin);
 expect(result.allowed.has('.codex-plugin/plugin.json')).toBe(true);
 expect(result.allowed.has('.claude-plugin/plugin.json')).toBe(false);
 await expect(readPluginArchive(bytes,metadata,entry,'darwin-arm64',pin)).rejects.toMatchObject({code:'PLUGIN_PACKAGE_INVALID'});
 expect(()=>validateArtifact(data,{...entry,harness:'cursor'},'darwin-arm64',pin)).toThrow();
});
test('Antigravity archive requires its root hook and MCP files and binds the native MCP destination',async()=>{
 const f=fixture(),entry:PackageRelease={...f.entry,harness:'antigravity',name:'opencrawl-local-antigravity',path:'local/antigravity'};
 const data={...JSON.parse(f.metadata.toString()),harness:entry.harness,name:entry.name,filename:entry.name+'-0.1.0-darwin-arm64.zip'};
 const metadata=Buffer.from(JSON.stringify(data)),pin={...f.pin,metadataSha256:fileHash(metadata)};
 const result=validateArtifact(data,entry,'darwin-arm64',pin);
 expect(result.allowed.has('.antigravity-plugin/plugin.json')).toBe(true);expect(result.allowed.has('hooks.json')).toBe(true);expect(result.allowed.has('mcp_config.json')).toBe(true);expect(result.allowed.has('hooks/hooks.json')).toBe(false);expect(result.allowed.size).toBe(17);
 await expect(readPluginArchive(bytes,metadata,entry,'darwin-arm64',pin)).rejects.toMatchObject({code:'PLUGIN_PACKAGE_INVALID'});
 const original={'.antigravity-plugin/plugin.json':JSON.stringify({name:entry.name,version:entry.version}),'.mcp.json':'{}','mcp.json':'{}','mcp_config.json':'{}','hooks.json':'{"native":"unchanged"}','runtime/main.mjs':'immutable runtime'};
 const bound=bindPublishedPackage('antigravity','https://private.example',{files:original,source:{repository:f.release.repository,ref:f.release.ref,path:entry.path,name:entry.name,version:entry.version},captureAvailable:true,daemonHandoff:true},{configHome:'/fixture/config',installationId:'fixture-install',owner:{tenantId:'fixture-tenant',userId:'fixture-user'},captureMode:'hook',command:['/fixture/opencrawl']});
 expect(JSON.parse(bound.files['mcp_config.json']).mcpServers.opencrawl.url).toBe('https://private.example/mcp');expect(bound.files['hooks.json']).toBe(original['hooks.json']);expect(bound.files['runtime/main.mjs']).toBe(original['runtime/main.mjs']);expect(original['mcp_config.json']).toBe('{}');
});
function altered(name:string,change:(copy:Buffer,central:number,local:number)=>void){
 const copy=Buffer.from(bytes);let offset=copy.readUInt32LE(copy.length-6);
 while(copy.readUInt32LE(offset)===0x02014b50){
  const size=copy.readUInt16LE(offset+28),actual=copy.subarray(offset+46,offset+46+size).toString();
  if(actual===name){change(copy,offset,copy.readUInt32LE(offset+42));return copy;}
  offset+=46+size+copy.readUInt16LE(offset+30)+copy.readUInt16LE(offset+32);
 }
 throw Error('Fixture entry missing');
}

test('platform ZIP preserves binary bytes, verifies metadata and caches only a complete package',async()=>{
 const f=fixture(),cache=mkdtempSync(join(tmpdir(),'oc-plugin-zip-'));let calls=0;
 const fetch=fetcher((url,options)=>{
  calls++;expect(options?.headers).toBeUndefined();expect(options?.redirect).toBe('manual');
  if(url===f.pin.metadataUrl)return new Response(f.metadata);
  if(url===f.pin.url)return new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/fixture.zip?signature=fixture'}});
  expect(url).toStartWith('https://release-assets.githubusercontent.com/');return new Response(f.archive);
 });
 try{
  const options={release:f.release,platform:'darwin-arm64',fetcher:fetch,cache};
  const result=await loadPublishedPackage('claude-code',options);
  expect(result.binaries?.['bin/opencrawl-hook']).toEqual(Buffer.from([...Array.from({length:256},(_,n)=>n),...Array.from({length:256},(_,n)=>n)]));
  expect(result).toMatchObject({executable:'bin/opencrawl-hook',captureAvailable:false,daemonHandoff:false,source:{archive:{platform:'darwin-arm64',sha256:f.pin.sha256}}});
  expect(calls).toBe(3);await loadPublishedPackage('claude-code',options);expect(calls).toBe(3);
  const path=join(cache,f.release.ref,'claude-code','darwin-arm64',f.pin.sha256+'.zip');writeFileSync(path,'corrupt cache');
  await loadPublishedPackage('claude-code',options);expect(calls).toBe(5);expect(fileHash(readFileSync(path))).toBe(f.pin.sha256);
 }finally{rmSync(cache,{recursive:true,force:true});}
});

test('wrong platform, metadata hash, identity or download redirect fails before native installation',async()=>{
 const f=fixture(),cache=mkdtempSync(join(tmpdir(),'oc-plugin-zip-'));let archiveCalls=0;
 try{
  await expect(loadPublishedPackage('claude-code',{cache,release:f.release,platform:'linux-x64',fetcher:fetcher(()=>{throw Error('No download');})})).rejects.toMatchObject({code:'PLUGIN_PLATFORM_UNAVAILABLE'});
  await expect(loadPublishedPackage('claude-code',{cache,release:f.release,platform:'darwin-arm64',fetcher:fetcher(url=>{if(url===f.pin.url)archiveCalls++;return new Response('bad metadata');})})).rejects.toMatchObject({code:'PLUGIN_PACKAGE_INVALID'});expect(archiveCalls).toBe(0);
  await expect(loadPublishedPackage('claude-code',{cache,release:f.release,platform:'darwin-arm64',fetcher:fetcher(()=>new Response(null,{status:302,headers:{location:'https://unrelated.example/runtime'}}))})).rejects.toMatchObject({code:'PLUGIN_PACKAGE_INVALID'});
  for(const patch of [{platform:'linux-x64'},{harness:'codex'},{name:'foreign'},{version:'0.2.0'},{executable:'../../hook'},{source:['runtime/extra.mjs']}]){
   const changed=fixture(bytes,patch);await expect(readPluginArchive(bytes,changed.metadata,changed.entry,'darwin-arm64',changed.pin)).rejects.toMatchObject({code:'PLUGIN_PACKAGE_INVALID'});
  }
  const tampered=Buffer.from(bytes);tampered[100]^=1;
  await expect(readPluginArchive(tampered,f.metadata,f.entry,'darwin-arm64',f.pin)).rejects.toMatchObject({code:'PLUGIN_PACKAGE_INVALID'});
 }finally{rmSync(cache,{recursive:true,force:true});}
});

test('ZIP parser rejects links, traversal, duplicates, executable mode changes and oversized files',async()=>{
 const hostile=[
  altered('runtime/auth.mjs',(b,c)=>b.writeUInt32LE((0o120644<<16)>>>0,c+38)),
  altered('README.md',(b,c,l)=>{b.write('../bad.md',c+46);b.write('../bad.md',l+30);}),
  altered('README.md',(b,c,l)=>{b.write('.mcp.json',c+46);b.write('.mcp.json',l+30);}),
  altered('bin/opencrawl-hook',(b,c)=>b.writeUInt32LE((0o100644<<16)>>>0,c+38)),
  altered('runtime/auth.mjs',(b,c)=>b.writeUInt32LE((0o100755<<16)>>>0,c+38)),
  altered('bin/opencrawl-hook',(b,c)=>b.writeUInt32LE(MAX_PLUGIN_BINARY+1,c+24)),
 ];
 for(const archive of hostile){const f=fixture(archive);await expect(readPluginArchive(archive,f.metadata,f.entry,'darwin-arm64',f.pin)).rejects.toMatchObject({code:'PLUGIN_PACKAGE_INVALID'});}
});

test('binary native bundle survives registration/resume and rejects byte or permission changes',async()=>{
 const f=fixture(),home=mkdtempSync(join(tmpdir(),'oc-binary-plugin-')),api='https://selfhost.example',identity=setupPluginIdentity(api),configHome=join(home,'config'),previous=process.env.OPENCRAWL_CONFIG_HOME;
 process.env.OPENCRAWL_CONFIG_HOME=configHome;
 try{
  const parsed=await readPluginArchive(bytes,f.metadata,f.entry,'darwin-arm64',f.pin);
  const source={...parsed,minimumHarnessVersion:'2.1.327',source:{repository:f.release.repository,ref:f.release.ref,path:f.entry.path,name:f.entry.name,version:f.entry.version},captureAvailable:false,daemonHandoff:false};
  const bundle=bindPublishedPackage('claude-code',api,source,{configHome,installationId:'fixture-installation',owner:{tenantId:'fixture-tenant',userId:'fixture-user'},captureMode:'hook',command:['/fixture/opencrawl'],env:{}});
  let market='',native:Record<string,unknown>[]=[];let installs=0;
  const options={home,env:{OPENCRAWL_CONFIG_HOME:configHome},command:['/fixture/opencrawl'],which:()=>'/fixture/claude',bundles:{'claude-code':bundle},runner:async(_command:string,args:string[])=>{
   if(args[0]==='--version')return {code:0,stdout:'2.1.327 (Claude Code)'};
   if(args[1]==='marketplace')market=args[3];
   if(args[1]==='install'){installs++;const path=join(home,'cache');rmSync(path,{recursive:true,force:true});cpSync(join(market,identity.name),path,{recursive:true});native=[{id:args[2],enabled:true,readFromFolder:path}];}
   return {code:0,stdout:JSON.stringify(native)};
  }};
  const result=await installSetupPlugins(api,['claude-code'],options),directory=result.results[0].directory!,root=join(home,'cache'),executable=join(root,'bin/opencrawl-hook');
  expect(result.results[0]).toMatchObject({status:'prepared',captureAvailable:false});expect(installs).toBe(1);
  expect(readFileSync(executable).equals(parsed.binaries['bin/opencrawl-hook'])).toBe(true);
  if(process.platform!=='win32'){expect(statSync(executable).mode&0o777).toBe(0o755);expect(statSync(join(root,'.opencrawl-binding.json')).mode&0o777).toBe(0o600);}
  const binding={api,client:'claude-code' as const,pluginName:identity.name,configHome,nativeRoot:root};
  expect(verifyPluginBundle(binding).files['bin/opencrawl-hook']).toBe(fileHash(parsed.binaries['bin/opencrawl-hook']));
  expect((await installSetupPlugins(api,['claude-code'],options)).results[0]).toMatchObject({status:'prepared'});expect(installs).toBe(1);
  rmSync(join(configHome,'opencrawl/setup-plugins/claude-code',identity.key,'installed.json'));expect((await installSetupPlugins(api,['claude-code'],options)).results[0]).toMatchObject({status:'prepared'});expect(installs).toBe(1);
  if(process.platform!=='win32'){chmodSync(executable,0o600);expect(()=>verifyPluginBundle(binding)).toThrow();chmodSync(executable,0o755);}
  writeFileSync(executable,'tampered');expect(()=>verifyPluginBundle(binding)).toThrow();expect((await installSetupPlugins(api,['claude-code'],options)).results[0].status).toBe('pending');expect(installs).toBe(1);
  expect(readFileSync(join(directory,'bin/opencrawl-hook')).equals(parsed.binaries['bin/opencrawl-hook'])).toBe(true);
  expect(nextSetupAction({schemaVersion:1,scope:{api,tenantId:'fixture-tenant',userId:'fixture-user'},installationId:'fixture-installation',acceptedAt:'now',selections:{plugins:{'claude-code':true},forward:{'claude-code':true},history:{}},pluginResults:result.results},{scope:{tenantId:'fixture-tenant',userId:'fixture-user'},firstWin:null,installations:[]}).kind).toBe('plugin_unavailable');
 }finally{if(previous===undefined)delete process.env.OPENCRAWL_CONFIG_HOME;else process.env.OPENCRAWL_CONFIG_HOME=previous;rmSync(home,{recursive:true,force:true});}
});

test('unknown, prerelease or old Claude cannot mutate the plugin source or native installation',async()=>{
 const f=fixture(),home=mkdtempSync(join(tmpdir(),'oc-plugin-version-')),configHome=join(home,'config');
 try{
  const parsed=await readPluginArchive(bytes,f.metadata,f.entry,'darwin-arm64',f.pin);
  const source={...parsed,minimumHarnessVersion:'2.1.327',source:{repository:f.release.repository,ref:f.release.ref,path:f.entry.path,name:f.entry.name,version:f.entry.version},captureAvailable:true,daemonHandoff:true};
  for(const version of ['2.1.326 (Claude Code)','1.99.999 (Claude Code)','2.1.327-beta','unknown','']){
   const calls:string[][]=[];
   const result=await installSetupPlugins('https://selfhost.example',['claude-code'],{home,env:{OPENCRAWL_CONFIG_HOME:configHome},command:['/fixture/opencrawl'],which:()=>'/fixture/claude',bundles:{'claude-code':source},runner:async(_command,args)=>{calls.push(args);return {code:0,stdout:version};}});
   expect(result.results[0]).toMatchObject({status:'pending',message:'Claude Code 2.1.327 or later is required. Update the client, then resume setup.'});
   expect(calls).toEqual([['--version']]);expect(existsSync(join(configHome,'opencrawl/setup-plugins'))).toBe(false);
  }
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('Codex native version prefix is recognized while old or unknown clients stop before mutation',async()=>{
 const f=fixture(),home=mkdtempSync(join(tmpdir(),'oc-codex-version-')),configHome=join(home,'config');
 try{
  const parsed=await readPluginArchive(bytes,f.metadata,f.entry,'darwin-arm64',f.pin);
  const source={...parsed,minimumHarnessVersion:'0.166.0',source:{repository:f.release.repository,ref:f.release.ref,path:'local/codex',name:'opencrawl-local-codex',version:'0.1.1'},captureAvailable:true,daemonHandoff:true};
  for(const version of ['codex-cli 0.165.0','codex-cli 0.166.0-beta','0.166.0','unknown','codex-cli 0.166.0','codex-cli 0.167.0']){
   const calls:string[][]=[];
   const result=await installSetupPlugins('https://selfhost.example',['codex'],{home,env:{OPENCRAWL_CONFIG_HOME:configHome},command:['/fixture/opencrawl'],which:()=>'/fixture/codex',bundles:{codex:source},runner:async(_command,args)=>{calls.push(args);return {code:0,stdout:args[0]==='--version'?version:'native listing unavailable'};}});
   const supported=['codex-cli 0.166.0','codex-cli 0.167.0'].includes(version);
   expect(calls).toEqual(supported?[['--version'],['plugin','list','--marketplace',setupPluginIdentity('https://selfhost.example').marketplace,'--json']]:[['--version']]);
   expect(result.results[0]?.status).toBe('pending');
   expect(result.results[0]?.message).toContain(supported?'could not report':'0.166.0 or later');
   expect(existsSync(join(configHome,'opencrawl/setup-plugins'))).toBe(false);
  }
 }finally{rmSync(home,{recursive:true,force:true});}
});
