import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,readdirSync,writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createReplicasTitles} from '../src/capture/replicas.ts';
import {captureDir,captureTranscript,type CaptureConfig} from '../src/capture/runtime.ts';
import {parseRecord} from '../src/capture/parse.ts';

const workspace='10000000-0000-4000-8000-000000000001',session='20000000-0000-4000-8000-000000000001',chat='30000000-0000-4000-8000-000000000001',other='30000000-0000-4000-8000-000000000002';

test('platform titles require the exact native thread and provider; list order cannot assign a title',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'oc-replicas-titles-'));
 try{
  const run=async(args:string[])=>args[0]==='chat'?{chats:[{id:other,provider:'claude',title:'Someone else'},{id:chat,provider:'claude',title:'Actual chat'}]}:{thread_id:args.includes(other)?other:session,coding_agent:'claude'};
  expect(await createReplicasTitles({run,directory:()=>dir})(workspace,session,'claude-code')).toMatchObject({chatId:chat,title:'Actual chat'});
  expect(await createReplicasTitles({run,directory:()=>dir})(workspace,session,'codex')).toBeUndefined();
  await expect(createReplicasTitles({directory:()=>join(dir,'bad'),run:async args=>args[0]==='chat'?{chats:[{id:chat,provider:'claude',title:'Wrong provider'}]}:{thread_id:session,coding_agent:'codex'}})(workspace,session,'claude-code')).rejects.toThrow('metadata');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('title cache survives restart, bounds provider reads and retains stable metadata identity across retries',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'oc-replicas-titles-'));let time=1800000000000,title='First',calls=0,offline=false;
 const run=async(args:string[])=>{calls++;if(offline)throw Error('offline');return args[0]==='chat'?{chats:[{id:chat,provider:'claude',title}]}:{thread_id:session,coding_agent:'claude'};};
 const options={run,directory:()=>dir,now:()=>time};
 try{
  const lookup=createReplicasTitles(options),first=await lookup(workspace,session,'claude-code');expect(calls).toBe(2);
  expect(await createReplicasTitles(options)(workspace,session,'claude-code')).toEqual(first);expect(calls).toBe(2);
  time+=31000;expect(await lookup(workspace,session,'claude-code')).toEqual(first);expect(calls).toBe(4);
  title='Renamed';time+=1;const renamed=await lookup(workspace,session,'claude-code',true);expect(renamed?.title).toBe('Renamed');expect(renamed?.timestamp).not.toBe(first?.timestamp);
  offline=true;time+=31000;await expect(lookup(workspace,session,'claude-code')).rejects.toThrow('retained');
  offline=false;expect(await lookup(workspace,session,'claude-code')).toEqual(renamed);
  writeFileSync(join(dir,readdirSync(dir)[0]!),'{bad');await expect(createReplicasTitles(options)(workspace,session,'claude-code')).rejects.toThrow('metadata');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('transport tool inventories and permission notifications are excluded without suppressing conversation',()=>{
 for(const type of ['deferred_tools_record','command_permissions','thinking_drop']){
  expect(parseRecord('claude-code',{type:'attachment',attachment:{type,content:'transport metadata'}},0)).toBeNull();
  expect(parseRecord('claude-code',{type:'user',message:{role:'user',content:type}},0)?.data.content).toBe(type);
 }
});

test.skipIf(process.platform==='win32')('capture replaces Replicas placeholder titles, keeps messages stable and detects title-only changes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'oc-replicas-title-capture-'));
 const keys=['OPENCRAWL_CONFIG_HOME','OPENCRAWL_AUTH','OPENCRAWL_TOKEN','OPENCRAWL_SESSIONS_TOKEN','REPLICAS_WORKSPACE_ID','PATH'] as const;
 const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 try{
  process.env.OPENCRAWL_CONFIG_HOME=join(dir,'config');process.env.OPENCRAWL_AUTH='replicas-workspace';process.env.REPLICAS_WORKSPACE_ID=workspace;
  delete process.env.OPENCRAWL_TOKEN;delete process.env.OPENCRAWL_SESSIONS_TOKEN;
  const titleFile=join(dir,'title.json');writeFileSync(titleFile,JSON.stringify('Platform title'));
  writeFileSync(join(dir,'replicas'),'#!/usr/bin/env node\nconst title=JSON.parse(require("fs").readFileSync('+JSON.stringify(titleFile)+',"utf8"));console.log(JSON.stringify(process.argv[2]==="chat"?{chats:[{id:'+JSON.stringify(chat)+',provider:"claude",title}]}:{thread_id:'+JSON.stringify(session)+',coding_agent:"claude"}));\n',{mode:0o755});
  process.env.PATH=dir+':'+saved.PATH;
  const config:CaptureConfig={schemaVersion:1,api:'https://example.test',owner:{tenantId:'tenant',userId:'owner'},installationId:'device',installedAt:new Date().toISOString(),roots:{codex:join(dir,'codex'),'claude-code':join(dir,'claude')},command:[]};
  mkdirSync(captureDir(),{recursive:true});writeFileSync(join(captureDir(),'config.json'),JSON.stringify(config));
  const path=join(config.roots['claude-code'],'projects','fixture','session.jsonl');mkdirSync(join(config.roots['claude-code'],'projects','fixture'),{recursive:true});
  writeFileSync(path,[{type:'custom-title',sessionId:session,customTitle:'Claude Code'},{type:'assistant',sessionId:session,message:{role:'assistant',content:'Preserved message'}}].map(row=>JSON.stringify(row)+'\n').join(''));
  await captureTranscript(config,'claude-code',path);
  const batches=()=>readdirSync(join(captureDir(),'queue')).map(name=>JSON.parse(readFileSync(join(captureDir(),'queue',name),'utf8')));
  expect(batches().flatMap(b=>b.events).filter(e=>e.kind==='session_title').map(e=>e.data.title)).toEqual(['Platform title']);
  const firstMessages=batches().flatMap(b=>b.events).filter(e=>e.kind==='message');expect(firstMessages).toHaveLength(1);
  const count=batches().length;await captureTranscript(config,'claude-code',path);expect(batches()).toHaveLength(count);
  writeFileSync(titleFile,JSON.stringify('Renamed platform title'));
  const cache=join(captureDir(),'replicas-titles',readdirSync(join(captureDir(),'replicas-titles'))[0]!);const state=JSON.parse(readFileSync(cache,'utf8'));state.checkedAt=0;writeFileSync(cache,JSON.stringify(state));
  await captureTranscript(config,'claude-code',path);
  expect(batches().flatMap(b=>b.events).filter(e=>e.kind==='message')).toEqual(firstMessages);
  expect(batches().flatMap(b=>b.events).filter(e=>e.kind==='session_title').map(e=>e.data.title).sort()).toEqual(['Platform title','Renamed platform title']);
 }finally{for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}rmSync(dir,{recursive:true,force:true});}
});
