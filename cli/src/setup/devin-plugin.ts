import {readFileSync,existsSync} from 'node:fs';
import {join,resolve,posix} from 'node:path';
import {apiOrigin,CliError} from '../oauth.ts';
import {atomicJson,configDir,withSessionLock} from '../session.ts';
import {readCaptureConfig,request} from '../capture/runtime.ts';
import {recordNativeDaemonHook} from '../capture/daemon-handoff.ts';
import {sessionStart} from '../session-start.ts';
import {setupCommand} from './command.ts';
import {readSetupState} from './state.ts';
import {setupPluginIdentity,type PluginResult} from './plugins.ts';
import {verifyPluginBundle,pluginHookContext,pluginRecordingEnabled,recordPluginActivation,pluginActivationMatches,type PluginBinding,type VerifiedPluginBundle} from './plugin-context.ts';

const object=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const invalid=()=>new CliError('DEVIN_PLUGIN_INVALID','The Cloud plugin does not match this deployment and profile. Preserve existing state and review the installed bundle.');
type DevinPlugin=PluginBinding&VerifiedPluginBundle&{client:'devin';command:string[];recording:boolean};
const receiptPath=(configHome:string,api:string)=>join(configHome,'opencrawl','setup-plugins','devin',setupPluginIdentity(api).key,'installed.json');

/** Public configuration only. This guard also runs before the first VM has an
 * installation; it never reads provider credentials or treats a bundle as auth. */
export function readDevinPlugin(api:string,env:NodeJS.ProcessEnv=process.env):DevinPlugin {
 try{
  const origin=apiOrigin(api),identity=setupPluginIdentity(origin),configHome=resolve(env.OPENCRAWL_CONFIG_HOME??'');
  if(!env.OPENCRAWL_CONFIG_HOME||resolve(configDir())!==join(configHome,'opencrawl')||env.OPENCRAWL_AUTH!=='devin-cloud'||env.OPENCRAWL_TOKEN||env.OPENCRAWL_SESSIONS_TOKEN)throw invalid();
  let nativeRoot=env.OPENCRAWL_PLUGIN_ROOT,installedDigest:unknown;
  if(nativeRoot){
   if(env.OPENCRAWL_PLUGIN_API!==origin||env.OPENCRAWL_PLUGIN_CLIENT!=='devin'||env.OPENCRAWL_PLUGIN_NAME!==identity.name)throw invalid();
  }else{
   if(['OPENCRAWL_PLUGIN_API','OPENCRAWL_PLUGIN_CLIENT','OPENCRAWL_PLUGIN_NAME'].some(key=>env[key]!==undefined))throw invalid();
   const receipt:unknown=JSON.parse(readFileSync(receiptPath(configHome,origin),'utf8'));
   if(!object(receipt)||receipt.schemaVersion!==2||receipt.api!==origin||receipt.client!=='devin'||receipt.pluginName!==identity.name||receipt.configHome!==configHome||typeof receipt.nativeRoot!=='string'||typeof receipt.digest!=='string')throw invalid();
   nativeRoot=receipt.nativeRoot;
   installedDigest=receipt.digest;
  }
  const binding:PluginBinding={api:origin,client:'devin',pluginName:identity.name,configHome,nativeRoot};
  const bundle=verifyPluginBundle(binding);
  if(installedDigest!==undefined&&installedDigest!==bundle.digest)throw invalid();
  if(!bundle.files['.opencrawl-devin.json'])throw invalid();
  const value:unknown=JSON.parse(readFileSync(join(bundle.root,'.opencrawl-devin.json'),'utf8'));
  if(!object(value)||Object.keys(value).sort().join(',')!=='api,command,configHome,recording,schemaVersion'||value.schemaVersion!==1||value.api!==origin||value.configHome!==configHome||typeof value.recording!=='boolean'||!Array.isArray(value.command)||value.command.length!==1||typeof value.command[0]!=='string'||!posix.isAbsolute(value.command[0])||/[\x00-\x1f\x7f]/.test(value.command[0]))throw invalid();
  const current=readCaptureConfig();
  if(current&&(current.api!==origin||current.hookOwnership!=='plugin'))throw invalid();
  return {...binding,...bundle,nativeRoot:bundle.root,client:'devin',command:[value.command[0]],recording:value.recording};
 }catch{throw invalid();}
}

/** The provider already loaded this bundle. Adopt only that verified source;
 * never invoke the unrelated local Devin CLI installer or alter Cloud policy. */
export async function adoptDevinPlugin(api:string,{configHome,env=process.env}:{configHome:string;env?:NodeJS.ProcessEnv}):Promise<PluginResult>{
 const bundle=readDevinPlugin(api,env);
 if(resolve(configHome)!==bundle.configHome)throw invalid();
 const config=readCaptureConfig();
 if(!config||config.authPending||config.installationId==='pending')throw invalid();
 const file=receiptPath(configHome,bundle.api);
 if(existsSync(file)){
  const previous:unknown=JSON.parse(readFileSync(file,'utf8'));
  if(!object(previous)||previous.schemaVersion!==2||previous.api!==bundle.api||previous.client!=='devin'||previous.pluginName!==bundle.pluginName||previous.configHome!==configHome)throw invalid();
 }
 atomicJson(file,{schemaVersion:2,api:bundle.api,client:'devin',pluginName:bundle.pluginName,configHome,digest:bundle.digest,pluginId:bundle.pluginName,directory:bundle.root,nativeRoot:bundle.root});
 const active=pluginActivationMatches(bundle);
 return {client:'devin',status:active?'installed':'prepared',pluginId:bundle.pluginName,directory:bundle.root,...(!active?{message:'Waiting for this Cloud bundle’s native startup hook; installation is not capture proof.'}:{})};
}

type Dependencies={identity?:typeof request;setup?:typeof setupCommand};
/** Cloud runs SessionStart in the background. Only this startup path performs
 * enrollment; ordinary content hooks retain the shared local-only handoff.
 * An earlier missing hook remains a capture gap, never reconstructed history. */
export async function startDevinPlugin(api:string,event:unknown,{identity=request,setup=setupCommand}:Dependencies={}){
 const bundle=readDevinPlugin(api);
 if(!object(event)||event.hook_event_name!=='SessionStart'||!['startup','resume'].includes(String(event.source))||typeof event.session_id!=='string'||!/^devin-[a-zA-Z0-9_-]{1,194}$/.test(event.session_id))throw invalid();
 return withSessionLock('devin:plugin-startup',async()=>{
  // Current server verification, not decoded JWT claims or hook metadata,
  // supplies the workload owner before any local setup mutation.
  const response:unknown=await identity(bundle.api,'/api/sessions/identity',{signal:AbortSignal.timeout(15_000)});
  const principal=object(response)&&object(response.principal)?response.principal:null;
  const workload=principal&&object(principal.owner)?principal.owner:null;
  if(!principal||typeof principal.tenantId!=='string'||!principal.tenantId||typeof principal.userId!=='string'||!principal.userId||!workload||workload.kind!=='shared'||workload.provider!=='devin'||workload.sessionId!==event.session_id||typeof workload.organizationId!=='string')throw new CliError('DEVIN_IDENTITY_MISMATCH','The server did not verify this native Devin session. No installation was created.');
  const validateCapturePrincipal=(value:unknown)=>{
   const current=object(value)&&object(value.owner)?value.owner:null;
   if(!object(value)||value.tenantId!==principal.tenantId||value.userId!==principal.userId||!current||current.kind!==workload.kind||current.provider!==workload.provider||current.organizationId!==workload.organizationId||current.sessionId!==workload.sessionId)throw new CliError('DEVIN_IDENTITY_MISMATCH','The verified Cloud identity changed before profile creation. No installation was created.');
  };
  if(readDevinPlugin(api).digest!==bundle.digest)throw invalid();
  const previous=readCaptureConfig(),scope={api:bundle.api,tenantId:principal.tenantId,userId:principal.userId},saved=readSetupState(scope);
  if(previous&&(previous.authPending||previous.owner.tenantId!==scope.tenantId||previous.owner.userId!==scope.userId||(previous.harnesses??[]).some(harness=>harness!=='devin')))throw new CliError('DEVIN_PROFILE_CHANGED','This profile belongs to another installation. Preserve its queued data; use the Cloud plugin’s fresh profile.');
  if(previous)validateCapturePrincipal(previous.owner);
  if(saved&&(!saved.selections.plugins.devin||Object.entries(saved.selections.plugins).some(([client,selected])=>client!=='devin'&&selected)))throw new CliError('DEVIN_PLUGIN_NOT_SELECTED','Preserve this profile’s saved plugin choices; startup cannot enable a deselected plugin.');
  const recording=previous?!previous.disabled&&previous.harnesses?.includes('devin')===true:bundle.recording;
  const capabilities=object(response)&&object(response.capabilities)?response.capabilities:null;
  if(recording&&(!Array.isArray(capabilities?.harnesses)||!capabilities.harnesses.includes('devin')))throw new CliError('CAPTURE_HARNESS_UNSUPPORTED','This receiver has not enabled Devin capture. Preserve existing state and upgrade the receiver before recording.');
  const installPlugins:NonNullable<NonNullable<Parameters<typeof setupCommand>[3]>['installPlugins']>=async(origin,selected)=>{
   if(selected.length!==1||selected[0]!=='devin'||readDevinPlugin(origin).digest!==bundle.digest)throw invalid();
   await adoptDevinPlugin(origin,{configHome:bundle.configHome});
   const context=pluginHookContext(origin,'devin');recordPluginActivation(context,event);
   return {results:[await adoptDevinPlugin(origin,{configHome:bundle.configHome})],humanTasks:[]};
  };
  await setup(saved?'resume':'apply',bundle.api,saved?{json:true}:{plugins:'devin',forward:recording?'devin':'none',history:'none',yes:true,json:true},{command:bundle.command,installPlugins,interactive:false,expectedScope:scope,validateCapturePrincipal});
  const context=pluginHookContext(bundle.api,'devin');recordPluginActivation(context,event);
  if(context&&pluginRecordingEnabled(context))recordNativeDaemonHook('devin',event);
  return sessionStart(bundle.api,'devin',event);
 },30_000);
}
