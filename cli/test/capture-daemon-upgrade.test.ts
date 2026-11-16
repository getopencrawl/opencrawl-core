import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {atomicJson,withSessionLock} from '../src/session.ts';
import {captureDir,readCaptureConfig,captureHook,drainCaptureNotices,type CaptureConfig} from '../src/capture/runtime.ts';
import {awaitDaemonActivation,waitForDaemonReady,bootstrapFile} from '../src/capture/daemon-bootstrap.ts';
import {importLegacyDaemonNotices} from '../src/capture/daemon-legacy.ts';
import {readdirSync} from 'node:fs';
import {upgradeCaptureDaemon as upgrade} from '../src/capture/daemon-upgrade.ts';

const upgradeCaptureDaemon=(options:Parameters<typeof upgrade>[0]={})=>upgrade({ready:async()=>true,cleanup:()=>{},...options});

async function fixture(run:(config:CaptureConfig)=>Promise<void>){
  const root=mkdtempSync(join(tmpdir(),'opencrawl-upgrade-test-')),previous=process.env.OPENCRAWL_CONFIG_HOME;
  process.env.OPENCRAWL_CONFIG_HOME=root;
  try{
    const config:CaptureConfig={schemaVersion:1,api:'http://127.0.0.1:1',installationId:'retained-installation',owner:{tenantId:'retained-tenant',userId:'retained-user'},installedAt:'2026-11-16T00:00:00Z',harnesses:['codex','cursor'],roots:{'claude-code':join(root,'claude'),codex:join(root,'codex'),cursor:join(root,'cursor')},command:[join(root,'opencrawl')]};
    atomicJson(join(captureDir(),'config.json'),config);await run(config);
  }finally{if(previous===undefined)delete process.env.OPENCRAWL_CONFIG_HOME;else process.env.OPENCRAWL_CONFIG_HOME=previous;rmSync(root,{recursive:true,force:true});}
}
const forbidden=async()=>{throw Error('Unexpected service installation');};
for(const changes of [{disabled:true},{authPending:true},{harnesses:[]},{hookOwnership:'plugin' as const}])test('upgrade preserves unselected profile '+JSON.stringify(changes),()=>fixture(async config=>{
  atomicJson(join(captureDir(),'config.json'),{...config,...changes});const before=readFileSync(join(captureDir(),'config.json'));
  expect(await upgradeCaptureDaemon({install:forbidden})).toEqual({state:'not-selected'});
  expect(readFileSync(join(captureDir(),'config.json'))).toEqual(before);
}));
test('upgrade preserves queued bytes, cursor and destination, and installs once',()=>fixture(async config=>{
  const retained=['queue/batch.json','state/cursor.json','sources/session.json'];
  for(const name of retained){const path=join(captureDir(),name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,'retained '+name);}
  let installs=0;const install=async(next:CaptureConfig)=>{installs++;expect(next).toEqual({...config,captureWorker:'daemon-v1'});return {supervised:true};};
  expect(await upgradeCaptureDaemon({install})).toEqual({state:'activated'});
  expect(await upgradeCaptureDaemon({install})).toEqual({state:'already-enabled'});
  expect(installs).toBe(1);
  for(const name of retained)expect(readFileSync(join(captureDir(),name),'utf8')).toBe('retained '+name);
}));
test('upgrade defers to a live legacy worker without switching ingress',()=>fixture(async config=>{
  await withSessionLock('capture:worker',async()=>{
    expect(await upgradeCaptureDaemon({install:async()=>({supervised:true})})).toEqual({state:'busy'});
  });
  expect(readCaptureConfig()).toEqual(config);
}));
test('bootstrap failures retain legacy capture and allow later retry',()=>fixture(async config=>{
  expect(await upgradeCaptureDaemon({install:async()=>{throw Error('supervisor unavailable');}})).toEqual({state:'fallback',reason:'bootstrap-failed'});
  expect(readCaptureConfig()).toEqual(config);
  expect(await upgradeCaptureDaemon({install:async()=>({supervised:false})})).toEqual({state:'fallback',reason:'supervision-unavailable'});
  expect(readCaptureConfig()).toEqual(config);
  expect(await upgradeCaptureDaemon({install:async()=>({supervised:true}),ready:async()=>false})).toEqual({state:'fallback',reason:'readiness-unconfirmed'});
  expect(readCaptureConfig()).toEqual(config);
  expect(await upgradeCaptureDaemon({install:async()=>({supervised:true})})).toEqual({state:'activated'});
}));
test('service startup releases configuration lock and never certifies a changed destination',()=>fixture(async config=>{
  expect(await upgradeCaptureDaemon({install:async()=>{
    await withSessionLock('capture:configuration',async()=>{
      atomicJson(join(captureDir(),'config.json'),{...config,disabled:true});
    },0);
    return {supervised:true};
  }})).toEqual({state:'busy'});
  expect(readCaptureConfig()).toEqual({...config,disabled:true});
}));

test('real readiness handshake leaves legacy ingress active until publication',()=>fixture(async config=>{
  let worker:Promise<boolean>|undefined;
  const result=await upgrade({install:async(candidate,before)=>{
    expect(readCaptureConfig()).toEqual(before);expect(before).toEqual(config);
    worker=awaitDaemonActivation({pollMs:1});
    await captureHook('cursor',{conversation_id:'during-bootstrap',hook_event_name:'beforeSubmitPrompt',prompt:'fallback remains live'});
    expect(readdirSync(join(captureDir(),'notices'))).toHaveLength(1);
    expect(candidate.captureWorker).toBe('daemon-v1');return {supervised:true};
  },ready:stage=>waitForDaemonReady(stage,1000),cleanup:()=>{}});
  expect(result).toEqual({state:'activated'});expect(await worker).toBe(true);
  importLegacyDaemonNotices(readCaptureConfig()!);
  expect(readdirSync(join(captureDir(),'notices'))).toHaveLength(0);
  const inbox=readdirSync(join(captureDir(),'daemon','inbox'));
  expect(inbox).toHaveLength(1);
  const notice=JSON.parse(readFileSync(join(captureDir(),'daemon','inbox',inbox[0]!),'utf8'));
  expect(notice.record.event.prompt).toBe('fallback remains live');expect(notice.owner).toEqual(config.owner);
}));
test('failed bootstrap still captures and spools a fresh event through the legacy mechanism',()=>fixture(async config=>{
  expect(await upgradeCaptureDaemon({install:async()=>{throw Error('no service manager');}})).toMatchObject({state:'fallback'});
  await captureHook('cursor',{conversation_id:'fallback-proof',hook_event_name:'beforeSubmitPrompt',prompt:'retained fallback text'});
  await drainCaptureNotices(config);
  expect(readdirSync(join(captureDir(),'queue')).length).toBeGreaterThan(0);
  expect(readCaptureConfig()).toEqual(config);
}));
test('late legacy notices recover after activation and cannot cross destinations',()=>fixture(async config=>{
  await upgradeCaptureDaemon({install:async()=>({supervised:true})});
  const current=readCaptureConfig()!,directory=join(captureDir(),'notices');mkdirSync(directory,{recursive:true});
  const record={id:'late-notice',at:new Date().toISOString(),sequence:42,harness:'cursor',event:{conversation_id:'late',hook_event_name:'beforeSubmitPrompt',prompt:'late'}};
  atomicJson(join(directory,'late.json'),record);importLegacyDaemonNotices(current);
  const target=join(captureDir(),'daemon','inbox','42-late-notice.json'),first=readFileSync(target,'utf8');
  // Crash replay after target publication preserves the same immutable identity.
  atomicJson(join(directory,'late.json'),record);importLegacyDaemonNotices(current);
  expect(readFileSync(target,'utf8')).toBe(first);
  atomicJson(join(directory,'foreign.json'),record);
  const changed={...current,owner:{...config.owner,userId:'another'}};atomicJson(join(captureDir(),'config.json'),changed);
  importLegacyDaemonNotices(changed);expect(existsSync(join(directory,'foreign.json'))).toBe(true);
}));

test('macOS and Linux hooks schedule only a bounded detached migration for owned capture',()=>fixture(async config=>{
  const {scheduleDaemonUpgrade}=await import('../src/capture/daemon-upgrade-launch.ts');
  const {ChildProcess}=await import('node:child_process');
  const prior=process.env.OPENCRAWL_NO_UPDATE;delete process.env.OPENCRAWL_NO_UPDATE;
  try{
    let launches=0;
    const launch:typeof import('node:child_process').spawn=((file:string,args:string[],options:any)=>{
      launches++;expect(file).toBe(process.execPath);expect(args).toEqual(['collect','upgrade-daemon','--json']);
      expect(options.detached).toBe(true);expect(options.stdio).toBe('ignore');expect(options.env.OPENCRAWL_NO_UPDATE).toBe('1');
      expect(readCaptureConfig()).toEqual(config);return new ChildProcess();
    }) as typeof import('node:child_process').spawn;
    for(const platform of ['darwin','linux'] as const){
      const receipt=join(captureDir(),'daemon','upgrade-attempt.json');if(existsSync(receipt))unlinkSync(receipt);
      const options={native:true,platform,launch,owned:()=>true,now:1000};
      scheduleDaemonUpgrade({...options,owned:()=>false});
      const before=launches;scheduleDaemonUpgrade(options);scheduleDaemonUpgrade(options);
      expect(launches).toBe(before+1);
      scheduleDaemonUpgrade({...options,now:1000+15*60_000});expect(launches).toBe(before+2);
      writeFileSync(receipt,'damaged cooldown');scheduleDaemonUpgrade(options);expect(launches).toBe(before+3);
    }
  }finally{if(prior===undefined)delete process.env.OPENCRAWL_NO_UPDATE;else process.env.OPENCRAWL_NO_UPDATE=prior;}
}));

test('pre-harness-list installations retain their original implicit Claude and Codex selection',()=>fixture(async config=>{
  delete config.harnesses;atomicJson(join(captureDir(),'config.json'),config);
  expect(await upgradeCaptureDaemon({install:async()=>({supervised:true})})).toEqual({state:'activated'});
  expect(readCaptureConfig()?.harnesses).toEqual(['claude-code','codex']);
}));

test('a cancelled staged worker exits without consuming legacy notices or changing capture',()=>fixture(async config=>{
  const controller=new AbortController();let worker:Promise<boolean>|undefined;
  const result=await upgrade({install:async()=>{
    worker=awaitDaemonActivation({signal:controller.signal,pollMs:1});return {supervised:true};
  },ready:async()=>{controller.abort();return false;},cleanup:()=>{}});
  expect(result).toEqual({state:'fallback',reason:'readiness-unconfirmed'});
  expect(await worker).toBe(false);expect(readCaptureConfig()).toEqual(config);expect(existsSync(bootstrapFile())).toBe(false);
}));

test('a damaged migration binding preserves old notices without breaking the current daemon',()=>fixture(async()=>{
  await upgradeCaptureDaemon({install:async()=>({supervised:true})});
  const marker=join(captureDir(),'daemon','legacy-handoff.json');writeFileSync(marker,'damaged binding');
  const directory=join(captureDir(),'notices');mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'retained.json'),'retained bytes');
  expect(importLegacyDaemonNotices(readCaptureConfig()!)).toBe(false);
  expect(existsSync(marker+'.held')).toBe(true);expect(readFileSync(join(directory,'retained.json'),'utf8')).toBe('retained bytes');
  expect(importLegacyDaemonNotices(readCaptureConfig()!)).toBe(false);
}));

for(const disabled of [false,true])test('requested plugin daemon stages startup without enabling paused recording '+disabled,()=>fixture(async config=>{
 const before:CaptureConfig={...config,hookOwnership:'plugin',disabled,harnesses:disabled?[]:['cursor'],backgroundStartup:false,daemonRequested:{backgroundStartup:true}};
 atomicJson(join(captureDir(),'config.json'),before);
 expect(await upgradeCaptureDaemon({install:async(candidate)=>{expect(candidate.backgroundStartup).toBe(true);expect(candidate.daemonRequested).toBeUndefined();expect(readCaptureConfig()).toEqual(before);throw Error('no service');}})).toEqual({state:'fallback',reason:'bootstrap-failed'});
 expect(readCaptureConfig()).toEqual(before);
 expect(await upgradeCaptureDaemon({install:async()=>({supervised:true})})).toEqual({state:'activated'});
 expect(readCaptureConfig()).toMatchObject({disabled,harnesses:before.harnesses,backgroundStartup:true,captureWorker:'daemon-v1',installationId:before.installationId,owner:before.owner});
}));
