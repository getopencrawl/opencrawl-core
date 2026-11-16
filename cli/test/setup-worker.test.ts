import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {atomicJson} from '../src/session.ts';
import {captureDir,type CaptureConfig} from '../src/capture/runtime.ts';
import {CliError} from '../src/oauth.ts';
import {updateSetupState,readSetupState,scopeKey,type SetupState} from '../src/setup/state.ts';
import {historyJob,runHistoryWorker} from '../src/setup/history-worker.ts';
import type {backfill} from '../src/capture/backfill.ts';
async function fixture(run:(state:SetupState,config:CaptureConfig)=>Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),'opencrawl-setup-worker-')),saved=process.env.OPENCRAWL_CONFIG_HOME;process.env.OPENCRAWL_CONFIG_HOME=dir;
 try{
  const scope={api:'https://fixture.invalid',tenantId:'team',userId:'owner'},selections={plugins:{},forward:{},history:{'claude-code':true,codex:true}};
  const state=await updateSetupState(scope,()=>({schemaVersion:1,scope,selections,acceptedAt:new Date().toISOString(),installationId:'installation',historyJob:historyJob(null,['claude-code','codex'],[])}));
  const config:CaptureConfig={schemaVersion:1,api:scope.api,installationId:'installation',owner:{tenantId:'team',userId:'owner'},harnesses:[],roots:{'claude-code':join(dir,'claude'),codex:join(dir,'codex')},command:['fixture'],installedAt:new Date().toISOString()};atomicJson(join(captureDir(),'config.json'),config);
  await run(state,config);
 }finally{if(saved===undefined)delete process.env.OPENCRAWL_CONFIG_HOME;else process.env.OPENCRAWL_CONFIG_HOME=saved;rmSync(dir,{recursive:true,force:true});}
}
const complete=()=>({status:'complete',sources:[],processed:0,processedBytes:0,uploaded:0,notice:'fixture'});
test('durable history resumes after failure without rerunning completed clients',async()=>fixture(async state=>{
 const calls:string[]=[];let fail=true;
 const importHistory:typeof backfill=async(_api,client,_approved,options)=>{calls.push(client);await options?.beforeFile?.();options?.onProgress?.({status:'importing',processed:0,totalFiles:0,processedBytes:0,totalBytes:0,uploaded:0});if(client==='codex'&&fail)throw new CliError('NETWORK_ERROR','fixture outage');return complete();};
 await runHistoryWorker(scopeKey(state.scope),{importHistory,publish:async()=>undefined});
 expect(readSetupState(state.scope)?.historyJob).toMatchObject({state:'failed',completedClients:['claude-code'],error:'NETWORK_ERROR'});
 fail=false;await runHistoryWorker(scopeKey(state.scope),{importHistory,publish:async()=>undefined});
 expect(calls).toEqual(['claude-code','codex','codex']);expect(readSetupState(state.scope)?.historyJob?.state).toBe('complete');
 await runHistoryWorker(scopeKey(state.scope),{importHistory,publish:async()=>undefined});expect(calls).toHaveLength(3);
}));
test('a different current capture owner fences an approved history job before any import',async()=>fixture(async(state,config)=>{
 atomicJson(join(captureDir(),'config.json'),{...config,owner:{tenantId:'other-team',userId:'owner'}});let calls=0;
 await runHistoryWorker(scopeKey(state.scope),{importHistory:async()=>{calls++;return complete();},publish:async()=>undefined});
 expect(calls).toBe(0);expect(readSetupState(state.scope)?.historyJob).toMatchObject({state:'paused',error:'SETUP_SCOPE_CHANGED'});
}));
test('turning history off stops a running job before its next file or upload',async()=>fixture(async state=>{
 let calls=0;
 const importHistory:typeof backfill=async(_api,client,_approved,options)=>{calls++;await updateSetupState(state.scope,current=>({...current!,selections:{...current!.selections,history:{...current!.selections.history,[client]:false}}}));await options?.beforeFile?.();return complete();};
 await runHistoryWorker(scopeKey(state.scope),{importHistory,publish:async()=>undefined});
 expect(calls).toBe(1);expect(readSetupState(state.scope)?.historyJob).toMatchObject({state:'paused',error:'SETUP_HISTORY_PAUSED'});
}));

test('a long single-client history publishes intermediate progress before completion',async()=>fixture(async state=>{
 const snapshots:{state:string;completed?:number}[]=[];
 const importHistory:typeof backfill=async(_api,_client,_approved,options)=>{options?.onProgress?.({status:'importing',processed:3,totalFiles:9,processedBytes:30,totalBytes:90,uploaded:1});await new Promise(resolve=>setTimeout(resolve,10));expect(snapshots.some(row=>row.state==='running'&&row.completed===3)).toBe(true);return complete();};
 await runHistoryWorker(scopeKey(state.scope),{importHistory,publishEveryMs:0,publish:async next=>{snapshots.push({state:next.historyJob!.state,completed:next.historyJob?.progress?.completed});return undefined;}});
 expect(readSetupState(state.scope)?.historyJob?.state).toBe('complete');
}));
