import {profileSetupCommand} from '../src/setup/invocation.ts';
import {sessionStart} from '../src/session-start.ts';
import {test,expect,spyOn} from 'bun:test';
import * as publishedPlugins from '../src/setup/published-plugins.ts';
import {pluginRelease} from '../src/setup/plugin-release.ts';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,readFileSync,readdirSync,realpathSync,statSync,rmSync,existsSync,copyFileSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {publishSetup,type SetupServerStatus} from '../src/setup/api.ts';
import {type CodexHookReview} from '../src/capture/codex-hooks.ts';
import {setupCommand as realSetupCommand,formatSetupOutput,formatSetupCommand} from '../src/setup/command.ts';
import {readSetupState,updateSetupState,statePath,scopeKey,historyBenefit,type SetupState} from '../src/setup/state.ts';
import {readCaptureConfig,captureDir,captureTranscript} from '../src/capture/runtime.ts';
import {uninstallCapture} from '../src/capture/install.ts';
import {atomicJson,withSessionLock} from '../src/session.ts';
import {hash} from '../src/capture/parse.ts';
import {validTranscriptIdentity} from '../src/capture/transcript-checkpoint.ts';
import {installCapture} from '../src/capture/install.ts';
import {installSetupPlugins} from './fixtures/legacy-plugins/prepare.ts';
import {recordingInstallState,setupPluginIdentity,type PluginOptions} from '../src/setup/plugins.ts';
import type {SelectionScreen} from '../src/setup/select.ts';
import {needsFirstRunSetup} from '../src/setup/first-run.ts';
import {findSetupConnection} from '../src/setup/native-mcp.ts';
import {runInteractiveSetup} from '../src/setup/interactive.ts';
import type {SetupUi} from '../src/setup/tui.tsx';
const approvedCodexHooks=async():Promise<CodexHookReview>=>({state:'observed',total:12,pending:0,disabled:0});
const setupCommand=(action:string,api:string,values:Parameters<typeof realSetupCommand>[2],dependencies:NonNullable<Parameters<typeof realSetupCommand>[3]>={})=>realSetupCommand(action,api,values,{platform:'darwin',canInstall:async()=>true,modeEligibility:()=>({eligible:values['capture-mode']==='daemon'||Boolean(readCaptureConfig()?.captureWorker||readCaptureConfig()?.daemonRequested),reason:'Fixture supervisor'}),daemonReady:async()=>true,installDaemon:async()=>({kind:'launchd',status:'installed',supervised:true,label:'fixture',path:'fixture'}),...dependencies});

test('authenticated setup registers the Git helper on apply and repairs it on rerun',async()=>{
 const git=Bun.which('git')!;
 expect(git).toBeTruthy();
 await fixture(async(api,dir)=>{
  const global=join(dir,'gitconfig');
  process.env.GIT_CONFIG_GLOBAL=global;
  process.env.GIT_CONFIG_NOSYSTEM='1';
  const choices={plugins:'none',forward:'none',history:'none',json:true};
  await setupCommand('plan',api,choices);
  await setupCommand('run',api,choices,{interactive:true,choose:async()=>null});
  expect(existsSync(global)).toBe(false);

  // The fixture initially has no Git on PATH. Other setup choices still apply.
  const applied=await setupCommand('apply',api,{...choices,yes:true});
  expect(applied).toMatchObject({status:'recording_off',gitCredentials:{status:'unavailable'}});
  process.env.PATH=dirname(git);
  const command=[process.execPath,join(import.meta.dir,'../src/cli.ts')];
  // A global config that cannot be opened for writing remains recoverable.
  process.env.GIT_CONFIG_GLOBAL=dir;
  expect(await setupCommand('run',api,{yes:true,json:true},{command})).toMatchObject({gitCredentials:{status:'unavailable'}});
  process.env.GIT_CONFIG_GLOBAL=global;
  for(let i=0;i<2;i++)expect(await setupCommand('run',api,{yes:true,json:true},{command})).toMatchObject({gitCredentials:{status:'configured'}});
  const config=(...args:string[])=>Bun.spawnSync([git,'config',...args],{env:{...process.env}}).stdout.toString().trim();
  expect(config('--global','--get-all','include.path').split('\n')).toHaveLength(1);
  expect(config('--get-urlmatch','credential.helper',api+'/git/tenant/files.git')).toContain('files-credential');
  expect(config('--get-urlmatch','credential.helper','https://example.invalid/repo.git')).toBe('');
  expect(readFileSync(config('--global','--get','include.path'),'utf8')).not.toContain(process.env.OPENCRAWL_TOKEN!);
 },false,'codex',false,true);
});

test.each(['darwin','linux'] as const)('%s first run stays open after interruption and remembers an explicit opt-out without capture',platform=>fixture(async api=>{
 expect(await needsFirstRunSetup()).toBe(true);
 const selectNone=(screen:SelectionScreen)=>screen.items.map(item=>({...item,selected:false}));
 await setupCommand('run',api,{}, {platform,interactive:true,choose:async screen=>screen.phase===2?null:selectNone(screen)});
 expect(await needsFirstRunSetup()).toBe(true);
 await setupCommand('run',api,{}, {platform,interactive:true,choose:async screen=>selectNone(screen)});
 expect(readCaptureConfig()).toBeNull();
 expect(await needsFirstRunSetup()).toBe(false);
 expect(await needsFirstRunSetup('https://different.example')).toBe(true);
 const result=await setupCommand('run',api,{yes:true,json:true},{platform});
 expect(result).toMatchObject({status:'recording_off'});
 expect(result).not.toHaveProperty('gitCredentials'); // Older servers and disabled accounts receive no Git setup prompts.
 expect(readCaptureConfig()).toBeNull();
}));

test('interrupted setup repairs a deleted Codex hook with the saved choices and no history import',()=>fixture(async(api,dir)=>{
 const scope={api,tenantId:'tenant',userId:'user'},identity=setupPluginIdentity(api);
 const cache=join(dir,'native-cache',identity.name);
 let directory:string;
 const hook=join(cache,'hooks','hooks.json');
 let nativeInstalled=false,installs=0;
 const native:PluginOptions={
  home:dir,applicationDirs:[],which:()=>'/fixture/codex',runner:async(_command,args)=>{
   if(args[1]==='marketplace'&&args[2]==='add')directory=join(args[3]!,identity.name);
   if(args[1]==='add'){cpSync(directory,cache,{recursive:true});nativeInstalled=true;installs++;}
   const rows=nativeInstalled?[{pluginId:identity.name+'@'+identity.marketplace,enabled:true,source:{source:'local',path:directory},installedPath:cache}]:[];
   return {code:0,stdout:JSON.stringify(args[1]==='list'?rows:{installedPath:cache})};
  },
 };
 const phases:number[]=[];
 const run=(expected:'new'|'repair'|'installed')=>setupCommand('run',api,{}, {interactive:true,
  installPlugins:(origin,ids,options)=>installSetupPlugins(origin,ids,{...options,...native}),
  inspectInstall:(origin,client,prior)=>recordingInstallState(origin,client,prior,native),
  launchHistory:()=>{throw Error('History was never approved');},
  choose:async screen=>{
   phases.push(screen.phase);
   if(screen.phase===4)return screen.items;
   if(screen.phase===2){
    expect(screen.items.every(item=>!item.selected)).toBe(true);
    return expected==='new'?null:screen.items;
   }
   const codex=screen.items.find(item=>item.id==='codex')!;
   expect(codex.installState).toBe(expected);
   expect(screen.items.find(item=>item.id==='cursor')?.installState).toBe('new');
   if(expected!=='new')expect(codex.selected).toBe(true);
   return screen.items.map(item=>({...item,selected:item.id==='codex'}));
  },
 });
 expect(await run('new')).toMatchObject({status:'cancelled'});
 const saved=readSetupState(scope)!,contents=readFileSync(hook);
 expect(saved.historyJob).toBeUndefined();
 // Reproduce the history checkpoint written by a pre-upgrade TUI as well.
 atomicJson(statePath(scopeKey(scope)),{...saved,checkpoint:{step:'history'}});
 rmSync(hook);
 await run('repair');
 expect(installs).toBe(2);
 await run('installed');
 expect(phases).toEqual([1,4,2,1,4,2,1,4,2]);expect(installs).toBe(2);
 expect(readFileSync(hook)).toEqual(contents);
 expect(readSetupState(scope)).toMatchObject({selections:saved.selections,installationId:saved.installationId});
 expect(readSetupState(scope)?.historyJob).toBeUndefined();
 expect(JSON.parse(readFileSync(statePath(scopeKey(scope)),'utf8'))).not.toHaveProperty('checkpoint');
}));

test('a legacy import checkpoint cannot start or expand an import on reinstall',()=>fixture(async(api,dir)=>{
 const scope={api,tenantId:'tenant',userId:'user'};
 await setupCommand('apply',api,{yes:true,plugins:'codex',forward:'codex',history:'none'},setupCodex);
 const old=readSetupState(scope)!;
 atomicJson(statePath(scopeKey(scope)),{...old,firstRun:'choosing',checkpoint:{step:'import',approvedHistory:{files:[],retained:[]}}});
 writeFileSync(join(dir,'codex','sessions','later.jsonl'),'{}');
 const phases:number[]=[];
 await setupCommand('run',api,{}, {...setupCodex,interactive:true,choose:async screen=>{
  phases.push(screen.phase);return screen.items;
 },launchHistory:()=>{throw Error('A stale navigation step cannot authorize a new import');}});
 expect(phases).toEqual([1,4,2]);expect(readSetupState(scope)?.historyJob).toBeUndefined();
}));

test('a saved opt-out and interrupted navigation do not skip fresh setup choices or require sign-in',()=>fixture(async(api,dir)=>{
 const scope={api,tenantId:'tenant',userId:'user'};
 await setupCommand('apply',api,{yes:true,plugins:'none',forward:'none',history:'none'});
 atomicJson(join(dirname(statePath(scopeKey(scope))),'interactive.json'),{id:'older-run',api:'https://stale.example'});
 const phases:number[]=[];
 const choose=async(screen:SelectionScreen)=>{
  phases.push(screen.phase);
  if(screen.phase===1)expect(screen.items.find(row=>row.id==='codex')?.selected).toBe(true);
  return screen.items.map(row=>({...row,selected:screen.phase===1&&row.id==='codex'}));
 };
 const result=await setupCommand('run',api,{}, {...setupCodex,interactive:true,choose,login:async()=>{throw Error('Repeated sign-in');}});
 expect(phases).toEqual([1,4,2]);expect(result).toMatchObject({selections:{forward:{codex:true}}});
 expect(readCaptureConfig()?.harnesses).toEqual(['codex']);
}));

test('first run checks legacy installation proof once and keeps completed help offline',()=>fixture(async(api,_dir,_observations,setClient)=>{
 await setupCommand('apply',api,{yes:true,plugins:'codex',forward:'codex',history:'none'}, {installPlugins:async()=>({results:[{client:'codex',status:'installed'}],humanTasks:[]})});
 const scope={api,tenantId:'tenant',userId:'user'};
 await updateSetupState(scope,current=>{const {firstRun,...legacy}=current!;return legacy;});
 expect(await needsFirstRunSetup(api)).toBe(true);
 setClient({installed:true,mcp:{state:'authenticated'},proof:{state:'verified'}});
 expect(await needsFirstRunSetup(api)).toBe(false);
 expect(readSetupState(scope)?.firstRun).toBe('complete');
 let reads=0;
 expect(await needsFirstRunSetup(api,async()=>{reads++;throw Error('offline');})).toBe(false);
 expect(reads).toBe(0);
}));

test('full human TUI keeps installation, history and pending verification in its own screens',async()=>fixture(async(api,_dir,_observations,setCodex)=>{
 const screens:string[]=[],controller=new AbortController();let closed=false,polls=0;
 const ui:SetupUi={invite:async options=>{screens.push("Invite "+options.workspace);await options.send("teammate@example.test");},signal:controller.signal,welcome:async()=>true,hosting:async()=>'self-hosted',workspace:async()=>({kind:'address',api}),progress:title=>{screens.push(title);},choose:async screen=>screen.items.map(item=>({...item,selected:screen.phase===1&&item.id==='codex'})),action:async screen=>{
  screens.push(screen.title);
  return 'done';
 },close:()=>{closed=true;},native:async run=>run()};
 const result=await runInteractiveSetup({values:{},readDestination:()=>({}),withOrigin:async(origin,run)=>{expect(origin).toBe(api);return run();},login:async()=>{throw Error('Unexpected sign-in');}},{createUi:()=>ui,resolveRuntime:async()=>undefined,inspectCodex:approvedCodexHooks,pause:async()=>{
  expect(screens.at(-1)).toBe('Verify the Codex connection');
  if(++polls===3)setCodex({installed:true,mcp:{state:'authenticated'},proof:{state:'verified'}});
 },setup:(action,origin,values,dependencies)=>setupCommand(action,origin,values,{...dependencies,installPlugins:async()=>({results:[{client:'codex',status:'installed'}],humanTasks:[]}),launchHistory:()=>({state:'not_started'})})});
 expect(result).toBe(0);expect(closed).toBe(true);expect(screens).toContain('Installing session capture tooling');expect(polls).toBe(3);expect(screens.indexOf('Invite Example Team')).toBeGreaterThan(screens.indexOf('Installing session capture tooling'));expect(screens.indexOf('Invite Example Team')).toBeLessThan(screens.indexOf('Checking setup'));expect(_observations).toContainEqual({tenantId:'tenant',userId:'user',email:'teammate@example.test'});expect(screens.slice(screens.indexOf('Checking setup'))).toEqual(['Checking setup','Approve OpenCrawl hooks','Checking setup','Verify the Codex connection','Setup complete']);
 expect(readCaptureConfig()?.harnesses).toEqual(['codex']);expect(readSetupState({api,tenantId:'tenant',userId:'user'})?.selections.history.codex).toBe(false);
},false,'codex',true));

test('cancelling workspace entry never runs auth or setup and the TUI always closes',async()=>{
 let closed=false;
 const ui:SetupUi={invite:async()=>{throw Error("Unexpected invite prompt");},signal:new AbortController().signal,welcome:async()=>true,hosting:async()=>'self-hosted',workspace:async()=>null,progress:()=>{},choose:async()=>null,action:async()=>null,close:()=>{closed=true;},native:async run=>run()};
 expect(await runInteractiveSetup({values:{},readDestination:()=>({}),withOrigin:async()=>{throw Error('Unexpected network binding');},login:async()=>{throw Error('Unexpected login');}},{createUi:()=>ui})).toBe(0);
 expect(closed).toBe(true);
});

test('only compatible local agents can be enabled, including after an earlier opt-in',()=>fixture(async api=>{
 await setupCommand('apply',api,{yes:true,plugins:'cursor',forward:'cursor',history:'none'},{installPlugins:async()=>({results:[{client:'cursor',status:'installed'}],humanTasks:[]})});
 const phases:number[]=[];
 const result=await setupCommand('run',api,{},{
  interactive:true,canInstall:async id=>id==='codex',
  choose:async screen=>{
   phases.push(screen.phase);
   if(screen.phase===1){
    expect(screen.items[0]).toMatchObject({id:'codex',label:'Codex',selected:true,disabled:false});
    expect(screen.items.find(row=>row.id==='claude-code')?.label).toBe('Claude Code');
    expect(screen.items.slice(1).every(row=>row.disabled&&!row.selected)).toBe(true);
    expect(screen.items.find(row=>row.id==='cursor')?.detail).toContain('No compatible local installation');
   }
   // Even a stale renderer returning a disabled row cannot enroll or defer it.
   return screen.items.map(row=>({...row,selected:screen.phase===1&&row.id==='cursor'}));
  },
  installPlugins:async(_api,ids)=>{expect(ids).toEqual([]);return {results:[],humanTasks:[]};}
 });
 expect(phases).toEqual([1,2]);
 expect(result).toMatchObject({status:'recording_off',selections:{forward:{cursor:false,codex:false},plugins:{cursor:false}}});
 expect(readCaptureConfig()?.harnesses??[]).not.toContain('cursor');
}));

test('a plugin download failure still reaches history confirmation and saves retry details',()=>fixture(async api=>{
 const load=spyOn(publishedPlugins,'loadPublishedPackage').mockRejectedValue(Error('Offline'));
 const phases:number[]=[];
 try{
  const result=await setupCommand('run',api,{},{
   interactive:true,canInstall:async id=>id==='cursor',
   choose:async screen=>{phases.push(screen.phase);return screen.items.map(row=>({...row,selected:row.id==='cursor'}));}
  });
  expect(load).toHaveBeenCalledTimes(1);expect(phases).toEqual([1,4,2]);
  expect(result).toMatchObject({plugins:[{client:'cursor',status:'error'}],nextAction:{kind:'repair_plugin',client:'cursor'}});
 }finally{load.mockRestore();}
}));

test('a failed plugin leaves history and healthy agents usable and can be retried after onboarding',()=>fixture(async(api,_dir,_observations,setCodex)=>{
 const screens:string[]=[],details:string[]=[];let historyJobs=0,polls=0;
 const ui:SetupUi={invite:async()=>{throw Error("Unexpected invite prompt");},signal:new AbortController().signal,welcome:async()=>true,hosting:async()=>'cloud',workspace:async()=>null,native:async run=>run(),close:()=>{},
  choose:async screen=>{screens.push(screen.title);return screen.items.map(row=>({...row,selected:screen.phase===1&&['codex','cursor'].includes(row.id)||screen.phase===2&&row.id==='codex'}));},
  progress:(title,_description,lines)=>{screens.push(title);details.push(...lines??[]);},
  action:async screen=>{screens.push(screen.title);details.push(screen.description,...screen.details??[]);return 'done';}
 };
 const failure={client:'cursor' as const,status:'error' as const,message:'Installer no longer available.'};
 const code=await runInteractiveSetup({values:{},readDestination:()=>({api}),withOrigin:(_origin,run)=>run(),login:async()=>{}},{
  createUi:()=>ui,resolveRuntime:async()=>undefined,inspectCodex:approvedCodexHooks,pause:async()=>{expect(++polls).toBe(1);setCodex({installed:true,mcp:{state:'authenticated'},proof:{state:'verified'}});},
  setup:(action,origin,values,deps)=>setupCommand(action,origin,values,{...deps,
   installPlugins:async()=>({results:[failure,{client:'codex',status:'installed'}],humanTasks:[{client:'cursor',id:'repair',kind:'plugin_install',title:'Resolve Cursor plugin installation',instruction:'Retry installation'}]}),
   launchHistory:()=>{historyJobs++;return {state:'queued'};}
  })
 });
 expect(code).toBe(0);expect(polls).toBe(1);expect(historyJobs).toBe(1);
 expect(screens).toContain('Import past sessions');expect(screens.at(-1)).toBe('Setup saved');
 expect([...screens,...details]).not.toContain('Resolve Cursor plugin installation');
 expect(details).toContain('Recording setup is pending for Cursor.');expect(details).toContain('Past sessions are importing in the background.');
 expect(await needsFirstRunSetup(api)).toBe(false);
 expect(await setupCommand('next',api,{})).toMatchObject({nextAction:{kind:'repair_plugin',client:'cursor'}});
 expect(await setupCommand('status',api,{local:true})).toMatchObject({pluginResults:expect.arrayContaining([failure])});
 const resumed=await setupCommand('run',api,{}, {interactive:true,choose:async screen=>screen.items.map(item=>({...item,selected:screen.phase===1&&['codex','cursor'].includes(item.id)})),installPlugins:async(_api,clients)=>{
  expect(clients).toEqual(['codex','cursor']);return {results:[{client:'codex',status:'unchanged'},{client:'cursor',status:'prepared'}],humanTasks:[]};
 },launchHistory:()=>({state:'queued'})});
 expect(resumed).toMatchObject({nextAction:{kind:'native_tool',arguments:{client:'cursor'}}});
}));

test('reinstalling a pending plugin leaves its next action visible',()=>fixture(async api=>{
 const failure={results:[{client:'cursor' as const,status:'pending' as const}],humanTasks:[]};
 await setupCommand('apply',api,{yes:true,plugins:'cursor',forward:'cursor',history:'none'},{installPlugins:async()=>failure});
 const unexpected=async():Promise<never>=>{throw Error('Unexpected setup question');};
 const actions:string[]=[];
 const ui:SetupUi={signal:new AbortController().signal,welcome:async()=>true,hosting:unexpected,workspace:unexpected,invite:unexpected,choose:async screen=>screen.items.map(item=>({...item,selected:screen.phase===1&&item.id==='cursor'})),native:unexpected,close:()=>{},progress:()=>{},
  action:async screen=>{actions.push(screen.title);expect(screen.actions?.map(action=>action.label)).toEqual(['Done']);return 'done';}
 };
 const code=await runInteractiveSetup({values:{},readDestination:()=>({api}),withOrigin:(_origin,run)=>run(),login:unexpected},{
  createUi:()=>ui,pause:unexpected,setup:(action,origin,values,deps)=>setupCommand(action,origin,values,{...deps,installPlugins:async()=>failure})
 });
 expect(code).toBe(0);expect(actions).toEqual(['Setup saved']);expect(await needsFirstRunSetup(api)).toBe(false);
}));

test('TUI service retry preserves selections and does not ask for native verification first',async()=>fixture(async(api,_dir,_observations,setCodex)=>{
 let ready=false,choices=0,installs=0;const screens:string[]=[],operations:string[]=[];
 const ui:SetupUi={invite:async()=>{throw Error("Unexpected invite prompt");},signal:new AbortController().signal,welcome:async()=>true,hosting:async()=>'self-hosted',workspace:async()=>({kind:'address',api}),progress:title=>{screens.push(title);},choose:async screen=>{choices++;return screen.items.map(item=>({...item,selected:screen.phase===1&&item.id==='codex'}));},action:async screen=>{
  screens.push(screen.title);
  if(screen.title==='Background capture needs attention'){expect(screen.actions?.map(a=>a.label)).toEqual(['Retry service','Close']);ready=true;setCodex({installed:true,mcp:{state:'authenticated'},proof:{state:'verified'}});return 'retry';}
  return 'done';
 },close:()=>{},native:async run=>run()};
 const result=await runInteractiveSetup({values:{},readDestination:()=>({api,explicit:api}),withOrigin:async(_origin,run)=>run(),login:async()=>{throw Error('Unexpected login');}},{createUi:()=>ui,resolveRuntime:async()=>undefined,pause:async()=>{throw Error('Must repair service before native verification');},setup:(action,origin,values,dependencies)=>{
  operations.push(values.yes?'repair':action);return setupCommand(action,origin,values,{...dependencies,modeEligibility:()=>({eligible:true,reason:'Fixture'}),daemonReady:async()=>ready,installDaemon:async()=>{installs++;return {kind:'launchd',status:'installed',supervised:true,label:'fixture',path:'fixture'};},installPlugins:async()=>({results:[{client:'codex',status:'installed',captureAvailable:true,daemonHandoff:true}],humanTasks:[]}),launchHistory:()=>({state:'not_started'})});
 }});
 expect(result).toBe(0);expect(installs).toBe(2);expect(operations.filter(x=>x==='run')).toHaveLength(1);expect(operations.filter(x=>x==='repair')).toHaveLength(1);expect(choices).toBe(3);expect(screens).toContain('Installing background service');expect(screens).not.toContain('Finish connecting your agents');expect(screens.at(-1)).toBe('Setup complete');
}));

test('failed supervision stops before launching Claude native sign-in',async()=>fixture(async api=>{
 let nativeCalls=0;const screens:string[]=[];
 const ui:SetupUi={invite:async()=>{throw Error("Unexpected invite prompt");},signal:new AbortController().signal,welcome:async()=>true,hosting:async()=>'self-hosted',workspace:async()=>({kind:'address',api}),progress:()=>{},choose:async screen=>screen.items.map(item=>({...item,selected:screen.phase===1&&item.id==='claude-code'})),action:async screen=>{screens.push(screen.title);return 'close';},close:()=>{},native:async run=>run()};
 const code=await runInteractiveSetup({values:{client:['claude-code']},readDestination:()=>({api}),withOrigin:async(_origin,run)=>run(),login:async()=>{}},{createUi:()=>ui,resolveRuntime:async()=>({executable:'/fixture/claude',desktop:false}),native:async()=>{nativeCalls++;return 0;},pause:async()=>{throw Error('Unexpected wait');},setup:(action,origin,values,dependencies)=>setupCommand(action,origin,values,{...dependencies,modeEligibility:()=>({eligible:true,reason:'Fixture'}),daemonReady:async()=>false,installPlugins:async()=>({results:[{client:'claude-code',status:'installed',captureAvailable:true,daemonHandoff:true}],humanTasks:[]}),launchHistory:()=>({state:'not_started'})})});
 expect(code).toBe(2);expect(nativeCalls).toBe(0);expect(screens).toEqual(['Background capture needs attention']);
}));

test('Codex hook approval refreshes without input and advances to a user-opened chat',()=>fixture(async(api,_dir,observations,setCodex)=>{
 const reviews:CodexHookReview[]=[
  {state:'unknown',total:0,pending:null,disabled:null},
  {state:'not_applicable',total:0,pending:0,disabled:0},
  {state:'observed',total:12,pending:2,disabled:1},
  {state:'observed',total:12,pending:0,disabled:1},
  {state:'observed',total:12,pending:1,disabled:0},
  {state:'observed',total:12,pending:0,disabled:0},
 ];
 const actions:string[]=[];
 let waitingScreens=0;
 let handoffs=0;
 const unexpected=async():Promise<never>=>{throw Error('Unexpected launch or prompt');};
 const ui:SetupUi={
  signal:new AbortController().signal,welcome:async()=>true,hosting:unexpected,workspace:unexpected,invite:unexpected,native:unexpected,close:()=>{},
  choose:async screen=>screen.items.map(item=>({...item,selected:screen.phase===1&&item.id==='codex'})),
  action:async screen=>{actions.push(screen.title);return 'done';},
  progress:(title,description,details,options)=>{
   if(options?.waiting?.onSkip){
    waitingScreens++;
    expect(title).toBe('Approve OpenCrawl hooks');
    expect(description).toBe('Choose either option:');
    expect(details).toEqual(['Codex Desktop','Open Settings → Hooks → From Plugins → OpenCrawl. Select “Trust all”.','\nCodex CLI','Run `codex` in another terminal. At “Hooks need review”, review the pending hooks and select “Trust all and continue”.']);
    expect(options.waiting.spinner).toBe('Waiting for approval…');
   }
   if(title==='Verify the Codex connection'){
    expect(reviews).toHaveLength(0);
    expect(description).toBe('Start a new chat in Codex CLI or Codex Desktop and send:');
    expect(options?.prompt).toBe('Finish OpenCrawl setup for '+api+' using my saved choices.');
    expect(details).toEqual([]);
    expect(options?.waiting).toEqual({spinner:'Waiting for Codex to connect…'});
    handoffs++;
   }
  }
 };
 const code=await runInteractiveSetup({values:{},readDestination:()=>({api}),withOrigin:async(_origin,run)=>run(),login:unexpected},{
  createUi:()=>ui,resolveRuntime:async()=>({executable:'/native/codex',desktop:false}),native:unexpected,findConnection:unexpected,
  inspectCodex:async()=>{const review=reviews.shift();if(!review)throw Error('Extra hook inspection');return review;},
  pause:async()=>{if(handoffs)setCodex({installed:true,mcp:{state:'authenticated'},proof:{state:'verified'}});},
  setup:(action,origin,values,dependencies)=>setupCommand(action,origin,values,{...dependencies,installPlugins:async()=>({results:[{client:'codex',status:'installed',captureAvailable:true}],humanTasks:[]}),launchHistory:()=>({state:'not_started'})})
 });
 expect(code).toBe(0);
 expect(waitingScreens).toBe(1);
 expect(handoffs).toBe(1);
 expect(observations.at(-1)).toMatchObject({clients:expect.arrayContaining([expect.objectContaining({client:'codex',hookTrust:'trusted'})])});
 expect(actions).toEqual(['Setup complete']);
}));

test('skipping hook trust during inspection saves Codex as pending and continues with Cursor',()=>fixture(async(api,_dir,_observations,setCursor)=>{
 const inspection=Promise.withResolvers<CodexHookReview>();
 const unexpected=async():Promise<never>=>{throw Error('Unexpected native launch');};
 const visited:string[]=[];
 let skip:undefined|(()=>void);
 const ui:SetupUi={
  signal:new AbortController().signal,welcome:async()=>true,hosting:unexpected,workspace:unexpected,invite:unexpected,native:unexpected,close:()=>{},
  choose:async screen=>screen.items.map(item=>({...item,selected:screen.phase===1&&['codex','cursor'].includes(item.id)})),
  progress:(title,_description,_details,options)=>{
   if(options?.waiting?.onSkip){visited.push('trust');skip=options.waiting.onSkip;}
   if(title==='Verify the Codex connection')throw Error('Skipped Codex was sent to verification');
   if(title==='Open Cursor'){
    visited.push('cursor');
    expect(options?.prompt).toContain('verify_installation tools for cursor');
    setCursor({installed:true,mcp:{state:'authenticated'},proof:{state:'verified'}});
   }
  },
  action:async screen=>{
   visited.push(screen.title);
   expect(screen.description).toBe('Recording setup is pending for Codex.');
   return 'done';
  }
 };
 const code=await runInteractiveSetup({values:{},readDestination:()=>({api}),withOrigin:(_origin,run)=>run(),login:unexpected},{
  createUi:()=>ui,resolveRuntime:async()=>undefined,native:unexpected,pause:async()=>{},
  inspectCodex:()=>{skip!();return inspection.promise;},
  setup:(action,origin,values,deps)=>setupCommand(action,origin,values,{...deps,installPlugins:async()=>({results:[{client:'codex',status:'installed'},{client:'cursor',status:'installed'}],humanTasks:[]}),launchHistory:()=>({state:'not_started'})})
 });
 inspection.resolve({state:'observed',total:12,pending:0,disabled:0});
 await Promise.resolve();
 expect(code).toBe(0);
 expect(visited).toEqual(['trust','cursor','Setup saved']);
 expect(readSetupState({api,tenantId:'tenant',userId:'user'})?.selections.forward.codex).toBe(true);
 expect((await setupCommand('next',api,{json:true}))).toMatchObject({nextAction:{kind:'native_tool',arguments:{client:'codex'}}});
},false,'cursor'));

test('exiting hook review stops polling and keeps the saved recording choice',()=>fixture(async api=>{
 const controller=new AbortController();
 let checks=0;
 const unexpected=async():Promise<never>=>{throw Error('Unexpected launch or prompt');};
 const ui:SetupUi={
  signal:controller.signal,welcome:async()=>true,hosting:unexpected,workspace:unexpected,invite:unexpected,native:unexpected,action:unexpected,close:()=>{},
  choose:async screen=>screen.items.map(item=>({...item,selected:screen.phase===1&&item.id==='codex'})),
  progress:()=>{},
 };
 const code=await runInteractiveSetup({values:{},readDestination:()=>({api}),withOrigin:async(_origin,run)=>run(),login:unexpected},{
  createUi:()=>ui,resolveRuntime:async()=>({executable:'/native/codex',desktop:false}),native:unexpected,
  inspectCodex:async()=>{checks++;return {state:'observed',total:12,pending:0,disabled:1};},
  pause:async()=>{controller.abort();},
  setup:(action,origin,values,dependencies)=>setupCommand(action,origin,values,{...dependencies,installPlugins:async()=>({results:[{client:'codex',status:'installed',captureAvailable:true}],humanTasks:[]}),launchHistory:()=>({state:'not_started'})})
 });
 expect(code).toBe(130);expect(checks).toBe(1);
 expect(readSetupState({api,tenantId:'tenant',userId:'user'})?.selections.forward.codex).toBe(true);
}));

test('closing a failed service install preserves its pending state and queued data',async()=>fixture(async api=>{
 let choices=0,stops=0,installs=0;let installationId:string|undefined;const queued=()=>join(captureDir(),'queue','preserved.json');
 const ui:SetupUi={invite:async()=>{throw Error("Unexpected invite prompt");},signal:new AbortController().signal,welcome:async()=>true,hosting:async()=>'self-hosted',workspace:async()=>({kind:'address',api}),progress:()=>{},choose:async screen=>{choices++;return screen.items.map(item=>({...item,selected:screen.phase===1&&item.id==='codex'}));},action:async screen=>{
  if(screen.title==='Background capture needs attention'){installationId=readCaptureConfig()?.installationId;mkdirSync(dirname(queued()),{recursive:true});writeFileSync(queued(),'retain queued bytes');return 'close';}
  throw Error('Unexpected screen: '+screen.title);
 },close:()=>{},native:async run=>run()};
 const code=await runInteractiveSetup({values:{},readDestination:()=>({api}),withOrigin:async(_origin,run)=>run(),login:async()=>{}},{createUi:()=>ui,resolveRuntime:async()=>undefined,pause:async()=>{throw Error('Unexpected polling');},setup:(action,origin,values,dependencies)=>setupCommand(action,origin,values,{...dependencies,modeEligibility:()=>({eligible:true,reason:'Fixture'}),daemonReady:async()=>false,installDaemon:async()=>{installs++;return {kind:'launchd',status:'installed',supervised:true,label:'fixture',path:'fixture'};},stopDaemon:()=>{stops++;},installPlugins:async()=>({results:[{client:'codex',status:'installed',captureAvailable:true,daemonHandoff:true}],humanTasks:[]}),launchHistory:()=>({state:'not_started'})})});
 expect(code).toBe(2);expect(choices).toBe(3);expect(stops).toBe(0);expect(installs).toBe(1);expect(readFileSync(queued(),'utf8')).toBe('retain queued bytes');expect(readCaptureConfig()?.installationId).toBe(installationId);expect(readCaptureConfig()?.harnesses).toEqual(['codex']);expect(readSetupState({api,tenantId:'tenant',userId:'user'})).toMatchObject({captureMode:'daemon',worker:{supervised:false}});
}));
async function legacySetupCommand(action:string,api:string,values:Parameters<typeof realSetupCommand>[2],dependencies:NonNullable<Parameters<typeof realSetupCommand>[3]>={}){
 const scope={api,tenantId:'tenant',userId:'user'};
 if(!readSetupState(scope)){
  const capture=await installCapture(api,{harnesses:[],historyHarnesses:[],selectionMode:'replace',daemon:true,daemonService:false,backgroundStartup:false,hookOwnership:'plugin',expectedOwner:scope});
  const group=(name:string)=>Object.fromEntries(['claude-code','codex','antigravity','cursor'].map(id=>[id,String(values[name]??'none').split(',').includes(id)]));
  await updateSetupState(scope,()=>({schemaVersion:1,scope,installationId:capture.installationId,machine:{id:'legacy',label:'Legacy fixture'},acceptedAt:new Date().toISOString(),selections:{plugins:group('plugins'),forward:group('forward'),history:group('history')}}));
 }
 return setupCommand(action,api,values,dependencies);
}
type ClientStatus=SetupServerStatus['installations'][number]['clients'][number];
async function fixture(run:(api:string,dir:string,observations:unknown[],setClient:(patch:Partial<ClientStatus>)=>void,calls:string[])=>Promise<void>,pluginStateSupported=false,patchedClient='codex',inviteEnabled=false,sharedFiles=false){
 const dir=mkdtempSync(join(tmpdir(),'opencrawl-setup-flow-')),saved={...process.env},observations:unknown[]=[],calls:string[]=[];let installations:SetupServerStatus['installations']=[],clientPatch:Partial<ClientStatus>={};
 const server=createServer(async(req,res)=>{
  calls.push(req.url??'');
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
  let data:unknown;
  if(req.url==='/api/setup')data={schemaVersion:1,scope:{tenantId:'tenant',userId:'user'},...(pluginStateSupported?{pluginStateSupported:true}:{}),firstWin:null,installations:installations.map(row=>({...row,clients:row.clients.map(client=>client.client===patchedClient?{...client,...clientPatch}:client)}))};
  else if(sharedFiles&&req.url==='/api/files'&&req.headers.authorization==='Bearer fixture-access-token-0123456789'){
   // Cold hosted membership + storage discovery may exceed a native hook's budget.
   if(calls.filter(path=>path==='/api/files').length===1)await new Promise(resolve=>setTimeout(resolve,1200));
   data={remotePath:'/api/files/'+'a'.repeat(64)+'.git',tenantId:'tenant',userId:'user'};
  }
  else if(inviteEnabled&&req.url==='/api/setup/invitations'){
   if(req.method==='GET')data={scope:{tenantId:'tenant',userId:'user'},workspace:'Example Team',delivery:'email'};
   else{observations.push(body);data={created:true,delivery:'email'};}
  }
  else if(req.url==='/api/setup/installation'){
   observations.push(body);
   const clients=installations.find(row=>row.installationId===body.installationId)?.clients??[];
   const reported=body.clients.map((client:Record<string,unknown>)=>({...client,humanTasks:[]}));
   installations=[{...body,clients:[...clients.filter(client=>!reported.some((row:ClientStatus)=>row.client===client.client)),...reported]}];data=installations[0];
  }
  else if(req.url==='/api/sessions/identity')data={principal:{tenantId:'tenant',userId:'user'},capabilities:{harnesses:['claude-code','codex','cursor','antigravity']}};
  else {res.writeHead(404);res.end();return;}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({schemaVersion:1,data}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const api='http://127.0.0.1:'+(server.address() as {port:number}).port;
 try{
  Object.assign(process.env,{HOME:dir,USERPROFILE:dir,PATH:dir,OPENCRAWL_CONFIG_HOME:join(dir,'config'),OPENCRAWL_API_URL:api,OPENCRAWL_TOKEN:'fixture-access-token-0123456789',OPENCRAWL_SESSIONS_TOKEN:'fixture-upload-token-0123456789',CLAUDE_DESKTOP_CONFIG_DIR:join(dir,'desktop'),CLAUDE_CONFIG_DIR:join(dir,'claude'),CODEX_HOME:join(dir,'codex'),CURSOR_CONFIG_DIR:join(dir,'cursor'),ANTIGRAVITY_HOME:join(dir,'agy')});
  const file=join(dir,'codex','sessions','one.jsonl');mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id:'one',source:'cli'}})+'\n'+JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:'approved historical content'}})+'\n');
  await run(api,dir,observations,patch=>{clientPatch=patch;},calls);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);rmSync(dir,{recursive:true,force:true});}
}
test('multi-agent setup resumes the approved browser action and advances to the next client',()=>fixture(async(api,dir,_observations,setClaude)=>{
 mkdirSync(join(dir,'claude','projects'),{recursive:true});
 const unexpected=async():Promise<never>=>{throw Error('Unexpected setup action');};
 const calls:string[][]=[],screens:string[]=[];
 const controller=new AbortController();
 let later=true;
 const ui:SetupUi={
  signal:controller.signal,welcome:async()=>true,hosting:unexpected,workspace:unexpected,
  invite:unexpected,native:unexpected,progress:title=>{if(title==='Verify the Codex connection'){screens.push(title);controller.abort();}},close:()=>{},
  choose:async screen=>screen.items.map(item=>({...item,selected:screen.phase===1&&['claude-code','codex'].includes(item.id)})),
  action:async screen=>{
   screens.push(screen.title);
   expect(JSON.stringify(screen)).not.toMatch(/installationId|proofId|verify_installation/);
   if(screen.title==='Connect Claude Code to OpenCrawl'){
    const needsLogin=calls.length===0;
    expect(screen.description).toContain(needsLogin?'in your browser. A Claude Code session will then open in this terminal.':'A Claude Code session will open in this terminal.');
    expect(screen.actions?.map(action=>action.label)).toEqual([needsLogin?'Sign in and open Claude Code':'Open Claude Code','Finish later']);
    expect(screen.details).toContain('OpenCrawl will pause while Claude checks the connection.');
    expect(screen.details).toContain('When Claude says it’s connected, press Ctrl+C to close the session and continue setup.');
    return later?'later':'connect';
   }
   throw Error('Unexpected action '+screen.title);
  }
 };
 const run=()=>runInteractiveSetup({values:{},readDestination:()=>({api}),withOrigin:(_origin,run)=>run(),login:unexpected},{
  createUi:()=>ui,resolveRuntime:async client=>({executable:client==='claude-code'?'/native/claude':'/native/agy',desktop:false}),findConnection:async client=>({name:client==='claude-code'?'opencrawl':setupPluginIdentity(api).name,skipLogin:false}),
  inspectCodex:async()=>({state:'observed',total:1,pending:0,disabled:0}),
  native:async(command,args)=>{
   calls.push([command,...args]);
   if(args[0]==='mcp')return 0;
   expect(args[0]).toContain('Once this client is verified, end your reply with “Press Ctrl+C to close Claude Code and return to OpenCrawl setup.');
   setClaude({installed:true,mcp:{state:'authenticated'},proof:{state:calls.length===2?'pending':'verified'}});
   return 130;
  },
  setup:(action,origin,values,deps)=>setupCommand(action,origin,values,{...deps,installPlugins:async(_api,clients)=>{expect(clients.sort()).toEqual(['claude-code','codex']);return {results:[{client:'claude-code',status:'installed'},{client:'codex',status:'installed'}],humanTasks:[]};}}),
  pause:async signal=>signal.throwIfAborted()
 });
 expect(await run()).toBe(0);
 expect(calls).toEqual([]);
 const scope={api,tenantId:'tenant',userId:'user'};
 const saved=readSetupState(scope)!;
 expect(saved.firstRun).toBe('ready');
 expect(saved.selections.forward).toMatchObject({'claude-code':true,codex:true});
 later=false;
 expect(await run()).toBe(130);
 expect(screens).toEqual(['Connect Claude Code to OpenCrawl','Connect Claude Code to OpenCrawl','Connect Claude Code to OpenCrawl','Verify the Codex connection']);
 expect(calls).toHaveLength(3);
 expect(calls[0]).toEqual(['/native/claude','mcp','login','opencrawl']);
 expect(calls[1][0]).toBe('/native/claude');
 expect(calls[1][1]).toContain('setup next --api '+api);
 expect(readSetupState(scope)?.selections).toEqual(saved.selections);
},false,'claude-code'));

test('Claude opens verification on its connected legacy server while workspace proof is still pending',()=>fixture(async(api,dir,_observations,setClient)=>{
 mkdirSync(join(dir,'claude','projects'),{recursive:true});
 const calls:string[][]=[];
 const ui:SetupUi={signal:new AbortController().signal,welcome:async()=>true,hosting:async()=>'self-hosted',workspace:async()=>({kind:'address',api}),invite:async()=>{},
  choose:async screen=>screen.items.map(item=>({...item,selected:screen.phase===1&&item.id==='claude-code'})),
  progress:()=>{},close:()=>{},native:async run=>run(),action:async screen=>{
   if(screen.title==='Setup complete')return 'done';
   expect(screen.title).toBe('Connect Claude Code to OpenCrawl');expect(screen.actions?.[0]?.label).toBe('Open Claude Code');return 'connect';
  }};
 const code=await runInteractiveSetup({values:{},readDestination:()=>({api}),withOrigin:(_api,run)=>run(),login:async()=>{}},{
  createUi:()=>ui,resolveRuntime:async()=>({executable:'/native/claude',desktop:false}),findConnection:(client,binary,origin)=>findSetupConnection(client,binary,origin,async args=>
   args[2]==='opencrawl'?['opencrawl:','  Status: ✓ Connected','  Type: http','  URL: '+api+'/mcp'].join('\n'):undefined),
  native:async(_command,args)=>{
   calls.push(args);expect(args).toHaveLength(1);expect(args[0]).toContain('Use native MCP server opencrawl at '+api+'/mcp');
   setClient({installed:true,mcp:{state:'authenticated'},proof:{state:'verified'}});return 130;
  },
  setup:(action,origin,values,deps)=>setupCommand(action,origin,values,{...deps,installPlugins:async()=>({results:[{client:'claude-code',status:'installed'}],humanTasks:[]})}),
 });
 expect(code).toBe(0);expect(calls).toHaveLength(1);
},false,'claude-code'));

test.each(['verify','connect'])('Antigravity opens native consent first and handles retry choice %s', async retry => {
 await fixture(async (api, dir, _observations, setClient) => {
  mkdirSync(join(dir, 'agy', 'antigravity-cli'), {recursive: true});
  const screens: string[] = [];
  const calls: string[][] = [];
  const ui: SetupUi = {invite:async()=>{throw Error("Unexpected invite prompt");},
   signal: new AbortController().signal, close() {}, progress() {}, native: run => run(),
   welcome: async () => true, hosting: async () => 'self-hosted', workspace: async () => ({kind: 'address', api}),
   choose: async screen => screen.items.map(item => ({...item, selected: screen.phase === 1 && item.id === 'antigravity'})),
   action: async screen => {
    screens.push(screen.title);
    if (screen.title === 'Connect Antigravity') {
     expect(screen.description).toBe(calls.length===0?'Open /mcp, select opencrawl_opencrawl, and sign in if prompted.':'Open /plugin, select opencrawl, and choose Sign in.');
     expect(screen.details).toEqual(['Once connected, press Esc and type /quit to continue setup.']);
     return 'open';
    }
    if (screen.title === 'Antigravity verification is pending') return retry;
    expect(screen.title).toBe('Setup complete');
    return 'done';
   },
  };
  const code = await runInteractiveSetup({
   values: {}, readDestination: () => ({api}), withOrigin: (_api, run) => run(), login: async () => {},
  }, {
   createUi: () => ui, resolveRuntime: async client => client === 'antigravity' ? {executable:'/native/agy',desktop:false} : undefined, findConnection: async () => ({name:'opencrawl_opencrawl',skipLogin:false}),
   native: async (command, args) => {
    expect(command).toBe('/native/agy');
    calls.push(args);
    if (calls.length === (retry==='verify'?3:4)) setClient({installed: true, mcp: {state: 'authenticated'}, proof: {state: 'verified'}});
    return 0;
   },
   setup: (action, origin, values, deps) => setupCommand(action, origin, values, {...deps,
    installPlugins: async () => ({results: [{client: 'antigravity', status: 'installed', captureAvailable: true}], humanTasks: []}),
   }),
   pause: async () => { throw Error('Pending native work must offer re-entry'); },
  });
  expect(code).toBe(0);
  expect(calls[0]).toEqual([]);
  expect(calls[1]?.[0]).toBe('--prompt-interactive');
  expect(calls[1]?.[1]).toContain('setup next --api ' + api);
  expect(calls.at(-1)).toEqual(calls[1]);
  if(retry==='connect')expect(calls[2]).toEqual([]);
  expect(screens).toEqual(['Connect Antigravity','Antigravity verification is pending',...(retry==='connect'?['Connect Antigravity']:[]),'Setup complete']);
 }, false, 'antigravity');
});
test('Claude setup separates capture from history and gives the agent one continuation command',async()=>fixture(async(api,dir)=>{
 const history=join(dir,'claude','projects','example','one.jsonl');mkdirSync(join(history,'..'),{recursive:true});writeFileSync(history,JSON.stringify({type:'user',sessionId:'one',uuid:'one',message:{role:'user',content:'fixture past session'}})+'\n');
 let questions=0;
 const result=await setupCommand('run',api,{client:['claude-code']},{interactive:true,choose:async screen=>{questions++;expect(screen.phase).toBe(([1,4,2] as const)[questions-1]!);if(screen.phase===2)expect(screen.items[0].selected).toBe(false);return screen.items.map(item=>({...item,selected:screen.phase===1}));},installPlugins:async(_api,clients)=>{expect(clients).toEqual(['claude-code']);return {results:[{client:'claude-code',status:'installed'}],humanTasks:[]};},launchHistory:()=>({state:'not_started'})});
 expect(questions).toBe(3);expect(result).toMatchObject({client:'claude-code',selections:{plugins:{'claude-code':true},forward:{'claude-code':true},history:{'claude-code':false}}});
 for(const group of ['plugins','forward','history'] as const)expect(readSetupState({api,tenantId:'tenant',userId:'user'})?.selections[group].codex).not.toBe(true);
 expect(result).toMatchObject({agentPrompt:expect.stringContaining('setup next')});
 const next=await setupCommand('next',api,{}, {choose:async()=>{throw new Error('must not ask again');}});
 expect(next).toMatchObject({status:'next_action',nextAction:{actor:'agent',kind:'native_tool',tool:'installation_status'}});
 expect(readSetupState({api,tenantId:'tenant',userId:'user'})?.historyJob).toBeUndefined();
}));
test('structured plan has no enrollment effects; apply requires explicit consent and unchanged history snapshot',async()=>fixture(async(api,dir,observations)=>{
 const plan=await setupCommand('run',api,{json:true});expect(plan).toMatchObject({status:'confirmation_required',historyBenefit});expect(observations).toHaveLength(0);expect(readCaptureConfig()).toBeNull();expect(existsSync(join(dir,'config','setup'))).toBe(false);
 await expect(setupCommand('apply',api,{yes:true})).rejects.toMatchObject({code:'SETUP_CONFIRMATION_REQUIRED'});expect(readCaptureConfig()).toBeNull();
 await expect(setupCommand('apply',api,{yes:true,'plan-id':'changed'})).rejects.toMatchObject({code:'SETUP_PLAN_CHANGED'});expect(observations).toHaveLength(0);
}));
test('the update step retains saved per-agent permissions until edited',()=>fixture(async api=>{
 const scope={api,tenantId:'tenant',userId:'user'};
 await setupCommand('apply',api,{yes:true,plugins:'codex,cursor',forward:'codex,cursor',history:'none'},setupCodex);
 await updateSetupState(scope,state=>({...state!,pluginAutoUpdates:{installationId:state!.installationId!,clients:['cursor']}}));
 const run=(savedClients:string[],updates?:boolean)=>setupCommand('run',api,{}, {...setupCodex,interactive:true,choose:async screen=>{
  if(screen.phase===1)return screen.items.map(row=>({...row,selected:row.id==='codex'||row.id==='cursor'}));
  if(screen.phase!==4)return screen.items;
  expect(screen.items.map(row=>row.id)).toEqual(['codex','cursor']);
  expect(screen.items.filter(row=>row.selected).map(row=>row.id)).toEqual(savedClients);
  return screen.items.map(row=>({...row,selected:updates??row.selected}));
 }});
 await run(['cursor']);
 expect(readSetupState(scope)?.pluginAutoUpdates?.clients).toEqual(['cursor']);
 await run(['cursor'],false);
 await run([]);
 expect(readSetupState(scope)?.pluginAutoUpdates).toBeUndefined();
}));
test('recording Codex can independently import only Claude history after the second confirmation',async()=>fixture(async(api,dir,observations)=>{
 const file=join(dir,'claude','projects','example','claude.jsonl');mkdirSync(dirname(file),{recursive:true});
 writeFileSync(file,JSON.stringify({type:'user',sessionId:'claude-history',uuid:'one',message:{role:'user',content:'past session'}})+'\n');
 const steps:string[]=[],screens:SelectionScreen[]=[],launched:SetupState[]=[];
 const result=await setupCommand('run',api,{}, {interactive:true,choose:async screen=>{
  if(screen.phase===4){
   steps.push('updates');
   expect(screen.items).toMatchObject([{id:'codex',selected:true}]);
   return screen.items;
  }
  screens.push(screen);steps.push('choose:'+screens.length);
  if(screens.length===1){
   expect(readSetupState({api,tenantId:'tenant',userId:'user'})).toBeNull();
   expect(screen.items.find(item=>item.id==='codex')).toMatchObject({label:'Codex'});
   return screen.items.map(item=>({...item,selected:item.id==='codex'}));
  }
  expect(steps).toEqual(['choose:1','updates','install','choose:2']);expect(launched).toHaveLength(0);expect(readSetupState({api,tenantId:'tenant',userId:'user'})?.historyJob).toBeUndefined();expect(screen.description).toBe(historyBenefit);expect(screen.items.map(item=>item.id)).toEqual(['claude-code','codex']);expect(screen.items.every(item=>!item.selected)).toBe(true);return screen.items.map(item=>({...item,selected:item.id==='claude-code'}));
 },installPlugins:async(_api,selected,options)=>{steps.push('install');expect(selected).toEqual(['codex']);expect(readCaptureConfig()).toMatchObject({hookOwnership:'plugin',harnesses:['codex']});expect(readCaptureConfig()?.command).toEqual(options?.command);return {results:[{client:'codex',status:'installed'}],humanTasks:[]};},launchHistory:state=>{steps.push('history');launched.push(state);return {state:'queued',jobId:state.historyJob?.id};}});
 expect(steps).toEqual(['choose:1','updates','install','choose:2','history']);expect(observations).toHaveLength(2);expect(launched[0].historyJob?.files.map(f=>f.path)).toEqual([realpathSync(file)]);expect(readCaptureConfig()).toMatchObject({harnesses:['codex'],historyHarnesses:['claude-code']});expect(formatSetupOutput(result)).toContain('In your primary coding agent');
 expect(readSetupState({api,tenantId:'tenant',userId:'user'})?.pluginAutoUpdates?.clients).toEqual(['codex']);
 for(const file of [join(dir,'codex','hooks.json'),join(dir,'codex','config.toml'),join(dir,'config','opencrawl','capture','runner.sh'),join(dir,'codex','skills','opencrawl','SKILL.md')])expect(existsSync(file)).toBe(false);
}));
test('cancelling the separate update step exits before installing or saving any choice',()=>fixture(async api=>{
 const phases:number[]=[];
 const result=await setupCommand('run',api,{}, {interactive:true,choose:async screen=>{
  phases.push(screen.phase);
  return screen.phase===1?screen.items.map(row=>({...row,selected:row.id==='codex'})):null;
 },installPlugins:async()=>{throw Error('Unexpected installation');}});
 expect(phases).toEqual([1,4]);
 expect(result).toMatchObject({status:'cancelled'});
 expect(readSetupState({api,tenantId:'tenant',userId:'user'})).toBeNull();
 expect(readCaptureConfig()).toBeNull();
}));
test('cancelling history preserves the confirmed clients and never starts a new import',async()=>fixture(async(api)=>{
 let screens=0,launches=0;
 const result=await setupCommand('run',api,{}, {interactive:true,choose:async screen=>screen.phase===4?screen.items:++screens===1?screen.items.map(item=>({...item,selected:item.id==='codex'})):null,installPlugins:async()=>({results:[{client:'codex',status:'installed'}],humanTasks:[]}),launchHistory:()=>{launches++;return {state:'queued'};}});
 const state=readSetupState({api,tenantId:'tenant',userId:'user'});expect(screens).toBe(2);expect(launches).toBe(0);expect(state?.selections.plugins.codex).toBe(true);expect(state?.selections.history.codex).toBe(false);expect(state?.historyJob).toBeUndefined();expect(readCaptureConfig()?.harnesses).toEqual(['codex']);expect(result).toMatchObject({historyDecision:'unchanged'});
}));

test('resume retries pending selected plugins without another selection screen or broader history consent',async()=>fixture(async api=>{
 let chooseCount=0,installs=0;
 const pending=await setupCommand('run',api,{}, {interactive:true,choose:async screen=>{chooseCount++;return screen.items.map(item=>({...item,selected:chooseCount===1&&item.id==='codex'}));},installPlugins:async()=>({results:[{client:'codex',status:'pending'}],humanTasks:[{id:'codex-install',kind:'plugin_install',client:'codex',title:'Install Codex',instruction:'Install Codex, then run setup.'}]}),launchHistory:()=>({state:'not_started'})});
 expect(pending).toMatchObject({status:'needs_attention'});const before=readSetupState({api,tenantId:'tenant',userId:'user'});
 const resumed=await setupCommand('run',api,{yes:true,json:true},{choose:async()=>{throw new Error('Unexpected questionnaire');},installPlugins:async(_api,selected)=>{installs++;expect(selected).toEqual(['codex']);return {results:[{client:'codex',status:'installed'}],humanTasks:[]};},launchHistory:()=>({state:'not_started'})});
 expect(installs).toBe(1);expect(resumed).toMatchObject({status:'configured'});expect(readSetupState({api,tenantId:'tenant',userId:'user'})?.selections.history).toEqual(before?.selections.history);expect(readSetupState({api,tenantId:'tenant',userId:'user'})?.historyJob).toBeUndefined();
}));
test('an existing client retains native reload tasks on resume',async()=>fixture(async api=>{
 await legacySetupCommand('apply',api,{yes:true,plugins:'codex',forward:'none',history:'none'},{installPlugins:async()=>({results:[{client:'codex',status:'installed'}],humanTasks:[]}),launchHistory:()=>({state:'not_started'})});
 await updateSetupState({api,tenantId:'tenant',userId:'user'},state=>({...state!,selections:{plugins:{cursor:true},forward:{cursor:false},history:{cursor:false}}}));
 const result=await setupCommand('run',api,{yes:true,json:true},{installPlugins:async()=>({results:[{client:'cursor',status:'installed'}],humanTasks:[{id:'cursor-reload',kind:'restart',client:'cursor',title:'Reload Cursor',instruction:'Reload Cursor to load the installed local plugin.'}]}),launchHistory:()=>({state:'not_started'})});
 expect(result).toMatchObject({humanTasks:[{id:'cursor-reload',kind:'restart'}]});
 const status=await setupCommand('status',api,{json:true});expect(status).toMatchObject({humanTasks:[{id:'cursor-reload'}]});
}));


test('setup observations request native hook trust only for clients with a trust gate',()=>fixture(async(api,_dir,observations)=>{
 const selected=Object.fromEntries(['claude-code','codex','cursor','antigravity'].map(client=>[client,true]));
 await publishSetup({schemaVersion:1,scope:{api,tenantId:'tenant',userId:'user'},installationId:'fixture-installation',machine:{id:'fixture-machine',label:'fixture'},acceptedAt:new Date().toISOString(),selections:{plugins:selected,forward:selected,history:{}}});
 const clients=(observations[0] as {clients:{client:string;hookTrust:string}[]}).clients;
 expect(Object.fromEntries(clients.map(client=>[client.client,client.hookTrust]))).toEqual({'claude-code':'not_required',codex:'unknown',cursor:'not_required',antigravity:'not_required'});
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

test('saved-choice reconciliation publishes native trust and history progress preserves it',()=>fixture(async(api,_dir,observations)=>{
 const trust=()=>{
  const last=observations.at(-1) as {clients:{client:string;hookTrust:string}[]};
  return last.clients.find(row=>row.client==='codex')?.hookTrust;
 };
 await setupCommand('apply',api,{yes:true,plugins:'codex',forward:'codex',history:'none'},setupCodex);
 expect(trust()).toBe('unknown');
 const approved=async():Promise<CodexHookReview>=>({state:'observed',total:12,pending:0,disabled:0});
 for(const [inspectHooks,expected] of [[approved,'trusted'],[nativeChanged,'pending'],[nativeDisabled,'not_required'],[nativeUnknown,'unknown']] as const){
  await setupCommand('run',api,{yes:true,json:true},{...setupCodex,inspectHooks});
  expect(trust()).toBe(expected);
  const saved=readSetupState({api,tenantId:'tenant',userId:'user'})!;
  await publishSetup(saved);
  expect(trust()).toBe(expected);
 }
}));

test('an agent can report a later native approval without reinstalling or republishing other clients',()=>fixture(async(api,_dir,observations)=>{
 await setupCommand('apply',api,{yes:true,plugins:'codex,claude-code',forward:'codex,claude-code',history:'none'},setupCodex);
 const before=(observations.at(-1) as {clients:{client:string;hookTrust:string}[]}).clients.find(row=>row.client==='codex')!;
 expect(before.hookTrust).toBe('unknown');
 const result=await setupCommand('report-hooks',api,{json:true},{
  inspectHooks:async()=>({state:'observed',total:12,pending:0,disabled:0}),
  installPlugins:async()=>{throw Error('Reporting trust must not reinstall the plugin');}
 });
 expect(result).toMatchObject({status:'hooks_reported',serverChecked:true});
 expect(observations.at(-1)).toMatchObject({clients:[{...before,hookTrust:'trusted'}]});
}));

test('a hook review from another installation, account or recording choice cannot update setup',()=>fixture(async(api,_dir,observations)=>{
 const scope={api,tenantId:'tenant',userId:'user'};
 await setupCommand('apply',api,{yes:true,plugins:'codex',forward:'codex',history:'none'},setupCodex);
 const saved=readSetupState(scope)!;
 const observation={scope,installationId:saved.installationId!,recordingSelected:true,review:{state:'observed' as const,total:12,pending:0,disabled:0}};
 const before=observations.length;
 for(const change of [{installationId:'other-machine'},{scope:{...scope,userId:'other-user'}},{recordingSelected:false}]){
  await expect(publishSetup(saved,fetch,{...observation,...change})).rejects.toMatchObject({code:'SETUP_SCOPE_CHANGED'});
 }
 expect(observations).toHaveLength(before);
}));

test('captured or verified Codex setup stays quiet when native inspection is unavailable or hooks are intentionally disabled',async()=>fixture(async(api,_dir,_observations,setCodex)=>{
 await setupCommand('apply',api,{yes:true,plugins:'codex',forward:'codex',history:'none'},setupCodex);
 for(const evidence of [{captureObservedAt:new Date().toISOString()}, {proof:{state:'verified'}}]){
  setCodex({...evidence,humanTasks:[]});
  for(const inspectHooks of [nativeUnknown,nativeDisabled])for(const action of ['status','run']){
   const result=await setupCommand(action,api,{json:true,yes:action==='run'},{...setupCodex,inspectHooks});
   expect(result).toMatchObject({humanTasks:[]});
  }
 }
}));

test('a search-only Codex plugin never adds capture trust, including stale server tasks and unrelated startup hooks',async()=>fixture(async(api,dir,_observations,setCodex)=>{
 writeFileSync(join(dir,'codex','hooks.json'),JSON.stringify({hooks:{SessionStart:[{hooks:[{type:'command',command:'echo unused fixture',statusMessage:'OpenCrawl session startup'}]}]}}));
 let inspections=0;const inspectHooks=async():Promise<CodexHookReview>=>{inspections++;return {state:'observed',total:1,pending:1,disabled:0};};
 await legacySetupCommand('apply',api,{yes:true,plugins:'codex',forward:'none',history:'none'},{...setupCodex,inspectHooks});
 setCodex({humanTasks:[{id:'stale-capture-trust',kind:'hook_trust',client:'codex',title:'Old recording choice',instruction:'Stale task'}, {id:'mcp-auth',kind:'mcp_auth',client:'codex',title:'Connect MCP',instruction:'Complete native sign-in'}]});
 for(const action of ['status','run']){
  const result=await setupCommand(action,api,{json:true,yes:action==='run'},{...setupCodex,inspectHooks});
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
 expect(await setupCommand('run',api,{yes:true,json:true},{...setupCodex,inspectHooks})).toMatchObject({humanTasks:[],selections:{forward:{codex:false}}});
}));

test('positively observed changed hooks still require review after a previous capture proof',async()=>fixture(async(api,_dir,_observations,setCodex)=>{
 await setupCommand('apply',api,{yes:true,plugins:'codex',forward:'codex',history:'none'},setupCodex);
 setCodex({captureObservedAt:new Date().toISOString(),proof:{state:'verified'},humanTasks:[]});
 for(const action of ['status','run']){
  const result=await setupCommand(action,api,{json:true,yes:action==='run'},{...setupCodex,inspectHooks:nativeChanged});
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
 const plan=await legacySetupCommand('plan',api,{plugins:'codex',forward:'none',history:'none'},dependencies) as {applyCommand:string;planId:string};
 expect(plan.applyCommand).toBe(formatSetupCommand(['setup','apply','--api',api,'--plugins','codex','--forward','none','--history','none','--capture-mode','daemon','--plan-id',plan.planId,'--yes','--json'],command));
 const applied=await legacySetupCommand('apply',api,{yes:true,plugins:'codex',forward:'none',history:'none'},dependencies);
 for(const result of [applied,await setupCommand('run',api,{yes:true,json:true},dependencies)]){
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
  const applied=await legacySetupCommand('apply',api,{yes:true,plugins:'codex',forward:'none',history:'none'},dependencies);
  if(!applied||!('agentPrompt' in applied)||typeof applied.agentPrompt!=='string')throw Error('Expected an agent handoff');
  const resumeCommand=formatSetupCommand(['setup','--yes','--api',api,'--json'],profileSetupCommand(command,join(dir,'config')));
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
   const resumed=await setupCommand('run',api,{yes:true,json:true},{...dependencies,choose:async()=>{throw Error('Unexpected questionnaire');}});
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
 await legacySetupCommand('apply',api,{yes:true,plugins:'codex',forward:'none',history:'none'},dependencies);
 setCodex({mcp:{state:'authenticated'},proof:{state:'verified'},captureObservedAt:new Date().toISOString()});
 for(const action of ['status','run'])expect(await setupCommand(action,api,{json:true,yes:action==='run'},dependencies)).toMatchObject({humanTasks:[{id:'codex-load',kind:'restart'}],selections:{forward:{codex:false}}});
}));

test('resume rechecks previously installed native plugins and a new launcher without expanding saved choices or history',()=>fixture(async(api,dir)=>{
 const first=[join(dir,'first-cli')],next=[join(dir,'new-cli')];
 await legacySetupCommand('apply',api,{yes:true,plugins:'codex',forward:'none',history:'codex'},{...setupCodex,command:first});const before=readSetupState({api,tenantId:'tenant',userId:'user'})!;
 let calls=0;
 const result=await setupCommand('run',api,{yes:true,json:true},{...setupCodex,command:next,choose:async()=>{throw new Error('No new questionnaire');},installPlugins:async(_api,selected,options)=>{calls++;expect(selected).toEqual(['codex']);expect(options?.command).toEqual(next);return {results:[{client:'codex',status:'prepared'}],humanTasks:[{id:'new-bundle-load',kind:'restart',client:'codex',title:'Load the current plugin',instruction:'Reload the native client.'}]};}});
 expect(calls).toBe(1);expect(result).toMatchObject({status:'needs_attention',humanTasks:[{id:'new-bundle-load'}]});
 const after=readSetupState({api,tenantId:'tenant',userId:'user'})!;expect(after.selections).toEqual(before.selections);expect(after.historyJob).toEqual(before.historyJob);expect(readCaptureConfig()?.command).toEqual(next);
}));


test('native hook status respects effective recording opt-outs without inspecting or authenticating',()=>fixture(async api=>{
 await legacySetupCommand('apply',api,{yes:true,plugins:'codex',forward:'none',history:'none'},setupCodex);
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
 const result=await setupCommand('apply',api,{yes:true,'capture-mode':'daemon',plugins:'claude-code,codex',forward:'claude-code,codex',history:'none'},{
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
  const result=await setupCommand('apply',api,{yes:true,'capture-mode':'daemon',plugins:'claude-code,codex',forward:'claude-code,codex',history:'none'},{
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

test('pending plugins defer the service while installed capture plugins enable supported lanes',async()=>fixture(async api=>{
 let launches=0;
 const dependencies={inspectHooks:nativeUnknown,launchHistory:()=>({state:'not_started'}),installDaemon:async()=>{launches++;return {kind:'process',status:'requested',supervised:false,command:[]};}};
 await setupCommand('apply',api,{yes:true,'capture-mode':'daemon',plugins:'claude-code',forward:'claude-code',history:'none'},{...dependencies,installPlugins:async()=>({results:[{client:'claude-code',status:'pending'}],humanTasks:[]})});
 expect(launches).toBe(0);
 for(const choice of [{plugins:'codex',forward:'codex'}, {plugins:'claude-code',forward:'claude-code'}] as const){
  const result=await setupCommand('apply',api,{yes:true,'capture-mode':'daemon',plugins:choice.plugins,forward:choice.forward,history:'none'},{...dependencies,installPlugins:async()=>({results:[{client:choice.plugins,status:'prepared'}],humanTasks:[]})});
  expect(result).toMatchObject({worker:{startup:false,harnesses:[choice.forward]}});
 }
 expect(launches).toBe(2);
}));

test('explicit uninstall stops both lanes and resume restores only selected startup while preserving queues',async()=>fixture(async(api,dir)=>{
 const dependencies={inspectHooks:nativeUnknown,installPlugins:async()=>({results:[{client:'claude-code' as const,status:'prepared' as const}],humanTasks:[]}),launchHistory:()=>({state:'not_started'})};
 await setupCommand('apply',api,{yes:true,'capture-mode':'daemon',plugins:'claude-code',forward:'claude-code',history:'none'},dependencies);
 const scope={api,tenantId:'tenant',userId:'user'},before=readSetupState(scope)!;
 const queue=join(captureDir(),'queue','retained.json'),task=join(captureDir(),'daemon','inbox','startup-retained.json');mkdirSync(join(task,'..'),{recursive:true});writeFileSync(queue,'retained queue');writeFileSync(task,'retained task');
 const stopped=await uninstallCapture(dir);expect(stopped).toMatchObject({backgroundStartupStopped:true,queuedDataPreserved:true});
 expect(readCaptureConfig()).toMatchObject({disabled:true,backgroundStartup:false});expect(readSetupState(scope)?.selections).toEqual(before.selections);
 let launches=0;const result=await setupCommand('run',api,{yes:true,json:true},{...dependencies,installDaemon:async config=>{launches++;expect(config).toMatchObject({disabled:true,backgroundStartup:true,harnesses:[]});return {kind:'process',status:'requested',supervised:false,command:[]};}});
 expect(launches).toBe(1);expect(result).toMatchObject({worker:{startup:true,harnesses:[]}});
 expect(readSetupState(scope)?.selections.plugins).toEqual(before.selections.plugins);expect(readSetupState(scope)?.selections.history).toEqual(before.selections.history);
 expect(readFileSync(queue,'utf8')).toBe('retained queue');expect(readFileSync(task,'utf8')).toBe('retained task');
}));

test('fresh service failure retains legacy capture and explicit registration recovery, then resume activates the same installation',async()=>fixture(async(api,_dir,observations)=>{
 const options={installPlugins:async()=>({results:[{client:'claude-code' as const,status:'prepared' as const}],humanTasks:[]}),launchHistory:()=>({state:'not_started'})};
 const failed=await setupCommand('apply',api,{yes:true,'capture-mode':'daemon',plugins:'claude-code',forward:'claude-code',history:'none'},{...options,installDaemon:async()=>{throw Error('synthetic supervisor refusal');}});
 expect(failed).toMatchObject({status:'needs_attention',worker:{kind:'fallback',supervised:false,startup:false}});
 const before=readCaptureConfig()!;expect(before.captureWorker).toBeUndefined();expect(before).toMatchObject({harnesses:['claude-code'],historyHarnesses:[],backgroundStartup:false,daemonRequested:{backgroundStartup:true}});
 const startup=await sessionStart(api,'claude-code',{session_id:'fallback-session',hook_event_name:'SessionStart',source:'startup'},async()=>{throw Error('Fallback hook must not make network calls');});
 expect(JSON.stringify(startup)).toContain('register this session');expect(JSON.stringify(startup)).not.toContain('background registration is pending');
 const saved=readSetupState({api,tenantId:'tenant',userId:'user'})!;
 const resumed=await setupCommand('run',api,{yes:true,json:true},options);
 expect(resumed).toMatchObject({worker:{supervised:true,startup:true}});
 expect(readCaptureConfig()).toMatchObject({installationId:before.installationId,owner:before.owner,harnesses:before.harnesses,historyHarnesses:[],captureWorker:'daemon-v1',backgroundStartup:true});
 expect(readCaptureConfig()?.daemonRequested).toBeUndefined();expect(readSetupState(saved.scope)?.selections).toEqual(saved.selections);
}));

test('missing Linux user supervision retains fallback and retries saved choices without importing history',async()=>fixture(async api=>{
 const dependencies={inspectHooks:async()=>({state:'observed',total:8,pending:0,disabled:0} as CodexHookReview),installPlugins:async()=>({results:[{client:'codex' as const,status:'installed' as const}],humanTasks:[]}),installDaemon:async()=>({kind:'external',status:'required',supervised:false,command:['/owned/worker'],reason:'No systemd user manager'}),launchHistory:()=>({state:'not_started'})};
 const applied=await setupCommand('apply',api,{yes:true,'capture-mode':'daemon',plugins:'codex',forward:'codex',history:'none'},dependencies);
 expect(applied).toMatchObject({status:'needs_attention',worker:{kind:'fallback',readiness:'pending',supervised:false},humanTasks:[]});
 const saved=readSetupState({api,tenantId:'tenant',userId:'user'})!;
 expect(readCaptureConfig()?.captureWorker).toBeUndefined();
 const resumed=await setupCommand('run',api,{yes:true,json:true},dependencies);
 expect(resumed).toMatchObject({status:'needs_attention',selections:saved.selections,worker:{kind:'fallback'}});
 expect(readSetupState(saved.scope)?.historyJob).toEqual(saved.historyJob);expect(formatSetupOutput(resumed)).toContain('legacy collector');
}));

test('supervised and not-required workers allow configured setup without invented operator tasks',async()=>fixture(async(api)=>{
 for(const worker of [{kind:'systemd',status:'installed',supervised:true,label:'fixture',path:'fixture'},{kind:'not-required',supervised:false,queuedDataPreserved:true}] as const){
  const active=worker.kind!=='not-required';
  const result=await setupCommand('apply',api,{yes:true,'capture-mode':'daemon',plugins:active?'codex':'none',forward:active?'codex':'none',history:'none'},{inspectHooks:async()=>({state:'observed',total:8,pending:0,disabled:0} as CodexHookReview),launchHistory:()=>({state:'not_started'}),installPlugins:async()=>({results:active?[{client:'codex',status:'installed'}]:[],humanTasks:[]}),installDaemon:async()=>worker});
  expect(result).toMatchObject(active?{status:'configured',humanTasks:[],worker:{kind:worker.kind,readiness:'configured'}}:{status:'recording_off',humanTasks:[]});
  expect(formatSetupOutput(result)).not.toContain('supervision is pending');expect((result as {agentPrompt?:string}).agentPrompt??'').not.toContain('host-owned service');
 }
}));


test('fresh macOS and Linux setup offer native agents and reject deferred selections before authentication',async()=>fixture(async(api,dir,_observations,_set,calls)=>{
 mkdirSync(join(dir,'claude'));mkdirSync(join(dir,'cursor'));mkdirSync(join(dir,'agy'));
 for(const platform of ['darwin','linux'] as const){
  const plan=await setupCommand('plan',api,{plugins:'all',forward:'all',history:'all'},{platform}) as {clients:{id:string}[];selections:SetupState['selections']};
  expect(plan.clients.map(row=>row.id).sort()).toEqual(['antigravity','claude-code','codex','cursor']);
  expect(plan.selections.plugins).toEqual({'claude-code':true,codex:true,cursor:true,antigravity:true});
  expect(plan.selections.forward).toEqual({'claude-code':true,codex:true,cursor:true,antigravity:true});
  expect(plan.selections.history).toEqual({'claude-code':false,codex:true,cursor:false,antigravity:false});
 }
 delete process.env.OPENCRAWL_TOKEN;calls.length=0;let login=0;
 for(const values of [{plugins:'devin'},{forward:'devin'},{history:'devin'}])await expect(setupCommand('run',api,values,{interactive:true,login:async()=>{login++;}})).rejects.toMatchObject({code:'SETUP_CLIENT_NOT_AVAILABLE'});
 await expect(setupCommand('run',api,{}, {platform:'win32',interactive:true,login:async()=>{login++;}})).rejects.toMatchObject({code:'SETUP_NOT_AVAILABLE'});
 expect(login).toBe(0);expect(calls).toEqual([]);expect(readCaptureConfig()).toBeNull();expect(existsSync(join(dir,'config','opencrawl','setup'))).toBe(false);
}));

test('manual Cursor MCP can enroll through normal setup without replacing connections or claiming native activation',async()=>fixture(async(api,dir,observations)=>{
 const cursorRoot=join(dir,'cursor'),mcpFile=join(cursorRoot,'mcp.json');mkdirSync(cursorRoot);
 const manual=JSON.stringify({mcpServers:{opencrawl:{url:api+'/mcp'},other:{url:'https://other.example/mcp'}}},null,2)+'\n';writeFileSync(mcpFile,manual);
 const choices={plugins:'cursor',forward:'cursor',history:'none','capture-mode':'daemon'},command=[join(dir,'opencrawl')];
 const dependencies={command,installPlugins:((target,clients,options)=>installSetupPlugins(target,clients,{...options,home:dir,applicationDirs:[],which:()=>null})) as typeof installSetupPlugins};
 const plan=await setupCommand('plan',api,choices) as {planId:string};
 expect(readSetupState({api,tenantId:'tenant',userId:'user'})).toBeNull();expect(readCaptureConfig()).toBeNull();expect(observations).toHaveLength(0);
 const result=await setupCommand('apply',api,{...choices,'plan-id':plan.planId,yes:true},dependencies);
 const state=readSetupState({api,tenantId:'tenant',userId:'user'})!,plugin=join(cursorRoot,'plugins','local',setupPluginIdentity(api).name);
 expect(state.selections).toMatchObject({plugins:{cursor:true,codex:false,'claude-code':false},forward:{cursor:true,codex:false,'claude-code':false},history:{cursor:false,codex:false,'claude-code':false}});
 expect(state.historyJob).toBeUndefined();expect(readCaptureConfig()).toMatchObject({api,hookOwnership:'plugin',captureWorker:'daemon-v1',harnesses:['cursor'],command});
 expect(JSON.parse(readFileSync(join(plugin,'mcp.json'),'utf8'))).toEqual({mcpServers:{opencrawl:{url:api+'/mcp'}}});
 expect(existsSync(join(plugin,'hooks','hooks.json'))).toBe(true);expect(existsSync(join(cursorRoot,'hooks.json'))).toBe(false);
 expect(result).toMatchObject({status:'needs_attention'});expect(state.pluginResults).toEqual([expect.objectContaining({client:'cursor',status:'prepared'})]);expect(readFileSync(mcpFile,'utf8')).toBe(manual);
 await setupCommand('run',api,{yes:true,json:true},dependencies);
 expect(readSetupState(state.scope)?.installationId).toBe(state.installationId);expect(readSetupState(state.scope)?.selections).toEqual(state.selections);expect(readFileSync(mcpFile,'utf8')).toBe(manual);
}));

test('existing deferred choices and bounded completed history survive new Mac offers and off remains off',async()=>fixture(async(api,dir,_observations,_set,calls)=>{
 await legacySetupCommand('apply',api,{yes:true,plugins:'codex',forward:'none',history:'none'},setupCodex);
 const scope={api,tenantId:'tenant',userId:'user'},now=new Date().toISOString();
 const oldFile={harness:'antigravity' as const,path:join(dir,'old-approved.json'),bytes:8,ino:1,mtimeMs:1};
 await updateSetupState(scope,state=>({...state!,selections:{plugins:{'claude-code':false,codex:true,cursor:false,antigravity:true},forward:{'claude-code':false,codex:false,cursor:false,antigravity:false},history:{'claude-code':false,codex:false,cursor:false,antigravity:true}},historyJob:{id:'approved-old-job',clients:['antigravity'],files:[oldFile],state:'complete',completedClients:['antigravity'],createdAt:now,updatedAt:now}}));
 const before=readSetupState(scope)!;calls.length=0;
 await expect(setupCommand('apply',api,{yes:true,plugins:'devin',forward:'none',history:'none'},setupCodex)).rejects.toMatchObject({code:'SETUP_CLIENT_NOT_AVAILABLE'});
 expect(calls).toEqual([]);expect(readSetupState(scope)).toEqual(before);
 // Resuming old search-only choices never turns recording on as a migration side effect.
 await setupCommand('run',api,{yes:true,json:true},{...setupCodex,platform:'linux',installPlugins:async(_api,ids)=>({results:[{client:'codex',status:'installed' as const},{client:'antigravity',status:'installed' as const}],humanTasks:[]})});
 expect(readSetupState(scope)?.historyJob).toEqual(before.historyJob);
 await updateSetupState(scope,state=>({...state!,historyJob:{...state!.historyJob!,state:'paused'}}));
 const paused=readSetupState(scope)!.historyJob;
 await setupCommand('apply',api,{yes:true,plugins:'all',forward:'none',history:'all'},{...setupCodex,platform:'win32',installPlugins:async()=>({results:[{client:'codex',status:'installed'},{client:'antigravity',status:'installed'}],humanTasks:[]})});
 expect(readSetupState(scope)?.historyJob).toEqual(paused);
 const off=await setupCommand('plan',api,{plugins:'none',forward:'none',history:'none'},{platform:'linux'}) as {selections:SetupState['selections']};
 expect(Object.values(off.selections.plugins).every(v=>!v)).toBe(true);expect(Object.values(off.selections.history).every(v=>!v)).toBe(true);
}));

test('the removed resume command cannot create an installation',async()=>fixture(async(api,dir,observations)=>{
 for(const platform of ['darwin','linux','win32'] as const)await expect(setupCommand('resume',api,{yes:true,plugins:'none',forward:'none',history:'codex'},{platform,launchHistory:()=>{throw new Error('Unapproved history worker');},installPlugins:async()=>{throw new Error('Unapproved plugin install');}})).rejects.toMatchObject({code:'INVALID_USAGE'});
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
  {plugins:{codex:true,devin:true},forward:{codex:false,devin:false},history:{codex:false}},
  {plugins:{codex:true,devin:false},forward:{codex:false,devin:true},history:{codex:false}},
  {plugins:{codex:true},forward:{codex:false},history:{codex:false,devin:true}},
 ];
 for(const selections of savedChoices){
  await updateSetupState(scope,()=>({schemaVersion:1,scope,installationId:'orphaned-installation',acceptedAt,selections,historyJob:{id:'retained-approved-job',clients:['devin'],files:[],state:'complete',completedClients:['devin'],createdAt:acceptedAt,updatedAt:acceptedAt}}));
  const before=readSetupState(scope);
  for(const action of ['run','plan','apply']){
   await expect(setupCommand(action,api,action==='apply'?{yes:true}:{},dependencies)).rejects.toMatchObject({code:'SETUP_CLIENT_NOT_AVAILABLE'});
   expect(readSetupState(scope)).toEqual(before);expect(readCaptureConfig()).toBeNull();
  }
 }
 expect(installs).toBe(0);expect(launches).toBe(0);expect(choices).toBe(0);expect(observations).toEqual([]);expect(calls).toHaveLength(9);expect(calls.every(path=>path==='/api/setup')).toBe(true);expect(existsSync(join(dir,'config','opencrawl','capture'))).toBe(false);
 // An interrupted approval containing only available Mac clients still recovers.
 await updateSetupState(scope,()=>({schemaVersion:1,scope,acceptedAt,selections:{plugins:{codex:true},forward:{codex:false},history:{codex:false}}}));
 await setupCommand('run',api,{yes:true,json:true},setupCodex);
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
 const resume=()=>setupCommand('run',api,{yes:true,json:true},{...setupCodex,choose:async()=>{throw Error('Unexpected questionnaire');}});
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
 const result=await setupCommand('apply',api,{yes:true,'capture-mode':'daemon',plugins:'codex',forward:'codex',history:'codex'},{
  installPlugins:async()=>({results:[{client:'codex',status:'installed'}],humanTasks:[]}),
  installDaemon:async()=>{if(failure==='throw')throw Error('unavailable');return {kind:'external',supervised:false,status:'required',command:[]};},
  launchHistory:state=>{started.push(state);return {state:'queued',jobId:state.historyJob?.id};}
 });
 expect(started).toHaveLength(1);expect(started[0]?.historyJob?.clients).toEqual(['codex']);expect(started[0]?.historyJob?.files).toHaveLength(1);
 expect(result).toMatchObject({status:'needs_attention',history:{state:'queued',jobId:started[0]?.historyJob?.id},worker:{kind:'fallback'}});
 expect(readCaptureConfig()).toMatchObject({harnesses:['codex'],historyHarnesses:['codex'],daemonRequested:{backgroundStartup:true}});
}));

for(const choice of [
 {plugins:'codex',forward:'none',history:'none'},
 {plugins:'codex',forward:'none',history:'codex'},
])test('new installs cannot separate installation from capture: '+JSON.stringify(choice),()=>fixture(async(api,_dir,observations)=>{
 await expect(setupCommand('apply',api,{...choice,yes:true},{installPlugins:async()=>{throw Error('Must not install');},launchHistory:()=>{throw Error('Must not import');}})).rejects.toMatchObject({code:'SETUP_CAPTURE_REQUIRED'});
 expect(readCaptureConfig()).toBeNull();expect(readSetupState({api,tenantId:'tenant',userId:'user'})).toBeNull();expect(observations).toEqual([]);
}));

test('declining recording still offers history, and skipping both leaves no installation',()=>fixture(async(api,_dir,observations)=>{
 const dependencies={interactive:true,installPlugins:async()=>{throw Error('Must not install');},installDaemon:async()=>{throw Error('Must not start service');},launchHistory:()=>{throw Error('Must not import');}};
 expect(await setupCommand('run',api,{}, {...dependencies,choose:async()=>null})).toMatchObject({status:'cancelled'});
 const scope={api,tenantId:'tenant',userId:'user'};expect(readSetupState(scope)).toBeNull();
 let questions=0;
 const off=await setupCommand('run',api,{}, {...dependencies,choose:async screen=>{questions++;
  if(screen.phase===1)expect(screen.noneLabel).toBe('Do not record any sessions on this machine');
  else {expect(screen.phase).toBe(2);expect(screen.items.map(item=>item.id)).toEqual(['codex']);}
  return screen.items.map(item=>({...item,selected:false}));}});
 expect(off).toMatchObject({status:'recording_off'});expect(questions).toBe(2);expect(readCaptureConfig()).toBeNull();expect(observations).toEqual([]);
 const saved=readSetupState(scope)!;for(const group of ['plugins','forward','history'] as const)expect(Object.values(saved.selections[group]).every(value=>!value)).toBe(true);
}));

test('history-only interactive setup finishes without installing a recording plugin or waiting for an agent',()=>fixture(async api=>{
 const ui:SetupUi={invite:async()=>{throw Error("Unexpected invite prompt");},
  signal:new AbortController().signal,welcome:async()=>true,hosting:async()=>'cloud',workspace:async()=>null,close:()=>{},progress:()=>{},native:async run=>run(),
  choose:async screen=>screen.items.map(item=>({...item,selected:screen.phase===2&&item.id==='codex'})),
  action:async screen=>{
   expect(screen.description).toBe('Past sessions are importing in the background.');
   expect(screen.details).toEqual(['New-session recording is off.']);
   return 'done';
  },
 };
 const code=await runInteractiveSetup({values:{},readDestination:()=>({api}),withOrigin:(_origin,run)=>run(),login:async()=>{}},{
  createUi:()=>ui,setup:(action,origin,values,deps)=>{
   expect(action).toBe('run');
   return setupCommand(action,origin,values,{...deps,
    installPlugins:async(_api,selected)=>{expect(selected).toEqual([]);return {results:[],humanTasks:[]};},
    installDaemon:async()=>{throw Error('History import must not install background capture');},
    launchHistory:state=>{expect(state.historyJob?.clients).toEqual(['codex']);return {state:'queued'};},
   });
  },
 });
 expect(code).toBe(0);expect(readCaptureConfig()).toMatchObject({harnesses:[],historyHarnesses:['codex'],backgroundStartup:false});
}));

test('changing recording and skipping a new import preserves the approved file snapshot',()=>fixture(async(api,dir)=>{
 const scope={api,tenantId:'tenant',userId:'user'};
 const dependencies={installPlugins:async()=>({results:[],humanTasks:[]}),launchHistory:()=>({state:'queued'})};
 await setupCommand('apply',api,{plugins:'none',forward:'none',history:'codex',yes:true},dependencies);
 const approved=readSetupState(scope)!.historyJob;
 writeFileSync(join(dir,'codex','sessions','later.jsonl'),'{}');
 await setupCommand('run',api,{}, {...dependencies,interactive:true,choose:async screen=>{
  if(screen.phase===2)expect(screen.items.every(item=>!item.selected)).toBe(true);
  return screen.items.map(item=>({...item,selected:false}));
 },launchHistory:()=>{throw Error('Skipping must not restart the worker');}});
 expect(readSetupState(scope)?.historyJob).toEqual(approved);
 expect(readCaptureConfig()).toMatchObject({harnesses:[],historyHarnesses:['codex']});
}));

test('eligible recording installs the service before history without a service question',()=>fixture(async api=>{
 const steps:(number|string)[]=[];
 await setupCommand('run',api,{},{
  interactive:true,modeEligibility:()=>({eligible:true,reason:'Fixture supervisor'}),
  choose:async screen=>{steps.push(screen.phase);return screen.items.map(item=>({...item,selected:screen.phase===1&&item.id==='codex'}));},
  installPlugins:async(_api,_clients,options)=>{expect(options?.captureMode).toBe('daemon');steps.push('plugin');return {results:[{client:'codex',status:'installed',captureAvailable:true,daemonHandoff:true}],humanTasks:[]};},
  installDaemon:async()=>{steps.push('service');return {kind:'launchd',status:'installed',supervised:true,label:'fixture',path:'fixture'};}
 });
 expect(steps).toEqual([1,4,'plugin','service',2]);
 expect(readCaptureConfig()?.backgroundStartup).toBe(true);
 expect(readSetupState({api,tenantId:'tenant',userId:'user'})).toMatchObject({captureMode:'daemon',worker:{supervised:true}});
}));

test('eligible apply requires the service and migrates an older hook installation without losing its queue',()=>fixture(async(api,dir)=>{
 const choices={plugins:'codex',forward:'codex',history:'none'};
 const supported={...setupCodex,modeEligibility:()=>({eligible:true,reason:'Fixture supervisor'})};
 await setupCommand('apply',api,{...choices,yes:true,'capture-mode':'hook'},{...setupCodex,modeEligibility:()=>({eligible:false,reason:'Fixture without service support'})});
 const before=readCaptureConfig(),queue=join(dir,'config/opencrawl/capture/queue/keep.json');
 writeFileSync(queue,'pending bytes');
 expect(await setupCommand('plan',api,choices,supported)).toMatchObject({captureMode:'daemon'});
 await expect(setupCommand('apply',api,{...choices,yes:true,'capture-mode':'hook'},supported)).rejects.toMatchObject({code:'SETUP_DAEMON_REQUIRED'});
 expect(readCaptureConfig()).toEqual(before);
 await setupCommand('run',api,{yes:true,json:true},supported);
 expect(readCaptureConfig()).toMatchObject({installationId:before!.installationId,backgroundStartup:true});
 expect(readFileSync(queue,'utf8')).toBe('pending bytes');
}));

test('unavailable daemon and cancellation before installation make no enrollment changes',()=>fixture(async api=>{
 await expect(setupCommand('apply',api,{yes:true,plugins:'codex',forward:'codex',history:'none','capture-mode':'daemon'},{modeEligibility:()=>({eligible:false,reason:'Unsupported host'})})).rejects.toMatchObject({code:'SETUP_DAEMON_UNAVAILABLE'});
 expect(readCaptureConfig()).toBeNull();
 const answer=await setupCommand('run',api,{}, {interactive:true,modeEligibility:()=>({eligible:true,reason:'Fixture'}),choose:async screen=>screen.phase===4?null:screen.items.map(row=>({...row,selected:row.id==='codex'}))});
 expect(answer).toMatchObject({status:'cancelled'});expect(readCaptureConfig()).toBeNull();
 expect(readSetupState({api,tenantId:'tenant',userId:'user'})).toBeNull();
}));

// Enable on the Mac proof host with the verified public release directory.
// Both the CLI and the fake version command run under the fixture's disposable HOME.
test.skipIf(!process.env.OPENCRAWL_TEST_CURSOR_RELEASE_DIR||process.platform!=='darwin'||process.arch!=='arm64')('published Cursor apply and resume use the normal CLI and publish scoped observations',()=>fixture(async(api,dir,observations,setClient)=>{
 const release=publishedPlugins.packageRelease('cursor')!,platform='darwin-arm64',pin=release.archives![platform]!;
 const cache=join(dir,'config','opencrawl','setup','packages',release.ref??pluginRelease.ref,'cursor',platform);
 mkdirSync(cache,{recursive:true});
 for(const [url,file] of [[pin.url,pin.sha256+'.zip'],[pin.metadataUrl,pin.metadataSha256+'.json']] as const){
  copyFileSync(join(process.env.OPENCRAWL_TEST_CURSOR_RELEASE_DIR!,new URL(url).pathname.split('/').pop()!),join(cache,file));
 }
 writeFileSync(join(dir,'cursor-agent'),'#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = "--version" ] || exit 1\necho '+release.minimumHarnessVersion+'\n',{mode:0o755});
 const preload=join(dir,'offline.ts');
 writeFileSync(preload,'const fetchLocal = globalThis.fetch; globalThis.fetch = (url, init) => { if(new URL(url).origin !== '+JSON.stringify(api)+') throw Error("Only the fixture server is available"); return fetchLocal(url, init); };');
 const env={...process.env,SSH_CONNECTION:'fixture',CURSOR_CONFIG_DIR:join(dir,'.cursor'),OPENCRAWL_NO_UPDATE:'1'};
 const run=async(args:string[])=>{
  const child=Bun.spawn([process.execPath,'--preload',preload,join(import.meta.dir,'../src/cli.ts'),'setup',...args,'--api',api,'--json'],{env,stdout:'pipe',stderr:'pipe'});
  const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  if(code!==0)throw Error('Fixture CLI returned '+code+' '+stderr+' '+stdout);
  const envelope=JSON.parse(stdout);expect(envelope.schemaVersion).toBe(1);return envelope.data;
 };
 const initial=await run(['apply','--plugins','cursor','--forward','cursor','--history','none','--capture-mode','hook','--yes']);
 expect(initial).toMatchObject({status:'needs_attention',plugins:[{client:'cursor',status:'prepared'}],nextAction:{kind:'native_tool'}});
 expect(observations.at(-1)).toMatchObject({clients:expect.arrayContaining([expect.objectContaining({client:'cursor',installed:false,pluginState:'prepared'})])});
 const preReceipt=await run(['--yes']);expect(preReceipt.plugins[0].preparedAt).toBe(initial.plugins[0].preparedAt);
 setClient({captureObservedAt:new Date().toISOString(),mcp:{state:'authenticated'},proof:{state:'verified'}});
 expect(await run(['--yes'])).toMatchObject({installationId:initial.installationId,plugins:[{client:'cursor',status:'unchanged'}],nextAction:{kind:'complete'}});
 expect(observations.at(-1)).toMatchObject({clients:expect.arrayContaining([expect.objectContaining({client:'cursor',installed:true,pluginState:'installed'})])});
},true,'cursor'),60000);

async function expectUnavailableCursorPin(api:string){
 const entry=publishedPlugins.packageRelease('cursor')!;
 const pin=spyOn(publishedPlugins,'packageRelease').mockReturnValue({...entry,captureAvailable:false});
 try{await expect(realSetupCommand('run',api,{yes:true,json:true})).rejects.toMatchObject({code:'PLUGIN_CAPTURE_UNAVAILABLE'});}
 finally{pin.mockRestore();}
}

test('published stub preserves a previously working installation before any mutation',()=>fixture(async api=>{
 await setupCommand('apply',api,{yes:true,plugins:'cursor',forward:'cursor',history:'none'},{...setupCodex,installPlugins:async()=>({results:[{client:'cursor',status:'installed'}],humanTasks:[]})});
 const before=readCaptureConfig(),saved=readSetupState({api,tenantId:'tenant',userId:'user'});
 await expectUnavailableCursorPin(api);
 expect(readCaptureConfig()).toEqual(before);expect(readSetupState({api,tenantId:'tenant',userId:'user'})).toEqual(saved);
}));

test('development pin cannot downgrade an earlier capture-capable public package',()=>fixture(async api=>{
 await setupCommand('apply',api,{yes:true,plugins:'cursor',forward:'cursor',history:'none'},{...setupCodex,installPlugins:async()=>({results:[{client:'cursor',status:'installed'}],humanTasks:[]})});
 const scope={api,tenantId:'tenant',userId:'user'};
 await updateSetupState(scope,current=>({...current!,pluginResults:[{client:'cursor',status:'installed',captureAvailable:true,source:{repository:'getopencrawl/opencrawl-plugins',ref:'a'.repeat(40),path:'local/cursor',name:'opencrawl-local-cursor',version:'0.1.0'}}]}));
 const before=readCaptureConfig(),saved=readSetupState(scope);
 await expectUnavailableCursorPin(api);
 expect(readCaptureConfig()).toEqual(before);expect(readSetupState(scope)).toEqual(saved);
}));

test('a saved daemon choice on an ineligible host remains selected but cannot claim supervision',()=>fixture(async api=>{
 await setupCommand('apply',api,{yes:true,plugins:'codex',forward:'codex',history:'none','capture-mode':'daemon'},setupCodex);
 let installs=0;
 const resumed=await setupCommand('run',api,{yes:true,json:true}, {...setupCodex,modeEligibility:()=>({eligible:false,reason:'Unsupported host'}),installDaemon:async()=>{installs++;throw Error('Must not install on this host');}});
 expect(installs).toBe(0);expect(resumed).toMatchObject({captureMode:'daemon',status:'needs_attention',worker:{kind:'unavailable',readiness:'pending',supervised:false},nextAction:{kind:'repair_worker'}});
 expect(readSetupState({api,tenantId:'tenant',userId:'user'})?.captureMode).toBe('daemon');
}));

test('failed daemon stop cannot leave a green saved worker observation',()=>fixture(async api=>{
 await setupCommand('apply',api,{yes:true,plugins:'codex',forward:'codex',history:'none','capture-mode':'daemon'},setupCodex);
 await expect(setupCommand('apply',api,{yes:true,plugins:'codex',forward:'codex',history:'none','capture-mode':'hook'},{...setupCodex,modeEligibility:()=>({eligible:false,reason:'Unsupported host'}),stopDaemon:()=>{throw Error('stop refused');}})).rejects.toThrow('stop refused');
 expect(readSetupState({api,tenantId:'tenant',userId:'user'})?.worker).toMatchObject({kind:'configuring',supervised:false});
 expect(await setupCommand('next',api,{})).toMatchObject({nextAction:{kind:'repair_worker'}});
}));
