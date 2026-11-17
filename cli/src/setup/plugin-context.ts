import {createHash} from 'node:crypto';
import {readFileSync, lstatSync, realpathSync} from 'node:fs';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';
import {apiOrigin, CliError} from '../oauth.ts';
import {atomicJson, configDir} from '../session.ts';
import {readCaptureConfig, type CaptureConfig} from '../capture/runtime.ts';

export type PluginHookClient = 'claude-code'|'codex'|'cursor'|'antigravity'|'devin';
export type PluginBinding = {api:string;client:PluginHookClient;pluginName:string;configHome:string;nativeRoot:string};
export type VerifiedPluginBundle = {root:string;digest:string;files:Record<string,string>};
type PluginActivation = PluginBinding & {schemaVersion:1;digest:string;installationId:string;owner:{tenantId:string;userId:string};event:string;observedAt:string};
export type PluginHookContext = PluginBinding & VerifiedPluginBundle & {installationId:string;owner:{tenantId:string;userId:string}};
const keys = ['OPENCRAWL_PLUGIN_API','OPENCRAWL_PLUGIN_NAME','OPENCRAWL_PLUGIN_CLIENT','OPENCRAWL_PLUGIN_ROOT'] as const;
const hash = (value:string|Buffer) => createHash('sha256').update(value).digest('hex');
const object = (value:unknown):value is Record<string,unknown> => Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const invalid = () => new CliError('PLUGIN_CONTEXT_INVALID','This OpenCrawl plugin no longer matches its installed CLI profile. Run setup again for the selected deployment; existing capture data is preserved.');
const originKey = (api:string) => hash(apiOrigin(api)).slice(0,12);
const profileRoot = (home:string,client:string,api:string) => join(home,'opencrawl','setup-plugins',client,originKey(api));
const isClient = (value:unknown):value is PluginHookClient => typeof value==='string'&&['claude-code','codex','cursor','antigravity','devin'].includes(value);
const readJson = (path:string):unknown => JSON.parse(readFileSync(path,'utf8'));

export function hasPluginContext(env:NodeJS.ProcessEnv=process.env):boolean {
  return keys.some(key=>env[key]!==undefined);
}

/** The Claude Code and Codex plugins live in plugins/opencrawl-sessions and are
 * installed natively from there. They carry no deployment binding: their hooks
 * name only the installed copy, and the saved CLI profile decides the rest. */
export const sessionsPlugin = {name:'opencrawl-sessions',marketplace:'opencrawl-core',id:'opencrawl-sessions@opencrawl-core'} as const;
export type SessionsClient = 'claude-code'|'codex';
export const isSessionsClient = (value:unknown):value is SessionsClient => value==='claude-code'||value==='codex';
const sessionsRootKey = 'OPENCRAWL_SESSIONS_PLUGIN_ROOT';
const sessionsFile = (client:SessionsClient,name:string) => join(configDir(),'setup-plugins',client,name);

export function hasSessionsPluginContext(env:NodeJS.ProcessEnv=process.env):boolean {
  return env[sessionsRootKey]!==undefined;
}

/** The plugin copy that ran this hook, or null when it is not that client's plugin. */
export function sessionsPluginRoot(client:string,root:string|undefined=process.env[sessionsRootKey]):string|null {
  if(!isSessionsClient(client)||!root||!isAbsolute(root))return null;
  try {
    const manifest=readJson(join(root,client==='codex'?'.codex-plugin':'.claude-plugin','plugin.json'));
    return object(manifest)&&manifest.name===sessionsPlugin.name?realpathSync(root):null;
  } catch {return null;}
}

/** A saved profile with its own global hooks keeps them; the plugin's hooks stand aside. */
export function sessionsHookSuperseded():boolean {
  const config=readCaptureConfig();
  return Boolean(config&&config.hookOwnership!=='plugin');
}

/** Installing the plugin is not consent to record. Only setup's saved choice is. */
export function sessionsRecordingEnabled(client:string):boolean {
  const config=readCaptureConfig();
  return Boolean(isSessionsClient(client)&&config&&config.hookOwnership==='plugin'&&!config.disabled&&!config.authPending&&config.harnesses?.includes(client));
}

export function writeSessionsReceipt(client:SessionsClient,api:string,nativeRoot:string):void {
  atomicJson(sessionsFile(client,'sessions.json'),{schemaVersion:1,client,api:apiOrigin(api),pluginId:sessionsPlugin.id,nativeRoot});
}

export function readSessionsReceipt(client:SessionsClient):{api:string;nativeRoot:string}|null {
  try {
    const receipt=readJson(sessionsFile(client,'sessions.json'));
    return object(receipt)&&receipt.schemaVersion===1&&receipt.client===client&&receipt.pluginId===sessionsPlugin.id&&typeof receipt.api==='string'&&typeof receipt.nativeRoot==='string'?{api:receipt.api,nativeRoot:receipt.nativeRoot}:null;
  } catch {return null;}
}

/** Operational evidence that the client loaded the plugin and ran its hook. */
export function recordSessionsActivation(client:string,event:unknown):void {
  const root=sessionsPluginRoot(client);if(!root||!isSessionsClient(client))return;
  const name=nativeEvent(client,event);if(!name)return;
  atomicJson(sessionsFile(client,'sessions-activation.json'),{schemaVersion:1,client,pluginId:sessionsPlugin.id,nativeRoot:root,event:name,observedAt:new Date().toISOString()});
}

export function sessionsActivationMatches(client:SessionsClient,nativeRoot:string):boolean {
  try {
    const receipt=readJson(sessionsFile(client,'sessions-activation.json'));
    return object(receipt)&&receipt.schemaVersion===1&&receipt.client===client&&receipt.pluginId===sessionsPlugin.id&&receipt.nativeRoot===realpathSync(nativeRoot)&&typeof receipt.observedAt==='string'&&Number.isFinite(Date.parse(receipt.observedAt));
  } catch {return false;}
}

function bundleFile(root:string,name:string):string {
  if(!name||name.includes('\\')||isAbsolute(name)||name.split('/').some(part=>!part||part==='.'||part==='..'))throw invalid();
  const file=resolve(root,name),inside=relative(root,file);
  if(!inside||inside.startsWith('..'+sep)||isAbsolute(inside))throw invalid();
  let current=root;
  for(const part of name.split('/')){current=join(current,part);if(lstatSync(current).isSymbolicLink())throw invalid();}
  const stat=lstatSync(file);
  if(!stat.isFile()||stat.size>2_000_000)throw invalid();
  return file;
}

/** Validate only public plugin assets. No native credential or trust file is read. */
export function verifyPluginBundle(binding:PluginBinding):VerifiedPluginBundle {
  try {
    if(!isClient(binding.client)||!isAbsolute(binding.nativeRoot)||!isAbsolute(binding.configHome))throw invalid();
    const api=apiOrigin(binding.api),root=realpathSync(binding.nativeRoot);
    if(binding.pluginName!=='opencrawl-'+originKey(api)||!lstatSync(root).isDirectory())throw invalid();
    const marker=readJson(bundleFile(root,'.opencrawl-setup-plugin.json'));
    if(!object(marker)||marker.schemaVersion!==2||marker.api!==api||marker.client!==binding.client||marker.pluginName!==binding.pluginName||marker.configHome!==resolve(binding.configHome)||typeof marker.digest!=='string'||!object(marker.files))throw invalid();
    const entries=Object.entries(marker.files);
    if(!entries.length||entries.length>128)throw invalid();
    const files:Record<string,string>={},contents:Record<string,string>={};let bytes=0;
    for(const [name,digest] of entries){
      if(name==='.opencrawl-setup-plugin.json'||typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))throw invalid();
      const data=readFileSync(bundleFile(root,name));bytes+=data.length;
      if(bytes>2_000_000||hash(data)!==digest)throw invalid();
      files[name]=digest;contents[name]=data.toString('utf8');
    }
    if(hash(JSON.stringify(contents,null,2)+'\n')!==marker.digest)throw invalid();
    return {root,digest:marker.digest,files};
  } catch {throw invalid();}
}

function profile(binding:PluginBinding):CaptureConfig {
  if(resolve(configDir())!==resolve(binding.configHome,'opencrawl'))throw invalid();
  const config=readCaptureConfig();
  if(!config||config.hookOwnership!=='plugin'||config.authPending||config.api!==binding.api||!config.installationId||config.installationId==='pending'||!config.owner?.tenantId||!config.owner.userId)throw invalid();
  return config;
}

function installedBundle(binding:PluginBinding,bundle:VerifiedPluginBundle):void {
  const receipt=readJson(join(profileRoot(binding.configHome,binding.client,binding.api),'installed.json'));
  if(!object(receipt)||receipt.schemaVersion!==2||receipt.api!==binding.api||receipt.client!==binding.client||receipt.pluginName!==binding.pluginName||receipt.digest!==bundle.digest||typeof receipt.nativeRoot!=='string'||realpathSync(receipt.nativeRoot)!==bundle.root)throw invalid();
}

/** Reject mismatched deployment/client/profile before reading a transcript or using auth. */
export function pluginHookContext(api:string,client:string,env:NodeJS.ProcessEnv=process.env):PluginHookContext|null {
  if(!hasPluginContext(env)){
    if(readCaptureConfig()?.hookOwnership==='plugin'&&!sessionsPluginRoot(client,env[sessionsRootKey]))throw invalid();
    return null;
  }
  try {
    // Claude Code and Codex no longer use a generated, deployment-bound bundle.
    if(isSessionsClient(client))throw invalid();
    // Native runners remove ambient tokens and workload identity. An explicit
    // generated --api must never rebind a secret inherited from another app.
    if(env.OPENCRAWL_TOKEN||env.OPENCRAWL_SESSIONS_TOKEN||(client==='devin'?env.OPENCRAWL_AUTH!=='devin-cloud':Boolean(env.OPENCRAWL_AUTH)))throw invalid();
    if(!isClient(client)||keys.some(key=>!env[key])||!env.OPENCRAWL_CONFIG_HOME||env.OPENCRAWL_PLUGIN_CLIENT!==client||apiOrigin(env.OPENCRAWL_PLUGIN_API!)!==apiOrigin(api))throw invalid();
    const binding:PluginBinding={api:apiOrigin(api),client,pluginName:env.OPENCRAWL_PLUGIN_NAME!,configHome:resolve(env.OPENCRAWL_CONFIG_HOME),nativeRoot:env.OPENCRAWL_PLUGIN_ROOT!};
    const config=profile(binding),bundle=verifyPluginBundle(binding);
    installedBundle(binding,bundle);
    return {...binding,...bundle,nativeRoot:bundle.root,installationId:config.installationId,owner:{tenantId:config.owner.tenantId,userId:config.owner.userId}};
  }catch{throw invalid();}
}

/** Startup participation and MCP access do not require forward recording. */
export function pluginRecordingEnabled(context:PluginHookContext):boolean {
  const current=profile(context);
  if(current.installationId!==context.installationId||current.owner.tenantId!==context.owner.tenantId||current.owner.userId!==context.owner.userId)throw invalid();
  return !current.disabled&&current.harnesses?.includes(context.client)===true;
}

function nativeEvent(client:PluginHookClient,event:unknown):string|null {
  if(!object(event))return null;
  if(client!=='cursor'&&typeof event.cursor_version==='string')return null;
  const name=client==='antigravity'?event.hookEventName:event.hook_event_name;
  const id=client==='antigravity'?event.conversationId:client==='cursor'?(event.session_id??event.conversation_id):event.session_id;
  if(typeof name!=='string'||typeof id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(id))return null;
  if(name==='SessionStart'&&client!=='antigravity'&&!(client==='devin'?['startup','resume']:['startup','resume','clear','compact','fork']).includes(String(event.source)))return null;
  const names=client==='devin'?['SessionStart','UserPromptSubmit','PostToolUse','Stop','PostCompaction']
    :client==='cursor'?['sessionStart','sessionEnd','beforeSubmitPrompt','afterAgentResponse','afterAgentThought','postToolUse','postToolUseFailure','preCompact','stop']
    :client==='antigravity'?['SessionStart','PreInvocation','PostInvocation','PreToolUse','PostToolUse','Stop']
    :['SessionStart','SessionEnd','UserPromptSubmit','PreToolUse','PostToolUse','PostToolUseFailure','PreCompact','PostCompact','SubagentStart','SubagentStop','Stop','Notification'];
  return names.includes(name)?name:null;
}

/** Operational activation evidence, not an authorization grant or a substitute for native E2E. */
export function recordPluginActivation(context:PluginHookContext|null,event:unknown):void {
  if(!context)return;
  const name=nativeEvent(context.client,event);if(!name){if(context.client==='devin')throw invalid();return;}
  const current=profile(context);
  if(current.installationId!==context.installationId||current.owner.tenantId!==context.owner.tenantId||current.owner.userId!==context.owner.userId)throw invalid();
  if(context.client==='devin'){
    const principal:unknown=current.owner;
    const workload=object(principal)&&object(principal.owner)?principal.owner:null;
    if(!workload||workload.kind!=='shared'||workload.provider!=='devin'||!object(event)||event.session_id!==workload.sessionId)throw invalid();
  }
  const receipt:PluginActivation={schemaVersion:1,api:context.api,client:context.client,pluginName:context.pluginName,configHome:context.configHome,nativeRoot:context.root,digest:context.digest,installationId:context.installationId,owner:context.owner,event:name,observedAt:new Date().toISOString()};
  atomicJson(join(profileRoot(context.configHome,context.client,context.api),'activation.json'),receipt);
}

export function pluginActivationMatches(binding:PluginBinding&{digest:string}):boolean {
  try {
    const config=profile(binding),bundle=verifyPluginBundle(binding);installedBundle(binding,bundle);
    if(bundle.digest!==binding.digest)return false;
    const receipt=readJson(join(profileRoot(binding.configHome,binding.client,binding.api),'activation.json'));
    return object(receipt)&&receipt.schemaVersion===1&&receipt.api===binding.api&&receipt.client===binding.client&&receipt.pluginName===binding.pluginName&&receipt.configHome===resolve(binding.configHome)&&receipt.nativeRoot===bundle.root&&receipt.digest===bundle.digest&&receipt.installationId===config.installationId&&object(receipt.owner)&&receipt.owner.tenantId===config.owner.tenantId&&receipt.owner.userId===config.owner.userId&&typeof receipt.observedAt==='string'&&Number.isFinite(Date.parse(receipt.observedAt));
  }catch{return false;}
}
