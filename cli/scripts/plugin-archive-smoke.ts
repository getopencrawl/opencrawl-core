// Install either the pinned public release or an explicitly supplied development
// CI package through the real native installer. Capture is verified separately.
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {atomicJson} from '../src/session.ts';
import {fileHash} from '../src/setup/plugin-bundle.ts';
import {loadPublishedPackage,installPublishedSetupPlugins} from '../src/setup/published-plugins.ts';
import {setupPluginIdentity} from '../src/setup/plugins.ts';
import {verifyPluginBundle,type PluginBinding} from '../src/setup/plugin-context.ts';
import {pluginRelease,type PluginRelease} from '../src/setup/plugin-release.ts';

const client=process.argv[2]==='--public-codex'?'codex':process.argv[2]==='--public-antigravity'?'antigravity':'claude-code';
const publicRelease=['--public','--public-codex','--public-antigravity'].includes(process.argv[2]??'');
const [metadataFile,zipFile,ref,expectedSha,ciNative,ciOutput]=process.argv.slice(2);
const nativeBinary=publicRelease?process.argv[3]:ciNative,outputDirectory=publicRelease?process.argv[4]:ciOutput;
assert(nativeBinary&&outputDirectory&&(publicRelease||metadataFile&&zipFile&&/^[a-f0-9]{40}$/.test(ref??'')&&/^[a-f0-9]{64}$/.test(expectedSha??'')),'Usage: plugin-archive-smoke.ts --public native-claude output-directory OR --public-codex native-codex output-directory OR --public-antigravity native-agy output-directory OR artifact.json package.zip source-ref sha256 claude-binary output-directory');
const output=resolve(outputDirectory);mkdirSync(output,{recursive:true});
const home=mkdtempSync(join(output,'profile-')),configHome=join(home,'config'),platform=process.platform+'-'+process.arch;
let release=pluginRelease,fetcher:typeof fetch|undefined,artifact:unknown;
if(!publicRelease){
 const archive=readFileSync(zipFile!),metadata=readFileSync(metadataFile!),data=JSON.parse(metadata.toString());artifact=data;
 assert.equal(fileHash(archive),expectedSha);assert.equal(data.sha256,expectedSha);assert.equal(data.platform,platform);
 const base='https://github.com/getopencrawl/opencrawl-plugins/releases/download/local-proof/';
 const pin={url:base+data.filename,sha256:expectedSha!,metadataUrl:base+'artifact.json',metadataSha256:fileHash(metadata)};
 release={schemaVersion:1,bindingSchemaVersion:1,repository:'getopencrawl/opencrawl-plugins',ref:ref!,packages:[{harness:'claude-code',name:data.name,version:data.version,path:'plugins/claude-code',capabilities:'capabilities.json',captureAvailable:false,daemonHandoff:false,archives:{[platform]:pin}}]};
 fetcher=Object.assign(async(url:RequestInfo|URL,options?:RequestInit)=>{assert.equal(options?.headers,undefined);if(String(url)===pin.url)return new Response(archive);assert.equal(String(url),pin.metadataUrl);return new Response(metadata);},{preconnect:()=>{}}) as typeof fetch;
}
const env:NodeJS.ProcessEnv={HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:configHome,XDG_DATA_HOME:join(home,'data'),XDG_CACHE_HOME:join(home,'cache'),OPENCRAWL_CONFIG_HOME:configHome,CLAUDE_CONFIG_DIR:join(home,'claude'),CODEX_HOME:join(home,'codex'),CURSOR_CONFIG_DIR:join(home,'cursor'),ANTIGRAVITY_HOME:join(home,'antigravity'),DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',OPENCRAWL_NO_UPDATE:'1',PATH:process.platform==='win32'?(process.env.SystemRoot??'C:\\Windows')+'\\System32':'/usr/bin:/bin',...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot}:{})};
const api='http://127.0.0.1:56900',owner={tenantId:'archive-fixture-tenant',userId:'archive-fixture-user'},installationId='archive-native-installation',identity=setupPluginIdentity(api);
const previous=process.env.OPENCRAWL_CONFIG_HOME;process.env.OPENCRAWL_CONFIG_HOME=configHome;
try{
 mkdirSync(client==='codex'?env.CODEX_HOME!:client==='antigravity'?env.ANTIGRAVITY_HOME!:env.CLAUDE_CONFIG_DIR!,{recursive:true});
 for(const name of ['opencrawl','node','bun'])assert.equal(Bun.which(name,{PATH:env.PATH}),null,`${name} must be absent from the hook PATH`);
 const versionProcess=Bun.spawn([resolve(nativeBinary),'--version'],{env,stdout:'pipe',stderr:'pipe'});
 const [versionCode,nativeVersion]=await Promise.all([versionProcess.exited,new Response(versionProcess.stdout).text()]);assert.equal(versionCode,0);
 const source=await loadPublishedPackage(client,{release,platform,fetcher,cache:join(home,'packages')});
 assert.equal(source.captureAvailable,publicRelease);assert(source.executable);assert(source.binaries?.[source.executable]);
 atomicJson(join(configHome,'opencrawl/capture/config.json'),{schemaVersion:1,hookOwnership:'plugin',api,installationId,owner,harnesses:[client],historyHarnesses:[],installedAt:new Date().toISOString(),roots:{'claude-code':env.CLAUDE_CONFIG_DIR,codex:env.CODEX_HOME,antigravity:env.ANTIGRAVITY_HOME},command:['/fixture/opencrawl']});
 const options={home,env,command:['/fixture/opencrawl'],which:(name:string)=>name===(client==='codex'?'codex':client==='antigravity'?'agy':'claude')?resolve(nativeBinary):null,loadPackage:async()=>source,captureMode:'hook' as const};
 const installed=await installPublishedSetupPlugins(api,[client],options);
 assert.equal(installed.results[0]?.status,publicRelease?'installed':'prepared',JSON.stringify(installed));assert.equal(installed.results[0]?.captureAvailable,publicRelease);
 const receipt=JSON.parse(readFileSync(join(configHome,'opencrawl/setup-plugins',client,identity.key,'installed.json'),'utf8'));
 const binding:PluginBinding={api,client,pluginName:identity.name,configHome,nativeRoot:receipt.nativeRoot};
 const verified=verifyPluginBundle(binding),executable=join(receipt.nativeRoot,source.executable);
 assert.equal(fileHash(readFileSync(executable)),fileHash(source.binaries![source.executable]!));
 if(process.platform!=='win32'){assert.equal(statSync(executable).mode&0o777,0o755);assert.equal(statSync(join(receipt.nativeRoot,'.opencrawl-binding.json')).mode&0o777,0o600);}
 const event={hook_event_name:'PreToolUse',session_id:'archive-native-smoke',tool_name:client==='codex'?`mcp__${identity.name}__opencrawl_search_v1`:`mcp__plugin_${identity.name}_opencrawl__opencrawl_search_v1`,tool_input:{query:'archive fixture',includeToolOutputs:true,currentSession:{harness:client,sessionId:'archive-native-smoke'}}};
 const nativeEvent=(value:typeof event|{tool_input:Record<string,unknown>})=>client==='antigravity'?{hookEventName:'PreToolUse',conversationId:event.session_id,toolCall:{name:'call_mcp_tool',args:{ServerName:identity.name+'_opencrawl',ToolName:'opencrawl_search_v1',Arguments:value.tool_input}}}:value;
 const child=Bun.spawn([executable,'--root',receipt.nativeRoot,'--action','search'],{env,stdin:new Blob([JSON.stringify(nativeEvent(event))]),stdout:'pipe',stderr:'pipe'});
 const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 assert.equal(code,0);assert.equal(stderr,'');
 const hookSearchContext=stdout.trim()?JSON.parse(stdout):null;
 if(publicRelease){if(client==='antigravity')assert.deepEqual(hookSearchContext,{decision:'allow'});else assert.equal(hookSearchContext,null,'A valid original identity must not rewrite arguments or grant permission');}
 else if(hookSearchContext)assert.deepEqual(hookSearchContext.hookSpecificOutput.updatedInput,event.tool_input);
 let missingIdentityRejected=false;
 if(publicRelease){
  const missing={...event,tool_input:{query:'archive fixture',includeToolOutputs:true}};
  const check=Bun.spawn([executable,'--root',receipt.nativeRoot,'--action','search'],{env,stdin:new Blob([JSON.stringify(nativeEvent(missing))]),stdout:'pipe',stderr:'pipe'});
  const [checkCode,checkOut,checkErr]=await Promise.all([check.exited,new Response(check.stdout).text(),new Response(check.stderr).text()]);
  assert.equal(checkCode,0);assert.equal(checkErr,'');const response=JSON.parse(checkOut),denied=client==='antigravity'?response:response.hookSpecificOutput;
  assert.equal(client==='antigravity'?denied.decision:denied.permissionDecision,'deny');assert.equal(denied.updatedInput,undefined);assert((client==='antigravity'?denied.reason:denied.permissionDecisionReason).includes(event.session_id));missingIdentityRejected=true;
 }
 const resumed=await installPublishedSetupPlugins(api,[client],options);assert.equal(resumed.results[0]?.status,publicRelease?'unchanged':'prepared');
 const result={source:source.source,originalCiMetadata:artifact,delivery:publicRelease?'Anonymous public release download through pinned production loader':'Operator-downloaded CI ZIP; injected public transport, no anonymous-download claim',nativeInstaller:nativeVersion.trim(),compiledRuntimeExecutedWithoutCliNodeOrBunOnPath:true,binarySha256:verified.files[source.executable],binaryMode:'0755',privateBindingMode:'0600',scope:{api,...owner},installationId,captureMode:'hook',captureAvailable:source.captureAvailable,daemonInstalled:false,recordingVerified:false,installerResult:installed.results[0],resumeResult:resumed.results[0],hookSearchContext,originalSearchInputPreserved:true,missingIdentityRejected,profileRemoved:true};
 writeFileSync(join(output,'native-archive-install.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{
 if(previous===undefined)delete process.env.OPENCRAWL_CONFIG_HOME;else process.env.OPENCRAWL_CONFIG_HOME=previous;
 rmSync(home,{recursive:true,force:true});
}
