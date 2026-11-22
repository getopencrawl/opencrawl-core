import {registrationMcp} from './registration-mcp.ts';
import {readSession} from '../session.ts';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {readFileSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {apiOrigin,CliError} from '../oauth.ts';
import {atomicJson,configDir} from '../session.ts';
import {readCaptureConfig} from '../capture/runtime.ts';
import {pluginRelease,type PluginRelease} from './plugin-release.ts';
import {loadPluginArchive} from './plugin-archive.ts';
import {installSetupPlugins,setupPluginIdentity,type PluginOptions,type PluginClient} from './plugins.ts';
import {setupAgentGuide} from './agent-guide.ts';
import {profileSetupCommand,setupCommandForSelf} from './invocation.ts';

export type CaptureMode='hook'|'daemon';
export type LocalPluginClient=Exclude<PluginClient,'devin'>;
export type PublishedPackage={files:Record<string,string>;binaries?:Record<string,Buffer>;executable?:string;minimumHarnessVersion?:string;source:{repository:string;ref:string;path:string;name:string;version:string;archive?:{platform:string;url:string;sha256:string;metadataSha256:string}};captureAvailable:boolean;daemonHandoff:boolean};
const invalid=()=>new CliError('PLUGIN_PACKAGE_INVALID','The pinned plugin package could not be verified. Existing plugins were preserved.');
const blobHash=(text:string)=>{const bytes=Buffer.from(text);return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');};
export const packageRelease=(client:string,release:PluginRelease=pluginRelease)=>release.packages.find(row=>row.harness===client);

/** Only immutable, reviewed public files are fetched. No account credential is sent. */
export async function loadPublishedPackage(client:LocalPluginClient,{fetcher=fetch,cache=join(configDir(),'setup','packages'),release=pluginRelease,platform=process.platform+'-'+process.arch,signal,historical=false}: {historical?:boolean;signal?:AbortSignal;fetcher?:typeof fetch;cache?:string;release?:PluginRelease;platform?:string}={}):Promise<PublishedPackage>{
 const entry=packageRelease(client,release);release={...release,ref:entry?.ref??release.ref};if(!entry||!/^[a-f0-9]{40}$/.test(release.ref)||release.repository!=='getopencrawl/opencrawl-plugins')throw invalid();
 let binary:Awaited<ReturnType<typeof loadPluginArchive>>|undefined;
 if(entry.archives)binary=await loadPluginArchive(entry,release,platform,{fetcher,cache,signal,historical});
 const expected=Object.entries(entry.files??{}),path=join(cache,release.ref,client+'.json');
 const valid=(value:unknown):value is Record<string,string>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===expected.length&&expected.every(([name,spec])=>{const text=(value as Record<string,unknown>)[name];return typeof text==='string'&&Buffer.byteLength(text)===spec.bytes&&blobHash(text)===spec.sha;}));
 let files:unknown=binary?.files;if(!binary)try{files=JSON.parse(readFileSync(path,'utf8'));}catch{}
 if(!binary&&!valid(files)){
  const loaded:Record<string,string>={};let index=0;
  await Promise.all(Array.from({length:Math.min(4,expected.length)},async()=>{
   for(;;){const item=expected[index++];if(!item)return;const [name,spec]=item;
    const response=await fetcher(`https://raw.githubusercontent.com/${release.repository}/${release.ref}/${entry.path}/${name}`,{redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30_000)]):AbortSignal.timeout(30_000)});
    if(!response.ok||!response.body)throw invalid();
    const chunks:Uint8Array[]=[];let size=0;const reader=response.body.getReader();
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>spec.bytes){await reader.cancel();throw invalid();}chunks.push(value);}}finally{reader.releaseLock();}
    loaded[name]=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
   }
  }));
  if(!valid(loaded))throw invalid();files=loaded;atomicJson(path,files);
 }
 if(!binary&&!valid(files))throw invalid();
 const textFiles=files as Record<string,string>,capability=JSON.parse(textFiles['capabilities.json']!);
 if(capability.schemaVersion!==1||capability.harness!==client||capability.version!==entry.version||capability.cliRequired!==false||typeof capability.capture?.minimum!=='boolean'||typeof capability.daemonHandoff!=='boolean'||
   capability.minimumHarnessVersion!==undefined&&(typeof capability.minimumHarnessVersion!=='string'||capability.minimumHarnessVersion.length>128)||
   !historical&&(capability.capture.minimum!==entry.captureAvailable||capability.daemonHandoff!==entry.daemonHandoff||capability.minimumHarnessVersion!==entry.minimumHarnessVersion))throw invalid();
 const available=!['stub','development'].includes(capability.status);
 return {files:textFiles,...(capability.minimumHarnessVersion?{minimumHarnessVersion:capability.minimumHarnessVersion}:{}),...(binary?{binaries:binary.binaries,executable:binary.executable}:{}),source:{repository:release.repository,ref:release.ref,path:entry.path,name:entry.name,version:entry.version,...(binary?{archive:binary.archive}:{})},captureAvailable:available&&capability.capture.minimum===true,daemonHandoff:available&&capability.daemonHandoff===true};
}

/** Match the per-client release layout as well as the unified plugin release layout. */
export function acceptedPackageSource(client:LocalPluginClient,source:PublishedPackage['source']){
 const pin=packageRelease(client);
 if(!pin||source.repository!==pluginRelease.repository||!/^\d+\.\d+\.\d+$/.test(source.version)||!/^[a-f0-9]{40}$/.test(source.ref))return false;
 const legacy=source.path==='local/'+client&&source.name==='opencrawl-local-'+client;
 if(!legacy&&(source.path!==pin.path||source.name!==pin.name))return false;
 const archive=source.archive;
 if(!archive)return true;
 const tag=(legacy?'local-'+client+'-v':'v')+source.version;
 const basename=legacy?source.name:'opencrawl-'+client;
 const platform=process.platform+'-'+process.arch;
 const url='https://github.com/'+pluginRelease.repository+'/releases/download/'+tag+'/'+basename+'-'+source.version+'-'+platform+'.zip';
 return archive.platform===platform&&archive.url===url&&/^[a-f0-9]{64}$/.test(archive.sha256)&&/^[a-f0-9]{64}$/.test(archive.metadataSha256);
}

/** Repair uses the accepted release receipt, including both artifact hashes. */
export async function loadAcceptedPackage(client:LocalPluginClient,source:PublishedPackage['source']){
 const pin=packageRelease(client),archive=source.archive;
 if(!pin||!archive||!acceptedPackageSource(client,source))throw invalid();
 const {platform,url}=archive;
 const entry={...pin,name:source.name,path:source.path,ref:source.ref,version:source.version,archives:{[platform]:{url,sha256:archive.sha256,metadataUrl:url.slice(0,-4)+'.json',metadataSha256:archive.metadataSha256}}};
 const pkg=await loadPublishedPackage(client,{release:{...pluginRelease,ref:source.ref,packages:[entry]},platform,historical:true});
 if(!isDeepStrictEqual(pkg.source,source))throw invalid();
 return pkg;
}

export function bindPublishedPackage(client:LocalPluginClient,api:string,source:PublishedPackage,{configHome,installationId,owner,captureMode,command=setupCommandForSelf(),env=process.env}:{configHome:string;installationId:string;owner:{tenantId:string;userId:string};captureMode:CaptureMode;command?:string[];env?:NodeJS.ProcessEnv}):PublishedPackage{
 const origin=apiOrigin(api),identity=setupPluginIdentity(origin);
 if(!isAbsolute(configHome)||!installationId||installationId==='pending'||!owner.tenantId||!owner.userId||!['hook','daemon'].includes(captureMode))throw new CliError('INVALID_PLUGIN_BINDING','A native plugin requires an explicit enrolled profile, owner, installation and capture mode.');
 const files={...source.files},manifest=client==='claude-code'?'.claude-plugin/plugin.json':client==='codex'?'.codex-plugin/plugin.json':client==='cursor'?'.cursor-plugin/plugin.json':'.antigravity-plugin/plugin.json';
 const json=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
 files[manifest]=json({...JSON.parse(files[manifest]!),name:identity.name});
 const registrationId=owner.userId.startsWith('agent_reg_')?owner.userId:undefined;
 if(registrationId && readSession(origin)?.registrationId!==registrationId)throw invalid();
 const transport=registrationId?registrationMcp(command,{api:origin,configHome,installationId,registrationId}):{type:'http',url:origin+'/mcp'};
 const mcp=json({mcpServers:{[client==='codex'?identity.name:'opencrawl']:transport}});
 for(const name of ['.mcp.json','mcp.json','mcp_config.json'])if(name in files)files[name]=mcp;
 files['.opencrawl-binding.json']=json({schemaVersion:1,client,api:origin,configHome:resolve(configHome),installationId,owner:{tenantId:owner.tenantId,userId:owner.userId},captureMode});
 files['.opencrawl-source.json']=json(source.source);
 files['skills/opencrawl-setup/SKILL.md']=setupAgentGuide(client,origin,profileSetupCommand(command,configHome,env),process.platform,client==='codex'?{name:identity.name,url:origin+'/mcp'}:undefined,Boolean(registrationId))+`\nVerify the native MCP connection selected by setup for ${origin}/mcp.\n`;
 return {...source,files};
}

/** Enrollment precedes binding; source package loading never invents an owner. */
export async function installPublishedSetupPlugins(api:string,selected:string[],options:PluginOptions&{captureMode?:CaptureMode;loadPackage?:typeof loadPublishedPackage}={}){
 if(selected.length===1&&selected[0]==='devin')return installSetupPlugins(api,selected,options);
 const config=readCaptureConfig(),origin=apiOrigin(api),configHome=dirname(configDir());
 if(selected.length&&(!config||config.api!==origin||config.authPending||config.installationId==='pending'))throw new CliError('INVALID_PLUGIN_BINDING','Enroll this exact workspace profile before installing its native plugin.');
 const bundles:Partial<Record<LocalPluginClient,PublishedPackage>>={};
 for(const client of selected){
  if(client==='devin')continue;
  if(!packageRelease(client))throw invalid();
  const source=await (options.loadPackage??loadPublishedPackage)(client as LocalPluginClient);
  bundles[client as LocalPluginClient]=bindPublishedPackage(client as LocalPluginClient,origin,source,{configHome,installationId:config!.installationId,owner:config!.owner,captureMode:options.captureMode??'hook',command:options.command,env:options.env});
 }
 const validateBinding=()=>{if(!isDeepStrictEqual(config,readCaptureConfig())||options.env?.OPENCRAWL_CONFIG_HOME&&resolve(options.env.OPENCRAWL_CONFIG_HOME)!==configHome)throw new CliError('SETUP_SCOPE_CHANGED','The enrolled plugin profile changed during installation. Preserve the saved state and retry.');};
 validateBinding();
 return installSetupPlugins(origin,selected,{...options,bundles,validateBinding});
}
