import {setTimeout as delay} from 'node:timers/promises';
import {CliError,apiOrigin,DEFAULT_API_ORIGIN} from '../oauth.ts';
import {filesystemError} from '../filesystem.ts';
import {offerInvitations} from './invites.ts';
import {nativeSetupPrompt,setupCommand} from './command.ts';
import {launchClaudeSetup} from './claude-launch.ts';
import {launchCodexSetup} from './codex-launch.ts';
import {launchAntigravitySetup} from './antigravity-launch.ts';
import type {SetupUi} from './tui.tsx';
import {labels,type PluginClient} from './plugins.ts';
import {findSetupConnection,nativeConnectionPrompt,type NativeClient} from './native-mcp.ts';
import {nativeLogin} from './native-login.ts';
import {nativeTerminal} from './native-terminal.ts';
import {inspectCodexHooks,type CodexHookReview} from '../capture/codex-hooks.ts';
import {readCaptureConfig} from '../capture/runtime.ts';

type Options={entry?:()=>ReturnType<typeof import('./entry.ts').terminalSetupEntry>;values:Record<string,unknown>;readDestination:()=>{api?:string;explicit?:string};withOrigin:(api:string|undefined,run:()=>Promise<number>)=>Promise<number>;login:(api:string,ui:SetupUi)=>Promise<unknown>};
type Dependencies={findConnection?:typeof findSetupConnection;createUi?:()=>SetupUi;setup?:typeof setupCommand;which?:(name:string)=>string|null;native?:(command:string,args:string[],ui:SetupUi,title?:string)=>Promise<number>;inspectCodex?:()=>Promise<CodexHookReview>;pause?:(signal:AbortSignal)=>Promise<void>};

async function currentCodexReview():Promise<CodexHookReview>{
 const root=readCaptureConfig()?.roots.codex;
 return root?inspectCodexHooks(root):{state:'unknown',total:0,pending:null,disabled:null};
}

async function nativeCommand(command:string,args:string[],ui:SetupUi,title?:string):Promise<number>{
 if(args[0]!=='mcp')return ui.native(()=>nativeTerminal(command,args));
 return nativeLogin(command,args,ui,title);
}

async function reviewCodexHooks(executable:string,ui:SetupUi,native:typeof nativeCommand,inspect:typeof currentCodexReview){
 let surface:'cli'|'desktop'|undefined;
 for(;;){
  const review=await inspect();
  ui.signal.throwIfAborted();
  if(review.state==='observed'&&review.total>0&&review.pending===0&&review.disabled===0)return surface??'cli';
  const choice=await ui.action({
   title:'Review Codex hooks',
   description:surface?'Waiting for Codex to confirm the OpenCrawl hooks are enabled.':'Review the OpenCrawl hooks for session recording.',
   details:[
    'In Codex Desktop, open Settings → Hooks and review the OpenCrawl entries. Then return here and choose Continue in Desktop.',
    'In Codex CLI, review the entries with /hooks, then type /quit to return here.'
   ],
   actions:[{id:'desktop',label:'Continue in Desktop'},{id:'review',label:'Open Codex CLI'},{id:'later',label:'Finish later'}]
  });
  if(choice!=='desktop'&&choice!=='review')return choice==='later'?0:2;
  surface=choice==='desktop'?'desktop':'cli';
  if(surface==='cli'&&await native(executable,[],ui,'Review Codex hooks')!==0)return 2;
  ui.signal.throwIfAborted();
 }
}

async function connectNativeClient(
 client:NativeClient, executable:string, api:string, ui:SetupUi,
 needsLogin:boolean, retryAntigravity:boolean, native:typeof nativeCommand, findConnection:typeof findSetupConnection
):Promise<number|undefined>{
 const label=labels[client];
 const execute=(command:string,args:string[])=>native(command,args,ui,'Connect '+label);
 ui.progress('Checking '+label,'Finding the OpenCrawl connection for this workspace.');
 const connection=await findConnection(client,executable,api);
 ui.signal.throwIfAborted();
 needsLogin=needsLogin&&!connection.skipLogin;
 const prompt=nativeConnectionPrompt(nativeSetupPrompt(api,client),connection.name,api);
 if(client==='antigravity'){
  if(retryAntigravity){
   const retry=await ui.action({title:'Antigravity verification is pending',description:'Reopen Antigravity to check the connection or sign in again.',actions:[{id:'verify',label:'Retry verification'},{id:'connect',label:'Review connection'},{id:'later',label:'Finish later'}]});
   if(retry!=='verify'&&retry!=='connect')return retry==='later'?0:2;
   needsLogin=retry==='connect';
  }
  const code=await launchAntigravitySetup(executable,connection.name,prompt,needsLogin,ui,execute);
  if(code!==0||ui.signal.aborted)return code||130;
 }else{
  const codex=client==='codex';
  const handoff=codex?{
   description:needsLogin?'Press Enter to open the sign-in page in your browser.':'Press Enter to open Codex and check the connection.',
   details:[...(needsLogin?['Approve access, then return to this terminal.','Codex will open and check the connection for you.','']:[]),'When Codex says it’s connected, type /quit to return to setup.'],
   button:needsLogin?'Open browser':'Open Codex',
  }:{
   description:needsLogin?'Approve access in your browser. A Claude Code session will then open in this terminal.':'A Claude Code session will open in this terminal.',
   details:['OpenCrawl will pause while Claude checks the connection.','When Claude says it’s connected, press Ctrl+C to close the session and continue setup.'],
   button:needsLogin?'Sign in and open Claude Code':'Open Claude Code',
  };
  const choice=await ui.action({
   title:'Connect '+label+' to OpenCrawl',description:handoff.description,details:handoff.details,
   actions:[{id:'connect',label:handoff.button},{id:'later',label:'Finish later'}]
  });
  if(choice!=='connect')return choice==='later'?0:2;
  const options={server:connection.name,prompt,needsLogin};
  const notify=(message:string)=>ui.progress('Continue in '+label,message);
  const code=codex?await launchCodexSetup(executable,options,execute,notify)
   :await launchClaudeSetup(executable,{...options,returnToSetup:true},execute,notify);
  if(ui.signal.aborted)return 130;
  if(code!==0)throw new CliError('NATIVE_SETUP_PENDING',label+' did not finish connecting. Retry to use your saved choices.',code);
 }
}

export async function showDeviceCode(ui:Pick<SetupUi,'action'|'progress'>,url:string,code:string,canOpenBrowser:boolean){
 const title='Sign in to OpenCrawl';
 const details=[`Device code: ${code}`,url];
 if(canOpenBrowser){
  const choice=await ui.action({title,description:'Press Enter to open your browser, then check that the codes match.',details,actions:[{id:'open',label:'Open browser'},{id:'cancel',label:'Cancel'}]});
  if(choice!=='open')throw new CliError('SETUP_CANCELLED','Sign-in cancelled.',130);
 }
 ui.progress(title,canOpenBrowser?'Confirm the code in your browser.':'Open this link in your browser and confirm the code.',details);
}

export async function runInteractiveSetup(options:Options,{createUi,setup=setupCommand,which=Bun.which,findConnection=findSetupConnection,native=nativeCommand,inspectCodex=currentCodexReview,pause=async signal=>{await delay(3000,undefined,{signal});}}:Dependencies={}){
 const ui=createUi?createUi():(await import('./tui.tsx')).createSetupUi();
 let destination:ReturnType<Options['readDestination']>|undefined;
 try{
  const entry=options.entry?.();
  if(!await ui.welcome())return 0;
  if(entry)await entry.save(entry.api);
  for(;;){
   try{
    if(!destination){
     destination=options.readDestination();
     if(!destination.explicit&&entry?.api)destination={api:entry.api};
    }
    while(!destination.api){
     const hosting=await ui.hosting();
     if(hosting===null)return 0;
     if(hosting==='cloud'){destination={api:DEFAULT_API_ORIGIN,explicit:DEFAULT_API_ORIGIN};break;}
     const answer=await ui.workspace();
     if(answer===null)return 0;
     if(answer.kind==='back')continue;
     destination={api:answer.api,explicit:answer.api};
    }
    const api=apiOrigin(destination.api??''),explicit=destination.explicit;
    destination={api,explicit};
    await entry?.save(api);
    ui.progress('Connecting to your workspace','Checking your sign-in and available agents.',[api]);
    return await options.withOrigin(explicit,async()=>{
     const onProgress=(title:string,description:string,phase?:'installing')=>ui.progress(title,description,undefined,phase==='installing');
     let finishedHistoryChoice=false;
     const choose:SetupUi['choose']=async screen=>{
      const selection=await ui.choose(screen);
      if(screen.phase===2&&selection!==null)finishedHistoryChoice=true;
      return selection;
     };
     const result=await setup('run',api,options.values,{interactive:true,choose,onProgress,login:()=>options.login(api,ui)});
     if(ui.signal.aborted)return 130;
     if(!result||'status' in result&&result.status==='cancelled')return 0;
     if(finishedHistoryChoice && 'scope' in result && result.scope){
      await offerInvitations(result.scope,ui);
      if(ui.signal.aborted)return 130;
     }
     if('status' in result&&result.status==='recording_off'){
      await entry?.finish();
      await ui.action({title:'Setup saved',description:'No sessions will be recorded on this machine. No history import was started.',actions:[{id:'done',label:'Done'}]});return 0;
     }
     const history='history' in result?result.history:undefined;
     if('selections' in result&&result.selections&&!Object.values(result.selections.plugins).some(Boolean)){
      const state=history&&typeof history==='object'&&'state' in history?history.state:undefined;
      const description=state==='complete'?'Your history import is complete.':state==='queued'||state==='running'?'Past sessions are importing in the background.':'Check setup status for your history import.';
      await entry?.finish();
      await ui.action({title:'Setup saved',description,details:['New-session recording is off.'],actions:[{id:'done',label:'Done'}]});
      return 0;
     }
     let displayedInstruction:string|undefined;
     const reconciled=new Set<string>();
     let lastLaunched:string|undefined;
     let useCodexDesktop=false;
     ui.progress('Checking setup','Waiting for native connection and session verification.');
     for(;;){
      let next=await setup('wait',api,{json:true},{interactive:false,finishOnboarding:true});
      if(ui.signal.aborted)return 130;
      if(next&&'nextAction' in next&&next.nextAction?.kind==='repair_worker'){
       displayedInstruction=undefined;
       const status=await setup('status',api,{json:true},{interactive:false});
       const worker=status&&'worker' in status?status.worker:undefined;
       const action=await ui.action({title:'Background capture needs attention',description:worker?.reason??next.nextAction.instruction,error:true,actions:[{id:'direct',label:'Record without a background service'},{id:'retry',label:'Retry service'},{id:'close',label:'Close'}]});
       if(action!=='retry'&&action!=='direct')return 2;
       ui.progress(action==='direct'?'Keeping session recording':'Starting background capture',action==='direct'?'Removing the background service. Your recording choices and queued uploads are kept.':'Retrying the service with your saved choices.',undefined,true);
       const repaired=await setup('run',api,{yes:true,json:true},{interactive:false,onProgress,...(action==='direct'?{confirmedCaptureMode:'hook' as const}:{})});
       if(!repaired)return 2;
       continue;
      }
      if(next&&'nextAction' in next&&next.nextAction?.kind==='reconcile_activation'&&!reconciled.has(next.nextAction.client)){
       reconciled.add(next.nextAction.client);
       displayedInstruction=undefined;
       ui.progress('Finishing setup','Saving the verified native installation.');
       await setup('run',api,{yes:true,json:true},{interactive:false});
       next=await setup('wait',api,{json:true},{interactive:false,finishOnboarding:true});
      }
      if(ui.signal.aborted)return 130;
      if(next&&'nextAction' in next&&(next.nextAction?.kind==='repair_plugin'||next.nextAction?.kind==='plugin_unavailable')){
       const names=next.nextAction.deferredClients.map(id=>labels[id as PluginClient]??id);
       const importing=history&&typeof history==='object'&&'state' in history&&['queued','running'].includes(history.state);
       await entry?.finish();
       await ui.action({title:'Setup saved',description:'Recording setup is pending for '+names.join(', ')+'.',details:[...(importing?['Past sessions are importing in the background.']:[]),'Run opencrawl setup to retry later.'],actions:[{id:'done',label:'Done'}]});
       return 0;
      }
      if(next&&'nextAction' in next&&next.nextAction?.kind==='complete'){
       await entry?.finish();
       await ui.action({title:'Setup complete',description:'Your selected agents are connected and verified.',details:['New-session recording is ready.',...(history&&typeof history==='object'&&'state' in history&&['queued','running'].includes(history.state)?['Past sessions are importing in the background.']:[])],actions:[{id:'done',label:'Done'}]});return 0;
      }
      const step=next&&'nextAction' in next?next.nextAction:undefined;
      const client=step?.kind==='native_tool'?step.arguments.client:step&&'client' in step?step.client:undefined;
      const binary=client==='claude-code'?'claude':client==='codex'?'codex':client==='antigravity'?'agy':undefined;
      const executable=binary&&which(binary);
      const recordsCodex=client==='codex'&&next&&'selections' in next&&next.selections?.forward.codex;
      if(step?.kind==='native_tool'&&recordsCodex&&executable&&!useCodexDesktop){
       const surface=await reviewCodexHooks(executable,ui,native,inspectCodex);
       if(typeof surface==='number')return surface;
       useCodexDesktop=surface==='desktop';
      }
      const desktop=client==='codex'&&useCodexDesktop;
      const label=desktop?'Codex Desktop':labels[client as PluginClient]??client;
      if(step?.kind==='native_tool'&&executable&&!desktop&&(client==='claude-code'||client==='codex'||client==='antigravity')){
       displayedInstruction=undefined;
       const code=await connectNativeClient(client,executable,api,ui,step.requiresSignIn,lastLaunched===client,native,findConnection);
       if(code!==undefined)return code;
       lastLaunched=client;
       ui.progress('Checking setup','Checking the connection to '+label+'.');
       continue;
      }
      let title:string,description:string,details:string[]=[];
      if(label&&(step?.kind==='native_tool'||step?.kind==='review_setup')){
       title='Open '+label;
       description='Start a new chat in '+label+' and send this message.';
       details=['Finish OpenCrawl setup for '+api+' using my saved choices.','','Keep this terminal open. Setup will continue when '+label+' connects.'];
       if(recordsCodex&&!desktop)
        details.push('Review OpenCrawl hooks in Codex Desktop under Settings → Hooks, or in Codex CLI with /hooks.');
      }else if(label&&step?.kind==='wait_capture'){
       title='Checking '+label;
       description='OpenCrawl is checking that it can find the new session. You can leave this terminal open.';
      }else{
       const retry=await ui.action({title:'Check the installation',description:'Your choices are saved. Retry to check the installation again.',actions:[{id:'retry',label:'Retry'},{id:'later',label:'Finish later'}]});
       if(retry!=='retry')return retry==='later'?0:2;
       if(client)reconciled.delete(client);
       continue;
      }
      const instruction=JSON.stringify([title,description,details]);
      if(displayedInstruction!==instruction){
       ui.progress(title,description,details);
       displayedInstruction=instruction;
      }
      await pause(ui.signal);
     }
    });
   }catch(error){
    if(ui.signal.aborted||error instanceof CliError&&error.code==='SETUP_CANCELLED')return 130;
    const failure=filesystemError(error),known=failure instanceof CliError;
    const action=await ui.action({title:'Setup needs attention',description:known?failure.message:'Setup could not finish. Your saved choices are kept. Retry when ready.',error:true,actions:[{id:'retry',label:'Retry'},{id:'address',label:'Change workspace'},{id:'close',label:'Close'}]});
    if(action==='address'){destination={};await entry?.save();continue;}
    if(action!=='retry')return known?failure.exitCode:1;
   }
  }
 }finally{ui.close();}
}
