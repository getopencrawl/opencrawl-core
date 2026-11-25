import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import fixture from './fixtures/published-claude-stub.json';
import stubRelease from './fixtures/published-stub-release.json';
import type {PluginRelease} from '../src/setup/plugin-release.ts';
import {acceptedPackageSource,loadPublishedPackage,bindPublishedPackage,type PublishedPackage} from '../src/setup/published-plugins.ts';
import {daemonEligibility,daemonStartupGuidance,requestedCaptureMode,savedCaptureMode} from '../src/setup/capture-mode.ts';
import {nextSetupAction} from '../src/setup/next.ts';
import type {SetupState} from '../src/setup/state.ts';

test('a retained per-client release must match the harness, official artifact URL and saved hashes',()=>{
 const platform=process.platform+'-'+process.arch;
 const receipt={repository:'getopencrawl/opencrawl-plugins',ref:'335991acf5e23c072b9874aa4d486fd82d3b37e2',name:'opencrawl-local-codex',path:'local/codex',version:'0.2.6',
  archive:{platform,url:'https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-codex-v0.2.6/opencrawl-local-codex-0.2.6-'+platform+'.zip',sha256:'a'.repeat(64),metadataSha256:'b'.repeat(64)}};
 expect(acceptedPackageSource('codex',receipt)).toBe(true);
 expect(acceptedPackageSource('claude-code',receipt)).toBe(false);
 for(const patch of [{name:'opencrawl'},{path:'plugins/codex'},{path:'local/cursor'},{repository:'other/plugins'},{ref:'main'},
  {archive:{...receipt.archive,url:receipt.archive.url.replace('local-codex-v','v')}},{archive:{...receipt.archive,sha256:''}}]){
  expect(acceptedPackageSource('codex',{...receipt,...patch})).toBe(false);
 }
});

test('pinned package bytes are checked and cached; ambient credentials never leave for GitHub',async()=>{
 const cache=mkdtempSync(join(tmpdir(),'oc-package-'));let calls=0;
 const fetcher=(async(url:string|URL|Request,init?:RequestInit)=>{
  calls++;expect(String(url)).toStartWith('https://raw.githubusercontent.com/getopencrawl/opencrawl-plugins/'+fixture.source.ref+'/local/claude-code/');
  expect(init?.headers).toBeUndefined();expect(init?.redirect).toBe('error');
  return new Response(fixture.files[String(url).split('/local/claude-code/')[1] as keyof typeof fixture.files]);
 }) as typeof fetch;
 try{
  expect(await loadPublishedPackage('claude-code',{release:stubRelease as PluginRelease,cache,fetcher})).toEqual(fixture);expect(calls).toBe(Object.keys(fixture.files).length);
  await loadPublishedPackage('claude-code',{release:stubRelease as PluginRelease,cache,fetcher});expect(calls).toBe(Object.keys(fixture.files).length);
  const path=join(cache,fixture.source.ref,'claude-code.json'),corrupt=JSON.parse(readFileSync(path,'utf8'));corrupt['README.md']='tampered';writeFileSync(path,JSON.stringify(corrupt));
  await expect(loadPublishedPackage('claude-code',{release:stubRelease as PluginRelease,cache,fetcher:Object.assign(async()=>new Response('wrong bytes'),{preconnect:()=>{}}) as typeof fetch})).rejects.toMatchObject({code:'PLUGIN_PACKAGE_INVALID'});
 }finally{rmSync(cache,{recursive:true,force:true});}
});
test('binding retains shipped skill and hooks, uses only explicit owner/profile/origin and private setup files',()=>{
 const options={configHome:join(tmpdir(),'profile'),installationId:'native-installation',owner:{tenantId:'tenant',userId:'user'},captureMode:'hook' as const,command:['/owned/opencrawl'],env:{}};
 const bound=bindPublishedPackage('claude-code','https://selfhost.example',fixture as PublishedPackage,options);
 expect(bound.files['skills/opencrawl/SKILL.md']).toBe(fixture.files['skills/opencrawl/SKILL.md']);
 expect(Object.keys(bound.files).some(name=>name.includes('hook'))).toBe(false);
 expect(JSON.parse(bound.files['.opencrawl-binding.json'])).toEqual({schemaVersion:1,client:'claude-code',api:'https://selfhost.example',configHome:options.configHome,installationId:options.installationId,owner:options.owner,captureMode:'hook'});
 expect(JSON.parse(bound.files['.mcp.json']).mcpServers.opencrawl.url).toBe('https://selfhost.example/mcp');
 expect(JSON.parse(bound.files['mcp.json']).mcpServers.opencrawl.url).toBe('https://selfhost.example/mcp');
 expect(()=>bindPublishedPackage('claude-code','https://selfhost.example',fixture as PublishedPackage,{...options,configHome:'relative'})).toThrow();
 expect(()=>bindPublishedPackage('claude-code','https://selfhost.example',fixture as PublishedPackage,{...options,installationId:'pending'})).toThrow();
});
test('a stub cannot complete setup even with an earlier green server receipt',()=>{
 const state:SetupState={schemaVersion:1,scope:{api:'https://selfhost.example',tenantId:'tenant',userId:'user'},installationId:'installation',acceptedAt:'now',captureMode:'hook',selections:{plugins:{'claude-code':true},forward:{'claude-code':true},history:{}},pluginResults:[{client:'claude-code',status:'prepared',captureAvailable:false}],worker:{kind:'not-required',supervised:false,harnesses:[],startup:false}};
 const server={scope:state.scope,firstWin:null,installations:[{installationId:'installation',clients:[{client:'claude-code',installed:true,mcp:{state:'authenticated'},proof:{state:'verified'},humanTasks:[]}]}]};
 expect(nextSetupAction(state,server).kind).toBe('plugin_unavailable');
 expect(nextSetupAction({...state,pluginResults:[{client:'claude-code',status:'installed',captureAvailable:true}]},server).kind).toBe('complete');
 for(const status of ['error','pending'])expect(nextSetupAction({...state,pluginResults:[{client:'claude-code',status,captureAvailable:true}]},server).kind).toBe('repair_plugin');
});
test('daemon requires a supported local host and handoff capability; new profiles default to hooks',()=>{
 expect(savedCaptureMode(null,null)).toBe('hook');
 expect(requestedCaptureMode(undefined,'daemon')).toBe('daemon');
 expect(()=>requestedCaptureMode('yes','hook')).toThrow();
 expect(daemonEligibility(['claude-code'],'darwin',{}).eligible).toBe(true);
 const capable=()=>({daemonHandoff:true,captureAvailable:true});
 expect(daemonEligibility(['claude-code'],'darwin',{},()=>({daemonHandoff:true,captureAvailable:false})).eligible).toBe(false);
 expect(daemonEligibility(['claude-code'],'darwin',{},capable).eligible).toBe(true);
 expect(daemonEligibility(['claude-code'],'win32',{},capable).eligible).toBe(false);
 const linuxCli=['codex','claude-code','antigravity','cursor'];
 expect(daemonEligibility(linuxCli,'linux',{SSH_CONNECTION:'test'},undefined,()=>true).eligible).toBe(true);
 expect(daemonEligibility(linuxCli,'linux',{},undefined,()=>false)).toMatchObject({eligible:false,requiresSystemd:true});
 expect(daemonEligibility(['claude-code'],'darwin',{CLAUDE_CODE_REMOTE:'true'},capable).eligible).toBe(false);
 expect(daemonEligibility(['unknown'],'darwin',{}).eligible).toBe(false);
});

test('failed mounted-volume service offers recovery without claiming a privacy diagnosis',()=>{
 const message=daemonStartupGuidance(['/Volumes/Proof/bin/opencrawl','/Volumes/Proof/profile'],'darwin');
 expect(message).toContain('startup was not confirmed');expect(message).toContain('mounted volume');expect(message).toContain('Fix the host-service issue and retry');expect(message).not.toContain('permission was denied');
 expect(daemonStartupGuidance(['/usr/local/bin/opencrawl','/Users/example/.config'],'darwin')).not.toContain('mounted volume');
 expect(daemonStartupGuidance(['/Volumes/Proof/bin/opencrawl'],'linux')).not.toContain('mounted volume');
});
