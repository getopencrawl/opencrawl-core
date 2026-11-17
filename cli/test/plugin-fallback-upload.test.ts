import {createHash} from 'node:crypto';
import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {atomicJson} from '../src/session.ts';
import {captureDir,type CaptureConfig} from '../src/capture/runtime.ts';
import {upgradeCaptureDaemon} from '../src/capture/daemon-upgrade.ts';
import {prepareFallbackPlugins,proveOnlinePluginFallback} from '../scripts/plugin-fallback-proof.ts';

(process.platform==='win32'?test.skip:test)('Claude, Codex and Cursor plugin hooks upload final answers with failed daemon bootstrap',async()=>{
 const root=mkdtempSync(join(tmpdir(),'opencrawl-plugin-fallback-')),before={...process.env},batches:unknown[]=[];
 const receiver=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  if(new URL(request.url).pathname==='/api/sessions/identity')return Response.json({data:{principal:{tenantId:'fixture',userId:'fixture'},capabilities:{harnesses:['claude-code','codex','cursor']}}});
  const raw=await request.text();batches.push(JSON.parse(raw));return Response.json({data:{stored:true,batchId:createHash('sha256').update(raw).digest('hex')}});
 }});
 try{
  for(const key of Object.keys(process.env))if(key.startsWith('OPENCRAWL_'))delete process.env[key];
  Object.assign(process.env,{HOME:root,USERPROFILE:root,OPENCRAWL_CONFIG_HOME:join(root,'profile'),OPENCRAWL_NO_UPDATE:'1',CLAUDE_CONFIG_DIR:join(root,'claude'),CODEX_HOME:join(root,'codex'),CURSOR_CONFIG_DIR:join(root,'cursor')});
  const command=[process.execPath,resolve(import.meta.dir,'../src/cli.ts')];
  const config:CaptureConfig={schemaVersion:1,api:receiver.url.origin,installationId:'fallback-install',owner:{tenantId:'fixture',userId:'fixture'},installedAt:new Date().toISOString(),harnesses:['claude-code','codex','cursor'],historyHarnesses:[],roots:{'claude-code':join(root,'claude'),codex:join(root,'codex'),cursor:join(root,'cursor')},command,hookOwnership:'plugin',backgroundStartup:false,daemonRequested:{backgroundStartup:true}};
  atomicJson(join(captureDir(),'config.json'),config);atomicJson(join(captureDir(),'receiver-token.json'),{api:config.api,token:'synthetic-fallback-upload-token'});
  expect(await upgradeCaptureDaemon({install:async()=>{throw Error('synthetic supervisor failure');}})).toEqual({state:'fallback',reason:'bootstrap-failed'});
  await proveOnlinePluginFallback(config,await prepareFallbackPlugins(command,config,root),batches);
 }finally{
  receiver.stop(true);for(const key of Object.keys(process.env))if(!(key in before))delete process.env[key];Object.assign(process.env,before);rmSync(root,{recursive:true,force:true});
 }
},60_000);
