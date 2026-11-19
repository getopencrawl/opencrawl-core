import {createHash} from 'node:crypto';
import {readFileSync, lstatSync, realpathSync} from 'node:fs';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';
import {apiOrigin, CliError} from '../oauth.ts';
import {atomicJson, configDir} from '../session.ts';
import {readCaptureConfig, type CaptureConfig} from '../capture/runtime.ts';
import {binaryPath,binaryBundleDigest,MAX_PLUGIN_BINARY,MAX_PLUGIN_TEXT,type BundleFiles} from './plugin-bundle.ts';
import {setupPluginIdentity,scopedPluginIdentity} from './plugin-identity.ts';

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

function bundleFile(root:string,name:string,limit=MAX_PLUGIN_TEXT):string {
  if(!name||name.includes('\\')||isAbsolute(name)||name.split('/').some(part=>!part||part==='.'||part==='..'))throw invalid();
  const file=resolve(root,name),inside=relative(root,file);
  if(!inside||inside.startsWith('..'+sep)||isAbsolute(inside))throw invalid();
  let current=root;
  for(const part of name.split('/')){current=join(current,part);if(lstatSync(current).isSymbolicLink())throw invalid();}
  const stat=lstatSync(file);
  if(!stat.isFile()||stat.size>limit)throw invalid();
  return file;
}

/** Validate only public plugin assets. No native credential or trust file is read. */
export function verifyPluginBundle(binding:PluginBinding):VerifiedPluginBundle {
  return inspectPluginBundle(binding);
}

// Only installation may reconstruct missing managed assets. Runtime activation
// always reads every byte from disk. The profile marker and binding must exist.
export function checkRepairablePluginBundle(binding:PluginBinding,replacements:BundleFiles):VerifiedPluginBundle {
  return inspectPluginBundle(binding,replacements);
}

function inspectPluginBundle(binding:PluginBinding,replacements?:BundleFiles):VerifiedPluginBundle {
  try {
    if(!isClient(binding.client)||!isAbsolute(binding.nativeRoot)||!isAbsolute(binding.configHome))throw invalid();
    const api=apiOrigin(binding.api),root=realpathSync(binding.nativeRoot);
    if(binding.pluginName!==scopedPluginIdentity(api).name&&(binding.client==='devin'||binding.pluginName!==setupPluginIdentity(api).name))throw invalid();
    if(!lstatSync(root).isDirectory())throw invalid();
    const marker=readJson(bundleFile(root,'.opencrawl-setup-plugin.json'));
    if(!object(marker)||(marker.schemaVersion!==2&&marker.schemaVersion!==3)||marker.api!==api||marker.client!==binding.client||marker.pluginName!==binding.pluginName||marker.configHome!==resolve(binding.configHome)||typeof marker.digest!=='string'||!object(marker.files))throw invalid();
    const executable=marker.schemaVersion===3?marker.executable:undefined;
    if(marker.schemaVersion===3&&(!binaryPath(executable)||!(executable in marker.files)))throw invalid();
    const entries=Object.entries(marker.files);
    if(!entries.length||entries.length>128)throw invalid();
    const files:Record<string,string>={},contents:Record<string,string>={};let bytes=0;
    for(const [name,digest] of entries){
      if(name==='.opencrawl-setup-plugin.json'||typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))throw invalid();
      const binary=name===executable;
      let data:Buffer;
      try{
        const file=bundleFile(root,name,binary?MAX_PLUGIN_BINARY:MAX_PLUGIN_TEXT);
        data=readFileSync(file);
        if(binary&&process.platform!=='win32'&&(lstatSync(file).mode&0o777)!==0o755)throw invalid();
      }catch(error){
        if((error as NodeJS.ErrnoException).code!=='ENOENT'||!replacements||name==='.opencrawl-binding.json'||!Object.hasOwn(replacements,name))throw error;
        data=Buffer.from(replacements[name]!);
      }
      if(!binary)bytes+=data.length;
      if(bytes>MAX_PLUGIN_TEXT||hash(data)!==digest)throw invalid();
      files[name]=digest;if(!executable)contents[name]=data.toString('utf8');
    }
    if((typeof executable==='string'?binaryBundleDigest(files,executable):hash(JSON.stringify(contents,null,2)+'\n'))!==marker.digest)throw invalid();
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
  // Ownership checks still admit an intact older bundle for installer migration.
  // Activation requires Codex's deployment-scoped MCP name, not a colliding key.
  if(binding.client==='codex'){
    if(!bundle.files['.mcp.json'])throw invalid();
    const mcp=readJson(bundleFile(bundle.root,'.mcp.json'));
    const servers=object(mcp)&&object(mcp.mcpServers)?mcp.mcpServers:null;
    const server=servers?.[binding.pluginName];
    if(!servers||Object.keys(servers).length!==1||!object(server)||server.type!=='http'||server.url!==binding.api+'/mcp')throw invalid();
  }
}

/** Reject mismatched deployment/client/profile before reading a transcript or using auth. */
export function pluginHookContext(api:string,client:string,env:NodeJS.ProcessEnv=process.env):PluginHookContext|null {
  if(!hasPluginContext(env)){
    if(readCaptureConfig()?.hookOwnership==='plugin')throw invalid();
    return null;
  }
  try {
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
