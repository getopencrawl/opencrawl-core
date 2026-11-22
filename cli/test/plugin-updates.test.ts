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
