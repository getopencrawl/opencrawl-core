import {availableFiles,setupFilesGit} from '../shared-files.ts';
import {readSession} from '../session.ts';
import {removeCursorSetupHooks} from './cursor-native-hooks.ts';
import {waitForSetup} from './wait.ts';
import {readFileSync} from 'node:fs';
import {hostname,homedir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {CliError,apiOrigin,DEFAULT_API_ORIGIN} from '../oauth.ts';
import {assertTokenDestination} from '../environment-token.ts';
import {atomicJson,withSessionLock,configDir} from '../session.ts';
import {withSetupChoices} from './setup-lock.ts';
import {readCaptureConfig,captureDir,captureDaemonHarnesses} from '../capture/runtime.ts';
import {installCaptureDaemon,uninstallCaptureDaemon} from '../capture/daemon-service.ts';
import {upgradeCaptureDaemon} from '../capture/daemon-upgrade.ts';
import {waitForDaemonReady} from '../capture/daemon-bootstrap.ts';
import {installCapture} from '../capture/install.ts';
import {inspectCodexHooks,codexHookReviewMessage} from '../capture/codex-hooks.ts';
import {inventory,type HistoryFile} from '../capture/backfill.ts';
import {defaultClaudeDesktopSessionsRoot} from '../capture/desktop-history.ts';
import type {Harness,TranscriptHarness} from '../capture/parse.ts';
import {hasClaudeDesktop} from './desktop-runtime.ts';
import {setupInventory} from './inventory.ts';
import {assertSetupAvailability,newSetupClientAvailable,selectOfferedGroup,setupAvailabilityMessage} from './availability.ts';
import {canInstallRecordingPlugin,recordingInstallState,installSetupPlugins,type PluginResult} from './plugins.ts';
import {installPublishedSetupPlugins,loadPublishedPackage,packageRelease,type LocalPluginClient,type CaptureMode} from './published-plugins.ts';
import {daemonEligibility,daemonStartupGuidance,savedCaptureMode,requestedCaptureMode} from './capture-mode.ts';
import {automaticUpdateClients,chosen,defaultSelections,historyBenefit,readSetupState,readStateKey,scopeKey,selectionDigest,updateSetupState,type SetupScope,type SetupState,type SetupWorker,type SetupHumanTask,type SetupSelections} from './state.ts';
import {readServerSetup,serverScope,publishSetup,type SetupServerStatus} from './api.ts';
import {historyJob,startHistoryWorker,runHistoryWorker} from './history-worker.ts';
import {chooseSetupItems,participationNotice} from './select.ts';
import {deferredPlugins,nextSetupAction} from './next.ts';
import {pendingPluginUpdates,formatPluginUpdates,updateCandidates,verifiedInstallation} from './plugin-updates.ts';
import {rememberFinishedSetup} from './first-run.ts';
import {verifyInstallation} from '../verify-installation.ts';
import {formatSetupCommand,setupCommandForSelf,profileSetupCommand} from './invocation.ts';
export {formatSetupCommand} from './invocation.ts';
type Values=Record<string,unknown>;
type Dependencies={skipCodexHooks?:boolean;finishOnboarding?:boolean;canInstall?:(id:string)=>Promise<boolean>;inspectInstall?:typeof recordingInstallState;confirmedCaptureMode?:'hook';modeEligibility?:typeof daemonEligibility;stopDaemon?:typeof uninstallCaptureDaemon;platform?:NodeJS.Platform;command?:string[];login?:()=>Promise<unknown>;installPlugins?:typeof installSetupPlugins;launchHistory?:typeof startHistoryWorker;choose?:typeof chooseSetupItems;interactive?:boolean;inspectHooks?:typeof inspectCodexHooks;installDaemon?:typeof installCaptureDaemon;daemonReady?:typeof waitForDaemonReady;expectedScope?:SetupScope;validateCapturePrincipal?:(principal:unknown)=>void;onProgress?:(title:string,description:string,phase?:'installing')=>void};
function historyFiles(api:string,client?:'claude-code'):HistoryFile[]{if(process.env.OPENCRAWL_AUTH==='devin-cloud')return [];const previous=readCaptureConfig();return inventory(previous?.api===api?previous:{roots:{'claude-code':process.env.CLAUDE_CONFIG_DIR||join(homedir(),'.claude'),codex:process.env.CODEX_HOME||join(homedir(),'.codex'),antigravity:process.env.ANTIGRAVITY_HOME||join(homedir(),'.gemini')},claudeDesktopSessionsRoot:defaultClaudeDesktopSessionsRoot()},client??'all').files;}
const list=(values:string[])=>values.length?values.join(','):'none';

function preserveRecordingOff(selections:SetupSelections,scope:SetupScope,config=readCaptureConfig()):SetupSelections{
 if(!config||config.api!==scope.api||config.owner.tenantId!==scope.tenantId||config.owner.userId!==scope.userId)return selections;
 const forward={...selections.forward};
 if(config.disabled)for(const client of Object.keys(forward))forward[client]=false;
 else {
  for(const client of Object.keys(forward))if(!(config.harnesses??['claude-code','codex']).includes(client as Harness))forward[client]=false;
  try{const value=Bun.TOML.parse(readFileSync(join(config.roots.codex,'config.toml'),'utf8')) as {features?:{hooks?:boolean}};if(value.features?.hooks===false)forward.codex=false;}catch{}
  if(config.roots.antigravity)try{const hooks=JSON.parse(readFileSync(join(config.roots.antigravity,'config','hooks.json'),'utf8'));if(hooks['opencrawl-capture']?.enabled===false)forward.antigravity=false;}catch{}
 }
 return {...selections,forward};
}

/** A local binding is not a freshly authenticated principal or server proof. */
function readLocalCaptureConfig(){
 try{return readCaptureConfig();}catch{throw new CliError('SETUP_STATE_INVALID','Local capture configuration could not be read. Preserve it and repair the local file before continuing; no sign-in or setup was started.',2);}
}
export function localSetupStatus(requestedApi?:string){
 const config=readLocalCaptureConfig();
 if(!config)throw new CliError('SETUP_NOT_STARTED','No local capture installation is saved. Local status cannot verify setup; no choices or sign-in were changed.',2);
 if(config.schemaVersion!==1||typeof config.api!=='string'||typeof config.owner?.tenantId!=='string'||!config.owner.tenantId||typeof config.owner?.userId!=='string'||!config.owner.userId||typeof config.installationId!=='string'||!config.installationId||config.installationId==='pending'||config.authPending)throw new CliError('SETUP_STATE_INVALID','Local capture has no complete saved installation binding. Preserve its configuration and finish the existing sign-in before continuing.',2);
 const api=apiOrigin(requestedApi??config.api);
 if(config.api!==api)throw new CliError('SETUP_SCOPE_CHANGED','The requested API differs from this local installation. No saved choices or credentials were changed.',2);
 const scope={api:config.api,tenantId:config.owner.tenantId,userId:config.owner.userId};
 let state:SetupState|null;
 try{state=readSetupState(scope);}catch(error){if(error instanceof CliError)throw error;throw new CliError('SETUP_STATE_INVALID','Saved local setup choices are malformed. Preserve the file and repair it before continuing; no sign-in or setup was started.',2);}
 if(!state)throw new CliError('SETUP_NOT_STARTED','No saved setup choices match this local installation owner and API. Preserve the current installation; local status did not start setup.',2);
 if(state.scope.api!==scope.api||state.scope.tenantId!==scope.tenantId||state.scope.userId!==scope.userId||state.installationId!==config.installationId)throw new CliError('SETUP_SCOPE_CHANGED','Saved setup choices do not match the current installation, API and owner. No state was changed.',2);
 const selections=preserveRecordingOff(state.selections,scope,config);
 const pluginUpdates=config.disabled?[]:pendingPluginUpdates(state);
 const automaticPluginUpdates=automaticUpdateClients(state);
 if(JSON.stringify(readLocalCaptureConfig())!==JSON.stringify(config))throw new CliError('SETUP_SCOPE_CHANGED','The local installation changed while reading status. Retry local status; no state was changed.',2);
 return {status:'local_status',freshness:'local-only',serverChecked:false,scopeSource:'saved-capture-config',scope,installationId:config.installationId,savedSelections:state.selections,selections,...(automaticPluginUpdates.length?{automaticPluginUpdates}:{}),...(pluginUpdates.length?{pluginUpdates}:{}),captureMode:savedCaptureMode(state,config),...(state.pluginResults?{pluginResults:state.pluginResults.map(({client,status,message})=>({client,status,message}))}:{}),...(state.worker?{worker:workerObservation(state.worker)}:{})};
}

const availabilityBinding=({scope,installationId,savedSelections,selections}:ReturnType<typeof localSetupStatus>)=>JSON.stringify({scope,installationId,savedSelections,selections});

/** Saved supervisor facts, never a liveness probe or permission to launch work. */
function workerObservation(worker:SetupWorker|undefined){
 if(!worker)return undefined;
 const readiness=worker.kind==='not-required'?'not_required':worker.supervised&&(!worker.status||worker.status==='installed')?'configured':'pending';
 const environment=worker.environment?Object.fromEntries(Object.entries(worker.environment).filter(([key,value])=>['OPENCRAWL_CONFIG_HOME','OPENCRAWL_NO_UPDATE','XDG_CACHE_HOME','XDG_DATA_HOME'].includes(key)&&typeof value==='string')):undefined;
 return {kind:worker.kind,...(worker.status?{status:worker.status}:{}),supervised:worker.supervised,harnesses:worker.harnesses,startup:worker.startup,readiness,freshness:'last-setup-observation',...(worker.command?{command:worker.command}:{}),...(environment?{environment}:{}),...(worker.reason?{reason:worker.reason}:{})};
}
const pendingWorkerGuidance='Background worker supervision is pending. A host-owned service must run the exact bound worker.command and any reported environment from local status. Starting it once in the foreground is not supervision. Keep this conversation and the saved choices; report the host-service prerequisite and retry setup only after it changes. Do not claim automatic setup is complete or loop through service startup and verification.';

const planDigest=(scope:SetupScope,selections:SetupSelections,files:HistoryFile[])=>createHash('sha256').update(selectionDigest(scope,selections)+JSON.stringify(files)).digest('hex');
/** Explicit native inspection, separate from the zero-process local status contract. */
export async function setupHookStatus(requestedApi?:string,inspectHooks=inspectCodexHooks){
 const local=localSetupStatus(requestedApi),config=readLocalCaptureConfig();
 if(!config)throw new CliError('SETUP_STATE_INVALID','The local installation changed before hook inspection. Retry; no setup state was changed.',2);
 const review=!local.selections.forward.codex?{state:'not_applicable' as const,total:0,pending:0,disabled:0}:config.hookOwnership==='plugin'?await inspectHooks(config.roots.codex):{state:'unknown' as const,total:0,pending:null,disabled:null};
 if(JSON.stringify(config)!==JSON.stringify(readLocalCaptureConfig())||JSON.stringify(local)!==JSON.stringify(localSetupStatus(requestedApi)))throw new CliError('SETUP_SCOPE_CHANGED','The local installation or choices changed during hook inspection. Retry; no setup state was changed.',2);
 return {status:'hook_status',serverChecked:false,scope:local.scope,installationId:local.installationId,client:'codex',recordingSelected:local.selections.forward.codex===true,review};
}

async function tasks(server:SetupServerStatus,state:SetupState|null,inspectHooks:typeof inspectCodexHooks):Promise<SetupHumanTask[]>{
 const row=server.installations.find(row=>row.installationId===state?.installationId);
 const combined=row?[...(state?.humanTasks??[]).filter(task=>{const client=row.clients.find(client=>client.client===task.client);if(task.kind==='plugin_install')return !client?.installed;if(task.kind==='restart')return Boolean(task.client&&state?.selections.plugins[task.client]&&(state.pluginResults?.some(result=>result.client===task.client&&result.status==='prepared')||!client?.captureObservedAt&&client?.mcp?.state!=='authenticated'&&client?.proof?.state!=='verified'));return false;}),...row.clients.flatMap(client=>client.humanTasks)]:state?.humanTasks??[];
 const found=server.scope.userId.startsWith('agent_reg_')?combined.filter(task=>task.kind!=='mcp_auth'):combined;
 const others=found.filter(task=>task.client!=='codex'||task.kind!=='hook_trust');
 if(!state)return found;
 // Plugin installation does not consent to recording. Respect saved and local opt-outs.
 if(!preserveRecordingOff(state.selections,state.scope).forward.codex)return others;
 const config=readCaptureConfig();
 if(!config||config.api!==state.scope.api||config.owner.tenantId!==state.scope.tenantId||config.owner.userId!==state.scope.userId)return found;
 const review=await inspectHooks(config.roots.codex);
 if(review.state==='not_applicable')return found;
 const client=row?.clients.find(client=>client.client==='codex');
 const captureProven=config.installationId===state.installationId&&Boolean(client?.captureObservedAt||client?.proof?.state==='verified');
 // Missing inspection and disabled opt-outs cannot undo server-owned capture proof.
 // A positively observed new or changed definition still needs the person's review.
 if(captureProven&&!(review.state==='observed'&&(review.pending??0)>0))return others;
 const instruction=codexHookReviewMessage(review);
 return instruction?[{id:'codex-hook-review',kind:'hook_trust',client:'codex',title:'Review OpenCrawl hooks in Codex',instruction},...others]:others;
}
function assertPluginSelection(selections:SetupSelections){const missing=chosen(selections,'forward').filter(client=>!selections.plugins[client]);if(missing.length)throw new CliError('SETUP_PLUGIN_REQUIRED','Future recording requires its native plugin. Select '+missing.join(', ')+' in --plugins, or turn its --forward choice off. Choose history separately.',64);}
/** Installing a new plugin enables future capture. History uses its own approval. */
function assertCaptureSelections(selections:SetupSelections,previous?:SetupSelections){
 for(const client of new Set([...Object.keys(selections.plugins),...Object.keys(selections.forward)])){
  const plugin=selections.plugins[client]===true,forward=selections.forward[client]===true;
  const retained=previous?.plugins[client]===plugin&&previous?.forward[client]===forward;
  if(plugin!==forward&&!retained)throw new CliError('SETUP_CAPTURE_REQUIRED','Installing a harness enables new-session capture. Use the same clients for --plugins and --forward, or none for both.',64);
 }
}
async function confirmScope(scope:SetupScope){
 const server=await readServerSetup(scope.api);
 if(scopeKey(serverScope(scope.api,server))!==scopeKey(scope))throw new CliError('SETUP_SCOPE_CHANGED','The signed-in workspace changed. Review setup again.');
 return server;
}
async function applyClients(scope:SetupScope,selections:SetupSelections,installPlugins:typeof installSetupPlugins,command:string[],installDaemon:typeof installCaptureDaemon,validatePrincipal:Dependencies['validateCapturePrincipal'],stageDaemon:boolean,daemonReady:typeof waitForDaemonReady,mode:CaptureMode,eligible:boolean,stopDaemon:typeof uninstallCaptureDaemon,onProgress:Dependencies['onProgress'],inspectHooks:typeof inspectCodexHooks,reviewingChoices=false,optionalFailures?:Map<string,PluginResult>){
 assertPluginSelection(selections);
 const server=await confirmScope(scope);
 const previous=readSetupState(scope),existing=readCaptureConfig();
 if(installPlugins===installPublishedSetupPlugins&&previous?.pluginResults?.some(row=>selections.forward[row.client]&&(!row.source||row.captureAvailable===true)&&['installed','unchanged','prepared'].includes(row.status)&&packageRelease(row.client)?.captureAvailable===false))throw new CliError('PLUGIN_CAPTURE_UNAVAILABLE','The pinned package cannot capture yet. Your current working installation and saved choices are preserved.');
 // Changing update preferences must not reinstall a healthy older plugin.
 const retained=new Map<string,PluginResult>();
 if(installPlugins===installPublishedSetupPlugins&&previous?.installationId&&existing?.installationId===previous.installationId&&
    existing.api===scope.api&&existing.owner.tenantId===scope.tenantId&&existing.owner.userId===scope.userId&&savedCaptureMode(previous,existing)===mode){
  for(const candidate of updateCandidates(previous)){
   const row=previous.pluginResults?.find(row=>row.client===candidate.client);
   if(!selections.plugins[candidate.client]||!row?.captureAvailable||!row.source?.archive||
      !verifiedInstallation(previous,candidate))continue;
   const native=await recordingInstallState(scope.api,candidate.client,row.status);
   if(native==='new'||native==='repair')continue;
   retained.set(candidate.client,{...row,client:candidate.client,status:native==='review'||row.status==='prepared'?'prepared':'unchanged',
    ...(native==='review'?{message:'The installed version was kept. Review its activation in the app.'}:{})});
  }
 }
 const packages=new Map<LocalPluginClient,Awaited<ReturnType<typeof loadPublishedPackage>>>();
 if(installPlugins===installPublishedSetupPlugins)for(const id of chosen(selections,'plugins')){
  const client=id as LocalPluginClient;
  if(id==='devin'||retained.has(client)||optionalFailures?.has(client))continue;
  onProgress?.('Installing session capture tooling','Loading the OpenCrawl plugin for '+client+'.','installing');
  try{packages.set(client,await loadPublishedPackage(client));}
  catch(error){
   if(!optionalFailures)throw error;
   optionalFailures.set(client,{client,status:'error',message:error instanceof CliError?error.message:'Could not load the plugin package.'});
  }
 }
 // Saving the first confirmation independently makes interruption before the
 // history screen safe: it cannot create consent or a job for new history.
 await updateSetupState(scope,old=>({...old,schemaVersion:1,firstRun:reviewingChoices?'choosing':'ready',scope,selections,captureMode:mode,acceptedAt:new Date().toISOString(),worker:mode==='daemon'||existing?.captureWorker||existing?.daemonRequested||existing?.backgroundStartup?{kind:'configuring',status:'pending',supervised:false,harnesses:chosen(selections,'forward'),startup:false}:undefined,pluginResults:[...(old?.pluginResults??[]).filter(row=>!selections.plugins[row.client]),...chosen(selections,'plugins').map(client=>retained.get(client)??({client,status:'pending',...(installPlugins===installPublishedSetupPlugins?{captureAvailable:packageRelease(client)?.captureAvailable??false,daemonHandoff:packageRelease(client)?.daemonHandoff??false}:{})}))]}));
 const forward=chosen(selections,'forward');
 const capture=await installCapture(scope.api,{harnesses:forward as Harness[],historyHarnesses:chosen(selections,'history') as TranscriptHarness[],selectionMode:'replace',captureMode:mode,daemon:mode==='daemon'&&eligible,stagedDaemon:mode==='daemon'&&eligible&&stageDaemon,daemonService:false,backgroundStartup:mode==='daemon'&&eligible&&chosen(selections,'plugins').length>0,expectedOwner:scope,expectedConfig:existing,validatePrincipal,hookOwnership:'plugin',command});
 if(!selections.plugins.cursor)await removeCursorSetupHooks(scope.api,existing?.roots.cursor);
 const cursor=server.installations.find(row=>row.installationId===capture.installationId)?.clients.find(row=>row.client==='cursor');
 const cursorCapture=cursor?.captureObservedAt?{installationId:capture.installationId,observedAt:cursor.captureObservedAt}:undefined;
 const selectedPlugins=chosen(selections,'plugins').filter(client=>!optionalFailures?.has(client)&&!retained.has(client));
 const pluginOptions={command,captureMode:mode,cursorCapture,onProgress:(message:string)=>onProgress?.('Installing session capture tooling',message,'installing')};
 const plugins=installPlugins===installPublishedSetupPlugins
  ?await installPublishedSetupPlugins(scope.api,selectedPlugins,{...pluginOptions,loadPackage:async client=>packages.get(client)!})
  :await installPlugins(scope.api,selectedPlugins,pluginOptions);
 plugins.results.push(...retained.values());
 for(const failure of optionalFailures?.values()??[])if(selections.plugins[failure.client])plugins.results.push(failure);
 await confirmScope(scope);
 const ready=chosen(selections,'plugins').every(client=>plugins.results.some(row=>row.client===client&&['installed','unchanged','prepared'].includes(row.status)));
 const configured=readCaptureConfig();
 if(!configured||configured.api!==scope.api||configured.installationId!==capture.installationId||configured.owner.tenantId!==scope.tenantId||configured.owner.userId!==scope.userId||JSON.stringify([...(configured.harnesses??[])].sort())!==JSON.stringify(forward)||(configured.daemonRequested?.backgroundStartup??configured.backgroundStartup)!==(mode==='daemon'&&eligible&&chosen(selections,'plugins').length>0))throw new CliError('SETUP_SCOPE_CHANGED','The local installation changed before starting its capture worker.');
 const daemonHarnesses=captureDaemonHarnesses(configured);
 // Plugin-owned clients can make progress independently.
 const preparedClient=plugins.results.some(row=>selections.plugins[row.client]&&['installed','unchanged','prepared'].includes(row.status));
 let worker:SetupWorker|undefined=mode==='hook'||!chosen(selections,'plugins').length?{kind:'not-required',supervised:false,harnesses:[],startup:false}:previous?.worker;
 if(mode==='daemon'&&!eligible&&chosen(selections,'plugins').length)worker={kind:'unavailable',status:'required',supervised:false,harnesses:forward,startup:false,reason:'The saved background-service choice is unavailable on this host or plugin version. No service was installed. Keep the saved choice or use setup to choose direct hook capture.'};
 if((mode==='hook'||!chosen(selections,'plugins').length)&&(existing?.captureWorker||existing?.daemonRequested||existing?.backgroundStartup)){stopDaemon();}
 const supportsDaemon=plugins.results.every(row=>!selections.forward[row.client]||row.daemonHandoff!==false);
 if(mode==='daemon'&&eligible&&supportsDaemon&&(ready||preparedClient)&&configured.hookOwnership==='plugin'){
  if(configured.daemonRequested){
   let service:Awaited<ReturnType<typeof installCaptureDaemon>>|undefined;
   const activation=await upgradeCaptureDaemon({install:async(candidate,expectedConfig)=>service=await installDaemon(candidate,{expectedConfig}),ready:daemonReady});
   worker=activation.state==='activated'&&service?{...service,harnesses:configured.disabled?[]:daemonHarnesses,startup:configured.daemonRequested.backgroundStartup}:{kind:'fallback',status:'required',supervised:false,harnesses:configured.disabled?[]:daemonHarnesses,startup:false,reason:plugins.results.some(row=>row.source)?daemonStartupGuidance([configDir(),...command]):'Daemon startup was not confirmed. Capture uses the legacy collector; session registration uses the installed skill. Run setup to retry without changing saved choices.'};
  }else worker={...await installDaemon(configured),harnesses:configured.disabled?[]:daemonHarnesses,startup:configured.backgroundStartup===true};
 }
 const pluginResults=[...(previous?.pluginResults??[]).filter(row=>!selections.plugins[row.client]&&['installed','unchanged'].includes(row.status)),...plugins.results];
 const humanTasks:SetupHumanTask[]=[...plugins.humanTasks];
 const state=await updateSetupState(scope,current=>({...current!,installationId:capture.installationId,machine:current?.machine??{id:capture.installationId,label:hostname()},pluginResults,humanTasks,worker}));
 const hooks=state.selections.forward.codex?await setupHookStatus(scope.api,inspectHooks):undefined;
 await publishSetup(state,fetch,hooks);return state;
}
async function applyHistory(scope:SetupScope,selections:SetupSelections,files:HistoryFile[],retainedHistory:string[]=[]){
 await confirmScope(scope);
 const historyClients=chosen(selections,'history');
 await withSessionLock('capture:configuration',async()=>{
  const current=readCaptureConfig();
  if(!current||current.api!==scope.api||current.owner.tenantId!==scope.tenantId||current.owner.userId!==scope.userId)throw new CliError('SETUP_SCOPE_CHANGED','The recording destination changed before history approval.');
  if(current.disabled&&historyClients.length&&current.harnesses?.length!==0)throw new CliError('SETUP_SCOPE_CHANGED','Recording was disabled during setup. Review your choices before importing history.');
  atomicJson(join(captureDir(),'config.json'),{...current,historyHarnesses:historyClients,...(current.disabled&&historyClients.length?{disabled:false}:{})});
 });
 const state=await updateSetupState(scope,current=>{if(!current?.installationId)throw new CliError('SETUP_NOT_STARTED','Confirm client setup before history.');const clients=chosen(selections,'history'),retainingPause=current.historyJob?.state==='paused'&&retainedHistory.some(client=>selections.history[client]);
  const sameSnapshot=JSON.stringify(current.historyJob?.clients)===JSON.stringify(clients)&&JSON.stringify(current.historyJob?.files)===JSON.stringify(files);
  const job=retainingPause&&sameSnapshot?current.historyJob:historyJob(current,clients,files);
  if(job&&job!==current.historyJob){job.completedClients=retainedHistory.filter(client=>selections.history[client]&&current.historyJob?.completedClients.includes(client));if(retainingPause)job.state='paused';}
  return {...current,selections,historyJob:job};});
 await publishSetup(state);return state;
}
async function result(state:SetupState,launchHistory:typeof startHistoryWorker,inspectHooks:typeof inspectCodexHooks,command:string[],start=true){
 command=profileSetupCommand(command,dirname(configDir()),process.env,true);
 const history=start&&state.historyJob?launchHistory(state):{state:state.historyJob?.state??'not_started'};
 const worker=workerObservation(state.worker),workerPending=worker?.readiness==='pending',workerGuidance=['fallback','unavailable'].includes(worker?.kind??'')?worker!.reason!:pendingWorkerGuidance;
 const server=await readServerSetup(state.scope.api),statusCommand=formatSetupCommand(['setup','status','--local','--api',state.scope.api,'--json'],command);
 const nextAction=nextSetupAction(state,server),unavailable=nextAction.kind==='plugin_unavailable';
 const prepared=!unavailable&&!workerPending&&state.pluginResults?.some(row=>state.selections.plugins[row.client]&&row.status==='prepared');
 const activationGuidance=prepared?` After this plugin's native startup or reload has run, if its installation report is still prepared and CLI network access is normally authorized, run \`${formatSetupCommand(['setup','--yes','--api',state.scope.api,'--json'],command)}\` once, then re-read native installation_status. Preserve saved choices. If access is denied or unavailable, leave installation pending and continue native verification; do not repeat requests or bypass permissions.`:'';
 return {status:workerPending||state.pluginResults?.some(row=>['error','pending','prepared'].includes(row.status))?'needs_attention':'configured',scope:state.scope,installationId:state.installationId,selections:state.selections,captureMode:state.captureMode,nextAction,plugins:state.pluginResults,worker,history,humanTasks:unavailable?[]:await tasks(server,state,inspectHooks),historyBenefit,agentPrompt:unavailable?nextAction.instruction:`Continue OpenCrawl setup in this conversation. Use \`${formatSetupCommand([],command)}\` for every OpenCrawl command${process.platform==='win32'?' in PowerShell':''}. Start with \`${statusCommand}\` to read this machine's saved choices without network access. ${workerPending?workerGuidance+' Once supervision is configured, use':"Then use"} the installed plugin's native installation_status tool for each selected client and follow its returned human tasks. Use its verify_installation tool for the returned proof. Reuse my saved choices.${state.selections.plugins.cursor?' Open the deployment-specific plugin in a new Cursor session and follow its setup skill.':''}${activationGuidance} For clients with recording off (forward=false), complete the MCP connection without requiring a new session capture.`,nextStep:workerPending?workerGuidance:`Use \`${statusCommand}\` for saved local choices; server status comes from the native plugin. Installation is not proof that a session is searchable.`};
}
export function setupCommand(action:string,api:string,values:Values,deps:Dependencies={}){
 const interactive=deps.interactive??Boolean(process.stdin.isTTY&&process.stderr.isTTY&&!values.json);
 const run=async()=>{
  const result=await executeSetup(action,api,values,{...deps,interactive});
  if(action!=='run'&&action!=='apply')return result;
  // Committed setup results carry installationId, even when recording is off.
  if(!result||!('installationId' in result))return result;
  const enabled=await availableFiles(api,undefined,result.scope,AbortSignal.timeout(10_000));
  let warning:string|undefined;
  if(!Bun.which('git',{PATH:process.env.PATH})){
   warning='Install Git and rerun setup to enable workspace Git authentication.';
  }else{
   try{await setupFilesGit(api,deps.command);}
   catch{warning='Could not register workspace Git authentication. Check that your OpenCrawl and global Git configurations are writable, then rerun setup.';}
  }
  // Setup already verified its deployment and principal. Installing this
  // path-scoped helper is safe before rollout: Git must still discover and
  // authenticate the exact workspace before the helper returns a credential.
  if(!enabled)return result;
  if(warning&&!values.json)process.stderr.write(warning+'\n');
  return {...result,gitCredentials:warning?{status:'unavailable',message:warning}:{status:'configured'}};
 };
 // Serialize changes to this profile's confirmed choices and installation.
 return action==='apply'&&values.yes===true||action==='run'&&(interactive||values.yes===true||!values.json)
  ?withSetupChoices(run,action==='run'&&interactive):run();
}
export function nativeSetupPrompt(api:string,client:string,command=setupCommandForSelf()){
 const nextCommand=formatSetupCommand(['setup','next','--api',api,'--json'],profileSetupCommand(command,dirname(configDir()),process.env,true));
 return `Finish OpenCrawl setup in this conversation. Run ${nextCommand} and follow nextAction. Reuse my saved choices. After the native verify_installation call, run setup wait --json with this same profile-bound CLI and follow its nextAction. Never ask me to reply just to wait for capture. After any reconciliation, read setup next again before reporting completion. Work only on ${client}. When this client is verified, tell the person it is connected and they can return to setup. Leave other clients to their own setup screens.`;
}

async function executeSetup(action:string,api:string,values:Values,{platform=process.platform,command=setupCommandForSelf(),login,installPlugins=installPublishedSetupPlugins,modeEligibility=daemonEligibility,stopDaemon=uninstallCaptureDaemon,launchHistory=startHistoryWorker,choose=chooseSetupItems,inspectHooks=inspectCodexHooks,installDaemon=installCaptureDaemon,daemonReady=waitForDaemonReady,expectedScope,validateCapturePrincipal,onProgress,confirmedCaptureMode,finishOnboarding=false,skipCodexHooks=false,inspectInstall=recordingInstallState,canInstall=id=>canInstallRecordingPlugin(id,{},platform),interactive=Boolean(process.stdin.isTTY&&process.stderr.isTTY&&!values.json)}:Dependencies={}){
 const requestedClients=Array.isArray(values.client)?values.client:values.client===undefined?[]:[values.client];
 const claudeOnly=requestedClients.length===1&&requestedClients[0]==='claude-code'&&['run','plan','apply'].includes(action);
 if(['run','plan','apply'].includes(action)&&requestedClients.length&&!claudeOnly)throw new CliError('INVALID_USAGE','Use opencrawl setup to choose detected agents, or --plugins and --forward for an explicit selection. --client claude-code limits the preview to Claude Code.',64);
 if(values.local!==undefined){if(values.local!==true||action!=='status')throw new CliError('INVALID_USAGE','Use --local only with setup status.',64);return localSetupStatus(api);}
 if(action==='hooks')return setupHookStatus(api,inspectHooks);
 if(action==='worker'){if(typeof values['scope-key']!=='string')throw new CliError('INVALID_USAGE','Missing history scope.',64);const state=readStateKey(values['scope-key']);if(state?.scope.api!==api)throw new CliError('SETUP_SCOPE_CHANGED','History worker API does not match its approved scope.');await runHistoryWorker(values['scope-key']);return null;}
 if(!['run','plan','status','next','wait','apply','verify','report-hooks'].includes(action))throw new CliError('INVALID_USAGE','Use setup, setup --json, setup apply, setup status, setup next, setup wait, setup hooks, setup report-hooks, or setup verify.',64);
 // Only the validated workload adapter supplies both contracts. Public CLI
 // arguments/environment cannot opt out of the local-client release policy.
 if(process.env.OPENCRAWL_TOKEN||process.env.OPENCRAWL_SESSIONS_TOKEN)assertTokenDestination(api);
 if(action==='report-hooks'){
  const hooks=await setupHookStatus(api,inspectHooks);
  const state=readSetupState(hooks.scope);
  if(!state)throw new CliError('SETUP_NOT_STARTED','Run setup first.');
  await publishSetup(state,fetch,{...hooks,onlyHooks:true});
  return {...hooks,status:'hooks_reported',serverChecked:true};
 }
 const workload=Boolean(expectedScope&&validateCapturePrincipal);
 const registrationId=readSession(api)?.registrationId;
 const registered=Boolean(registrationId);
 const changing=['run','plan','apply'].includes(action);
 let admitted:ReturnType<typeof localSetupStatus>|undefined;
 if(changing&&!workload){
  const config=readLocalCaptureConfig();
  if(config?.api===api&&config.owner){
   const saved=readSetupState({api,...config.owner});
   // A crash inside installCapture can leave the binding on disk before the journal records its ID.
   if(saved&&(saved.installationId||saved.firstRun!=='choosing'))admitted=localSetupStatus(api);
  }
  if(api===DEFAULT_API_ORIGIN&&!interactive&&!registered&&!admitted&&!readSession(api)&&platform!=='darwin'&&values.json&&!process.env.OPENCRAWL_TOKEN&&!process.env.OPENCRAWL_SESSIONS_TOKEN&&!process.env.OPENCRAWL_AUTH){
   return {status:'action_required',agentSignupCommand:formatSetupCommand(['signup','--api',api,'--json'],command),guide:'https://getopencrawl.com/agents.md'};
  }
  assertSetupAvailability(platform,values,admitted?.selections,registered);
  if(config?.api===api&&!admitted&&(config.harnesses??[]).some(client=>!newSetupClientAvailable(client,platform,registered)))throw new CliError('SETUP_EXISTING_CLIENTS_DEFERRED','This legacy installation includes deferred clients. Its capture configuration is unchanged; preserve it until those clients are available in setup.',2);
 }
 let server;
 try{server=await readServerSetup(api);}catch(error){
  if(error instanceof CliError&&error.code==='AUTH_REQUIRED'){
   if(process.env.OPENCRAWL_AUTH==='devin-cloud')throw error;
   if(action==='run'&&interactive&&login){await login();server=await readServerSetup(api);}
   else return {status:'action_required',...(api===DEFAULT_API_ORIGIN?{agentSignupCommand:formatSetupCommand(['signup','--api',api,'--json'],command),guide:'https://getopencrawl.com/agents.md'}:{}),humanTasks:[{id:'cli-login',kind:'login',title:'Sign in to OpenCrawl',instruction:`Run \`${formatSetupCommand(['login','--api',api],command)}\`${process.platform==='win32'?' in PowerShell':''}, complete browser sign-in, then run \`${formatSetupCommand(['setup','--api',api,'--json'],command)}\`.`}],historyBenefit};
  }else throw error;
 }
 const scope=serverScope(api,server);
 if(registered&&scope.userId!==registrationId)throw new CliError('SETUP_SCOPE_CHANGED','The server identity differs from the saved agent registration.');
 if(expectedScope&&scopeKey(scope)!==scopeKey(expectedScope))throw new CliError('SETUP_SCOPE_CHANGED','The authenticated setup destination changed before setup. No installation was created.');
 const previous=readSetupState(scope),boundConfig=readCaptureConfig();
 const sameOwner=boundConfig?.api===scope.api&&boundConfig.owner.tenantId===scope.tenantId&&boundConfig.owner.userId===scope.userId;
 const retainedMode=workload?'daemon':savedCaptureMode(previous,sameOwner?boundConfig:null);
 if(values['capture-mode']!==undefined&&!['run','plan','apply'].includes(action))throw new CliError('INVALID_USAGE','Change capture mode through setup or setup apply.',64);
 const questionnaire=action==='run'&&interactive;
 let captureMode=requestedCaptureMode(confirmedCaptureMode??values['capture-mode'],questionnaire?'hook':retainedMode);
 const eligibility=(selections:SetupSelections)=>workload?{eligible:true,reason:'Existing workload supervisor'}:modeEligibility(chosen(selections,'plugins'),platform);
 const checkMode=(selections:SetupSelections)=>{if(captureMode==='daemon'&&!eligibility(selections).eligible&&!(previous&&retainedMode==='daemon'))throw new CliError('SETUP_DAEMON_UNAVAILABLE',eligibility(selections).reason,2);};
 if(action==='wait'){
  if(!previous)throw new CliError('SETUP_NOT_STARTED','Run opencrawl setup first.');
  const progress=await waitForSetup(()=>{const saved=readSetupState(scope);if(!saved)throw new CliError('SETUP_SCOPE_CHANGED','Saved setup was removed while waiting.');const local=localSetupStatus(api);if(local.installationId!==previous.installationId)throw new CliError('SETUP_SCOPE_CHANGED','The local installation changed while waiting.');return {...saved,selections:preserveRecordingOff(saved.selections,scope)};},{skipCodexHooks,read:()=>readServerSetup(api),verify:(installationId,client)=>verifyInstallation(api,{installationId,client})});
  if(progress.nextAction.kind==='complete'||finishOnboarding&&['repair_plugin','plugin_unavailable','hook_trust_skipped'].includes(progress.nextAction.kind))await rememberFinishedSetup(previous);
  return progress;
 }
 if(action==='next'){
  if(!previous)throw new CliError('SETUP_NOT_STARTED','Run opencrawl setup first.');
  const effective={...previous,selections:preserveRecordingOff(previous.selections,scope)};
  return {status:'next_action',scope,installationId:effective.installationId,selections:effective.selections,captureMode,nextAction:nextSetupAction(effective,server)};
 }
 if(changing&&!workload){if(admitted&&(scopeKey(admitted.scope)!==scopeKey(scope)||previous?.installationId!==admitted.installationId||availabilityBinding(localSetupStatus(api))!==availabilityBinding(admitted)))throw new CliError('SETUP_SCOPE_CHANGED','The setup owner or installation changed after the local availability check.');assertSetupAvailability(platform,values,admitted?.selections,registered);}
 if(action==='status')return {status:'status',scope,captureMode,selections:previous?.selections??null,history:previous?.historyJob??null,...(previous?.worker?{worker:workerObservation(previous.worker)}:{}),server,humanTasks:await tasks(server,previous,inspectHooks)};
 if(action==='verify'){
  const client=Array.isArray(values.client)?values.client[0]:values.client;
  if(!previous?.installationId||typeof client!=='string')throw new CliError('INVALID_USAGE',`Run \`${formatSetupCommand(['setup','--api',api],command)}\` first, then \`${formatSetupCommand(['setup','verify','--api',api,'--client','CLIENT'],command)}\`.`,64);
  return verifyInstallation(api,{installationId:previous.installationId,client});
 }
 const repairSaved=action==='run'&&!interactive&&values.yes===true&&
  ['plugins','forward','history','capture-mode','client','plan-id'].every(key=>values[key]===undefined);
 if(repairSaved&&previous){
  if(boundConfig&&!sameOwner||previous.installationId&&boundConfig?.installationId!==previous.installationId)
   throw new CliError('SETUP_SCOPE_CHANGED','The saved setup belongs to a different installation. Review the current workspace before continuing.');
  if(!workload)assertSetupAvailability(platform,Object.fromEntries((['plugins','forward','history'] as const).map(group=>[group,list(chosen(previous.selections,group))])),admitted?.selections,registered);
  if(previous.firstRun==='choosing'&&!workload)return {status:'action_required',instruction:'Run opencrawl setup in a terminal to review this interrupted installation.',humanTasks:[]};
  const selected=preserveRecordingOff(previous.selections,scope);
  if(!previous.installationId&&previous.firstRun==='complete'&&!chosen(selected,'plugins').length&&!chosen(selected,'history').length){
   return {status:'recording_off',scope,installationId:undefined,selections:selected,humanTasks:[]};
  }
  const state=await applyClients(scope,selected,installPlugins,command,installDaemon,validateCapturePrincipal,['darwin','linux'].includes(platform)&&!process.env.OPENCRAWL_AUTH,daemonReady,captureMode,eligibility(selected).eligible,stopDaemon,onProgress,inspectHooks);
  return completed(state);
 }
 const clients=setupInventory({api,platform,workload,registered,saved:interactive&&action==='run'?admitted?.selections:undefined,...(claudeOnly?{client:'claude-code' as const}:{})});
 const legacyForward:string[]|undefined=sameOwner?(boundConfig.disabled?[]:boundConfig.harnesses??['claude-code','codex']):undefined;
 const selections=preserveRecordingOff(defaultSelections(clients,previous?.selections,legacyForward),scope);
 if(questionnaire){
  // Fresh defaults for editable clients. Keep unrelated and grandfathered
  // bindings intact until the user explicitly changes them.
  for(const client of clients)if(newSetupClientAvailable(client.id,platform,registered)){
   selections.plugins[client.id]=client.plugin&&client.detected;
   selections.forward[client.id]=client.forward&&client.detected;
   selections.history[client.id]=false;
  }
 }
 if(claudeOnly){
  // Targeting one client cannot silently enable discovered clients or replace
  // previously accepted choices for them.
  for(const group of ['plugins','forward','history'] as const)for(const id of Object.keys(selections[group]))if(id!=='claude-code')selections[group][id]=previous?.selections[group][id]??false;
  selections.plugins['claude-code']=true;
  selections.history['claude-code']=previous?.selections.history['claude-code']??false;
 }
 for(const group of ['plugins','forward','history'] as const)selections[group]=selectOfferedGroup(values[group]===undefined?undefined:String(values[group]),group,clients,selections,admitted?.selections);
 // Defaults may include an interrupted setup row without a capture binding.
 // Only exact admitted choices can retain deferred clients, even implicitly.
 if(!workload)assertSetupAvailability(platform,Object.fromEntries((['plugins','forward','history'] as const).map(group=>[group,list(chosen(selections,group))])),admitted?.selections,registered);
 if(!interactive||action!=='run'){assertPluginSelection(selections);if(!workload)assertCaptureSelections(selections,previous?.selections);}
 const retainedHistory=workload?[]:Object.keys(previous?.selections.history??{}).filter(client=>!newSetupClientAvailable(client,platform,registered));
 const availableHistory=()=>[...historyFiles(api,claudeOnly?'claude-code':undefined).filter(file=>!retainedHistory.includes(file.harness)&& (workload||newSetupClientAvailable(file.harness,platform,registered))),...(previous?.historyJob?.files??[]).filter(file=>retainedHistory.includes(file.harness))];
 const optionalFailures=action==='run'&&interactive?new Map<string,PluginResult>():undefined;
 const configureClients=()=>applyClients(scope,selections,installPlugins,command,installDaemon,validateCapturePrincipal,['darwin','linux'].includes(platform)&&!process.env.OPENCRAWL_AUTH,daemonReady,captureMode,chosen(selections,'plugins').length>0&&eligibility(selections).eligible,stopDaemon,onProgress,inspectHooks,true,optionalFailures);
 const saveRecording=()=>sameOwner||chosen(selections,'plugins').length?configureClients():updateSetupState(scope,current=>({...current,schemaVersion:1,firstRun:'choosing',scope,selections,captureMode,pluginResults:current?.pluginResults?.filter(row=>['installed','unchanged','prepared'].includes(row.status)),humanTasks:[],acceptedAt:new Date().toISOString()}));
 const finishChoices=(state:SetupState,importing=false)=>updateSetupState(scope,current=>{
  if(!current||current.acceptedAt!==state.acceptedAt||current.installationId!==state.installationId)throw new CliError('SETUP_SCOPE_CHANGED','The saved installation changed while finishing setup. Review its current choices.');
  return {...current,firstRun:chosen(current.selections,'plugins').length||importing&&current.historyJob?'ready':'complete'};
 });
 const recordingOff=(state:SetupState)=>({status:'recording_off',scope,installationId:state.installationId,selections:state.selections,humanTasks:[]});
 async function completed(state:SetupState,startHistory=true){
  const configured=await result(state,launchHistory,inspectHooks,command,startHistory);
  if(configured.nextAction.kind==='complete')await rememberFinishedSetup(state);
  const deferred=deferredPlugins(state);
  const client=chosen(state.selections,'plugins').filter(id=>!deferred.some(row=>row.client===id)).join(',');
  const interactiveHandoff=action==='run'&&interactive&&['codex','antigravity'].includes(client);
  if(repairSaved||configured.nextAction.kind==='complete'||configured.nextAction.kind==='plugin_unavailable'||client!=='claude-code'&&!interactiveHandoff)return configured;
  const latest=await readServerSetup(api),nativeClient=latest.installations.find(row=>row.installationId===state.installationId)?.clients.find(row=>row.client===client);
  return {...configured,client,nativeMcpLoginRequired:!registered&&!['authenticated','observed'].includes(nativeClient?.mcp?.state??'pending'),agentPrompt:nativeSetupPrompt(api,client,command),nextAction:nextSetupAction(state,latest)};
 };
 async function importApproved(files:HistoryFile[]){
  const state=await applyHistory(scope,selections,files,retainedHistory);
  return completed(await finishChoices(state,true));
 }
 if(action==='run'&&interactive){
  const prospectiveHistory=values.history===undefined?{}:selections.history;
  const candidates=clients.filter(client=>client.plugin&&client.forward);
  const savedInstallation=sameOwner&&previous?.installationId&&previous.installationId===boundConfig.installationId?previous:null;
  const previousGrant=automaticUpdateClients(savedInstallation);
  const options=await Promise.all(candidates.map(async ({id,label})=>{
   const offered=newSetupClientAvailable(id,platform,registered);
   if(!offered||!await canInstall(id)){
    let detail=offered?'No compatible local installation':'Unavailable on this platform';
    if(offered&&id==='claude-code'&&hasClaudeDesktop({platform}))detail='Open or update Claude Desktop’s Code tab, then rerun setup';
    return {id,label,selected:false,disabled:true,detail};
   }
   const prior=previous?.pluginResults?.find(row=>row.client===id);
   const installState=await inspectInstall(api,id as LocalPluginClient,prior?.status);
   return {id,label,selected:values.forward===undefined||selections.forward[id]===true,disabled:false,installState};
  }));
  options.sort((a,b)=>Number(a.disabled)-Number(b.disabled));
  const selected=await choose({phase:1,title:'Record new sessions',description:'Choose which agents to record on this machine.',noneLabel:'Do not record any sessions on this machine',items:options});
  if(selected===null)return {status:'cancelled',humanTasks:[]};
  const eligibleIds=new Set(options.filter(item=>!item.disabled).map(item=>item.id));
  const selectedIds=new Set(selected.filter(row=>row.selected&&eligibleIds.has(row.id)).map(row=>row.id));
  for(const {id} of candidates){
   selections.plugins[id]=selectedIds.has(id);
   selections.forward[id]=selectedIds.has(id);
  }
  selections.history=Object.fromEntries(Object.keys(selections.history).map(id=>[id,previous?.selections.history[id]===true]));
  assertCaptureSelections(selections,previous?.selections);
  // A single checkbox represents the saved grants for the chosen recording agents.
  // The mixed state retains each existing grant until the user toggles it.
  const autoUpdateClients=previousGrant.filter(id=>!candidates.some(client=>client.id===id)&&selections.plugins[id]);
  if(selectedIds.size){
   const updates=await choose({phase:4,title:'Keep OpenCrawl plugins up to date (Recommended)',
    items:options.filter(item=>selectedIds.has(item.id)).map(({id,label})=>({id,label,selected:!savedInstallation||previousGrant.includes(id)}))});
   if(updates===null)return {status:'cancelled',humanTasks:[]};
   autoUpdateClients.push(...updates.filter(row=>row.selected&&selectedIds.has(row.id)).map(row=>row.id));
  }
  if(selectedIds.size&&eligibility(selections).eligible){
   const service=await choose({phase:3,title:'Background capture',description:'Install background utility for more reliable session capture?',noneLabel:'Record without a background service',items:[{id:'daemon',label:'Install background service',selected:values['capture-mode']===undefined||captureMode==='daemon'}]});
   if(service===null)return {status:'cancelled',humanTasks:[]};
   captureMode=service.some(item=>item.id==='daemon'&&item.selected)?'daemon':'hook';
  }
  const capture=chosen(selections,'plugins').length>0;
  if(capture){
   checkMode(selections);
   onProgress?.('Installing session capture tooling','Connecting the selected agents and enabling session recording.','installing');
  }else onProgress?.('Saving your choices','Turning off new-session recording for this workspace on this machine.');
  const recorded=await saveRecording();
  const state=await updateSetupState(scope,current=>{
   if(!current||current.acceptedAt!==recorded.acceptedAt||current.installationId!==recorded.installationId)throw new CliError('SETUP_SCOPE_CHANGED','The installation changed before saving automatic plugin updates.');
   return {...current,pluginAutoUpdates:current.installationId?{installationId:current.installationId,clients:autoUpdateClients}:undefined};
  });
  const available=availableHistory(),historyClients=clients.filter(client=>newSetupClientAvailable(client.id,platform,registered)&&client.history&&available.some(file=>file.harness===client.id));
  const selectedHistory=await choose({phase:2,title:'Import past sessions',description:historyBenefit,noneLabel:'Skip history import',emptyMessage:'No supported local session history was found. Continuing without an import.',items:historyClients.map(client=>{const count=available.filter(file=>file.harness===client.id).length;return {id:client.id,label:client.label,detail:`${count} ${count===1?'file':'files'}`,selected:prospectiveHistory[client.id]===true};})});
  if(selectedHistory===null)return {status:'cancelled',historyDecision:'unchanged',humanTasks:[]};
  const selectedClients=selectedHistory.filter(row=>row.selected).map(row=>row.id);
  if(!selectedClients.length){
   const saved=await finishChoices(state);
   return capture||sameOwner&&saved.historyJob?completed(saved,false):recordingOff(saved);
  }
  selections.history=Object.fromEntries(Object.keys(selections.history).map(id=>[id,selectedClients.includes(id)]));
  if(!state.installationId)await configureClients();
  onProgress?.('Saving your choices','Starting your history import in the background.');
  return importApproved(available.filter(file=>selections.history[file.harness]));
 }
 const files=availableHistory().filter(file=>selections.history[file.harness]),planId=createHash('sha256').update(planDigest(scope,selections,files)+captureMode).digest('hex');
 const notice=participationNotice(chosen(selections,'plugins'));
 const plan=async()=>({status:'confirmation_required',...(workload||registered?{}:{availability:setupAvailabilityMessage}),scope,clients,selections,captureMode,daemon:eligibility(selections),...(notice?{participationNotice:notice}:{}),...(selections.plugins.cursor?{nativeHooks:'Cursor setup installs the deployment-specific plugin and its recording hooks in the local plugins folder.'}:{}),historyBenefit,history:{files:files.length,bytes:files.reduce((n,f)=>n+f.bytes,0)},planId,humanTasks:await tasks(server,previous,inspectHooks),applyCommand:formatSetupCommand(['setup','apply','--api',api,...(claudeOnly?['--client','claude-code']:[]),'--plugins',list(chosen(selections,'plugins')),'--forward',list(chosen(selections,'forward')),'--history',list(chosen(selections,'history')),'--capture-mode',captureMode,'--plan-id',planId,'--yes','--json'],command)});
 if(action!=='apply'||values.yes!==true)return plan();
 checkMode(selections);
 if(values['plan-id']!==undefined&&values['plan-id']!==planId)throw new CliError('SETUP_PLAN_CHANGED',`The workspace, choices or available history changed. Review \`${formatSetupCommand(['setup','--api',api,'--json'],command)}\` again before applying.`,2);
 if(values['plan-id']===undefined&&!['plugins','forward','history'].every(group=>typeof values[group]==='string'))throw new CliError('SETUP_CONFIRMATION_REQUIRED','Use the applyCommand after the user confirms its choices, or specify all three selections with --yes.',64);
 if(!chosen(selections,'plugins').length&&!chosen(selections,'history').length)return recordingOff(await finishChoices(await saveRecording()));
 await configureClients();
 return importApproved(files);
}
export function formatSetupOutput(data:unknown):string{
 const value=data as {pluginUpdates?:ReturnType<typeof pendingPluginUpdates>;status?:string;instruction?:string;humanTasks?:SetupHumanTask[];applyCommand?:string;agentPrompt?:string;history?:{state?:string};worker?:{readiness?:string}};
 if(value.status==='recording_off')return 'No sessions will be recorded on this machine. No history import was started.';
 if(value.status==='cancelled')return 'Setup closed. Run opencrawl setup to review your choices.';
 if(value.status==='local_status')return 'Setup: local-only saved state. The server, current authentication, and worker liveness were not checked.'+(value.worker?.readiness==='pending'?'\nBackground worker supervision is pending; --json preserves its bound command and environment.':'')+(value.pluginUpdates?.length?'\n'+formatPluginUpdates(value.pluginUpdates):'')+'\nUse --json for the installation binding and saved/effective choices.';
 if(value.agentPrompt)return `OpenCrawl setup saved.${value.worker?.readiness==='pending'?' Background worker supervision is pending.':''}${value.history?.state==='queued'||value.history?.state==='running'?' History is importing in the background.':''}\nIn your primary coding agent, send:\n${value.agentPrompt}`;
 if(value.applyCommand)return 'Review the JSON setup plan, then run its applyCommand after confirming the choices.';
 if(value.status==='action_required')return value.instruction??value.humanTasks?.[0]?.instruction??'Complete CLI sign-in before continuing setup.';
 return `Setup: ${value.status??'status'}${value.history?.state?'\nHistory: '+value.history.state:''}\nUse --json for the agent-readable details.`;
}
