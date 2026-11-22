import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,statSync,rmSync,chmodSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {scopeKey,type SetupState} from '../src/setup/state.ts';
import type {CaptureConfig} from '../src/capture/runtime.ts';
import type {CodexHookReview} from '../src/capture/codex-hooks.ts';

const api='https://offline.example',scope={api,tenantId:'local-team',userId:'local-user'};
function snapshot(root:string):unknown[]{
 return readdirSync(root,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{
  const path=join(root,entry.name),stat=statSync(path);
  return [[relative(root,path),stat.mode,stat.mtimeMs,entry.isFile()?readFileSync(path).toString('base64'):snapshot(path)]];
 });
}
async function fixture(run:(f:{root:string;config:CaptureConfig;state:SetupState;captureFile:string;stateFile:string;save:()=>void;invoke:(args?:string[])=>Promise<{code:number;data:Record<string,unknown>;output:string}>})=>Promise<void>,nativeReview?:CodexHookReview){
 const root=mkdtempSync(join(tmpdir(),'opencrawl-local-status-')),configHome=join(root,'config'),captureFile=join(configHome,'opencrawl','capture','config.json'),stateFile=join(configHome,'opencrawl','setup',scopeKey(scope)+'.json');
 const config:CaptureConfig={schemaVersion:1,api,installationId:'local-installation',owner:{tenantId:scope.tenantId,userId:scope.userId,name:'private-owner-name',email:'private-owner-email'},installedAt:'2026-11-15T00:00:00Z',command:['private-launcher'],roots:{'claude-code':join(root,'claude'),codex:join(root,'codex'),cursor:join(root,'cursor'),antigravity:join(root,'gemini')},harnesses:['codex','antigravity'],historyHarnesses:['codex'],hookOwnership:'plugin'};
 const state:SetupState={schemaVersion:1,scope,installationId:config.installationId,acceptedAt:'2026-11-15T00:00:00Z',selections:{plugins:{codex:true,cursor:true,antigravity:true,'claude-code':false},forward:{codex:true,cursor:true,antigravity:true,'claude-code':false},history:{codex:true,cursor:false,antigravity:false,'claude-code':false}},historyJob:{id:'approved-history',clients:['codex'],files:[],state:'queued',completedClients:[],createdAt:'2026-11-15T00:00:00Z',updatedAt:'2026-11-15T00:00:00Z'}};
 for(const path of [join(configHome,'opencrawl','capture'),join(configHome,'opencrawl','setup'),config.roots.codex,join(config.roots.antigravity!,'config')])mkdirSync(path,{recursive:true});
 const save=()=>{writeFileSync(captureFile,JSON.stringify(config));writeFileSync(stateFile,JSON.stringify(state));};save();
 const credential=join(configHome,'opencrawl',createHash('sha256').update(api).digest('hex')+'.json');
 writeFileSync(credential,JSON.stringify({accessToken:'synthetic-access-secret',refreshToken:'synthetic-refresh-secret',expiresAt:0,auth:{clientId:'fixture',tokenEndpoint:api+'/token'}}));chmodSync(credential,0o644);
 const preload=join(root,'offline-guards.ts');
 writeFileSync(preload,`import {mock} from 'bun:test';
${nativeReview?`import * as nativeHooks from ${JSON.stringify(resolve(import.meta.dir,'../src/capture/codex-hooks.ts'))};\nmock.module(${JSON.stringify(resolve(import.meta.dir,'../src/capture/codex-hooks.ts'))},()=>({...nativeHooks,inspectCodexHooks:async()=>(${JSON.stringify(nativeReview)})}));`:''}
import * as fs from 'node:fs';
import * as cp from 'node:child_process';
const denied=(name)=>{process.stderr.write('FORBIDDEN_SIDE_EFFECT:'+name+'\\n');throw new Error('Forbidden offline side effect');};
const writes=['writeFileSync','writeFile','appendFileSync','appendFile','mkdirSync','mkdir','renameSync','rename','unlinkSync','unlink','rmSync','rm','chmodSync','chmod','fchmodSync','fchmod','truncateSync','truncate','createWriteStream'];
const reads={readFileSync:fs.readFileSync,openSync:fs.openSync};
const guarded={...fs,...Object.fromEntries(writes.map(name=>[name,()=>denied(name)]))};
for(const name of ['readFileSync','openSync'])guarded[name]=(...args)=>String(args[0])===${JSON.stringify(credential)}?denied('credential-read'):reads[name](...args);
mock.module('node:fs',()=>guarded);
mock.module('node:child_process',()=>({...cp,...Object.fromEntries(['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'].map(name=>[name,()=>denied(name)]))}));
globalThis.fetch=()=>denied('fetch');Bun.spawn=()=>denied('Bun.spawn');Bun.spawnSync=()=>denied('Bun.spawnSync');process.execve=()=>denied('execve');
`);
 const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('OPENCRAWL_'))delete env[key];
 Object.assign(env,{BUN_RUNTIME_TRANSPILER_CACHE_PATH:'0',HOME:root,USERPROFILE:root,XDG_CONFIG_HOME:configHome,XDG_CACHE_HOME:join(root,'cache'),XDG_DATA_HOME:join(root,'data'),OPENCRAWL_CONFIG_HOME:configHome,OPENCRAWL_TOKEN:'synthetic-environment-secret',CODEX_HOME:config.roots.codex,CLAUDE_CONFIG_DIR:config.roots['claude-code'],CURSOR_CONFIG_DIR:config.roots.cursor,ANTIGRAVITY_HOME:config.roots.antigravity});
 const invoke=async(args=['setup','status','--local'])=>{
  const before=snapshot(root),child=Bun.spawn([process.execPath,'--preload',preload,resolve(import.meta.dir,'../src/cli.ts'),...args,'--json'],{env,stdout:'pipe',stderr:'pipe'});
  const [output,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect(stderr).toBe('');expect(snapshot(root)).toEqual(before);
  for(const secret of ['synthetic-access-secret','synthetic-refresh-secret','synthetic-environment-secret','private-owner-name','private-owner-email','private-launcher'])expect(output).not.toContain(secret);
  return {code,data:JSON.parse(output),output};
 };
 try{await run({root,config,state,captureFile,stateFile,save,invoke});}finally{rmSync(root,{recursive:true,force:true});}
}

test('local status reads only the exact saved binding, retains independent choices and makes no server claims',()=>fixture(async({config,state,invoke})=>{
 const result=await invoke();expect(result.code).toBe(0);expect(result.data).toEqual({schemaVersion:1,data:{status:'local_status',freshness:'local-only',serverChecked:false,scopeSource:'saved-capture-config',scope,installationId:config.installationId,captureMode:'hook',savedSelections:state.selections,selections:{...state.selections,forward:{...state.selections.forward,cursor:false}}}});
 expect(result.output).not.toContain('"authenticated"');expect(result.output).not.toContain('"proof"');expect(result.output).not.toContain('"server":');
}));

test('local status shows only automatic updates granted to this installation',()=>fixture(async({state,save,invoke})=>{
 state.pluginAutoUpdates={installationId:state.installationId!,clients:['codex','claude-code']};save();
 expect(await invoke()).toMatchObject({code:0,data:{data:{automaticPluginUpdates:['codex']}}});
 state.pluginAutoUpdates.installationId='different-machine';save();
 expect((await invoke()).output).not.toContain('automaticPluginUpdates');
}));

test('local status includes the saved per-client repair reason',()=>fixture(async({state,save,invoke})=>{
 state.pluginResults=[{client:'codex',status:'pending',message:'Codex timed out during inventory.'}];save();
 expect((await invoke()).data).toMatchObject({data:{pluginResults:state.pluginResults}});
}));

test('local status preserves global pause, native disabled recording and explicit saved opt-outs',()=>fixture(async({config,state,save,invoke})=>{
 writeFileSync(join(config.roots.codex,'config.toml'),'[features]\nhooks = false\n');writeFileSync(join(config.roots.antigravity!,'config','hooks.json'),JSON.stringify({'opencrawl-capture':{enabled:false}}));
 const native=await invoke();expect(native.code).toBe(0);expect(native.data).toMatchObject({data:{savedSelections:state.selections,selections:{forward:{codex:false,cursor:false,antigravity:false,'claude-code':false},history:state.selections.history}}});
 config.disabled=true;save();expect((await invoke()).data).toMatchObject({data:{selections:{forward:{codex:false,cursor:false,antigravity:false,'claude-code':false}}}});
 config.disabled=false;state.selections.forward.codex=false;save();writeFileSync(join(config.roots.codex,'config.toml'),'[features]\nhooks = true\n');expect((await invoke()).data).toMatchObject({data:{selections:{forward:{codex:false}},savedSelections:{forward:{codex:false}}}});
}));

test('local status rejects API, installation and owner mismatch without changing state or authenticating',()=>fixture(async({config,state,save,invoke})=>{
 expect(await invoke(['setup','status','--local','--api','https://another.example'])).toMatchObject({code:2,data:{error:{code:'SETUP_SCOPE_CHANGED'}}});
 state.installationId='another-installation';save();expect(await invoke()).toMatchObject({code:2,data:{error:{code:'SETUP_SCOPE_CHANGED'}}});
 state.installationId=config.installationId;state.scope={...scope,userId:'different-user'};save();expect(await invoke()).toMatchObject({data:{error:{code:'SETUP_STATE_INVALID'}}});
 state.scope=scope;config.owner={tenantId:'different-team',userId:scope.userId};save();expect(await invoke()).toMatchObject({code:2,data:{error:{code:'SETUP_NOT_STARTED'}}});
}));

test('missing or incomplete local binding fails without restarting setup, even with expired saved auth',()=>fixture(async({config,save,captureFile,stateFile,invoke})=>{
 writeFileSync(captureFile,'{invalid');expect(await invoke()).toMatchObject({code:2,data:{error:{code:'SETUP_STATE_INVALID'}}});
 config.authPending=true;save();expect(await invoke()).toMatchObject({code:2,data:{error:{code:'SETUP_STATE_INVALID'}}});
 config.authPending=false;config.installationId='pending';save();expect(await invoke()).toMatchObject({code:2,data:{error:{code:'SETUP_STATE_INVALID'}}});
 config.installationId='local-installation';save();writeFileSync(stateFile,'null');expect(await invoke()).toMatchObject({code:2,data:{error:{code:'SETUP_STATE_INVALID'}}});
 rmSync(stateFile);expect(await invoke()).toMatchObject({code:2,data:{error:{code:'SETUP_NOT_STARTED'}}});
 rmSync(captureFile);expect(await invoke()).toMatchObject({code:2,data:{error:{code:'SETUP_NOT_STARTED'}}});
}));

test('local flag and malformed variants reject before native delegation, global hook refresh, auth or history work',()=>fixture(async({config,save,invoke})=>{
 config.hookOwnership='global';save();
 for(const args of [['setup'],['setup','hooks'],['setup','resume'],['setup','apply'],['setup','worker'],['setup','verify'],['verify-installation'],['whoami'],['search','fixture'],['session','start'],['collect','install'],['update'],['login']]){
  expect(await invoke([...args,'--local'])).toMatchObject({code:64,data:{error:{code:'INVALID_USAGE'}}});
 }
 for(const args of [['setup','status','--local=false'],['search','fixture','--local='],['setup','status','--local','--api']])expect(await invoke(args)).toMatchObject({code:64,data:{error:{code:'INVALID_USAGE'}}});
}));


test('explicit hook status observes native trust without server auth, writes, workers or generic process launches',()=>fixture(async({config,invoke})=>{
 const result=await invoke(['setup','hooks']);
 expect(result).toMatchObject({code:0,data:{data:{status:'hook_status',serverChecked:false,scope,installationId:config.installationId,client:'codex',recordingSelected:true,review:{state:'observed',total:8,pending:0,disabled:0}}}});
 expect(result.output).not.toContain('"authenticated"');expect(result.output).not.toContain('"proof"');
}, {state:'observed',total:8,pending:0,disabled:0}));

test('explicit hook status keeps unknown trust distinct from successful native review',()=>fixture(async({invoke})=>{
 expect(await invoke(['setup','hooks'])).toMatchObject({code:0,data:{data:{review:{state:'unknown',total:8,pending:null,disabled:null}}}});
 expect(await invoke(['setup','hooks','--api','https://another.example'])).toMatchObject({code:2,data:{error:{code:'SETUP_SCOPE_CHANGED'}}});
}, {state:'unknown',total:8,pending:null,disabled:null}));

test('local worker observation preserves external prerequisites without credentials processes or readiness claims',()=>fixture(async({state,save,invoke})=>{
 const command=['/owned/worker','collect','daemon','--worker-environment','{"OPENCRAWL_CONFIG_HOME":"/owned/profile","OPENCRAWL_NO_UPDATE":"1"}'],environment={OPENCRAWL_CONFIG_HOME:'/owned/profile',OPENCRAWL_NO_UPDATE:'1'};
 state.worker={kind:'external',status:'required',supervised:false,harnesses:['codex'],startup:true,command,environment};save();
 expect(await invoke()).toMatchObject({code:0,data:{data:{serverChecked:false,worker:{kind:'external',status:'required',readiness:'pending',freshness:'last-setup-observation',command,environment}}}});
 state.worker={kind:'systemd',status:'installed',supervised:true,harnesses:['codex'],startup:true};save();expect(await invoke()).toMatchObject({data:{data:{worker:{readiness:'configured',freshness:'last-setup-observation'}}}});
 state.worker={kind:'not-required',supervised:false,harnesses:[],startup:false};save();expect(await invoke()).toMatchObject({data:{data:{worker:{readiness:'not_required'}}}});
}));
