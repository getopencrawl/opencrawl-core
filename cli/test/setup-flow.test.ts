import {profileSetupCommand} from '../src/setup/invocation.ts';
import {sessionStart} from '../src/session-start.ts';
import {test,expect} from 'bun:test';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,readFileSync,readdirSync,realpathSync,statSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {publishSetup,type SetupServerStatus} from '../src/setup/api.ts';
import {type CodexHookReview} from '../src/capture/codex-hooks.ts';
import {setupCommand as realSetupCommand,formatSetupOutput,formatSetupCommand} from '../src/setup/command.ts';
import {readSetupState,updateSetupState,historyBenefit,type SetupState} from '../src/setup/state.ts';
import {readCaptureConfig,captureDir,captureTranscript} from '../src/capture/runtime.ts';
import {uninstallCapture} from '../src/capture/install.ts';
import {atomicJson,withSessionLock} from '../src/session.ts';
import {hash} from '../src/capture/parse.ts';
import {validTranscriptIdentity} from '../src/capture/transcript-checkpoint.ts';
import {applySelectionKey,type SelectionCursor} from '../src/setup/select.ts';
import {installSetupPlugins,setupPluginIdentity} from '../src/setup/plugins.ts';
import type {SelectionScreen} from '../src/setup/select.ts';
const setupCommand=(action:string,api:string,values:Parameters<typeof realSetupCommand>[2],dependencies:NonNullable<Parameters<typeof realSetupCommand>[3]>={})=>realSetupCommand(action,api,values,{platform:'darwin',daemonReady:async()=>true,installDaemon:async()=>({kind:'launchd',status:'installed',supervised:true,label:'fixture',path:'fixture'}),...dependencies});
type ClientStatus=SetupServerStatus['installations'][number]['clients'][number];
async function fixture(run:(api:string,dir:string,observations:unknown[],setCodex:(patch:Partial<ClientStatus>)=>void,calls:string[])=>Promise<void>,pluginStateSupported=false){
 const dir=mkdtempSync(join(tmpdir(),'opencrawl-setup-flow-')),saved={...process.env},observations:unknown[]=[],calls:string[]=[];let installations:SetupServerStatus['installations']=[],codexPatch:Partial<ClientStatus>={};
 const server=createServer(async(req,res)=>{
  calls.push(req.url??'');
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
  let data:unknown;
  if(req.url==='/api/setup')data={schemaVersion:1,scope:{tenantId:'tenant',userId:'user'},...(pluginStateSupported?{pluginStateSupported:true}:{}),firstWin:null,installations:installations.map(row=>({...row,clients:row.clients.map(client=>client.client==='codex'?{...client,...codexPatch}:client)}))};
  else if(req.url==='/api/setup/installation'){observations.push(body);installations=[{...body,clients:body.clients.map((client:Record<string,unknown>)=>({...client,humanTasks:[]}))}];data=installations[0];}
  else if(req.url==='/api/sessions/identity')data={principal:{tenantId:'tenant',userId:'user'},capabilities:{harnesses:['claude-code','codex','cursor','antigravity']}};
  else {res.writeHead(404);res.end();return;}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({schemaVersion:1,data}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const api='http://127.0.0.1:'+(server.address() as {port:number}).port;
 try{
  Object.assign(process.env,{HOME:dir,USERPROFILE:dir,PATH:dir,OPENCRAWL_CONFIG_HOME:join(dir,'config'),OPENCRAWL_API_URL:api,OPENCRAWL_TOKEN:'fixture-access-token-0123456789',OPENCRAWL_SESSIONS_TOKEN:'fixture-upload-token-0123456789',CLAUDE_DESKTOP_CONFIG_DIR:join(dir,'desktop'),CLAUDE_CONFIG_DIR:join(dir,'claude'),CODEX_HOME:join(dir,'codex'),CURSOR_CONFIG_DIR:join(dir,'cursor'),ANTIGRAVITY_HOME:join(dir,'agy')});
  const file=join(dir,'codex','sessions','one.jsonl');mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id:'one',source:'cli'}})+'\n'+JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:'approved historical content'}})+'\n');
  await run(api,dir,observations,patch=>{codexPatch=patch;},calls);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);rmSync(dir,{recursive:true,force:true});}
}
test('keyboard selection keeps recording dependent on plugins and permits search-only plugins',()=>{
 let state:SelectionCursor={index:0,column:0,items:[{id:'codex',label:'Codex',selected:true,secondary:false},{id:'cursor',label:'Cursor',selected:true,secondary:true}]};
 state=applySelectionKey(state,'n');expect(state.items.map(item=>item.selected)).toEqual([false,false]);expect(state.items.map(item=>item.secondary)).toEqual([false,false]);
 state=applySelectionKey(state,'right');state=applySelectionKey(state,'space');expect(state.items[0]).toMatchObject({selected:true,secondary:true});
 state=applySelectionKey(state,'down');state=applySelectionKey(state,'space');expect(state.items[1]).toMatchObject({selected:true,secondary:true});
 state=applySelectionKey(state,'space');expect(state.items[1]).toMatchObject({selected:true,secondary:false});
 state=applySelectionKey(state,'left');state=applySelectionKey(state,'n');expect(state.items.every(item=>!item.selected&&!item.secondary)).toBe(true);
 state=applySelectionKey(state,'a');expect(state.items.every(item=>item.selected&&!item.secondary)).toBe(true);
});
test('structured plan has no enrollment effects; apply requires explicit consent and unchanged history snapshot',async()=>fixture(async(api,dir,observations)=>{
 const plan=await setupCommand('run',api,{json:true});expect(plan).toMatchObject({status:'confirmation_required',historyBenefit});expect(observations).toHaveLength(0);expect(readCaptureConfig()).toBeNull();expect(existsSync(join(dir,'config','setup'))).toBe(false);
 await expect(setupCommand('apply',api,{yes:true})).rejects.toMatchObject({code:'SETUP_CONFIRMATION_REQUIRED'});expect(readCaptureConfig()).toBeNull();
 await expect(setupCommand('apply',api,{yes:true,'plan-id':'changed'})).rejects.toMatchObject({code:'SETUP_PLAN_CHANGED'});expect(observations).toHaveLength(0);
}));
test('two interactive screens install plugins first and queue approved history only after the second confirmation',async()=>fixture(async(api,dir,observations)=>{
 const steps:string[]=[],screens:SelectionScreen[]=[],launched:SetupState[]=[];
 const result=await setupCommand('run',api,{}, {interactive:true,choose:async screen=>{
  screens.push(screen);steps.push('choose:'+screens.length);
  if(screens.length===1){expect(readSetupState({api,tenantId:'tenant',userId:'user'})).toBeNull();return screen.items.map(item=>({...item,selected:item.id==='codex',secondary:item.id==='codex'}));}
  expect(steps).toEqual(['choose:1','install','choose:2']);expect(launched).toHaveLength(0);expect(readSetupState({api,tenantId:'tenant',userId:'user'})?.historyJob).toBeUndefined();expect(screen.description.split('\n')[0]).toBe(historyBenefit);expect(screen.items.find(item=>item.id==='codex')?.selected).toBe(true);return screen.items;
 },installPlugins:async(_api,selected,options)=>{steps.push('install');expect(selected).toEqual(['codex']);expect(readCaptureConfig()).toMatchObject({hookOwnership:'plugin',harnesses:['codex']});expect(readCaptureConfig()?.command).toEqual(options?.command);return {results:[{client:'codex',status:'installed'}],humanTasks:[]};},launchHistory:state=>{steps.push('history');launched.push(state);return {state:'queued',jobId:state.historyJob?.id};}});
 expect(steps).toEqual(['choose:1','install','choose:2','history']);expect(observations).toHaveLength(2);expect(launched[0].historyJob?.files).toHaveLength(1);expect(launched[0].selections.forward.codex).toBe(true);expect(formatSetupOutput(result)).toContain('In your primary coding agent');
 for(const file of [join(dir,'codex','hooks.json'),join(dir,'codex','config.toml'),join(dir,'config','opencrawl','capture','runner.sh'),join(dir,'codex','skills','opencrawl','SKILL.md')])expect(existsSync(file)).toBe(false);
}));
test('cancelling history preserves the confirmed clients and never starts a new import',async()=>fixture(async(api)=>{
 let screens=0,launches=0;
 const result=await setupCommand('run',api,{}, {interactive:true,choose:async screen=>++screens===1?screen.items.map(item=>({...item,selected:item.id==='codex',secondary:false})):null,installPlugins:async()=>({results:[{client:'codex',status:'installed'}],humanTasks:[]}),launchHistory:()=>{launches++;return {state:'queued'};}});
 const state=readSetupState({api,tenantId:'tenant',userId:'user'});expect(screens).toBe(2);expect(launches).toBe(0);expect(state?.selections.plugins.codex).toBe(true);expect(state?.selections.history.codex).toBe(false);expect(state?.historyJob).toBeUndefined();expect(readCaptureConfig()?.harnesses).toEqual([]);expect(result).toMatchObject({historyDecision:'unchanged'});
}));

test('resume retries pending selected plugins without another selection screen or broader history consent',async()=>fixture(async api=>{
 let chooseCount=0,installs=0;
 const pending=await setupCommand('run',api,{}, {interactive:true,choose:async screen=>{chooseCount++;return screen.items.map(item=>({...item,selected:chooseCount===1&&item.id==='codex',secondary:false}));},installPlugins:async()=>({results:[{client:'codex',status:'pending'}],humanTasks:[{id:'codex-install',kind:'plugin_install',client:'codex',title:'Install Codex',instruction:'Install Codex, then run setup resume.'}]}),launchHistory:()=>({state:'not_started'})});
 expect(pending).toMatchObject({status:'needs_attention'});const before=readSetupState({api,tenantId:'tenant',userId:'user'});
 const resumed=await setupCommand('resume',api,{json:true},{choose:async()=>{throw new Error('Unexpected questionnaire');},installPlugins:async(_api,selected)=>{installs++;expect(selected).toEqual(['codex']);return {results:[{client:'codex',status:'installed'}],humanTasks:[]};},launchHistory:()=>({state:'not_started'})});
 expect(installs).toBe(1);expect(resumed).toMatchObject({status:'configured'});expect(readSetupState({api,tenantId:'tenant',userId:'user'})?.selections.history).toEqual(before?.selections.history);expect(readSetupState({api,tenantId:'tenant',userId:'user'})?.historyJob).toBeUndefined();
}));
test('an existing client retains native reload tasks on resume',async()=>fixture(async api=>{
 await setupCommand('apply',api,{yes:true,plugins:'codex',forward:'none',history:'none'},{installPlugins:async()=>({results:[{client:'codex',status:'installed'}],humanTasks:[]}),launchHistory:()=>({state:'not_started'})});
 await updateSetupState({api,tenantId:'tenant',userId:'user'},state=>({...state!,selections:{plugins:{cursor:true},forward:{cursor:false},history:{cursor:false}}}));
 const result=await setupCommand('resume',api,{json:true},{installPlugins:async()=>({results:[{client:'cursor',status:'installed'}],humanTasks:[{id:'cursor-reload',kind:'restart',client:'cursor',title:'Reload Cursor',instruction:'Reload Cursor to load the installed local plugin.'}]}),launchHistory:()=>({state:'not_started'})});
 expect(result).toMatchObject({humanTasks:[{id:'cursor-reload',kind:'restart'}]});
 const status=await setupCommand('status',api,{json:true});expect(status).toMatchObject({humanTasks:[{id:'cursor-reload'}]});
}));


test('setup observations request native hook trust only for clients with a trust gate',()=>fixture(async(api,_dir,observations)=>{
 const selected=Object.fromEntries(['claude-code','codex','cursor','antigravity'].map(client=>[client,true]));
 await publishSetup({schemaVersion:1,scope:{api,tenantId:'tenant',userId:'user'},installationId:'fixture-installation',machine:{id:'fixture-machine',label:'fixture'},acceptedAt:new Date().toISOString(),selections:{plugins:selected,forward:selected,history:{}}});
 const clients=(observations[0] as {clients:{client:string;hookTrust:string}[]}).clients;
 expect(Object.fromEntries(clients.map(client=>[client.client,client.hookTrust]))).toEqual({'claude-code':'not_required',codex:'pending',cursor:'not_required',antigravity:'not_required'});
}));

test('publishing preserves prepared and failed plugin states only when the server supports them',async()=>{
 for(const supported of [false,true])await fixture(async(api,_dir,observations)=>{
  const selected={'claude-code':true,codex:true,cursor:true,antigravity:true,'grok-bot':false};
  await publishSetup({schemaVersion:1,scope:{api,tenantId:'tenant',userId:'user'},installationId:'fixture-installation',machine:{id:'fixture-machine',label:'fixture'},acceptedAt:new Date().toISOString(),selections:{plugins:selected,forward:{},history:{}},pluginResults:[{client:'claude-code',status:'pending'},{client:'codex',status:'unchanged'},{client:'cursor',status:'prepared'},{client:'antigravity',status:'error'}]});
  const clients=(observations[0] as {clients:{client:string;installed:boolean;pluginState?:string}[]}).clients;
  expect(Object.fromEntries(clients.map(client=>[client.client,client.installed]))).toEqual({'claude-code':false,codex:true,cursor:false,antigravity:false,'grok-bot':false});
  if(supported)expect(Object.fromEntries(clients.map(client=>[client.client,client.pluginState]))).toEqual({'claude-code':'pending',codex:'installed',cursor:'prepared',antigravity:'error','grok-bot':'not_selected'});
  else expect(clients.every(client=>!Object.hasOwn(client,'pluginState'))).toBe(true);
 },supported);
});

const nativeUnknown=async():Promise<CodexHookReview>=>({state:'unknown',total:8,pending:null,disabled:null});
const nativeDisabled=async():Promise<CodexHookReview>=>({state:'observed',total:8,pending:0,disabled:8});
const nativeChanged=async():Promise<CodexHookReview>=>({state:'observed',total:8,pending:2,disabled:1});
const setupCodex:NonNullable<Parameters<typeof setupCommand>[3]>={installPlugins:async()=>({results:[{client:'codex',status:'installed'}],humanTasks:[]}),launchHistory:()=>({state:'not_started'}),inspectHooks:nativeUnknown};

test('captured or verified Codex setup stays quiet when native inspection is unavailable or hooks are intentionally disabled',async()=>fixture(async(api,_dir,_observations,setCodex)=>{
 await setupCommand('apply',api,{yes:true,plugins:'codex',forward:'codex',history:'none'},setupCodex);
 for(const evidence of [{captureObservedAt:new Date().toISOString()}, {proof:{state:'verified'}}]){
  setCodex({...evidence,humanTasks:[]});
  for(const inspectHooks of [nativeUnknown,nativeDisabled])for(const action of ['status','resume']){
   const result=await setupCommand(action,api,{json:true},{...setupCodex,inspectHooks});
   expect(result).toMatchObject({humanTasks:[]});
  }
 }
}));

test('a search-only Codex plugin never adds capture trust, including stale server tasks and unrelated startup hooks',async()=>fixture(async(api,dir,_observations,setCodex)=>{
 writeFileSync(join(dir,'codex','hooks.json'),JSON.stringify({hooks:{SessionStart:[{hooks:[{type:'command',command:'echo unused fixture',statusMessage:'OpenCrawl session startup'}]}]}}));
 let inspections=0;const inspectHooks=async():Promise<CodexHookReview>=>{inspections++;return {state:'observed',total:1,pending:1,disabled:0};};
 await setupCommand('apply',api,{yes:true,plugins:'codex',forward:'none',history:'none'},{...setupCodex,inspectHooks});
 setCodex({humanTasks:[{id:'stale-capture-trust',kind:'hook_trust',client:'codex',title:'Old recording choice',instruction:'Stale task'}, {id:'mcp-auth',kind:'mcp_auth',client:'codex',title:'Connect MCP',instruction:'Complete native sign-in'}]});
 for(const action of ['status','resume']){
  const result=await setupCommand(action,api,{json:true},{...setupCodex,inspectHooks});
  expect(result).toMatchObject({humanTasks:[{id:'mcp-auth'}],selections:{forward:{codex:false}}});
 }
 expect(inspections).toBe(0);
}));

test('a local recording opt-out suppresses capture trust before saved setup choices are refreshed',async()=>fixture(async(api,_dir,_observations,setCodex)=>{
 await setupCommand('apply',api,{yes:true,plugins:'codex',forward:'codex',history:'none'},setupCodex);
 const path=join(captureDir(),'config.json'),config=JSON.parse(readFileSync(path,'utf8'));writeFileSync(path,JSON.stringify({...config,disabled:true}));
 setCodex({humanTasks:[{id:'stale-capture-trust',kind:'hook_trust',client:'codex',title:'Old recording choice',instruction:'Stale task'}]});
 const inspectHooks=async():Promise<CodexHookReview>=>{throw new Error('Recording opt-out must not inspect native hooks');};
 expect(await setupCommand('status',api,{json:true},{...setupCodex,inspectHooks})).toMatchObject({humanTasks:[]});
 expect(await setupCommand('resume',api,{json:true},{...setupCodex,inspectHooks})).toMatchObject({humanTasks:[],selections:{forward:{codex:false}}});
}));

test('positively observed changed hooks still require review after a previous capture proof',async()=>fixture(async(api,_dir,_observations,setCodex)=>{
 await setupCommand('apply',api,{yes:true,plugins:'codex',forward:'codex',history:'none'},setupCodex);
 setCodex({captureObservedAt:new Date().toISOString(),proof:{state:'verified'},humanTasks:[]});
 for(const action of ['status','resume']){
  const result=await setupCommand(action,api,{json:true},{...setupCodex,inspectHooks:nativeChanged});
  expect(result).toMatchObject({humanTasks:[{id:'codex-hook-review',kind:'hook_trust',client:'codex'}]});
  const instruction=(result as {humanTasks:{instruction:string}[]}).humanTasks[0].instruction;
  expect(instruction).toContain('Codex will not run 2 OpenCrawl hooks');
  expect(instruction).toContain('keep intentional opt-outs');
 }
}));

test('an older installation proof cannot suppress review for a replacement local installation',async()=>fixture(async(api,_dir,_observations,setCodex)=>{
 await setupCommand('apply',api,{yes:true,plugins:'codex',forward:'codex',history:'none'},setupCodex);
 setCodex({captureObservedAt:new Date().toISOString(),proof:{state:'verified'},humanTasks:[]});
 const path=join(captureDir(),'config.json'),config=JSON.parse(readFileSync(path,'utf8'));writeFileSync(path,JSON.stringify({...config,installationId:'replacement-installation'}));
 const result=await setupCommand('status',api,{json:true},setupCodex);
 expect(result).toMatchObject({humanTasks:[{id:'codex-hook-review',kind:'hook_trust',client:'codex'}]});
}));


test('setup plans, handoffs and sign-in keep the selected launcher and saved search-only choices',async()=>fixture(async(api,dir)=>{
 const command=[join(dir,"private install's bin",process.platform==='win32'?'opencrawl.cmd':'opencrawl')];
 const dependencies={...setupCodex,command};
 const plan=await setupCommand('plan',api,{plugins:'codex',forward:'none',history:'none'},dependencies) as {applyCommand:string;planId:string};
 expect(plan.applyCommand).toBe(formatSetupCommand(['setup','apply','--api',api,'--plugins','codex','--forward','none','--history','none','--plan-id',plan.planId,'--yes','--json'],command));
 const applied=await setupCommand('apply',api,{yes:true,plugins:'codex',forward:'none',history:'none'},dependencies);
 for(const result of [applied,await setupCommand('resume',api,{json:true},dependencies)]){
  if(!result||!('agentPrompt' in result)||!('nextStep' in result))throw Error('Expected an agent handoff');
  const handoff=result;
  expect(handoff.agentPrompt).toContain('in this conversation');
  expect(handoff.agentPrompt).toContain('Use `'+formatSetupCommand([],profileSetupCommand(command,join(dir,'config')))+'` for every OpenCrawl command');
  expect(handoff.agentPrompt).toContain('Start with `'+formatSetupCommand(['setup','status','--local','--api',api,'--json'],profileSetupCommand(command,join(dir,'config')))+'`');
  expect(handoff.agentPrompt).toContain('recording off (forward=false)');
  expect(handoff.agentPrompt).toContain('without requiring a new session capture');
  expect(handoff.nextStep).toContain(formatSetupCommand(['setup','status','--local','--api',api,'--json'],profileSetupCommand(command,join(dir,'config'))));
 }
 delete process.env.OPENCRAWL_TOKEN;
 const login=await setupCommand('run',api,{json:true},{command,interactive:false}) as {humanTasks:{instruction:string}[]};
 expect(login.humanTasks[0].instruction).toContain(formatSetupCommand(['login','--api',api],command));
 expect(login.humanTasks[0].instruction).toContain(formatSetupCommand(['setup','--api',api,'--json'],command));
}));

test('prepared plugin handoff reconciles only selected activations with ready supervision',async()=>{
 for(const scenario of ['prepared','already-active','unselected','worker-pending'] as const)await fixture(async(api,dir,observations)=>{
  const command=[join(dir,"private install's bin",process.platform==='win32'?'opencrawl.cmd':'opencrawl')];
  let status:'prepared'|'unchanged'=scenario==='already-active'?'unchanged':'prepared',installs=0;
  const client=scenario==='unselected'?'claude-code' as const:'codex' as const;
  const dependencies={...setupCodex,command,installPlugins:async()=>{installs++;return {results:[{client,status}],humanTasks:[]};},...(scenario==='worker-pending'?{installDaemon:async()=>({kind:'external',status:'required',supervised:false,command:['/owned/worker'],reason:'No systemd user manager'})}:{})};
  const applied=await setupCommand('apply',api,{yes:true,plugins:'codex',forward:'none',history:'none'},dependencies);
  if(!applied||!('agentPrompt' in applied))throw Error('Expected an agent handoff');
  const resumeCommand=formatSetupCommand(['setup','resume','--api',api,'--json'],profileSetupCommand(command,join(dir,'config')));
  expect(applied.agentPrompt.includes('`'+resumeCommand+'` once')).toBe(scenario==='prepared');
  expect(installs).toBe(1);
  const saved=readSetupState({api,tenantId:'tenant',userId:'user'});
  expect(saved?.selections).toMatchObject({plugins:{codex:true,'claude-code':false},forward:{codex:false},history:{codex:false}});
  expect(readCaptureConfig()?.harnesses).toEqual([]);
  if(scenario==='prepared'){
   expect(applied.agentPrompt).toContain("After this plugin's native startup or reload has run");
   expect(applied.agentPrompt).toContain('CLI network access is normally authorized');
   expect(applied.agentPrompt).toContain('If access is denied or unavailable, leave installation pending');
   expect(applied.agentPrompt).toContain('do not repeat requests or bypass permissions');
   const before=observations.at(-1) as {clients:{client:string;installed:boolean;pluginState?:string}[]};
   expect(before.clients.find(row=>row.client==='codex')).toMatchObject({installed:false,pluginState:'prepared'});
   // A handoff is not activation: only the normal explicit resume publishes the new observation.
   status='unchanged';
   const resumed=await setupCommand('resume',api,{json:true},{...dependencies,choose:async()=>{throw Error('Unexpected questionnaire');}});
   if(!resumed||!('agentPrompt' in resumed))throw Error('Expected an agent handoff');
   expect(resumed.agentPrompt).not.toContain('`'+resumeCommand+'` once');
   expect(installs).toBe(2);
   const after=observations.at(-1) as {clients:{client:string;installed:boolean;pluginState?:string}[]};
   expect(after.clients.find(row=>row.client==='codex')).toMatchObject({installed:true,pluginState:'installed'});
   expect(readSetupState({api,tenantId:'tenant',userId:'user'})?.selections).toEqual(saved?.selections);
   expect(readSetupState({api,tenantId:'tenant',userId:'user'})?.historyJob).toEqual(saved?.historyJob);
  }
 },true);
});

test('explicit recording without its plugin fails before any setup mutation',()=>fixture(async(api,dir,observations)=>{
 let installed=false;
 await expect(setupCommand('apply',api,{yes:true,plugins:'none',forward:'codex',history:'codex'},{installPlugins:async()=>{installed=true;return {results:[],humanTasks:[]};}})).rejects.toMatchObject({code:'SETUP_PLUGIN_REQUIRED'});
 expect(installed).toBe(false);expect(readCaptureConfig()).toBeNull();expect(readSetupState({api,tenantId:'tenant',userId:'user'})).toBeNull();expect(observations).toHaveLength(0);
}));

test('prepared native load guidance survives independent MCP or capture proof',()=>fixture(async(api,_dir,_observations,setCodex)=>{
 const dependencies={...setupCodex,installPlugins:async()=>({results:[{client:'codex' as const,status:'prepared' as const}],humanTasks:[{id:'codex-load',kind:'restart' as const,client:'codex' as const,title:'Load native plugin',instruction:'Review native plugin trust and reload.'}]})};
 await setupCommand('apply',api,{yes:true,plugins:'codex',forward:'none',history:'none'},dependencies);
 setCodex({mcp:{state:'authenticated'},proof:{state:'verified'},captureObservedAt:new Date().toISOString()});
 for(const action of ['status','resume'])expect(await setupCommand(action,api,{json:true},dependencies)).toMatchObject({humanTasks:[{id:'codex-load',kind:'restart'}],selections:{forward:{codex:false}}});
}));

test('resume rechecks previously installed native plugins and a new launcher without expanding saved choices or history',()=>fixture(async(api,dir)=>{
 const first=[join(dir,'first-cli')],next=[join(dir,'new-cli')];
 await setupCommand('apply',api,{yes:true,plugins:'codex',forward:'none',history:'codex'},{...setupCodex,command:first});const before=readSetupState({api,tenantId:'tenant',userId:'user'})!;
 let calls=0;
 const result=await setupCommand('resume',api,{json:true},{...setupCodex,command:next,choose:async()=>{throw new Error('No new questionnaire');},installPlugins:async(_api,selected,options)=>{calls++;expect(selected).toEqual(['codex']);expect(options?.command).toEqual(next);return {results:[{client:'codex',status:'prepared'}],humanTasks:[{id:'new-bundle-load',kind:'restart',client:'codex',title:'Load the current plugin',instruction:'Reload the native client.'}]};}});
 expect(calls).toBe(1);expect(result).toMatchObject({status:'needs_attention',humanTasks:[{id:'new-bundle-load'}]});
 const after=readSetupState({api,tenantId:'tenant',userId:'user'})!;expect(after.selections).toEqual(before.selections);expect(after.historyJob).toEqual(before.historyJob);expect(readCaptureConfig()?.command).toEqual(next);
}));


test('native hook status respects effective recording opt-outs without inspecting or authenticating',()=>fixture(async api=>{
 await setupCommand('apply',api,{yes:true,plugins:'codex',forward:'none',history:'none'},setupCodex);
 const savedFetch=globalThis.fetch;globalThis.fetch=Object.assign(()=>{throw new Error('Hook status must not access the server');},{preconnect:()=>{throw new Error('Hook status must not preconnect');}});
 try{
  expect(await setupCommand('hooks',api,{json:true},{inspectHooks:async()=>{throw new Error('Do not inspect opted-out capture');}})).toMatchObject({status:'hook_status',recordingSelected:false,review:{state:'not_applicable',pending:0}});
 }finally{globalThis.fetch=savedFetch;}
}));

test('native hook status fails closed when installation or selections change during inspection',()=>fixture(async api=>{
 await setupCommand('apply',api,{yes:true,plugins:'codex',forward:'codex',history:'none'},setupCodex);
 const config=readCaptureConfig()!,file=join(process.env.OPENCRAWL_CONFIG_HOME!,'opencrawl','capture','config.json');
 const savedFetch=globalThis.fetch;globalThis.fetch=Object.assign(()=>{throw new Error('Hook status must not access the server');},{preconnect:()=>{throw new Error('Hook status must not preconnect');}});
 try{
  await expect(setupCommand('hooks',api,{json:true},{inspectHooks:async root=>{
   expect(root).toBe(config.roots.codex);writeFileSync(file,JSON.stringify({...config,installationId:'changed-during-inspection'}));
   return {state:'observed',total:8,pending:0,disabled:0};
  }})).rejects.toMatchObject({code:'SETUP_SCOPE_CHANGED'});
 }finally{globalThis.fetch=savedFetch;}
}));


test('native setup inspection cannot inherit trusted legacy global hooks for a plugin enrollment',()=>fixture(async api=>{
 await setupCommand('apply',api,{yes:true,plugins:'codex',forward:'codex',history:'none'},setupCodex);
 const config=readCaptureConfig()!,file=join(process.env.OPENCRAWL_CONFIG_HOME!,'opencrawl','capture','config.json');
 writeFileSync(file,JSON.stringify({...config,hookOwnership:'global'}));
 expect(await setupCommand('hooks',api,{json:true},{inspectHooks:async()=>{throw new Error('Legacy global trust is not plugin trust');}})).toMatchObject({recordingSelected:true,review:{state:'unknown',total:0,pending:null,disabled:null}});
}));


test('setup starts only the implemented worker after plugin files are ready and reports its real supervision',async()=>fixture(async(api,_dir,observations)=>{
 const order:string[]=[];
 const result=await setupCommand('apply',api,{yes:true,plugins:'claude-code,codex',forward:'claude-code,codex',history:'none'},{
  inspectHooks:nativeUnknown,launchHistory:()=>({state:'not_started'}),
  installPlugins:async()=>{order.push('plugins');expect(readCaptureConfig()).toMatchObject({daemonRequested:{backgroundStartup:true},backgroundStartup:false,hookOwnership:'plugin',harnesses:['claude-code','codex']});return {results:[{client:'claude-code',status:'prepared'},{client:'codex',status:'prepared'}],humanTasks:[]};},
  installDaemon:async config=>{order.push('daemon');expect(config.harnesses).toEqual(['claude-code','codex']);return {kind:'process',status:'requested',supervised:false,command:[]};}
 });
 expect(order).toEqual(['plugins','daemon']);expect(result).toMatchObject({worker:{kind:'fallback',supervised:false,harnesses:['claude-code','codex']}});
 expect(observations).toHaveLength(2);expect(readCaptureConfig()?.historyHarnesses).toEqual([]);
}));

test('one pending plugin does not block another plugin worker in an existing plugin-owned profile',async()=>fixture(async api=>{
 for(const stalledStatus of ['pending','error'] as const){
  let launches=0;
  const result=await setupCommand('apply',api,{yes:true,plugins:'claude-code,codex',forward:'claude-code,codex',history:'none'},{
   inspectHooks:nativeUnknown,launchHistory:()=>({state:'not_started'}),
   installPlugins:async()=>({results:[{client:'claude-code',status:'prepared'},{client:'codex',status:stalledStatus}],humanTasks:[]}),
   installDaemon:async config=>{launches++;expect(config).toMatchObject({hookOwnership:'plugin',harnesses:['claude-code','codex']});return {kind:'systemd',status:'installed',supervised:true,label:'fixture',path:'fixture'};}
  });
  expect(launches).toBe(1);expect(result).toMatchObject({status:'needs_attention',worker:{readiness:'configured',startup:true}});
  const saved=readSetupState({api,tenantId:'tenant',userId:'user'})!;
  expect(saved.selections.forward).toMatchObject({'claude-code':true,codex:true});expect(saved.selections.history.codex).toBe(false);
  expect(saved.pluginResults).toContainEqual({client:'codex',status:stalledStatus});
 }
}));

test('pending plugins defer the service while selected search plugins enable only their supported lanes',async()=>fixture(async api=>{
 let launches=0;
 const dependencies={inspectHooks:nativeUnknown,launchHistory:()=>({state:'not_started'}),installDaemon:async()=>{launches++;return {kind:'process',status:'requested',supervised:false,command:[]};}};
 await setupCommand('apply',api,{yes:true,plugins:'claude-code',forward:'claude-code',history:'none'},{...dependencies,installPlugins:async()=>({results:[{client:'claude-code',status:'pending'}],humanTasks:[]})});
 expect(launches).toBe(0);
 for(const choice of [{plugins:'codex',forward:'codex'}, {plugins:'claude-code',forward:'none'}] as const){
  const result=await setupCommand('apply',api,{yes:true,plugins:choice.plugins,forward:choice.forward,history:'none'},{...dependencies,installPlugins:async()=>({results:[{client:choice.plugins,status:'prepared'}],humanTasks:[]})});
  expect(result).toMatchObject({worker:{startup:false,harnesses:choice.forward==='codex'?['codex']:[]}});
 }
 expect(launches).toBe(2);
}));

test('explicit uninstall stops both lanes and resume restores only selected startup while preserving queues',async()=>fixture(async(api,dir)=>{
 const dependencies={inspectHooks:nativeUnknown,installPlugins:async()=>({results:[{client:'claude-code' as const,status:'prepared' as const}],humanTasks:[]}),launchHistory:()=>({state:'not_started'})};
 await setupCommand('apply',api,{yes:true,plugins:'claude-code',forward:'claude-code',history:'none'},dependencies);
 const scope={api,tenantId:'tenant',userId:'user'},before=readSetupState(scope)!;
 const queue=join(captureDir(),'queue','retained.json'),task=join(captureDir(),'daemon','inbox','startup-retained.json');mkdirSync(join(task,'..'),{recursive:true});writeFileSync(queue,'retained queue');writeFileSync(task,'retained task');
 const stopped=await uninstallCapture(dir);expect(stopped).toMatchObject({backgroundStartupStopped:true,queuedDataPreserved:true});
 expect(readCaptureConfig()).toMatchObject({disabled:true,backgroundStartup:false});expect(readSetupState(scope)?.selections).toEqual(before.selections);
 let launches=0;const result=await setupCommand('resume',api,{json:true},{...dependencies,installDaemon:async config=>{launches++;expect(config).toMatchObject({disabled:true,backgroundStartup:true,harnesses:[]});return {kind:'process',status:'requested',supervised:false,command:[]};}});
 expect(launches).toBe(1);expect(result).toMatchObject({worker:{startup:true,harnesses:[]}});
 expect(readSetupState(scope)?.selections.plugins).toEqual(before.selections.plugins);expect(readSetupState(scope)?.selections.history).toEqual(before.selections.history);
 expect(readFileSync(queue,'utf8')).toBe('retained queue');expect(readFileSync(task,'utf8')).toBe('retained task');
}));

test('fresh service failure retains legacy capture and explicit registration recovery, then resume activates the same installation',async()=>fixture(async(api,_dir,observations)=>{
 const options={installPlugins:async()=>({results:[{client:'claude-code' as const,status:'prepared' as const}],humanTasks:[]}),launchHistory:()=>({state:'not_started'})};
 const failed=await setupCommand('apply',api,{yes:true,plugins:'claude-code',forward:'claude-code',history:'none'},{...options,installDaemon:async()=>{throw Error('synthetic supervisor refusal');}});
 expect(failed).toMatchObject({status:'needs_attention',worker:{kind:'fallback',supervised:false,startup:false}});
 const before=readCaptureConfig()!;expect(before.captureWorker).toBeUndefined();expect(before).toMatchObject({harnesses:['claude-code'],historyHarnesses:[],backgroundStartup:false,daemonRequested:{backgroundStartup:true}});
 const startup=await sessionStart(api,'claude-code',{session_id:'fallback-session',hook_event_name:'SessionStart',source:'startup'},async()=>{throw Error('Fallback hook must not make network calls');});
 expect(JSON.stringify(startup)).toContain('register this session');expect(JSON.stringify(startup)).not.toContain('background registration is pending');
 const saved=readSetupState({api,tenantId:'tenant',userId:'user'})!;
 const resumed=await setupCommand('resume',api,{json:true},options);
 expect(resumed).toMatchObject({worker:{supervised:true,startup:true}});
 expect(readCaptureConfig()).toMatchObject({installationId:before.installationId,owner:before.owner,harnesses:before.harnesses,historyHarnesses:[],captureWorker:'daemon-v1',backgroundStartup:true});
 expect(readCaptureConfig()?.daemonRequested).toBeUndefined();expect(readSetupState(saved.scope)?.selections).toEqual(saved.selections);
}));

test('missing Linux user supervision retains fallback and retries saved choices without importing history',async()=>fixture(async api=>{
 const dependencies={inspectHooks:async()=>({state:'observed',total:8,pending:0,disabled:0} as CodexHookReview),installPlugins:async()=>({results:[{client:'codex' as const,status:'installed' as const}],humanTasks:[]}),installDaemon:async()=>({kind:'external',status:'required',supervised:false,command:['/owned/worker'],reason:'No systemd user manager'}),launchHistory:()=>({state:'not_started'})};
 const applied=await setupCommand('apply',api,{yes:true,plugins:'codex',forward:'codex',history:'none'},dependencies);
 expect(applied).toMatchObject({status:'needs_attention',worker:{kind:'fallback',readiness:'pending',supervised:false},humanTasks:[]});
 const saved=readSetupState({api,tenantId:'tenant',userId:'user'})!;
 expect(readCaptureConfig()?.captureWorker).toBeUndefined();
 const resumed=await setupCommand('resume',api,{json:true},dependencies);
 expect(resumed).toMatchObject({status:'needs_attention',selections:saved.selections,worker:{kind:'fallback'}});
 expect(readSetupState(saved.scope)?.historyJob).toEqual(saved.historyJob);expect(formatSetupOutput(resumed)).toContain('legacy collector');
}));

test('supervised and not-required workers allow configured setup without invented operator tasks',async()=>fixture(async(api)=>{
 for(const worker of [{kind:'systemd',status:'installed',supervised:true,label:'fixture',path:'fixture'},{kind:'not-required',supervised:false,queuedDataPreserved:true}] as const){
  const active=worker.kind!=='not-required';
  const result=await setupCommand('apply',api,{yes:true,plugins:active?'codex':'none',forward:active?'codex':'none',history:'none'},{inspectHooks:async()=>({state:'observed',total:8,pending:0,disabled:0} as CodexHookReview),launchHistory:()=>({state:'not_started'}),installPlugins:async()=>({results:active?[{client:'codex',status:'installed'}]:[],humanTasks:[]}),installDaemon:async()=>worker});
  expect(result).toMatchObject({status:'configured',humanTasks:[],worker:{kind:worker.kind,readiness:active?'configured':'not_required'}});
  expect(formatSetupOutput(result)).not.toContain('supervision is pending');expect((result as {agentPrompt:string}).agentPrompt).not.toContain('host-owned service');
 }
}));


test('new setup offers Mac Claude, Codex and Cursor and rejects deferred selections before authentication',async()=>fixture(async(api,dir,_observations,_set,calls)=>{
 mkdirSync(join(dir,'claude'));mkdirSync(join(dir,'cursor'));mkdirSync(join(dir,'agy'));
 const plan=await setupCommand('plan',api,{plugins:'all',forward:'all',history:'all'}) as {clients:{id:string}[];selections:SetupState['selections']};
 expect(plan.clients.map(row=>row.id).sort()).toEqual(['claude-code','codex','cursor']);
 expect(plan.selections.plugins).toEqual({'claude-code':true,codex:true,cursor:true});
 expect(plan.selections.forward).toEqual({'claude-code':true,codex:true,cursor:true});
 expect(plan.selections.history).toEqual({'claude-code':false,codex:true,cursor:false});
 delete process.env.OPENCRAWL_TOKEN;calls.length=0;let login=0;
 for(const values of [{plugins:'antigravity'},{forward:'antigravity'},{history:'antigravity'},{plugins:'devin'}])await expect(setupCommand('run',api,values,{interactive:true,login:async()=>{login++;}})).rejects.toMatchObject({code:'SETUP_CLIENT_NOT_AVAILABLE'});
 for(const platform of ['linux','win32'] as const)await expect(setupCommand('run',api,{}, {platform,interactive:true,login:async()=>{login++;}})).rejects.toMatchObject({code:'SETUP_NOT_AVAILABLE'});
 expect(login).toBe(0);expect(calls).toEqual([]);expect(readCaptureConfig()).toBeNull();expect(existsSync(join(dir,'config','opencrawl','setup'))).toBe(false);
}));

test('manual Cursor MCP can enroll through normal setup without replacing connections or claiming native activation',async()=>fixture(async(api,dir,observations)=>{
 const cursorRoot=join(dir,'cursor'),mcpFile=join(cursorRoot,'mcp.json');mkdirSync(cursorRoot);
 const manual=JSON.stringify({mcpServers:{opencrawl:{url:api+'/mcp'},other:{url:'https://other.example/mcp'}}},null,2)+'\n';writeFileSync(mcpFile,manual);
 const choices={plugins:'cursor',forward:'cursor',history:'none'},command=[join(dir,'opencrawl')];
 const dependencies={command,installPlugins:((target,clients,options)=>installSetupPlugins(target,clients,{...options,home:dir,which:()=>null})) as typeof installSetupPlugins};
 const plan=await setupCommand('plan',api,choices) as {planId:string};
 expect(readSetupState({api,tenantId:'tenant',userId:'user'})).toBeNull();expect(readCaptureConfig()).toBeNull();expect(observations).toHaveLength(0);
 const result=await setupCommand('apply',api,{...choices,'plan-id':plan.planId,yes:true},dependencies);
 const state=readSetupState({api,tenantId:'tenant',userId:'user'})!,plugin=join(cursorRoot,'plugins','local',setupPluginIdentity(api).name);
 expect(state.selections).toMatchObject({plugins:{cursor:true,codex:false,'claude-code':false},forward:{cursor:true,codex:false,'claude-code':false},history:{cursor:false,codex:false,'claude-code':false}});
 expect(state.historyJob).toBeUndefined();expect(readCaptureConfig()).toMatchObject({api,hookOwnership:'plugin',captureWorker:'daemon-v1',harnesses:['cursor'],command});
 expect(JSON.parse(readFileSync(join(plugin,'mcp.json'),'utf8'))).toEqual({mcpServers:{opencrawl:{url:api+'/mcp'}}});
 expect(existsSync(join(plugin,'hooks','hooks.json'))).toBe(true);expect(existsSync(join(cursorRoot,'hooks.json'))).toBe(false);
 expect(result).toMatchObject({status:'needs_attention'});expect(state.pluginResults).toEqual([expect.objectContaining({client:'cursor',status:'prepared'})]);expect(readFileSync(mcpFile,'utf8')).toBe(manual);
 await setupCommand('resume',api,{json:true},dependencies);
 expect(readSetupState(state.scope)?.installationId).toBe(state.installationId);expect(readSetupState(state.scope)?.selections).toEqual(state.selections);expect(readFileSync(mcpFile,'utf8')).toBe(manual);
}));

test('existing deferred choices and bounded completed history survive new Mac offers and off remains off',async()=>fixture(async(api,dir,_observations,_set,calls)=>{
 await setupCommand('apply',api,{yes:true,plugins:'codex',forward:'none',history:'none'},setupCodex);
 const scope={api,tenantId:'tenant',userId:'user'},now=new Date().toISOString();
 const oldFile={harness:'antigravity' as const,path:join(dir,'old-approved.json'),bytes:8,ino:1,mtimeMs:1};
 await updateSetupState(scope,state=>({...state!,selections:{plugins:{'claude-code':false,codex:true,cursor:false,antigravity:true},forward:{'claude-code':false,codex:false,cursor:false,antigravity:false},history:{'claude-code':false,codex:false,cursor:false,antigravity:true}},historyJob:{id:'approved-old-job',clients:['antigravity'],files:[oldFile],state:'complete',completedClients:['antigravity'],createdAt:now,updatedAt:now}}));
 const before=readSetupState(scope)!;calls.length=0;
 await expect(setupCommand('apply',api,{yes:true,plugins:'devin',forward:'none',history:'none'},setupCodex)).rejects.toMatchObject({code:'SETUP_CLIENT_NOT_AVAILABLE'});
 await expect(setupCommand('apply',api,{yes:true,plugins:'antigravity',forward:'antigravity',history:'none'},setupCodex)).rejects.toMatchObject({code:'SETUP_CLIENT_NOT_AVAILABLE'});
 expect(calls).toEqual([]);expect(readSetupState(scope)).toEqual(before);
 let screens=0;
 await setupCommand('run',api,{}, {...setupCodex,interactive:true,choose:async screen=>{screens++;expect(screen.items.every(row=>['claude-code','codex','cursor'].includes(row.id))).toBe(true);return screen.items;},installPlugins:async(_api,ids)=>{expect(ids).toEqual(['antigravity','codex']);return {results:[{client:'codex',status:'installed' as const},{client:'antigravity',status:'installed' as const}],humanTasks:[]};}});
 expect(screens).toBe(2);expect(readSetupState(scope)?.historyJob).toEqual(before.historyJob);expect(readSetupState(scope)?.selections).toEqual({...before.selections,plugins:{...before.selections.plugins,'claude-code':false},forward:{...before.selections.forward,'claude-code':false},history:{...before.selections.history,'claude-code':false}});
 await setupCommand('resume',api,{json:true},{...setupCodex,platform:'linux',installPlugins:async(_api,ids)=>({results:[{client:'codex',status:'installed' as const},{client:'antigravity',status:'installed' as const}],humanTasks:[]})});
 expect(readSetupState(scope)?.historyJob).toEqual(before.historyJob);
 await updateSetupState(scope,state=>({...state!,historyJob:{...state!.historyJob!,state:'paused'}}));
 const paused=readSetupState(scope)!.historyJob;
 await setupCommand('apply',api,{yes:true,plugins:'all',forward:'none',history:'all'},{...setupCodex,platform:'linux',installPlugins:async()=>({results:[{client:'codex',status:'installed'},{client:'antigravity',status:'installed'}],humanTasks:[]})});
 expect(readSetupState(scope)?.historyJob).toEqual(paused);
 const off=await setupCommand('plan',api,{plugins:'none',forward:'none',history:'none'},{platform:'linux'}) as {selections:SetupState['selections']};
 expect(Object.values(off.selections.plugins).every(v=>!v)).toBe(true);expect(Object.values(off.selections.history).every(v=>!v)).toBe(true);
}));

test('resume cannot create a first-time history approval on any platform',async()=>fixture(async(api,dir,observations)=>{
 for(const platform of ['darwin','linux','win32'] as const)await expect(setupCommand('resume',api,{yes:true,plugins:'none',forward:'none',history:'codex'},{platform,launchHistory:()=>{throw new Error('Unapproved history worker');},installPlugins:async()=>{throw new Error('Unapproved plugin install');}})).rejects.toMatchObject({code:'SETUP_NOT_STARTED'});
 expect(readCaptureConfig()).toBeNull();expect(readSetupState({api,tenantId:'tenant',userId:'user'})).toBeNull();expect(observations).toEqual([]);expect(existsSync(join(dir,'config','opencrawl','capture'))).toBe(false);
}));


test('availability rechecks consent and binding without treating worker progress as new consent',async()=>fixture(async(api)=>{
 await setupCommand('apply',api,{yes:true,plugins:'codex',forward:'codex',history:'none'},setupCodex);
 const scope={api,tenantId:'tenant',userId:'user'},original=globalThis.fetch;
 for(const changeSelection of [false,true]){
  let changed=false;
  globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{const response=await original(...args);if(!changed){changed=true;await updateSetupState(scope,state=>({...state!,worker:{kind:'external',status:'required',supervised:false,harnesses:['codex'],startup:true},...(changeSelection?{selections:{...state!.selections,forward:{...state!.selections.forward,codex:false}}}:{})}));}return response;},{preconnect:original.preconnect});
  try{
   const pending=setupCommand('plan',api,{json:true},setupCodex);
   if(changeSelection)await expect(pending).rejects.toMatchObject({code:'SETUP_SCOPE_CHANGED'});
   else expect(await pending).toMatchObject({status:'confirmation_required',selections:{forward:{codex:true}}});
   expect(changed).toBe(true);
  }finally{globalThis.fetch=original;}
 }
}));


test('unbound saved deferred choices cannot enter run, plan, or apply implicitly',async()=>fixture(async(api,dir,observations,_set,calls)=>{
 const scope={api,tenantId:'tenant',userId:'user'},acceptedAt='2026-01-01T00:00:00.000Z';let installs=0,launches=0,choices=0;
 const dependencies={interactive:true,choose:async()=>{choices++;throw new Error('Unbound choices reached the selector');},installPlugins:async()=>{installs++;throw new Error('Unbound choices reached installation');},launchHistory:()=>{launches++;throw new Error('Unbound choices launched history');}};
 const savedChoices:SetupState['selections'][]=[
  {plugins:{codex:true,antigravity:true},forward:{codex:false,antigravity:false},history:{codex:false}},
  {plugins:{codex:true,antigravity:false},forward:{codex:false,antigravity:true},history:{codex:false}},
  {plugins:{codex:true},forward:{codex:false},history:{codex:false,antigravity:true}},
 ];
 for(const selections of savedChoices){
  await updateSetupState(scope,()=>({schemaVersion:1,scope,installationId:'orphaned-installation',acceptedAt,selections,historyJob:{id:'retained-approved-job',clients:['antigravity'],files:[{harness:'antigravity',path:join(dir,'bounded-old.json'),bytes:1,ino:1,mtimeMs:1}],state:'complete',completedClients:['antigravity'],createdAt:acceptedAt,updatedAt:acceptedAt}}));
  const before=readSetupState(scope);
  for(const action of ['run','plan','apply']){
   await expect(setupCommand(action,api,action==='apply'?{yes:true}:{},dependencies)).rejects.toMatchObject({code:'SETUP_CLIENT_NOT_AVAILABLE'});
   expect(readSetupState(scope)).toEqual(before);expect(readCaptureConfig()).toBeNull();
  }
 }
 expect(installs).toBe(0);expect(launches).toBe(0);expect(choices).toBe(0);expect(observations).toEqual([]);expect(calls).toHaveLength(9);expect(calls.every(path=>path==='/api/setup')).toBe(true);expect(existsSync(join(dir,'config','opencrawl','capture'))).toBe(false);
 // An interrupted approval containing only available Mac clients still recovers.
 await updateSetupState(scope,()=>({schemaVersion:1,scope,acceptedAt,selections:{plugins:{codex:true},forward:{codex:false},history:{codex:false}}}));
 await setupCommand('resume',api,{json:true},setupCodex);
 expect(readCaptureConfig()).toMatchObject({harnesses:[],historyHarnesses:[],owner:{tenantId:'tenant',userId:'user'}});
 expect(readSetupState(scope)?.selections).toEqual({plugins:{codex:true},forward:{codex:false},history:{codex:false}});expect(readSetupState(scope)?.historyJob).toBeUndefined();
}));


test('ordinary resume repairs only unverified future boundaries and never waits on an active spool owner',()=>fixture(async(api,dir)=>{
 const file=join(dir,'codex','sessions','one.jsonl'),exactFile=join(dir,'codex','sessions','exact.jsonl');
 writeFileSync(exactFile,JSON.stringify({type:'session_meta',payload:{id:'exact',source:'cli'}})+'\n');
 await setupCommand('apply',api,{yes:true,plugins:'codex',forward:'codex',history:'none'},setupCodex);
 const config=readCaptureConfig()!,stateFile=(path:string)=>join(captureDir(),'state',hash('codex'+realpathSync(path))+'.json');
 const statePath=stateFile(file),exactPath=stateFile(exactFile),exactBefore=readFileSync(exactPath,'utf8');
 const line=(text:string)=>JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}})+'\n';
 const capture=()=>captureTranscript(config,'codex',file,{session_id:'one'});
 const resume=()=>setupCommand('resume',api,{json:true},{...setupCodex,choose:async()=>{throw Error('Unexpected questionnaire');}});
 // An unchanged exact profile does not acquire the busy spool lock at all.
 await withSessionLock('capture:spool',async()=>{expect(await resume()).toMatchObject({status:'configured'});});
 appendFileSync(file,line('ALREADY APPROVED'));await capture();
 const queue=join(captureDir(),'queue'),queued=new Map(readdirSync(queue).filter(name=>name.endsWith('.json')).map(name=>[name,readFileSync(join(queue,name),'utf8')]));
 expect(queued.size).toBeGreaterThan(0);
 const before=JSON.parse(readFileSync(statePath,'utf8')) as Record<string,unknown>;delete before.identity;atomicJson(statePath,before);
 appendFileSync(file,line('PRIVATE LEGACY TAIL'));
 const oldState=readFileSync(statePath,'utf8'),configPath=join(captureDir(),'config.json'),oldConfig=readFileSync(configPath,'utf8');
 const choices=readSetupState({api,tenantId:'tenant',userId:'user'})!;
 // A normal legacy cursor without a future boundary and a recording-off
 // client's boundary must not be reset as a side effect of the repair.
 const legacyFile=join(dir,'codex','sessions','legacy.jsonl');writeFileSync(legacyFile,line('LEGACY'));
 const legacyPath=stateFile(legacyFile),legacyBytes=JSON.stringify({offset:7,ino:statSync(legacyFile).ino,parserVersion:2});writeFileSync(legacyPath,legacyBytes);
 const offFile=join(dir,'claude','projects','project','off.jsonl');mkdirSync(join(offFile,'..'),{recursive:true});writeFileSync(offFile,'{}\n');
 const offPath=join(captureDir(),'state',hash('claude-code'+realpathSync(offFile))+'.json'),offBytes=JSON.stringify({offset:0,ino:1,forwardBoundary:true});writeFileSync(offPath,offBytes);
 await expect(capture()).rejects.toMatchObject({code:'CAPTURE_FILE_IDENTITY_UNVERIFIED'});
 await withSessionLock('capture:spool',async()=>{
  await expect(resume()).rejects.toMatchObject({code:'SESSION_BUSY'});
  expect(readFileSync(statePath,'utf8')).toBe(oldState);expect(readFileSync(configPath,'utf8')).toBe(oldConfig);
  // Release configuration immediately on contention, so this spool owner can
  // finish a credential update instead of forming a configuration/spool cycle.
  await withSessionLock('capture:configuration',async()=>{},0);
 });
 expect(await resume()).toMatchObject({status:'configured'});
 const repaired=JSON.parse(readFileSync(statePath,'utf8')) as {identity:unknown;offset:number;forwardBoundary:boolean};
 expect(validTranscriptIdentity(repaired.identity)).toBe(true);expect(repaired).toMatchObject({offset:statSync(file).size,forwardBoundary:true});
 expect(readFileSync(exactPath,'utf8')).toBe(exactBefore);expect(readFileSync(legacyPath,'utf8')).toBe(legacyBytes);expect(readFileSync(offPath,'utf8')).toBe(offBytes);
 expect(readdirSync(queue).filter(name=>name.endsWith('.json')).sort()).toEqual([...queued.keys()].sort());
 for(const [name,bytes] of queued)expect(readFileSync(join(queue,name),'utf8')).toBe(bytes);
 const after=readSetupState({api,tenantId:'tenant',userId:'user'})!;expect(after.selections).toEqual(choices.selections);expect(after.historyJob).toEqual(choices.historyJob);
 appendFileSync(file,line('APPROVED AFTER RESUME'));await capture();
 const text=JSON.stringify(readdirSync(queue).filter(name=>name.endsWith('.json')).flatMap(name=>(JSON.parse(readFileSync(join(queue,name),'utf8')) as {events:unknown[]}).events));
 expect(text).toContain('ALREADY APPROVED');expect(text).toContain('APPROVED AFTER RESUME');expect(text).not.toContain('PRIVATE LEGACY TAIL');
}));

for(const failure of ['throw','unsupervised'] as const)test('approved history starts independently of daemon fallback '+failure,()=>fixture(async api=>{
 const started:SetupState[]=[];
 const result=await setupCommand('apply',api,{yes:true,plugins:'codex',forward:'none',history:'codex'},{
  installPlugins:async()=>({results:[{client:'codex',status:'installed'}],humanTasks:[]}),
  installDaemon:async()=>{if(failure==='throw')throw Error('unavailable');return {kind:'external',supervised:false,status:'required',command:[]};},
  launchHistory:state=>{started.push(state);return {state:'queued',jobId:state.historyJob?.id};}
 });
 expect(started).toHaveLength(1);expect(started[0]?.historyJob?.clients).toEqual(['codex']);expect(started[0]?.historyJob?.files).toHaveLength(1);
 expect(result).toMatchObject({status:'needs_attention',history:{state:'queued',jobId:started[0]?.historyJob?.id},worker:{kind:'fallback'}});
 expect(readCaptureConfig()).toMatchObject({harnesses:[],historyHarnesses:['codex'],daemonRequested:{backgroundStartup:true}});
}));
