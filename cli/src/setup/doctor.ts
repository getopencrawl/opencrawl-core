import {dirname,join} from 'node:path';
import {statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {compiled,delegateToNewest,read,version} from '../distribution.ts';
import {updateCli} from '../update.ts';
import {CliError,DEFAULT_API_ORIGIN,apiOrigin} from '../oauth.ts';
import {atomicJson,configDir,withSessionLock} from '../session.ts';
import {workspaceIdentityEnabled} from '../workspace-identity.ts';
import {withEnvironmentTokenOrigin} from '../environment-token.ts';
import {captureDir,captureIdentity,readCaptureConfig,type CaptureConfig} from '../capture/runtime.ts';
import {verifyInstallation} from '../verify-installation.ts';
import {readServerSetup,serverScope,publishSetup} from './api.ts';
import {chosen,scopeKey,automaticUpdateClients,readSetupState,updateSetupState,type SetupState} from './state.ts';
import {unboundSetupComplete} from './first-run.ts';
import {localSetupStatus,setupHookStatus} from './command.ts';
import {refreshManagedPlugins} from './plugin-updates.ts';
import {setupPluginIdentity,recordingInstallState} from './plugins.ts';
import {acceptedPackageSource,installPublishedSetupPlugins,loadAcceptedPackage,packageRelease,type LocalPluginClient} from './published-plugins.ts';
import {settlePromotion} from './plugin-promotion.ts';
import {doctorWorker} from './doctor-worker.ts';

const exits={green:0,needs_human:2,needs_agent:3,retry:75,blocked:1} as const;
type Status=keyof typeof exits;
type Action={kind:string;instruction:string;client?:string;tool?:string;arguments?:Record<string,string>;message?:string};
type Issue={status:Exclude<Status,'green'>;action:Action};
type App={desired:'recording'|'connected';observed:string;desiredVersion?:string;installedVersion?:string;availableVersion?:string;verifiedAt?:string;sessionId?:string};
type Report={cliVersion:string;apps:Record<string,App>;repairs:string[];issues:Issue[];worker?:string;recordingOff?:boolean};
function issue(status:Issue['status'],kind:string,instruction:string,extra:Partial<Action>={}):Issue{return {status,action:{kind,instruction,...extra}};}
const setupNeeded=()=>issue('needs_human','choose_setup','Run opencrawl setup and choose the apps and recording settings for this machine.');
function failure(error:unknown):Issue{
  const code=error instanceof CliError?error.code:'';
  if(['AUTH_REQUIRED','NOT_LOGGED_IN','NO_SESSION','LOGIN_REQUIRED','SESSION_EXPIRED'].includes(code))
    return workspaceIdentityEnabled()?issue('blocked','repair_identity','Restore the configured workload identity for this host.'):issue('needs_human','sign_in','Run opencrawl login for the saved workspace, then rerun doctor.');
  if(code==='SETUP_NOT_STARTED')return setupNeeded();
  if(['SESSION_BUSY','SETUP_CHANGED','SETUP_UNAVAILABLE','NETWORK_ERROR','CAPTURE_RETRY_EXHAUSTED','SEARCH_UNAVAILABLE','UPDATE_UNAVAILABLE','CONTENT_CHANGED','NOT_FOUND'].includes(code)||
     error instanceof Error&&(/Timeout|Abort|fetch failed|network|socket|connect/i.test(error.name+' '+error.message)))return issue('retry','retry','Retry the check after the current operation or service recovers.');
  return issue('blocked',code.toLowerCase()||'check_failed',error instanceof CliError?error.message:'The host check failed. Inspect the local installation and rerun doctor.');
}
function outcome(report:Report,api?:string){
  const first=(['needs_human','needs_agent','blocked','retry'] as const).flatMap(status=>report.issues.filter(row=>row.status===status))[0];
  const {issues,...observations}=report,status:Status=first?first.status:'green';
  const resume=['opencrawl','doctor',...(api?['--api',api]:[]),'--json'];
  const nextAction=first?{actor:status==='needs_human'?'human':status==='needs_agent'?'agent':status==='retry'?'caller':'operator',...first.action,resume}:undefined;
  const data={schemaVersion:1,status,...observations,...(issues.length>1?{issues}:{}),...(nextAction?{nextAction}:{}),...(status==='retry'?{retryAfterSeconds:10}:{})};
  const human=[!first?(report.recordingOff?'Green. Recording is off as requested.':'Green. All selected apps are ready.'):status.replaceAll('_',' '),
    ...Object.entries(report.apps).map(([name,row])=>name+' — '+row.observed+(row.installedVersion?' ('+row.installedVersion+')':'')),
    ...report.repairs.map(item=>'Repaired '+item.replaceAll('_',' ')),nextAction?.instruction,
    ...(nextAction?.tool?[nextAction.tool+' '+JSON.stringify(nextAction.arguments)]:[]),...(nextAction?.message?[nextAction.message]:[]),
    ...(status==='retry'?['Retry in 10 seconds.']:[])].filter(Boolean).join('\n');
  return {data,human,exit:exits[status]};
}
type Local=ReturnType<typeof localSetupStatus>;
function assertSame(local:Local){
  const current=localSetupStatus(local.scope.api);
  if(current.installationId!==local.installationId||scopeKey(current.scope)!==scopeKey(local.scope)||
     !isDeepStrictEqual(current.selections,local.selections)||current.captureMode!==local.captureMode)
    throw new CliError('SETUP_SCOPE_CHANGED','The saved installation or its choices changed. Rerun doctor.');
}
async function inspectClient(state:SetupState,config:CaptureConfig,local:Local,client:LocalPluginClient,app:App,report:Report,updates:Awaited<ReturnType<typeof refreshManagedPlugins>>,proofSupported:boolean,permissionRevision?:string){
  const api=state.scope.api,recording=app.desired==='recording',installationId=local.installationId!;
  const pin=packageRelease(client)!,auto=automaticUpdateClients(state).includes(client);
  let prior=state.pluginResults?.find(row=>row.client===client);
  app.desiredVersion=auto?pin.version:prior?.source?.version??pin.version;
  app.installedVersion=prior?.source?.version;
  if(!auto&&app.installedVersion&&pin.version!==app.installedVersion)app.availableVersion=pin.version;
  const root=join(configDir(),'setup-plugins',client,setupPluginIdentity(api).key);
  const fail=(status:Issue['status'],kind:string,instruction:string)=>{app.observed=kind;report.issues.push(issue(status,kind,instruction,{client}));};
  const retained=read(join(root,'pending-verification.json'));
  const directoryClient=client==='claude-code'||client==='cursor'?client:undefined;
  if(directoryClient&&retained?.decision){
    const result=await settlePromotion(state,directoryClient,retained.nextDigest,'resume');
    if(result==='rolled_back'){report.repairs.push('restored_'+client+'_plugin');return fail('blocked','update_rolled_back','The previous package was restored. The rejected release is held until a different pin is available.');}
  }
  let native=await recordingInstallState(api,client,prior?.status);
  if(native==='repair'&&directoryClient&&retained&&!retained.decision){
    // Only exchange intact, exclusively managed directories. A declined trust
    // prompt and delayed indexing are never treated as a verification failure.
    if(await settlePromotion(state,directoryClient,retained.nextDigest,'rollback')==='rolled_back'){
      app.installedVersion=retained.previous.source.version;
      report.repairs.push('restored_'+client+'_plugin');
      return fail('blocked','update_rolled_back','The native installation check failed. The previous plugin was restored and the failing pin is held.');
    }
  }
  if(native==='new'||native==='repair'){
    // Repair an enrolled release only when this CLI can authenticate its exact archive.
    // A missing or corrupt older release must never implicitly accept the newer pin.
    if(prior&&!prior.source&&['installed','unchanged','prepared'].includes(prior.status))return fail('blocked','legacy_release','Setup must identify the accepted release before this legacy installation can be repaired.');
    assertSame(local);
    const accepted=prior?.source;
    const repaired=await installPublishedSetupPlugins(api,[client],{command:config.command,captureMode:local.captureMode,
      ...(accepted?{loadPackage:()=>loadAcceptedPackage(client,accepted)}:{})});
    const row=repaired.results[0];
    if(!row||!['installed','prepared','unchanged'].includes(row.status))return fail('blocked','plugin_repair_failed',row?.message??'The native client could not install the verified package.');
    await updateSetupState(state.scope,current=>{
      if(current?.installationId!==installationId||current.acceptedAt!==state.acceptedAt)throw new CliError('SETUP_CHANGED','Setup changed during repair.');
      return {...current,pluginResults:[...(current.pluginResults??[]).filter(item=>item.client!==client),row]};
    });
    prior=row;report.repairs.push('repaired_'+client+'_plugin');
    native=await recordingInstallState(api,client,row.status);
  }
  if(native!=='installed')return fail('blocked','native_plugin_unconfirmed','Inspect the OpenCrawl plugin entry in '+client+' for a disabled plugin, source conflict, or missing client.');
  const installed=read(join(root,'installed.json'));
  const source=read(join(installed.nativeRoot,'.opencrawl-source.json')),binding=read(join(installed.nativeRoot,'.opencrawl-binding.json'));
  if(!prior?.source||!isDeepStrictEqual(prior.source,source)||!acceptedPackageSource(client,prior.source)||
    binding?.api!==api||binding.client!==client||binding.configHome!==dirname(configDir())||binding.installationId!==installationId||
    binding.owner?.tenantId!==state.scope.tenantId||binding.owner?.userId!==state.scope.userId||binding.captureMode!==local.captureMode)
    return fail('blocked','plugin_binding_changed','Review this plugin’s installation and saved capture mode in setup.');
  app.installedVersion=source.version;
  if(recording&&client==='codex'){
    const {review}=await setupHookStatus(api);
    if(review.pending)return fail('needs_human','review_hooks','In Codex, open /hooks (desktop Settings → Hooks), review the pending OpenCrawl hooks, then start a new session.');
    if(review.state!=='observed'||!review.total||review.disabled)return fail('blocked','hook_state_unconfirmed',review.disabled?'Codex reports disabled OpenCrawl hooks. Keep intentional exclusions or review the selected recording mode in setup.':'Codex could not report the active OpenCrawl hooks. Check the native hook inventory and rerun doctor.');
  }
  if(app.installedVersion!==app.desiredVersion&&!retained){
    if(read(join(root,'rejected-update.json'))?.sha256===pin.archives?.[process.platform+'-'+process.arch]?.sha256)
      return fail('blocked','update_rolled_back','The native check rejected this pin. The previous release is active until a different verified pin is available.');
    const row=updates.find(item=>item.client===client);
    return row?.status==='retry'?fail('retry','download_pending','Retry the verified plugin download.'):
      fail('blocked',row?'update_staged':'update_unconfirmed',row?.status==='kept_current'?row.reason+' The desired release is still pending.':'The desired release has not been safely activated. Keep the current installation until activation is supported.');
  }
  if(recording&&prior.captureAvailable!==true)return fail('blocked','capture_unavailable','This installed package has no confirmed support for recording.');
  if(recording&&local.captureMode==='daemon'&&report.worker!=='running'){app.observed='waiting_for_worker';return;}
  if(!proofSupported)return fail('blocked','server_upgrade_required','Upgrade this deployment to a release that supports revision-bound installation verification.');
  const worker=recording&&local.captureMode==='daemon'?read(join(captureDir(),'daemon','status.json')):undefined;
  const markerFile=join(installed.nativeRoot,'.opencrawl-setup-plugin.json'),markerTime=statSync(markerFile).mtimeMs;
  const revision=createHash('sha256').update(JSON.stringify([state.scope,installationId,client,installed.digest,installed.nativeRoot,
    markerTime,local.captureMode,config.roots,config.exclusions,
    config.command,config.installedAt,state.acceptedAt,config.captureWorker,worker?.version,worker?.startedAt,source.archive?.sha256,permissionRevision,recording])).digest('hex');
  if(auto&&app.installedVersion===pin.version&&source.archive?.sha256!==pin.archives?.[process.platform+'-'+process.arch]?.sha256)
    return fail('blocked','archive_mismatch','The installed archive differs from the verified pin for this platform.');
  const verify=await verifyInstallation(api,{installationId,client,revision});
  if(!isDeepStrictEqual(installed,read(join(root,'installed.json')))||statSync(markerFile).mtimeMs!==markerTime||
     await recordingInstallState(api,client,prior.status)!=='installed')throw new CliError('SETUP_CHANGED','The active plugin changed during native verification. Rerun doctor.');
  if(!recording&&['authenticated','observed'].includes(verify.mcp.state)){app.observed='connected';return;}
  if(recording&&verify.forward&&verify.proof.state==='verified'&&verify.mcp.state==='authenticated'){
    app.observed='verified';app.verifiedAt=verify.proof.verifiedAt;app.sessionId=verify.proof.sessionId;
    if(prior.status==='prepared'){
      const updated=await withSessionLock('setup:plugins',async()=>{
        const file=join(root,'installed.json'),now=read(file);
        if(!isDeepStrictEqual(installed,now))throw new CliError('SETUP_CHANGED','The native plugin changed during verification.');
        if(client==='cursor'&&now.captureConfirmed!==true)atomicJson(file,{...now,captureConfirmed:true});
        return updateSetupState(state.scope,current=>{
          if(!current||current.acceptedAt!==state.acceptedAt||current.installationId!==installationId)throw new CliError('SETUP_CHANGED','The installation changed during verification.');
          return {...current,pluginResults:current.pluginResults?.map(row=>row.client===client?{...row,status:'installed',message:undefined}:row)};
        });
      },0);
      await publishSetup(updated);report.repairs.push('confirmed_'+client+'_activation');
    }
    if(retained&&directoryClient)await settlePromotion(state,directoryClient,installed.digest,'verify');
    if(app.desiredVersion!==app.installedVersion)return fail('retry','newer_pin_pending','The intermediate version passed capture verification. Rerun doctor to activate the next release.');
    return;
  }
  if(verify.mcp.state!=='pending'){
    if(verify.proof.state==='waiting_index')return fail('retry','indexing','The native event reached OpenCrawl. Wait for indexing and rerun doctor.');
    const elapsed=Date.now()-Date.parse(verify.mcp.observedAt??'');
    if(elapsed<5*60_000)return fail('retry','waiting_capture','The native tool call succeeded. Let the recording and upload finish, then rerun doctor.');
    return fail('blocked','capture_unconfirmed','The native tool call succeeded, but its session has not supplied both the marker and the tool receipt. Check the capture worker and upload queue, then rerun doctor.');
  }
  const message=recording?verify.proof.marker:undefined;
  const action=issue('needs_agent','native_tool','Use a fresh '+client+' session with this profile. '+(message?'Emit the marker below as a normal assistant message. ':'')+
    'Call the listed native MCP tool, complete sign-in only if the client prompts, then let capture run and rerun doctor.',
    {client,tool:'verify_installation',arguments:{installationId,client,proofId:verify.proof.id!},...(message?{message}:{})});
  app.observed='awaiting_native_check';report.issues.push(action);
}
async function reconcile(api:string,report:Report,explicitDestination:boolean){
  const config=readCaptureConfig();
  if(!config){
    if(unboundSetupComplete(explicitDestination?api:undefined)){report.recordingOff=true;return;}
    report.issues.push(setupNeeded());return;
  }
  if(config.api!==api)throw new CliError('SETUP_SCOPE_CHANGED','Use the deployment configured for this local installation.');
  if(config.authPending){
    const authenticated=await readServerSetup(api),scope=serverScope(api,authenticated),saved=readSetupState(scope);
    if(!saved||saved.firstRun==='choosing'||!saved.installationId||saved.installationId!==config.installationId||config.installationId==='pending'){
      report.issues.push(setupNeeded());return;
    }
    await captureIdentity(config,undefined,AbortSignal.timeout(20_000),scope);
    report.repairs.push('renewed_capture_identity');
  }
  const local=localSetupStatus(api),state=readSetupState(local.scope)!;
  if(state.firstRun==='choosing'){report.issues.push(setupNeeded());return;}
  const ids=chosen(local.selections,'plugins');
  if(!ids.length){
    if(!config.disabled&&(config.harnesses??['claude-code','codex']).length)throw new CliError('SETUP_STATE_INVALID','Recording is active outside the saved selection. Review setup for this installation.');
    report.recordingOff=true;return;
  }
  if(config.hookOwnership!=='plugin')throw new CliError('SETUP_STATE_INVALID','Review this legacy capture installation with opencrawl setup.');
  const server=await readServerSetup(api);
  if(scopeKey(serverScope(api,server))!==scopeKey(local.scope))throw new CliError('SETUP_SCOPE_CHANGED','Sign in to the workspace that owns this installation.');
  let permissionRevision:string|undefined,paused=false;
  if(chosen(local.selections,'forward').length){
    const identity=await captureIdentity(config,undefined,AbortSignal.timeout(20_000));
    permissionRevision=identity.recording?.revision;paused=identity.recording?.paused===true;
  }
  let updates:Awaited<ReturnType<typeof refreshManagedPlugins>>=[];
  try{updates=await refreshManagedPlugins(api,AbortSignal.timeout(90_000));}
  catch(error){report.issues.push(failure(error));}
  for(const item of updates)if(item.status==='updated')report.repairs.push('updated_'+item.client+'_plugin');
  await withSessionLock('setup:interactive-choices',async()=>{
    assertSame(local);
    const current=readSetupState(local.scope)!;
    if(current.firstRun==='choosing'||current.acceptedAt!==state.acceptedAt)throw new CliError('SETUP_CHANGED','Setup is changing.');
    if(local.captureMode==='daemon'&&(!config.disabled||config.backgroundStartup)){
      try{
        report.worker=await doctorWorker(config,current,report.repairs);
        if(report.worker!=='running')report.issues.push(report.worker==='starting'?issue('retry','worker_starting','The capture worker is starting. Rerun doctor shortly.'):
          issue('blocked','worker_supervision','The host could not supervise the selected worker. Inspect opencrawl setup status --local --json for its service command.'));
      }catch(error){report.worker='unavailable';report.issues.push(failure(error));}
    }
    if(!server.installations.some(i=>i.installationId===current.installationId&&ids.every(id=>i.clients.some(row=>row.client===id&&row.forward===(current.selections.forward[id]===true)&&(!current.pluginResults?.some(p=>p.client===id&&['installed','unchanged'].includes(p.status))||row.installed===true))))){
      await publishSetup(current);report.repairs.push('reported_installation');
    }
    const active=readCaptureConfig()!;
    for(const id of ids){
      const app:App={desired:local.selections.forward[id]&&!paused?'recording':'connected',observed:'pending'};report.apps[id]=app;
      if(!packageRelease(id)){app.observed='unsupported';report.issues.push(issue('blocked','unsupported_client','This doctor supports locally installed recording plugins.',{client:id}));continue;}
      try{await inspectClient(current,active,local,id as LocalPluginClient,app,report,updates,server.revisionProofSupported===true,permissionRevision);}
      catch(error){const problem=failure(error);problem.action.client=id;app.observed=problem.action.kind;report.issues.push(problem);}
    }
    assertSame(local);
    if(!isDeepStrictEqual(active,readCaptureConfig()))throw new CliError('SETUP_CHANGED','Capture configuration changed during verification.');
    report.recordingOff=paused||!chosen(local.selections,'forward').length;
  },0);
}
export async function hostDoctor(explicitApi:string|undefined,args:string[]){
  const report:Report={cliVersion:version,apps:{},repairs:[],issues:[]};
  try{
    if(compiled()&&process.env.OPENCRAWL_NO_UPDATE!=='1'){
      try{await updateCli(AbortSignal.timeout(90_000));const delegated=delegateToNewest(args);if(delegated!==undefined)return {delegated};}
      catch{report.issues.push(issue('retry','cli_update','The CLI release check did not finish. Rerun doctor to check the configured channel.'));}
    }
    const api=apiOrigin(explicitApi??readCaptureConfig()?.api??DEFAULT_API_ORIGIN);
    await withEnvironmentTokenOrigin(explicitApi,()=>withSessionLock('doctor',()=>reconcile(api,report,explicitApi!==undefined),0));
  }catch(error){report.issues.push(failure(error));}
  return outcome(report,explicitApi);
}
