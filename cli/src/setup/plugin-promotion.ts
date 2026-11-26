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
import {acceptedPackageSource,bindPublishedPackage,loadPublishedPackage,type PublishedPackage} from './published-plugins.ts';
import {pluginRelease} from './plugin-release.ts';
import {bundleManifest} from './plugin-bundle.ts';
import {exchangePluginDirectories} from './exchange-plugin.ts';

type Client='claude-code'|'cursor';
type Backup={directory:string;oldDigest:string;previous?:NonNullable<SetupState['pluginResults']>[number];previousPreparedAt?:string;previousConfirmed?:boolean};
type Journal=Backup & {installationId:string;client:Client;nextDigest:string;
  source:PublishedPackage['source'];daemonHandoff:boolean;preparedAt:string;
  fallback?:Backup};
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

/** Caller holds the setup choices lock. Journal both sides of rollback so stopping
 * between exchange and metadata writes is recoverable on the next doctor run. */
export async function settlePromotion(state:SetupState,client:Client,digest:string,decision:'verify'|'rollback'|'resume'){
  const identity=setupPluginIdentity(state.scope.api),home=dirname(configDir());
  const manager=join(configDir(),'setup-plugins',client,identity.key),file=join(manager,'pending-verification.json');
  if(!existsSync(file))return 'none';
  return withSessionLock('setup:plugins',()=>withSessionLock('capture:configuration',async()=>{
    const tx=read(file) as (Journal&{decision?:'verify'|'rollback'})|null;
    const live=client==='cursor'?join(homedir(),'.cursor','plugins','local',identity.name):join(manager,'marketplace',identity.name);
    const receiptFile=join(manager,'installed.json'),receipt=read(receiptFile),config=readCaptureConfig();
    if(!tx||tx.client!==client||tx.installationId!==state.installationId||!tx.previous?.source||tx.previous.client!==client||
      tx.nextDigest!==digest||dirname(tx.directory)!==manager||!/^swap-[a-zA-Z0-9]+$/.test(basename(tx.directory))||
      receipt?.api!==state.scope.api||receipt.configHome!==home||receipt.directory!==live||receipt.nativeRoot!==live||
      config?.api!==state.scope.api||config.installationId!==state.installationId||config.owner?.userId!==state.scope.userId||
      config.owner?.tenantId!==state.scope.tenantId||!ordinaryPath(home,manager)||!ordinaryPath(client==='cursor'?homedir():manager,live))
      throw Error('The retained plugin changed during verification.');
    const op=tx.decision??decision;
    if(op==='resume')return 'pending';
    const binding:PluginBinding={api:state.scope.api,client,configHome:home,pluginName:identity.name,nativeRoot:live};
    const active=verifyPluginBundle(binding),backup=join(tx.directory,'bundle');
    const ownership=read(join(live,'.opencrawl-binding.json'));
    if(ownership?.installationId!==state.installationId||ownership?.owner?.tenantId!==state.scope.tenantId||ownership?.owner?.userId!==state.scope.userId)throw Error('The active plugin changed owner.');
    if(!tx.decision){
      if(active.digest!==digest||!automaticUpdateClients(readSetupState(state.scope)).includes(client)&&op==='rollback')return 'pending';
      atomicJson(file,{...tx,decision:op});
    }
    let saved;
    if(existsSync(backup)){
      if(!ordinaryPath(manager,backup))throw Error('Retained plugin moved');
      saved=verifyPluginBundle({...binding,nativeRoot:backup});
      if(!exclusivelyManaged(backup,saved.files))throw Error('Retained plugin contains local changes');
    }
    if(op==='rollback'){
      if(active.digest===digest){
        if(saved?.digest!==tx.oldDigest||!exclusivelyManaged(live,active.files)||
          !isDeepStrictEqual(read(join(backup,'.opencrawl-binding.json')),ownership)||
          !isDeepStrictEqual(read(join(backup,'.opencrawl-source.json')),tx.previous.source)||
          !exchangePluginDirectories(live,backup))throw Error('Cannot safely restore the retained plugin.');
        syncDirectory(dirname(live));syncDirectory(tx.directory);
      }else if(active.digest!==tx.oldDigest)throw Error('Active plugin changed before rollback');
      atomicJson(receiptFile,{...receipt,digest:tx.oldDigest,preparedAt:tx.previousPreparedAt,captureConfirmed:tx.previousConfirmed});
      await updateSetupState(state.scope,current=>{
        if(!current||current.installationId!==state.installationId)throw Error('Installation changed before rollback');
        return {...current,pluginResults:current.pluginResults?.map(item=>item.client===client?tx.previous!:item)};
      });
      atomicJson(join(manager,'rejected-update.json'),{installationId:state.installationId,sha256:tx.source.archive?.sha256});
    }else if(active.digest!==digest)throw Error('Active plugin changed before verification');
    if(existsSync(backup)){
      const retired=verifyPluginBundle({...binding,nativeRoot:backup});
      if(retired.digest!==(op==='verify'?tx.oldDigest:tx.nextDigest)||!exclusivelyManaged(backup,retired.files))throw Error('Retained plugin changed');
      rmSync(backup,{recursive:true});
    }
    if(existsSync(tx.directory))rmdirSync(tx.directory);
    unlinkSync(file);syncDirectory(manager);
    return op==='verify'?'verified':'rolled_back';
  },0),0);
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
  if(!prior?.source?.archive||prior.source.repository!==pluginRelease.repository||
    (prior.source.path!==pin.path&&!acceptedPackageSource(client,prior.source))||
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
    if(tx.previous){
      const {fallback,...current}=tx;
      atomicJson(join(manager,'pending-verification.json'),{...current,...fallback});
      if(fallback)clearStage(tx,tx.oldDigest);
    }else clearStage(tx,tx.oldDigest);
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
  const rejected=read(join(manager,'rejected-update.json'));
  if(rejected?.installationId===installationId&&rejected.sha256===archive.sha256)return false;
  let fallback:Backup|undefined;
  const pendingFile=join(manager,'pending-verification.json');
  if(existsSync(pendingFile)){
    const pending=read(pendingFile);
    if(!pending||pending.decision||pending.client!==client||pending.installationId!==installationId||
      pending.nextDigest!==active.digest||!pending.previous?.source||typeof pending.directory!=='string'||
      dirname(pending.directory)!==manager||!/^swap-[A-Za-z0-9]+$/.test(basename(pending.directory)))return false;
    const folder=join(pending.directory,'bundle');
    if(!ordinaryPath(manager,folder)||verifyPluginBundle({...binding,nativeRoot:folder}).digest!==pending.oldDigest)return false;
    const {directory,oldDigest,previous,previousPreparedAt,previousConfirmed}=pending;
    fallback={directory,oldDigest,previous,previousPreparedAt,previousConfirmed};
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
    daemonHandoff:pkg.daemonHandoff,preparedAt:new Date().toISOString(),previous:prior,previousPreparedAt:receipt.preparedAt,previousConfirmed:receipt.captureConfirmed,fallback};
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
