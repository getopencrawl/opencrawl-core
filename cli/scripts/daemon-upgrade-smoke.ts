import {prepareFallbackPlugins,proveOnlinePluginFallback} from './plugin-fallback-proof.ts';
/** Isolated native acceptance for upgrade/fallback. No user client settings or
 * credentials are read; an optional published old executable tests late hooks. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,readdirSync,rmSync,realpathSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {captureDir,readCaptureConfig,captureHook,drainCaptureNotices,type CaptureConfig} from '../src/capture/runtime.ts';
import {upgradeCaptureDaemon} from '../src/capture/daemon-upgrade.ts';
import {installCaptureDaemon,uninstallCaptureDaemon} from '../src/capture/daemon-service.ts';
import {setupPluginIdentity} from '../src/setup/plugins.ts';
import {atomicJson,withSessionLock} from '../src/session.ts';

const [evidenceArg,binaryArg,thirdArg]=process.argv.slice(2);
const pluginMode=thirdArg==='--plugin',oldBinaryArg=pluginMode?undefined:thirdArg;
if(!evidenceArg||!binaryArg)throw Error('Supply evidence directory and packaged native executable, optionally a published old executable');
const evidence=resolve(evidenceArg),binary=resolve(binaryArg),root=mkdtempSync(join(tmpdir(),'opencrawl-native-upgrade-')),before={...process.env};
const supervisorHome=process.platform==='linux'?homedir():root;
mkdirSync(evidence,{recursive:true});
const result:Record<string,unknown>={passed:false,platform:process.platform,pluginMode};
let fail=true,installed=false,pid:number|undefined,removed=false;
const batches:unknown[]=[],requests:string[]=[];
const receiver=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  if(new URL(request.url).pathname==='/api/sessions/identity')return Response.json({data:{principal:{tenantId:'fixture',userId:'fixture'},capabilities:{harnesses:['cursor','claude-code','codex']}}});
  const raw=await request.text();requests.push(raw);
  if(fail)return Response.json({error:'synthetic offline'}, {status:503});
  batches.push(JSON.parse(raw));return Response.json({data:{stored:true,batchId:createHash('sha256').update(raw).digest('hex')}});
}});
const alive=(id:number)=>{try{process.kill(id,0);return true;}catch{return false;}};
async function until(check:()=>boolean,ms=20_000){const end=Date.now()+ms;while(!check()){if(Date.now()>end)throw Error('Native acceptance timed out');await Bun.sleep(50);}}
try{
  for(const key of Object.keys(process.env))if(key.startsWith('OPENCRAWL_'))delete process.env[key];
  Object.assign(process.env,{HOME:root,USERPROFILE:root,OPENCRAWL_CONFIG_HOME:join(root,'config'),XDG_CONFIG_HOME:process.platform==='linux'?(before.XDG_CONFIG_HOME||join(supervisorHome,'.config')):join(root,'xdg'),XDG_CACHE_HOME:join(root,'cache'),XDG_DATA_HOME:join(root,'data'),OPENCRAWL_NO_UPDATE:'1',OPENCRAWL_SESSIONS_TOKEN:'synthetic-upgrade-token',CLAUDE_CONFIG_DIR:join(root,'claude'),CODEX_HOME:join(root,'codex'),CURSOR_CONFIG_DIR:join(root,'cursor')});
  const config:CaptureConfig={schemaVersion:1,api:receiver.url.origin,installationId:'native-upgrade',owner:{tenantId:'fixture',userId:'fixture'},installedAt:new Date().toISOString(),harnesses:['claude-code','codex','cursor'],roots:{'claude-code':join(root,'claude'),codex:join(root,'codex'),cursor:join(root,'cursor')},command:[binary],hookMode:'native-v5',...(pluginMode?{hookOwnership:'plugin',backgroundStartup:false,daemonRequested:{backgroundStartup:true}}:{})};
  atomicJson(join(captureDir(),'config.json'),config);
  atomicJson(join(captureDir(),'receiver-token.json'),{api:config.api,token:'synthetic-upgrade-token'});
  const hookEnv={...process.env},pluginRoots=new Map<string,string>();
  if(pluginMode){
    for(const [client,directory] of await prepareFallbackPlugins([binary],config,root))pluginRoots.set(client,directory);
    const directory=pluginRoots.get('cursor')!;
    delete hookEnv.OPENCRAWL_SESSIONS_TOKEN;
    Object.assign(hookEnv,{OPENCRAWL_PLUGIN_API:config.api,OPENCRAWL_PLUGIN_NAME:setupPluginIdentity(config.api).name,OPENCRAWL_PLUGIN_CLIENT:'cursor',OPENCRAWL_PLUGIN_ROOT:directory});
  }
  const runHook=async(executable:string,prompt:string)=>{
    const started=performance.now();
    const child=Bun.spawn([executable,'collect','hook','--harness','cursor','--api',config.api],{env:hookEnv,stdin:new Blob([JSON.stringify({conversation_id:'native-hooks',hook_event_name:'beforeSubmitPrompt',prompt})]),stdout:'pipe',stderr:'pipe'});
    const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    assert.equal(code,0,err+out);return performance.now()-started;
  };
  const fallback=await upgradeCaptureDaemon({install:async()=>{throw Error('synthetic bootstrap failure');},cleanup:()=>{}});
  assert.equal(fallback.state,'fallback');assert.deepEqual(readCaptureConfig(),config);
  if(pluginMode){
    fail=false;
    await proveOnlinePluginFallback(config,pluginRoots,batches);
    result.onlineFallbackFinalAnswers=['claude-code','codex','cursor'];
    fail=true;
    result.fallbackHookMs=await runHook(binary,'native fallback is retained');
    const child=Bun.spawn([binary,'session','start','--harness','cursor','--api',config.api],{env:hookEnv,stdin:new Blob([JSON.stringify({session_id:'fallback',hook_event_name:'sessionStart'})]),stdout:'pipe',stderr:'pipe'});
    const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);assert.equal(code,0,err);assert(out.includes('register this session'));result.startupFallbackExplicit=true;
  }else await captureHook('cursor',{conversation_id:'fallback',hook_event_name:'beforeSubmitPrompt',prompt:'native fallback is retained'});
  await drainCaptureNotices(config);
  const retained=new Map(readdirSync(join(captureDir(),'queue')).filter(name=>name.endsWith('.json')).map(name=>[name,readFileSync(join(captureDir(),'queue',name),'utf8')]));
  assert(retained.size>0);result.fallbackSpoolsFreshEvent=true;
  installed=true;
  const upgraded=await upgradeCaptureDaemon({install:(candidate,expectedConfig)=>installCaptureDaemon(candidate,{home:supervisorHome,expectedConfig}),cleanup:()=>uninstallCaptureDaemon(supervisorHome)});
  assert.equal(upgraded.state,'activated',JSON.stringify(upgraded));
  const status=()=>{try{return JSON.parse(readFileSync(join(captureDir(),'daemon','status.json'),'utf8'));}catch{return null;}};
  await until(()=>status()?.state==='running'&&alive(status().pid));pid=status().pid;
  assert.equal(realpathSync(status().executable),realpathSync(binary));assert.equal(status().compiled,true);
  const manifest=JSON.parse(readFileSync(join(dirname(dirname(binary)),'package.json'),'utf8'));
  assert.match(manifest.opencrawlRevision,/^[a-f0-9]{40}$/);assert.equal(status().version,manifest.version);
  result.worker={version:manifest.version,revision:manifest.opencrawlRevision,sha256:createHash('sha256').update(readFileSync(binary)).digest('hex')};
  for(const [name,bytes]of retained)assert.equal(readFileSync(join(captureDir(),'queue',name),'utf8'),bytes);
  result.nativeHookMs=await runHook(binary,'native daemon hook proof');
  if(oldBinaryArg)result.oldNativeHookMs=await runHook(resolve(oldBinaryArg),'published old hook survives migration');
  const killed=pid!,at=performance.now();process.kill(killed,'SIGKILL');
  await until(()=>status()?.state==='running'&&status().pid!==killed&&alive(status().pid),90_000);pid=status().pid;result.restartMs=performance.now()-at;
  fail=false;
  await until(()=>JSON.stringify(batches).includes('native fallback is retained')&&JSON.stringify(batches).includes('native daemon hook proof')&&(!oldBinaryArg||JSON.stringify(batches).includes('published old hook survives migration')),90_000);
  await until(()=>readdirSync(join(captureDir(),'queue')).filter(name=>name.endsWith('.json')).length===0);
  result.oldNativeHookRecovered=Boolean(oldBinaryArg);result.queuedFallbackRecovered=true;result.passed=true;
}catch(error){result.requestCount=requests.length;result.receivedBatches=batches;result.error=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{
  if(installed)try{uninstallCaptureDaemon(supervisorHome);removed=true;}catch(error){result.cleanupError=String(error);process.exitCode=1;result.passed=false;}
  try{if(pid)await until(()=>!alive(pid!),10_000);await withSessionLock('capture:daemon',async()=>{},0);if(!installed||removed)rmSync(root,{recursive:true,force:true});else result.retainedProfile=root;}
  catch{result.retainedProfile=root;result.passed=false;process.exitCode=1;}
  receiver.stop(true);for(const key of Object.keys(process.env))if(!(key in before))delete process.env[key];Object.assign(process.env,before);
  result.finishedAt=new Date().toISOString();writeFileSync(join(evidence,'native-upgrade-'+process.platform+(pluginMode?'-plugin':'')+'.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}
