import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,readdirSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {scopedPluginIdentity as setupPluginIdentity} from '../src/setup/plugin-identity.ts';
import {writeDevinPlugin,setupPluginFiles} from '../src/setup/plugins.ts';
import {readDevinPlugin,startDevinPlugin} from '../src/setup/devin-plugin.ts';
import {pluginHookContext,recordPluginActivation} from '../src/setup/plugin-context.ts';
import {setupCommand} from '../src/setup/command.ts';
import {readSetupState,updateSetupState} from '../src/setup/state.ts';
import {captureDevinStartup,readCaptureConfig,captureDir} from '../src/capture/runtime.ts';
import {atomicJson} from '../src/session.ts';
import {withEnvironmentTokenOrigin} from '../src/environment-token.ts';

type Fixture={api:string;dir:string;bundle:string;profile:string;observations:Record<string,unknown>[];calls:string[];start:(session?:string)=>ReturnType<typeof startDevinPlugin>;setOwner:(id:string)=>void;setSession:(id:string)=>void;failPublish:(value:boolean)=>void;changeDuringSetup:(stage:'setup'|'capture')=>void};
const nativeSession='devin-native-session',startup={hook_event_name:'SessionStart',source:'startup',session_id:nativeSession};
// Bundle export is portable; runtime fixtures execute the Linux Cloud shell
// helper and exercise a POSIX VM profile. Windows validates export below, not
// this runtime, whose native acceptance runs on Linux.
const cloudRuntimeTest=test.skipIf(!['linux','darwin'].includes(process.platform));
async function fixture(run:(f:Fixture)=>Promise<void>,recording=true){
 const dir=mkdtempSync(join(tmpdir(),'opencrawl-devin-plugin-')),profile=join(dir,'profile'),bundle=join(dir,'bundle'),helper=join(dir,'helpers'),saved={...process.env};
 let userId='workload_devin_fixture',publishFailure=false,changeAt:'setup'|'capture'|undefined,identityCalls=0,sessionId=nativeSession;
 const observations:Record<string,unknown>[]=[],calls:string[]=[],installations:Record<string,unknown>[]=[];
 const principal=()=>({tenantId:'fixture-tenant',userId,owner:{kind:'shared',provider:'devin',organizationId:'org-0123456789abcdef0123456789abcdef',sessionId}});
 let token='';
 const server=createServer(async(req,res)=>{
  calls.push(req.url??'');
  if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);res.end('{}');return;}
  const send=(data:unknown)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({schemaVersion:1,data}));};
  if(req.url==='/api/sessions/identity'){if(++identityCalls===2&&changeAt==='capture')sessionId='devin-changed-session';send({principal:principal(),capabilities:{harnesses:['devin']}});return;}
  if(req.url==='/api/setup'){if(changeAt==='setup')userId='changed-after-startup';send({scope:{tenantId:'fixture-tenant',userId},pluginStateSupported:true,firstWin:null,installations});return;}
  if(req.url==='/api/setup/installation'){
   const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
   const body=JSON.parse(Buffer.concat(chunks).toString());
   if(publishFailure){res.writeHead(503);res.end('{}');return;}
   observations.push(body);installations.splice(0,installations.length,{...body,clients:body.clients.map((client:Record<string,unknown>)=>({...client,humanTasks:[]}))});send(body);return;
  }
  res.writeHead(404);res.end('{}');
 });
 await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);}).catch(error=>{rmSync(dir,{recursive:true,force:true});throw error;});
 const api='http://127.0.0.1:'+(server.address() as {port:number}).port;
 try{
  token=['synthetic',Buffer.from(JSON.stringify({iss:'https://app.devin.ai',aud:api,exp:Math.floor(Date.now()/1000)+120})).toString('base64url'),'signature'].join('.');
  mkdirSync(helper);writeFileSync(join(helper,'devin-oidc'),'#!/bin/sh\nprintf "%s" "'+token+'"\n',{mode:0o700});
  for(const key of ['OPENCRAWL_TOKEN','OPENCRAWL_SESSIONS_TOKEN','OPENCRAWL_PLUGIN_ROOT','OPENCRAWL_PLUGIN_API','OPENCRAWL_PLUGIN_NAME','OPENCRAWL_PLUGIN_CLIENT'])delete process.env[key];
  Object.assign(process.env,{HOME:dir,USERPROFILE:dir,OPENCRAWL_CONFIG_HOME:profile,OPENCRAWL_AUTH:'devin-cloud',OPENCRAWL_API_URL:api,PATH:helper+':/usr/bin:/bin',CLAUDE_CONFIG_DIR:join(dir,'claude'),CODEX_HOME:join(dir,'codex'),CURSOR_CONFIG_DIR:join(dir,'cursor'),ANTIGRAVITY_HOME:join(dir,'agy'),CLAUDE_DESKTOP_CONFIG_DIR:join(dir,'desktop')});
  writeDevinPlugin(bundle,api,{command:[join(dir,'opencrawl')],configHome:profile,recording});
  Object.assign(process.env,{OPENCRAWL_PLUGIN_ROOT:bundle,OPENCRAWL_PLUGIN_API:api,OPENCRAWL_PLUGIN_NAME:setupPluginIdentity(api).name,OPENCRAWL_PLUGIN_CLIENT:'devin'});
  const setup:typeof setupCommand=(action,origin,values,dependencies)=>setupCommand(action,origin,values,{...dependencies,installDaemon:async()=>({kind:'systemd-host',status:'installed',supervised:true,label:'fixture-only',uid:1000,transient:true,recreateOnHook:true}),launchHistory:()=>({state:'not_started'})});
  await withEnvironmentTokenOrigin(api,()=>run({api,dir,bundle,profile,observations,calls,start:(session=nativeSession)=>startDevinPlugin(api,{...startup,session_id:session},{setup}),setOwner:id=>{userId=id;},setSession:id=>{sessionId=id;},failPublish:value=>{publishFailure=value;},changeDuringSetup:stage=>{changeAt=stage;}}));
 }finally{
  server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));
  for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);rmSync(dir,{recursive:true,force:true});
 }
}

test('Cloud bundle exports on any host with Linux target paths and public configuration only',()=>{
 const dir=mkdtempSync(join(tmpdir(),'opencrawl-devin-export-')),bundle=join(dir,'bundle'),api='https://cloud-fixture.example';
 const options={command:['/usr/local/bin/opencrawl'],configHome:'/home/ubuntu/.config/opencrawl-cloud',recording:true};
 try{
 const result=writeDevinPlugin(bundle,api,options),files=setupPluginFiles('devin',api,options);
 expect(result).toMatchObject({client:'devin',api,directory:bundle,recording:true,installed:false});
 for(const [name,content] of Object.entries(files))expect(readFileSync(join(bundle,name),'utf8')).toBe(content);
 expect(JSON.parse(files['.opencrawl-devin.json']!)).toEqual({schemaVersion:1,api,...options});
 const binding=JSON.parse(files['.opencrawl-binding.json']!);
 expect(binding.dataHome).toBe(options.configHome+'/data');expect(binding.cacheHome).toBe(options.configHome+'/cache');
 const otherMachine=setupPluginFiles('devin',api,{...options,env:{XDG_DATA_HOME:'/private/exporter/data',XDG_CACHE_HOME:'/private/exporter/cache'}});
 expect(otherMachine).toEqual(files);
 expect(JSON.parse(files['.devin-plugin/plugin.json']!).platforms).toEqual(['cloud']);
 expect(JSON.parse(files['.mcp.json']!).mcpServers[setupPluginIdentity(api).name]).toEqual({command:'/bin/sh',args:['${PLUGIN_ROOT}/scripts/opencrawl-hook.sh','mcp']});
 const hooks=JSON.parse(files['hooks.json']!);expect(Object.keys(hooks).sort()).toEqual(['PostCompaction','PostToolUse','SessionStart','Stop','UserPromptSubmit']);
 expect(hooks.SessionStart[0].hooks[0].command).toEndWith(' workload');
 expect(JSON.stringify(files)).not.toContain('fixture-tenant');expect(JSON.stringify(files)).not.toContain('workload_devin_fixture');
 expect(readdirSync(dir)).toEqual(['bundle']);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

cloudRuntimeTest('Cloud bundle validation creates no local-client installation state or network requests',()=>fixture(async f=>{
 expect(readCaptureConfig()).toBeNull();expect(f.calls).toHaveLength(0);expect(readDevinPlugin(f.api).recording).toBe(true);
 expect(existsSync(join(f.dir,'codex'))).toBe(false);expect(existsSync(join(f.dir,'claude'))).toBe(false);
}));

cloudRuntimeTest('Cloud canonical runner invokes the pinned native CLI without ambient profile fallback',()=>fixture(async f=>{
 writeFileSync(join(f.dir,'opencrawl'),'#!/bin/sh\nprintf "%s\\n" "$@"\n',{mode:0o700});
 const child=Bun.spawn(['/bin/sh',join(f.bundle,'scripts/opencrawl-hook.sh'),'mcp'],{env:{HOME:f.dir,PATH:'/no-node'},stdout:'pipe',stderr:'pipe'});
 expect(await child.exited).toBe(0);expect(await new Response(child.stdout).text()).toBe(['plugin-hook','--root',realpathSync(f.bundle),'--action','mcp',''].join('\n'));expect(await new Response(child.stderr).text()).toBe('');
}));

cloudRuntimeTest('fresh Cloud startup binds the verified native owner through shared setup, capture and durable registration',()=>fixture(async f=>{
 const output=await f.start(),config=readCaptureConfig()!;
 expect(config).toMatchObject({api:f.api,hookOwnership:'plugin',harnesses:['devin'],backgroundStartup:true,owner:{tenantId:'fixture-tenant',userId:'workload_devin_fixture'}});
 expect(config.installationId).not.toBe('pending');expect(config.roots.devin).toBeDefined();
 expect(output.hookSpecificOutput.additionalContext).toContain('background registration pending');
 const state=readSetupState({api:f.api,tenantId:'fixture-tenant',userId:'workload_devin_fixture'})!;
 expect(state.selections).toEqual({plugins:{devin:true},forward:{devin:true},history:{devin:false}});
 expect(state.pluginResults).toMatchObject([{client:'devin',status:'installed'}]);
 expect(f.observations[0]).toMatchObject({clients:[{client:'devin',installed:true,forward:true}]});
 expect(f.observations.at(-1)).toMatchObject({clients:[{client:'devin',installed:true,forward:true,hookTrust:'not_required'}]});
 const inbox=readdirSync(join(captureDir(),'daemon','inbox'));expect(inbox.some(name=>name.startsWith('startup-'))).toBe(true);expect(inbox.some(name=>!name.startsWith('startup-'))).toBe(true);
 expect(readFileSync(join(captureDir(),'config.json'),'utf8')).not.toContain('synthetic.');
 for(const client of ['claude','codex','cursor','agy','desktop'])expect(existsSync(join(f.dir,client))).toBe(false);
}));

cloudRuntimeTest('search-only Cloud startup keeps recording off and creates no capture notice',()=>fixture(async f=>{
 await f.start();expect(readCaptureConfig()?.harnesses).toEqual([]);
 expect(readdirSync(join(captureDir(),'daemon','inbox')).every(name=>name.startsWith('startup-'))).toBe(true);
 expect(f.observations.at(-1)).toMatchObject({clients:[{client:'devin',installed:true,forward:false}]});
},false));

cloudRuntimeTest('resume preserves installation, recording opt-out and a deselected plugin',()=>fixture(async f=>{
 await f.start();const initial=readCaptureConfig()!,scope={api:f.api,...initial.owner};
 atomicJson(join(captureDir(),'config.json'),{...initial,disabled:true});await f.start();
 expect(readCaptureConfig()).toMatchObject({installationId:initial.installationId,disabled:true,harnesses:[]});
 expect(readSetupState(scope)?.selections.forward.devin).toBe(false);
 await updateSetupState(scope,current=>({...current!,selections:{...current!.selections,plugins:{devin:false}}}));
 const before=readFileSync(join(captureDir(),'config.json'),'utf8');await expect(f.start()).rejects.toMatchObject({code:'DEVIN_PLUGIN_NOT_SELECTED'});expect(readFileSync(join(captureDir(),'config.json'),'utf8')).toBe(before);
}));

cloudRuntimeTest('wrong native session or changed owner cannot create or rebind an installation',()=>fixture(async f=>{
 await expect(f.start('devin-other-session')).rejects.toMatchObject({code:'DEVIN_IDENTITY_MISMATCH'});expect(readCaptureConfig()).toBeNull();expect(f.observations).toHaveLength(0);
 await f.start();const before=readFileSync(join(captureDir(),'config.json'),'utf8'),count=f.observations.length;
 f.setOwner('different-workload');await expect(f.start()).rejects.toMatchObject({code:'DEVIN_PROFILE_CHANGED'});expect(readFileSync(join(captureDir(),'config.json'),'utf8')).toBe(before);expect(f.observations).toHaveLength(count);
}));

cloudRuntimeTest('bundle tampering and mixed authentication fail before network or setup mutation',()=>fixture(async f=>{
 process.env.OPENCRAWL_TOKEN='must-not-use';await expect(f.start()).rejects.toMatchObject({code:'DEVIN_PLUGIN_INVALID'});delete process.env.OPENCRAWL_TOKEN;
 process.env.OPENCRAWL_AUTH='replicas-workspace';await expect(f.start()).rejects.toMatchObject({code:'DEVIN_PLUGIN_INVALID'});process.env.OPENCRAWL_AUTH='devin-cloud';
 writeFileSync(join(f.bundle,'AGENTS.md'),'tampered');await expect(f.start()).rejects.toMatchObject({code:'DEVIN_PLUGIN_INVALID'});
 expect(f.calls).toHaveLength(0);expect(readCaptureConfig()).toBeNull();
}));

for(const stage of ['setup','capture'] as const)cloudRuntimeTest('identity changing during '+stage+' cannot create an installation',()=>fixture(async f=>{
 f.changeDuringSetup(stage);
 await expect(f.start()).rejects.toMatchObject({code:stage==='setup'?'SETUP_SCOPE_CHANGED':'DEVIN_IDENTITY_MISMATCH'});
 expect(readCaptureConfig()).toBeNull();expect(f.observations).toHaveLength(0);
}));

cloudRuntimeTest('another authenticated session in the same organization cannot inherit a previous VM profile',()=>fixture(async f=>{
 await f.start();const before=readFileSync(join(captureDir(),'config.json'),'utf8'),count=f.observations.length;
 f.setSession('devin-next-vm');await expect(f.start('devin-next-vm')).rejects.toMatchObject({code:'DEVIN_IDENTITY_MISMATCH'});
 expect(readFileSync(join(captureDir(),'config.json'),'utf8')).toBe(before);expect(f.observations).toHaveLength(count);
}));

cloudRuntimeTest('interrupted server publication resumes the same installation and rejects foreign native activation',()=>fixture(async f=>{
 f.failPublish(true);await expect(f.start()).rejects.toMatchObject({code:'SETUP_UNAVAILABLE'});const initial=readCaptureConfig()!;
 f.failPublish(false);await f.start();expect(readCaptureConfig()?.installationId).toBe(initial.installationId);
 const context=pluginHookContext(f.api,'devin');expect(context).not.toBeNull();
 expect(()=>recordPluginActivation(context,{...startup,session_id:'devin-foreign'})).toThrow();
 const before=readFileSync(join(captureDir(),'config.json'),'utf8');
 process.env.OPENCRAWL_PLUGIN_API='https://different.example';await expect(f.start()).rejects.toMatchObject({code:'DEVIN_PLUGIN_INVALID'});expect(readFileSync(join(captureDir(),'config.json'),'utf8')).toBe(before);
}));

cloudRuntimeTest('pre-install Devin events use the normal redacted wire queue, retries and opt-out',()=>fixture(async f=>{
 await f.start();
 const config=readCaptureConfig()!;
 config.installedAt=new Date(Date.now()-60000).toISOString();
 const file=join(captureDir(),'config.json');atomicJson(file,config);
 const fixtureSecret='ghp_'+'a'.repeat(36);
 const event={id:'devin-event:event-synthetic',nativeId:'event-synthetic',kind:'message',timestamp:config.installedAt,
   data:{role:'user',content:[{type:'text',text:'early marker '+fixtureSecret}]}};
 const calls:string[]=[];
 const read=async(api:string,path:string,init:RequestInit={})=>{
   calls.push(path);expect(api).toBe(f.api);
   expect(JSON.parse(String(init.body))).toEqual({installationId:config.installationId,through:config.installedAt});
   return {sessionId:nativeSession,events:[event]};
 };
 await captureDevinStartup(config,nativeSession,read);
 await captureDevinStartup(config,nativeSession,read);
 const queued=readdirSync(join(captureDir(),'queue')).map(name=>JSON.parse(readFileSync(join(captureDir(),'queue',name),'utf8')));
 const copies=queued.flatMap(batch=>batch.events).filter(e=>e.nativeId==='event-synthetic');
 expect(copies).toHaveLength(1);expect(copies[0].data.role).toBe('user');expect(JSON.stringify(copies)).toContain('early marker');
 expect(JSON.stringify(copies)).not.toContain(fixtureSecret);
 expect(calls).toEqual(['/api/cli/workloads/devin/startup-events','/api/cli/workloads/devin/startup-events']);
 await captureDevinStartup(config,nativeSession,async()=>{
   throw Object.assign(new Error('denied'),{httpStatus:403,responseCode:'DEVIN_RECORDING_CREDENTIAL_REQUIRED'});
 });
 expect(JSON.parse(readFileSync(join(captureDir(),'last-error.json'),'utf8')).code).toBe('DEVIN_RECORDING_CREDENTIAL_REQUIRED');
 atomicJson(file,{...config,disabled:true});
 await captureDevinStartup(config,nativeSession,read);expect(calls).toHaveLength(2);
}));
