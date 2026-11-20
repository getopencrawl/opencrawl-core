import {test,expect,spyOn} from 'bun:test';
import {mkdtempSync,readFileSync,readdirSync,rmSync,statSync,existsSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sessionStart,cursorToolContext} from '../src/session-start.ts';
import {processSessionStartTask,startupObservation,startupBindingKey,waitForStartupRegistration,type SessionStartTask} from '../src/session-start-task.ts';
import {captureDir,type CaptureConfig} from '../src/capture/runtime.ts';
import {boardCommand,boardStateFile,participationInstructions} from '../src/board.ts';
import {retrievalInstruction} from '../src/retrieval-instruction.ts';
import {scopeKey,statePath,type SetupState} from '../src/setup/state.ts';
import * as session from '../src/session.ts';
import * as identity from '../src/workspace-identity.ts';
import * as service from '../src/capture/daemon-service.ts';
import {privacyRoot,privacyKey} from '../src/incognito-state.ts';

const api='https://startup-background.example',sessionId='native-startup-session';
const event={hook_event_name:'SessionStart',session_id:sessionId,source:'startup'};
const clients=['codex','claude-code','cursor','antigravity'] as const;
type Fixture={config:CaptureConfig;setup:SetupState;writeConfig:(config:CaptureConfig)=>void;writeSetup:(state:SetupState)=>void;tasks:()=>SessionStartTask[];inbox:string;stateFile:()=>string};
async function fixture(run:(f:Fixture)=>Promise<void>){
 const home=mkdtempSync(join(tmpdir(),'opencrawl-background-start-')),saved={...process.env};
 try{
  Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(home,'config'),OPENCRAWL_API_URL:api,OPENCRAWL_TOKEN:'synthetic-startup-token',GIT_CONFIG_GLOBAL:join(home,'gitconfig')});
  delete process.env.OPENCRAWL_AUTH;delete process.env.OPENCRAWL_SESSIONS_TOKEN;
  const config:CaptureConfig={schemaVersion:1,api,installationId:'startup-installation',owner:{tenantId:'startup-team',userId:'startup-owner'},installedAt:new Date().toISOString(),roots:{codex:join(home,'codex'),'claude-code':join(home,'claude')},command:[],hookOwnership:'plugin',backgroundStartup:true,disabled:true,harnesses:[]};
  const setup:SetupState={schemaVersion:1,scope:{api,...config.owner},installationId:config.installationId,acceptedAt:new Date().toISOString(),selections:{plugins:Object.fromEntries(clients.map(c=>[c,true])),forward:Object.fromEntries(clients.map(c=>[c,false])),history:{}}};
  const writeConfig=(value:CaptureConfig)=>session.atomicJson(join(captureDir(),'config.json'),value);
  const writeSetup=(value:SetupState)=>session.atomicJson(statePath(scopeKey(value.scope)),value);
  writeConfig(config);writeSetup(setup);
  const inbox=join(captureDir(),'daemon','inbox');
  const tasks=()=>existsSync(inbox)?readdirSync(inbox).filter(n=>n.startsWith('startup-')).map(n=>JSON.parse(readFileSync(join(inbox,n),'utf8')) as SessionStartTask):[];
  await run({config,setup,writeConfig,writeSetup,tasks,inbox,stateFile:()=>join(session.configDir(),'startup','registrations',readdirSync(join(session.configDir(),'startup','registrations'))[0]!)});
 }finally{for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);rmSync(home,{recursive:true,force:true});}
}
function receiver(f:Fixture,onRequest?:(path:string)=>void,filesEnabled=false):typeof fetch {
 return (async(input:RequestInfo|URL,init?:RequestInit)=>{
  const path=new URL(String(input)).pathname;
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-startup-token');
  onRequest?.(path);
  if(path==='/api/cli/me')return Response.json({schemaVersion:1,data:{user:{id:f.config.owner.userId},workspace:{id:f.config.owner.tenantId}}});
  expect(path).toBe('/api/board/bootstrap');
  const body=JSON.parse(String(init?.body));expect(body.workspace).toBe(f.config.owner.tenantId);
  return Response.json({schemaVersion:1,data:{workspace:f.config.owner.tenantId,session:body.session,agent:'a'.repeat(64),name:null,task:null,...(filesEnabled?{sharedFiles:true}:{})}});
 }) as typeof fetch;
}

test('a background upgrade repairs on confirmed bootstrap and announces only current file access',()=>fixture(async f=>{
  let enabled=true;
  const global=process.env.GIT_CONFIG_GLOBAL!;
  const fetcher=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=new URL(String(input)).pathname;
    if(path==='/api/files')return enabled?Response.json({schemaVersion:1,data:{...f.config.owner,remotePath:'/api/files/'+'a'.repeat(64)+'.git'}}):new Response(null,{status:404});
    if(path==='/api/board/v2/inbox')return Response.json({schemaVersion:1,data:{left:true,ids:[],messages:[],more:false}});
    return receiver(f,undefined,enabled)(input,init);
  }) as typeof fetch;
  const live=spyOn(globalThis,'fetch').mockImplementation(fetcher);
  try {
    const start=async()=> (await sessionStart(api,'codex',event)).hookSpecificOutput.additionalContext;
    const work=async()=>{
      const id=JSON.parse(readFileSync(f.stateFile(),'utf8')).pending.id;
      await processSessionStartTask(f.config,f.tasks().find(task=>task.id===id),fetcher);
    };
    const notices=async()=>{
      const result:unknown[]=[];
      await boardCommand('watch',api,{session:sessionId,'notify-only':true,'timeout-ms':2000},row=>result.push(row));
      return result;
    };
    expect(await start()).not.toContain('files open');expect(existsSync(global)).toBe(false);
    await work();expect(readFileSync(global,'utf8')).toContain('include');
    expect(await notices()).toMatchObject([{type:'board.capabilities',sharedFiles:expect.stringContaining('files open --session '+sessionId)}]);
    enabled=false;
    expect(await notices()).toEqual([]); // The prior receipt still says enabled.
    expect(await start()).not.toContain('files open');
    rmSync(global);await work();expect(existsSync(global)).toBe(false);
    expect(await notices()).toEqual([]);
    enabled=true;await start();
    const privateId={harness:'codex',sessionId};
    session.atomicJson(join(privacyRoot(f.config),'accepted',privacyKey(privateId)),privateId);
    await work();expect(existsSync(global)).toBe(false);
    expect(await start()).toContain('incognito');
  } finally {live.mockRestore();}
}));

test('offline startup is a bounded local handoff across four harnesses with static retrieval guidance',()=>fixture(async f=>{
 const network=spyOn(globalThis,'fetch').mockImplementation((async()=>{throw Error('foreground network');}) as unknown as typeof fetch);
 const auth=spyOn(session,'accessToken').mockImplementation(async()=>{throw Error('foreground auth');});
 const configured=spyOn(identity,'configuredToken').mockImplementation(async()=>{throw Error('foreground identity');});
 const ensure=spyOn(service,'ensureCaptureDaemon').mockImplementation(async()=>{throw Error('foreground service launch');});
 const install=spyOn(service,'installCaptureDaemon').mockImplementation(async()=>{throw Error('foreground service install');});
 try{
  const outputs=[
   (await sessionStart(api,'codex',{...event,transcript_path:'/must-not-read',tool_output:'private output'})).hookSpecificOutput.additionalContext,
   (await sessionStart(api,'claude-code',event)).hookSpecificOutput.additionalContext,
   (await sessionStart(api,'cursor',{hook_event_name:'sessionStart',session_id:sessionId,tool_input:'private input'})).additional_context,
   (await sessionStart(api,'antigravity',{hookEventName:'SessionStart',conversationId:sessionId,lastUserInput:'private user input'})).injectSteps[0].systemMessage.systemMessage,
  ];
  for(const output of outputs){expect(output).toContain('background registration pending');expect(output).toContain(retrievalInstruction);expect(output).toContain('does not attach a listener');}
  for(let i=0;i<5;i++)await sessionStart(api,'codex',event);
  expect(f.tasks()).toHaveLength(4);
  for(const name of readdirSync(f.inbox)){
   expect(name).toMatch(/^startup-[0-9a-f-]+\.json$/);
   const path=join(f.inbox,name),text=readFileSync(path,'utf8');expect(Buffer.byteLength(text)).toBeLessThan(1024);
   expect(text).not.toContain('private');expect(text).not.toContain('must-not-read');
   if(process.platform!=='win32')expect(statSync(path).mode&0o777).toBe(0o600);
  }
  for(const spy of [network,auth,configured,ensure,install])expect(spy).not.toHaveBeenCalled();
 }finally{network.mockRestore();auth.mockRestore();configured.mockRestore();ensure.mockRestore();install.mockRestore();}
}));

test('search-only startup confirms later with the same authenticated owner credential and preserves listener checkpoint',()=>fixture(async f=>{
 await sessionStart(api,'codex',event);
 const task=f.tasks()[0]!,file=join(f.inbox,'startup-'+task.id+'.json'),bytes=readFileSync(file,'utf8');
 expect(startupObservation(api,'codex',sessionId)).toBeUndefined();
 session.atomicJson(boardStateFile(api,sessionId),{workspace:f.config.owner.tenantId,agent:'a'.repeat(64),name:null,lastEmitted:'listener-checkpoint'});
 const paths:string[]=[];
 await processSessionStartTask(f.config,task,receiver(f,path=>paths.push(path)));
 expect(paths).toEqual(['/api/cli/me','/api/board/bootstrap']);
 expect(startupObservation(api,'codex',sessionId)?.registration.workspace).toBe(f.config.owner.tenantId);
 expect(readFileSync(file,'utf8')).toBe(bytes); // Only the worker lane may remove its task.
 expect(JSON.parse(readFileSync(boardStateFile(api,sessionId),'utf8')).lastEmitted).toBe('listener-checkpoint');
 const output=(await sessionStart(api,'codex',event)).hookSpecificOutput.additionalContext;
 expect(output).toContain('registration previously confirmed at');expect(output).toContain('not proof of current authentication');expect(output).toContain(retrievalInstruction);
 expect(JSON.parse(readFileSync(join(captureDir(),'config.json'),'utf8'))).toEqual(f.config);
 expect(existsSync(join(captureDir(),'queue'))).toBe(false);expect(f.config.disabled).toBe(true);expect(f.config.harnesses).toEqual([]);
}));

test('legacy board state and cache mismatches cannot confirm another startup binding',()=>fixture(async f=>{
 session.atomicJson(boardStateFile(api,sessionId),{workspace:f.config.owner.tenantId,agent:'a'.repeat(64),name:null});
 expect((await sessionStart(api,'codex',event)).hookSpecificOutput.additionalContext).toContain('registration pending');
 await processSessionStartTask(f.config,f.tasks()[0],receiver(f));
 const original=JSON.parse(readFileSync(f.stateFile(),'utf8'));
 session.atomicJson(f.stateFile(),{...original,binding:Object.fromEntries(Object.entries(original.binding).reverse())});
 expect(startupObservation(api,'codex',sessionId)).toBeDefined();
 for(const change of [{api:'https://wrong.example'},{installationId:'different'},{owner:{...f.config.owner,userId:'different'}},{owner:{...f.config.owner,tenantId:'different'}},{harness:'cursor'},{sessionId:'other-native'}]){
  session.atomicJson(f.stateFile(),{...original,binding:{...original.binding,...change}});
  expect(startupObservation(api,'codex',sessionId)).toBeUndefined();
  expect((await sessionStart(api,'codex',event)).hookSpecificOutput.additionalContext).toContain('registration pending');
 }
}));

test('worker rejects wrong authenticated owner/workspace and invalid native task without consuming the task',()=>fixture(async f=>{
 await sessionStart(api,'codex',event);const task=f.tasks()[0]!,file=join(f.inbox,'startup-'+task.id+'.json'),before=readFileSync(file,'utf8');
 for(const data of [{user:{id:'different'},workspace:{id:f.config.owner.tenantId}},{user:{id:f.config.owner.userId},workspace:{id:'different'}},{user:{id:f.config.owner.userId}}]){
  let calls=0;
  const fetcher=(async()=>{calls++;return Response.json({schemaVersion:1,data});}) as unknown as typeof fetch;
  await expect(processSessionStartTask(f.config,task,fetcher)).rejects.toMatchObject({code:'BOARD_OWNER_MISMATCH'});
  expect(calls).toBe(1);expect(startupObservation(api,'codex',sessionId)).toBeUndefined();expect(readFileSync(file,'utf8')).toBe(before);
 }
 let calls=0;const fetcher=receiver(f,()=>{calls++;});
 for(const change of [{installationId:'different'},{owner:{...task.owner,userId:'different'}},{api:'https://wrong.example'},{payload:{...task.payload,tool_output:'must not persist'}},{sessionId:'bad/native'}])
  await expect(processSessionStartTask(f.config,{...task,...change},fetcher)).rejects.toMatchObject({code:'STARTUP_BINDING_CHANGED'});
 expect(calls).toBe(0);expect(readFileSync(file,'utf8')).toBe(before);
}));

test('worker rechecks installation and plugin selection after identity and bootstrap awaits',async()=>{
 for(const stage of ['/api/cli/me','/api/board/bootstrap'])for(const changed of ['api','installation','owner','selection'])await fixture(async f=>{
  await sessionStart(api,'codex',event);const task=f.tasks()[0]!,file=join(f.inbox,'startup-'+task.id+'.json'),before=readFileSync(file,'utf8');
  const fetcher=receiver(f,path=>{if(path===stage){
   if(changed==='selection')f.writeSetup({...f.setup,selections:{...f.setup.selections,plugins:{codex:false}}});
   else f.writeConfig(changed==='owner'?{...f.config,owner:{...f.config.owner,userId:'changed'}}:changed==='api'?{...f.config,api:'https://changed.example'}:{...f.config,installationId:'changed'});
  }});
  await expect(processSessionStartTask(f.config,task,fetcher)).rejects.toMatchObject({code:'STARTUP_BINDING_CHANGED'});
  expect(JSON.parse(readFileSync(f.stateFile(),'utf8')).confirmed).toBeUndefined();expect(readFileSync(file,'utf8')).toBe(before);
  expect(existsSync(boardStateFile(api,sessionId))).toBe(false);
 });
});

test('worker cannot confirm after selection is revoked while waiting for the receipt lock',()=>fixture(async f=>{
 await sessionStart(api,'codex',event);const task=f.tasks()[0]!;
 let release:(()=>void)|undefined,received=false;
 const held=session.withSessionLock('startup:'+startupBindingKey(api,'codex',sessionId),()=>new Promise<void>(resolve=>{release=resolve;}));
 while(!release)await new Promise(resolve=>setTimeout(resolve,1));
 const processed=processSessionStartTask(f.config,task,receiver(f,path=>{if(path==='/api/board/bootstrap')received=true;}));
 const outcome=processed.then(()=>null,error=>error as unknown);
 try{
  while(!received)await new Promise(resolve=>setTimeout(resolve,1));
  await new Promise(resolve=>setTimeout(resolve,10));
  f.writeSetup({...f.setup,selections:{...f.setup.selections,plugins:{codex:false}}});
 }finally{release();await held;}
 expect(await outcome).toMatchObject({code:'STARTUP_BINDING_CHANGED'});
 expect(JSON.parse(readFileSync(f.stateFile(),'utf8')).confirmed).toBeUndefined();
 expect(existsSync(boardStateFile(api,sessionId))).toBe(false);expect(f.tasks()).toHaveLength(1);
}));

test('failed worker retries retain the task and only a successful bound response becomes confirmed',()=>fixture(async f=>{
 await sessionStart(api,'codex',event);const task=f.tasks()[0]!,before=readFileSync(join(f.inbox,'startup-'+task.id+'.json'),'utf8');
 await expect(processSessionStartTask(f.config,task,(async()=>{throw Error('offline');}) as unknown as typeof fetch)).rejects.toMatchObject({code:'NETWORK_ERROR'});
 expect(startupObservation(api,'codex',sessionId)).toBeUndefined();expect(readFileSync(join(f.inbox,'startup-'+task.id+'.json'),'utf8')).toBe(before);
 const wrong=(async(input:RequestInfo|URL,init?:RequestInit)=>new URL(String(input)).pathname==='/api/cli/me'?receiver(f)(input,init):Response.json({schemaVersion:1,data:{workspace:'wrong',session:sessionId,agent:'a'.repeat(64),name:null,task:null}})) as typeof fetch;
 await expect(processSessionStartTask(f.config,task,wrong)).rejects.toMatchObject({code:'BOARD_PROTOCOL_ERROR'});
 expect(startupObservation(api,'codex',sessionId)).toBeUndefined();
 await processSessionStartTask(f.config,task,receiver(f));expect(startupObservation(api,'codex',sessionId)).toBeDefined();
}));

test('Cursor emits pending once and delayed confirmation once per generation without retaining raw tool data',()=>fixture(async f=>{
 const hook={hook_event_name:'postToolUse',conversation_id:sessionId,generation_id:'turn-one',tool_input:'private tool input',tool_output:'private tool output'};
 expect((await cursorToolContext(api,hook)).additional_context).toContain('registration pending');
 expect(await cursorToolContext(api,hook)).toEqual({});expect(f.tasks()).toHaveLength(1);
 await processSessionStartTask(f.config,f.tasks()[0],receiver(f));
 expect((await cursorToolContext(api,hook)).additional_context).toContain('previously confirmed');
 expect(await cursorToolContext(api,hook)).toEqual({});
 expect((await cursorToolContext(api,{...hook,generation_id:'turn-two'})).additional_context).toContain('previously confirmed');
 const folder=join(session.configDir(),'startup','cursor-context');
 expect(readdirSync(folder).map(name=>JSON.parse(readFileSync(join(folder,name),'utf8')))).toEqual([{generation:'turn-two',confirmed:true}]);
 expect(JSON.stringify(f.tasks())).not.toContain('private');
 f.writeConfig({...f.config,installationId:'replacement-installation'});
 f.writeSetup({...f.setup,installationId:'replacement-installation'});
 expect((await cursorToolContext(api,{...hook,generation_id:'turn-two'})).additional_context).toContain('registration pending');
 expect(startupObservation(api,'cursor',sessionId)).toBeUndefined();
 expect(readdirSync(folder)).toHaveLength(2);
}));

test('unavailable and invalid native startup always retain static retrieval guidance',()=>fixture(async f=>{
 f.writeSetup({...f.setup,selections:{...f.setup.selections,plugins:{codex:false}}});
 for(const input of [event,{...event,session_id:'bad/native'}]){
  const output=(await sessionStart(api,'codex',input)).hookSpecificOutput.additionalContext;
  expect(output).toContain('unavailable');expect(output).toContain(retrievalInstruction);
 }
 expect(f.tasks()).toHaveLength(0);
}));

for(const operation of ['profile','watch'])for(const resumed of [false,true])test(`${operation} waits for ${resumed?'resumed':'initial'} background registration and reloads its workspace`,()=>fixture(async f=>{
 await sessionStart(api,'codex',event);
 if(resumed){await processSessionStartTask(f.config,f.tasks()[0],receiver(f));await sessionStart(api,'codex',event);}
 const task=f.tasks().find(task=>task.id===JSON.parse(readFileSync(f.stateFile(),'utf8')).pending.id)!;
 // An older board file is not authority for a newer startup observation.
 session.atomicJson(boardStateFile(api,sessionId),{workspace:'stale-workspace',agent:'b'.repeat(64),name:null});
 const requests:string[]=[],backend=receiver(f,path=>requests.push(path));
 const fetcher=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const path=new URL(String(input)).pathname;
  if(path==='/api/board/profile'||path==='/api/board/inbox'){
   requests.push(path);expect(JSON.parse(String(init?.body)).workspace).toBe(f.config.owner.tenantId);
   return Response.json({schemaVersion:1,data:path.endsWith('inbox')?{left:true}:{workspace:f.config.owner.tenantId,agent:'a'.repeat(64),name:'codex:fixture'}});
  }
  return backend(input,init);
 }) as typeof fetch;
 const network=spyOn(globalThis,'fetch').mockImplementation(fetcher);
 try{
  const command=boardCommand(operation,api,{session:sessionId,name:'codex:fixture','timeout-ms':1000},()=>{});
  await new Promise(resolve=>setTimeout(resolve,20));expect(requests).toEqual([]);
  await processSessionStartTask(f.config,task,fetcher);await command;
  expect(requests).toEqual(['/api/cli/me','/api/board/bootstrap',operation==='profile'?'/api/board/profile':'/api/board/inbox']);
 }finally{network.mockRestore();}
}));

test('pending registration wait honors deadline, revocation and native parent cancellation without board requests',()=>fixture(async f=>{
 await sessionStart(api,'codex',event);
 const network=spyOn(globalThis,'fetch').mockImplementation((async()=>{throw Error('unexpected network');}) as unknown as typeof fetch);
 try{
  expect(await waitForStartupRegistration(api,sessionId,{timeoutMs:20})).toBe(false);
  await boardCommand('watch',api,{session:sessionId,'timeout-ms':20},()=>{});
  const controller=new AbortController(),waiting=waitForStartupRegistration(api,sessionId,{timeoutMs:0,signal:controller.signal});
  controller.abort();await expect(waiting).rejects.toMatchObject({name:'AbortError'});
  const changed=waitForStartupRegistration(api,sessionId,{timeoutMs:1000});
  f.writeConfig({...f.config,installationId:'revoked'});
  await expect(changed).rejects.toMatchObject({code:'STARTUP_BINDING_CHANGED'});
  expect(network).not.toHaveBeenCalled();expect(f.tasks()).toHaveLength(1);
 }finally{network.mockRestore();}
 expect(participationInstructions(api)).toContain('Pending is not failure: do not manually register again');
}));

test('only one normal listener may wait for the same pending native session',()=>fixture(async()=>{
 await sessionStart(api,'codex',event);
 const first=boardCommand('watch',api,{session:sessionId,'timeout-ms':150},()=>{});
 await new Promise(resolve=>setTimeout(resolve,10));
 await expect(boardCommand('watch',api,{session:sessionId,'timeout-ms':150},()=>{})).rejects.toMatchObject({code:'SESSION_BUSY'});
 await first;
}));

for(const held of [true,false])test(`pending registration fails truthfully when its task is ${held?'held':'missing'}`,()=>fixture(async f=>{
 await sessionStart(api,'codex',event);const task=f.tasks()[0]!,path=join(f.inbox,'startup-'+task.id+'.json'),before=readFileSync(path,'utf8');
 expect(await waitForStartupRegistration(api,sessionId,{timeoutMs:10})).toBe(false);
 const waiting=waitForStartupRegistration(api,sessionId,{timeoutMs:0});
 if(held)renameSync(path,path+'.held');else rmSync(path);
 await expect(waiting).rejects.toMatchObject({code:'BOARD_STARTUP_UNAVAILABLE'});
 if(held)expect(readFileSync(path+'.held','utf8')).toBe(before);
 expect(JSON.parse(readFileSync(f.stateFile(),'utf8')).pending.id).toBe(task.id);
}));


test('selected Devin startup is local with recording off and revocation blocks worker confirmation',()=>fixture(async f=>{
 const config={...f.config,disabled:true,harnesses:[]};f.writeConfig(config);
 const request:typeof import('../src/board.ts').boardRequest=async()=>{throw Error('foreground bootstrap');};
 const network=spyOn(globalThis,'fetch').mockImplementation((async()=>{throw Error('foreground network');}) as unknown as typeof fetch);
 const auth=spyOn(session,'accessToken').mockImplementation(async()=>{throw Error('foreground auth');});
 const configured=spyOn(identity,'configuredToken').mockImplementation(async()=>{throw Error('foreground identity');});
 const ensure=spyOn(service,'ensureCaptureDaemon').mockImplementation(async()=>{throw Error('foreground service launch');});
 const selected={...f.setup,selections:{...f.setup.selections,plugins:{...f.setup.selections.plugins,devin:true}}};
 try{
  // A recognized harness is not permission to enqueue it.
  expect((await sessionStart(api,'devin',event,request)).hookSpecificOutput.additionalContext).not.toContain('background registration pending');expect(f.tasks()).toHaveLength(0);
  f.writeSetup(selected);
  for(const changed of [{source:'compact'},{source:'fork'},{hook_event_name:'Stop'}])expect((await sessionStart(api,'devin',{...event,...changed},request)).hookSpecificOutput.additionalContext).not.toContain('background registration pending');
  f.writeConfig({...config,installationId:'foreign-installation'});
  expect((await sessionStart(api,'devin',event,request)).hookSpecificOutput.additionalContext).not.toContain('background registration pending');expect(f.tasks()).toHaveLength(0);f.writeConfig(config);
  for(const source of ['startup','resume']){
   const output=(await sessionStart(api,'devin',{...event,source,requester:{email:'untrusted'},tool_output:'never persist'},request)).hookSpecificOutput.additionalContext;
   expect(output).toContain('background registration pending');expect(output).toContain(retrievalInstruction);expect(output).toContain('does not prove first-turn capture');
  }
  expect(f.tasks()).toHaveLength(1);expect(JSON.stringify(f.tasks())).not.toContain('untrusted');expect(JSON.stringify(f.tasks())).not.toContain('never persist');
  for(const spy of [network,auth,configured,ensure])expect(spy).not.toHaveBeenCalled();
 }finally{network.mockRestore();auth.mockRestore();configured.mockRestore();ensure.mockRestore();}
 const task=f.tasks()[0]!,paths:string[]=[];
 f.writeSetup(f.setup);
 await expect(processSessionStartTask(config,task,receiver(f,path=>paths.push(path)))).rejects.toMatchObject({code:'STARTUP_BINDING_CHANGED'});expect(paths).toEqual([]);
 f.writeSetup(selected);await processSessionStartTask(config,task,receiver(f,path=>paths.push(path)));
 expect(paths).toEqual(['/api/cli/me','/api/board/bootstrap']);expect(startupObservation(api,'devin',sessionId)?.registration.session).toBe(sessionId);
}));
