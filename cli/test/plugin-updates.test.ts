import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {pluginRelease} from '../src/setup/plugin-release.ts';
import {bundleManifest,fileHash} from '../src/setup/plugin-bundle.ts';
import {setupPluginIdentity} from '../src/setup/plugin-identity.ts';
import {scopeKey,type SetupState} from '../src/setup/state.ts';
import {stagePluginUpdates,updateCandidates,changedHookFiles,pendingPluginUpdates} from '../src/setup/plugin-updates.ts';
import type {PublishedPackage} from '../src/setup/published-plugins.ts';

const api='https://selfhost.example',scope={api,tenantId:'org',userId:'member'};
const state:SetupState={schemaVersion:1,scope,acceptedAt:'time',installationId:'machine',
  selections:{plugins:{},history:{},forward:{}},pluginResults:[]};
for(const entry of pluginRelease.packages){
  state.selections.plugins[entry.harness]=true;
  state.pluginResults!.push({client:entry.harness,status:'installed',source:{repository:pluginRelease.repository,
    path:entry.path,version:'0.0.1',name:entry.name,ref:'old'}});
}

test('only selected managed installs on an older release are candidates',()=>{
  const changed=structuredClone(state);
  expect(updateCandidates(changed,pluginRelease,'linux-x64').length).toBe(pluginRelease.packages.filter(entry=>entry.captureAvailable).length);
  for(const [index,row] of changed.pluginResults!.entries()){
    if(index===0)changed.selections.plugins[row.client]=false;
    if(index===1)row.source!.repository='other/plugins';
    if(index===2)row.source!.version='99.0.0';
    if(index===3)row.status='error';
  }
  expect(updateCandidates(changed)).toEqual([]);
  expect(updateCandidates(state,pluginRelease,'unsupported')).toEqual([]);
});

test('staging verifies active profile and release, leaves native bytes intact and retries independent clients',async()=>{
  const home=mkdtempSync(join(tmpdir(),'oc-review-')),previous=process.env.OPENCRAWL_CONFIG_HOME;
  process.env.OPENCRAWL_CONFIG_HOME=home;
  const root=join(home,'opencrawl'),key=setupPluginIdentity(api).key;
  const json=(file:string,value:unknown)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(value));};
  const config={api,installationId:state.installationId,owner:{userId:scope.userId,tenantId:scope.tenantId},hookOwnership:'plugin'};
  const configFile=join(root,'capture','config.json'),setupFile=join(root,'setup',scopeKey(scope)+'.json');
  const liveFiles:string[]=[];
  try{
    json(configFile,config);json(setupFile,state);
    for(const row of state.pluginResults!){
      const directory=join(home,'native',row.client);
      const binding={api,installationId:state.installationId,owner:config.owner,client:row.client,configHome:home};
      const contents={'.opencrawl-binding.json':JSON.stringify(binding),'.opencrawl-source.json':JSON.stringify(row.source),'hooks.json':'{}'};
      const manifest=bundleManifest(contents);
      mkdirSync(directory,{recursive:true});
      for(const [name,value] of Object.entries(contents))writeFileSync(join(directory,name),value);
      liveFiles.push(join(directory,'hooks.json'));
      json(join(directory,'.opencrawl-setup-plugin.json'),{...manifest,api,client:row.client,configHome:home,pluginName:'opencrawl'});
      json(join(root,'setup-plugins',row.client,key,'installed.json'),{schemaVersion:2,api,client:row.client,configHome:home,
        pluginName:'opencrawl',digest:manifest.digest,directory,nativeRoot:directory});
    }
    const candidates=updateCandidates(state);
    let calls=0;
    const load=async(client:string)=>{
      calls++;
      const sha256=client===candidates[0]!.client?'invalid':candidates.find(row=>row.client===client)!.sha256;
      return {source:{archive:{sha256}}} as PublishedPackage;
    };
    expect(await stagePluginUpdates('https://other.example',undefined,load)).toEqual([]);
    const staged=await stagePluginUpdates(api,undefined,load);
    expect(calls).toBe(candidates.length);
    expect(pendingPluginUpdates(state)).toEqual(staged);
    expect(staged.map(row=>row.status)).toEqual(candidates.map((_,i)=>i===0?'retry':'ready_for_review'));
    expect(await stagePluginUpdates(api,undefined,load)).toEqual(staged);
    expect(calls).toBe(candidates.length);
    json(configFile,{...config,installationId:'changed'});
    expect(await stagePluginUpdates(api,undefined,load)).toEqual([]);
    for(const file of liveFiles)expect(readFileSync(file,'utf8')).toBe('{}');
  }finally{
    if(previous===undefined)delete process.env.OPENCRAWL_CONFIG_HOME;else process.env.OPENCRAWL_CONFIG_HOME=previous;
    rmSync(home,{recursive:true,force:true});
  }
});

test('review includes changed binaries and removed scripts when the hook command itself is unchanged',()=>{
  const installed={'hooks.json':fileHash('{}'),'bin/opencrawl-hook':fileHash('v1'),'scripts/old.sh':fileHash('old')};
  const candidate={files:{'hooks.json':'{}','README.md':'new'},binaries:{'bin/opencrawl-hook':Buffer.from('v2')}} as unknown as PublishedPackage;
  expect(changedHookFiles(installed,candidate)).toEqual(['bin/opencrawl-hook','scripts/old.sh']);
});

test('standing consent belongs to the installation and its selected local clients',async()=>{
  const {automaticUpdateClients}=await import('../src/setup/state.ts');
  expect(automaticUpdateClients(state)).toEqual([]);
  const saved={...state,pluginAutoUpdates:{installationId:'machine',clients:['cursor','codex','devin','codex']}};
  expect(automaticUpdateClients(saved)).toEqual(['codex','cursor']);
  expect(automaticUpdateClients({...saved,installationId:'replacement'})).toEqual([]);
  expect(automaticUpdateClients({...saved,selections:{...saved.selections,plugins:{codex:false,cursor:true}}})).toEqual(['cursor']);
});

test.skipIf(process.platform==='win32')('an opted-in local release exchanges intact folders, rechecks consent, and finishes interrupted receipts',async()=>{
  const {promoteDirectoryPlugin,retainsHookRegistrations}=await import('../src/setup/plugin-promotion.ts');
  const {bindPublishedPackage}=await import('../src/setup/published-plugins.ts');
  const {writeBundle}=await import('../src/setup/plugins.ts');
  const {readSetupState}=await import('../src/setup/state.ts');
  const home=mkdtempSync(join(tmpdir(),'oc-auto-')),previous=process.env.OPENCRAWL_CONFIG_HOME;
  process.env.OPENCRAWL_CONFIG_HOME=home;
  const owner={tenantId:scope.tenantId,userId:scope.userId,name:'Local member'},client='claude-code',installationId='test-machine';
  const root=join(home,'opencrawl'),manager=join(root,'setup-plugins',client,setupPluginIdentity(api).key);
  const live=join(manager,'marketplace','opencrawl'),receipt=join(manager,'installed.json'),journal=join(manager,'update-transaction.json');
  const stateFile=join(root,'setup',scopeKey(scope)+'.json');
  const json=(file:string,data:unknown)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(data),{mode:0o600});};
  const get=(file:string)=>JSON.parse(readFileSync(file,'utf8'));
  const pin=pluginRelease.packages.find(p=>p.harness===client)!;
  const platform=process.platform+'-'+process.arch,archive=pin.archives![platform]!;
  const oldCommand={hooks:[{type:'command',command:'./bin/opencrawl-hook capture'}]};
  const make=(version:string,sha256:string):PublishedPackage=>({
    source:{repository:pluginRelease.repository,ref:pluginRelease.ref,path:pin.path,name:pin.name,version,archive:{platform,url:archive.url,metadataSha256:archive.metadataSha256,sha256}},
    files:{'.claude-plugin/plugin.json':JSON.stringify({name:pin.name,version}),'hooks/hooks.json':JSON.stringify({hooks:{SessionStart:[oldCommand],...(version===pin.version?{Stop:[oldCommand]}:{})}})},
    executable:'bin/opencrawl-hook',binaries:{'bin/opencrawl-hook':Buffer.from(version)},captureAvailable:true,daemonHandoff:true
  });
  const old=make('0.0.1','0'.repeat(64)),next=make(pin.version,archive.sha256);
  const binding={configHome:home,installationId,owner,captureMode:'hook' as const,command:['/fixture/opencrawl']};
  const selected:SetupState={schemaVersion:1,scope,installationId,selections:{plugins:{[client]:true},forward:{[client]:true},history:{}},
    acceptedAt:'now',pluginAutoUpdates:{installationId,clients:[client]},pluginResults:[{client,status:'installed',source:old.source,captureAvailable:true}]};
  const native={which:()=>'/fixture/claude',applicationDirs:[],runner:async(_bin:string,args:string[])=>({code:0,stdout:args[0]==='--version'?'2.1.330':JSON.stringify([{id:'opencrawl@opencrawl-cli',scope:'user',enabled:true,readFromFolder:live}])})};
  try{
    json(join(root,'capture/config.json'),{schemaVersion:1,api,owner,installationId,harnesses:[client],hookOwnership:'plugin',command:binding.command});
    const bound=bindPublishedPackage(client,api,old,binding),assets={...bound.files,...bound.binaries},original=bundleManifest(assets,bound.executable);
    writeBundle(live,assets,client,api,'opencrawl',home,home,bound.executable);
    const oldReceipt={schemaVersion:2,api,client,pluginName:'opencrawl',configHome:home,directory:live,nativeRoot:live,digest:original.digest};
    json(receipt,oldReceipt);json(stateFile,selected);
    const run=(load=async()=>next)=>promoteDirectoryPlugin(selected,client,undefined,load,native);
    expect(await run(async()=>{json(stateFile,{...selected,pluginAutoUpdates:undefined});return next;})).toBe(false);
    expect(get(receipt)).toEqual(oldReceipt);
    json(stateFile,selected);
    writeFileSync(join(live,'personal.txt'),'mine');
    expect(await run()).toBe(false);
    rmSync(join(live,'personal.txt'));
    expect(await run(async()=>({...next,files:{...next.files,'hooks/hooks.json':'{"hooks":{}}'}}))).toBe(false);
    expect(retainsHookRegistrations({hooks:{Stop:[oldCommand]}},{hooks:{Stop:[{...oldCommand,matcher:'only-new-context'}]}})).toBe(false);
    expect(await run()).toBe(true);
    expect(get(join(live,'.opencrawl-source.json'))).toEqual(next.source);
    const updated=get(receipt);
    expect(updated.digest).not.toBe(original.digest);
    expect(readSetupState(scope)?.pluginResults?.[0]?.source).toEqual(next.source);
    // Model a process interrupted between the directory exchange and receipt writes.
    json(receipt,oldReceipt);json(stateFile,{...selected,pluginAutoUpdates:undefined});
    json(journal,{installationId,client,oldDigest:original.digest,nextDigest:updated.digest,directory:join(manager,'swap-interrupted'),
      source:next.source,daemonHandoff:true,preparedAt:new Date().toISOString()});
    expect(await run(async()=>{throw Error('recovery must use the already-active release');})).toBe(true);
    expect(get(receipt).digest).toBe(updated.digest);
    expect(readSetupState(scope)?.pluginAutoUpdates).toBeUndefined();
  }finally{
    if(previous===undefined)delete process.env.OPENCRAWL_CONFIG_HOME;else process.env.OPENCRAWL_CONFIG_HOME=previous;
    rmSync(home,{recursive:true,force:true});
  }
});
