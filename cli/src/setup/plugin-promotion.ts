import {existsSync,lstatSync,mkdtempSync,readdirSync,realpathSync,rmdirSync,rmSync,unlinkSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename,dirname,join,relative,sep} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {atomicJson,configDir,syncDirectory,withSessionLock} from '../session.ts';
import {compare,read,stable} from '../distribution.ts';
import {readCaptureConfig} from '../capture/runtime.ts';
import {readSetupState,updateSetupState,automaticUpdateClients,type SetupState} from './state.ts';
import {verifyPluginBundle,type PluginBinding} from './plugin-context.ts';
import {setupPluginIdentity,recordingInstallState,recordingRuntime,writeBundle,type PluginOptions} from './plugins.ts';
import {bindPublishedPackage,loadPublishedPackage,type PublishedPackage} from './published-plugins.ts';
import {pluginRelease} from './plugin-release.ts';
import {bundleManifest} from './plugin-bundle.ts';
import {exchangePluginDirectories} from './exchange-plugin.ts';

type Client='claude-code'|'cursor';
type Journal={installationId:string;client:Client;oldDigest:string;nextDigest:string;directory:string;
  source:PublishedPackage['source'];daemonHandoff:boolean;preparedAt:string};
const marker='.opencrawl-setup-plugin.json';

function ordinaryPath(base:string,target:string) {
  return !lstatSync(base).isSymbolicLink()&&realpathSync(target)===join(realpathSync(base),relative(base,target));
}

// Preserve files the user has added to this directory.
function exclusivelyManaged(root:string,files:Record<string,string>) {
  const allowed=new Set([...Object.keys(files),marker]);
  function inspect(directory:string):boolean {
    return readdirSync(directory,{withFileTypes:true}).every(entry=>{
      const file=join(directory,entry.name),name=relative(root,file).split(sep).join('/');
      if(entry.isDirectory())return [...allowed].some(asset=>asset.startsWith(name+'/'))&&inspect(file);
      return entry.isFile()&&allowed.has(name);
    });
  }
  return inspect(root);
}

// Existing sessions may have already loaded the old list of commands. Require
// their entry points and hook registrations to still be available after exchange.
function object(value:unknown):value is Record<string,unknown>{
  return Boolean(value&&typeof value==='object'&&!Array.isArray(value));
}
export function retainsHookRegistrations(old:unknown,next:unknown):boolean {
  if(!object(old)||!object(next))return false;
  const {hooks:previous,...oldOptions}=old,{hooks:updated,...newOptions}=next;
  if(!object(previous)||!object(updated)||!isDeepStrictEqual(oldOptions,newOptions))return false;
  return Object.entries(previous).every(([event,entries])=>{
    const current=updated[event];
    if(!Array.isArray(entries)||!Array.isArray(current))return false;
    return entries.every(entry=>current.some(candidate=>{
      if(!object(entry)||!object(candidate))return false;
      const {hooks:commands,...match}=entry,{hooks:additions,...nextMatch}=candidate;
      if(!isDeepStrictEqual(match,nextMatch))return false;
      if(commands===undefined)return additions===undefined;
      return Array.isArray(commands)&&Array.isArray(additions)&&commands.every(command=>additions.some(other=>isDeepStrictEqual(command,other)));
    }));
  });
}

export async function promoteDirectoryPlugin(state:SetupState,client:Client,signal?:AbortSignal,load=loadPublishedPackage,native:PluginOptions={}) {
  if(process.platform!=='darwin'&&process.platform!=='linux')return false;
  const api=state.scope.api,identity=setupPluginIdentity(api),home=dirname(configDir());
  const manager=join(configDir(),'setup-plugins',client,identity.key);
  const live=client==='cursor'?join(homedir(),'.cursor','plugins','local',identity.name):join(manager,'marketplace',identity.name);
  const receiptFile=join(manager,'installed.json'),journalFile=join(manager,'update-transaction.json');
  const pin=pluginRelease.packages.find(row=>row.harness===client),archive=pin?.archives?.[process.platform+'-'+process.arch];
  const config=readCaptureConfig(),receipt=read(receiptFile),installationId=state.installationId;
  if(!pin||!archive||!installationId||!config||config.disabled||config.authPending||config.hookOwnership!=='plugin'||
    config.api!==api||config.installationId!==installationId||config.owner?.tenantId!==state.scope.tenantId||config.owner?.userId!==state.scope.userId||
    !config.harnesses?.includes(client)||receipt?.schemaVersion!==2||receipt.api!==api||receipt.client!==client||
    receipt.configHome!==home||receipt.pluginName!==identity.name||receipt.directory!==live||receipt.nativeRoot!==live)return false;
  if(!ordinaryPath(home,manager)||!ordinaryPath(client==='cursor'?homedir():manager,live))return false;
  const binding:PluginBinding={client,api,pluginName:identity.name,configHome:home,nativeRoot:live};
  const active=verifyPluginBundle(binding),enrolled=read(join(live,'.opencrawl-binding.json')),source=read(join(live,'.opencrawl-source.json'));
  if(enrolled?.installationId!==installationId||enrolled.client!==client||enrolled.api!==api||enrolled.configHome!==home||
    enrolled.owner?.tenantId!==config.owner.tenantId||enrolled.owner?.userId!==config.owner.userId||enrolled.captureMode!==(state.captureMode??'hook'))return false;
  const prior=state.pluginResults?.find(row=>row.client===client);
  if(!prior?.source?.archive||prior.source.repository!==pluginRelease.repository||prior.source.path!==pin.path||
    !['installed','unchanged','prepared'].includes(prior.status))return false;
  const consent=()=>automaticUpdateClients(readSetupState(state.scope)).includes(client)&&isDeepStrictEqual(config,readCaptureConfig());

  function clearStage(tx:Journal,expected:string){
    const folder=join(tx.directory,'bundle');
    if(existsSync(folder)){
      if(!ordinaryPath(manager,folder))throw new Error('Plugin backup moved');
      const saved=verifyPluginBundle({...binding,nativeRoot:folder});
      if(saved.digest!==expected||!exclusivelyManaged(folder,saved.files))throw new Error('Plugin backup changed');
      rmSync(folder,{recursive:true});
    }
    if(existsSync(tx.directory))rmdirSync(tx.directory);
  }
  async function commit(tx:Journal){
    atomicJson(receiptFile,{...receipt,digest:tx.nextDigest,...(client==='cursor'?{captureConfirmed:false,preparedAt:tx.preparedAt}:{})});
    await updateSetupState(state.scope,current=>{
      if(!current||current.installationId!==installationId)throw new Error('Installation changed during plugin update');
      return {...current,pluginResults:current.pluginResults?.map(row=>row.client!==client?row:{...row,source:tx.source,
        status:client==='cursor'?'prepared':'installed',preparedAt:client==='cursor'?tx.preparedAt:undefined,message:undefined,captureAvailable:true,daemonHandoff:tx.daemonHandoff})};
    });
    clearStage(tx,tx.oldDigest);
    unlinkSync(journalFile);
    syncDirectory(manager);
  }
  if(existsSync(journalFile)){
    const tx=read(journalFile) as Journal|null;
    if(!tx||tx.installationId!==installationId||tx.client!==client||tx.source?.repository!==pluginRelease.repository||tx.source.path!==pin.path||
      typeof tx.directory!=='string'||dirname(tx.directory)!==manager||!/^swap-[A-Za-z0-9]+$/.test(basename(tx.directory)))return false;
    if(active.digest===tx.nextDigest&&isDeepStrictEqual(source,tx.source)&&[tx.oldDigest,tx.nextDigest].includes(receipt.digest)){
      // The exchange has already happened. Its recorded release may predate this CLI.
      return withSessionLock('capture:configuration',async()=>{
        if(!isDeepStrictEqual(config,readCaptureConfig())||verifyPluginBundle(binding).digest!==tx.nextDigest)return false;
        await commit(tx);return true;
      },0,signal);
    }
    if(active.digest!==tx.oldDigest||active.digest!==receipt.digest)return false;
    clearStage(tx,tx.nextDigest);unlinkSync(journalFile);
  }
  if(!consent()||active.digest!==receipt.digest||!isDeepStrictEqual(source,prior.source)||!stable(source.version)||
    compare(source.version,pin.version)>=0||!exclusivelyManaged(live,active.files))return false;
  const pkg=await load(client,{signal});
  if(pkg.source.version!==pin.version||pkg.source.archive?.sha256!==archive.sha256||!pkg.captureAvailable||
    (enrolled.captureMode==='daemon'&&!pkg.daemonHandoff))return false;
  if(!await recordingRuntime(client,native,process.platform,pkg.minimumHarnessVersion)||
    await recordingInstallState(api,client,prior.status,{...native,requireLiveDirectory:true})!=='installed')return false;
  const candidate=bindPublishedPackage(client,api,pkg,{configHome:home,installationId,owner:config.owner,captureMode:enrolled.captureMode,command:config.command});
  const contents={...candidate.files,...candidate.binaries};
  if(Object.keys(active.files).some(name=>/^(bin|hooks|scripts|runtime)\//.test(name)&&!Object.hasOwn(contents,name)))return false;
  const hookFiles=['hooks/hooks.json','hooks.json'].filter(name=>Object.hasOwn(active.files,name));
  if(!hookFiles.length||hookFiles.some(name=>!candidate.files[name]||!retainsHookRegistrations(read(join(live,name)),JSON.parse(candidate.files[name]))))return false;
  const digest=bundleManifest(contents,candidate.executable).digest;
  const directory=mkdtempSync(join(manager,'swap-')),staged=join(directory,'bundle');
  const tx:Journal={installationId,client,oldDigest:active.digest,nextDigest:digest,directory,source:pkg.source,
    daemonHandoff:pkg.daemonHandoff,preparedAt:new Date().toISOString()};
  let exchanged=false;
  try{
    writeBundle(staged,contents,client,api,identity.name,home,manager,candidate.executable);
    if(verifyPluginBundle({...binding,nativeRoot:staged}).digest!==digest)return false;
    signal?.throwIfAborted();
    return await withSessionLock('capture:configuration',async()=>{
      if(!consent()||verifyPluginBundle(binding).digest!==active.digest||!exclusivelyManaged(live,active.files)||!isDeepStrictEqual(read(receiptFile),receipt))return false;
      atomicJson(journalFile,tx);
      exchanged=exchangePluginDirectories(live,staged);
      if(!exchanged){unlinkSync(journalFile);return false;}
      syncDirectory(dirname(live));syncDirectory(directory);
      await commit(tx);return true;
    },0,signal);
  }finally{
    if(!exchanged)rmSync(directory,{recursive:true,force:true});
  }
}
