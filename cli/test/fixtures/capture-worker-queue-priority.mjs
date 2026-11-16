// Controlled lookup/read costs measure ordering and progress, not real latency.
// Only synthetic files and a loopback receiver; no installed hooks or real data.
import {mock} from 'bun:test';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';

const raw={...fs},dir=raw.realpathSync(raw.mkdtempSync(join(tmpdir(),'opencrawl-worker-priority-')));
const captureRoot=join(dir,'config','opencrawl','capture'),sourceRoot=join(captureRoot,'sources');
const nativeRoot=join(dir,'gemini'),claudeRoot=join(dir,'claude');
const originalNow=Date.now,originalFetch=globalThis.fetch,hash=v=>createHash('sha256').update(v).digest('hex');
let clock=originalNow(),lookups=0,server;
const sources=[],fds=new Map(),charged=new Set(),uploads=[];
try{
 for(const name of ['queue','state','blobs','notices','sources','rejected','uploads'])raw.mkdirSync(join(captureRoot,name),{recursive:true});
 const principal={tenantId:'synthetic-worker-tenant',userId:'synthetic-worker-user'},token='synthetic-worker-token';
 server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  if(request.headers.get('authorization')!=='Bearer '+token)return new Response('{}',{status:401});
  const path=new URL(request.url).pathname,response=data=>Response.json({schemaVersion:1,data});
  if(path==='/api/sessions/identity')return response({principal,capabilities:{batchEncodings:[],harnesses:['antigravity']}});
  if(path==='/api/sessions/batches'){
   const bytes=await request.text(),batch=JSON.parse(bytes);
   if(batch.owner.tenantId!==principal.tenantId||batch.owner.userId!==principal.userId||batch.installationId!=='synthetic-worker')throw Error('Fixture scope');
   uploads.push({at:clock,lookups,sessionId:batch.sessionId,events:batch.events.map(e=>({id:e.id,kind:e.kind}))});
   return response({stored:true,batchId:hash(bytes),eventCount:batch.events.length});
  }
  return new Response('{}',{status:404});
 }});
 const api='http://127.0.0.1:'+server.port;
 Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(dir,'config'),OPENCRAWL_API_URL:api,OPENCRAWL_SESSIONS_TOKEN:token,OPENCRAWL_NO_UPDATE:'1'});
 delete process.env.OPENCRAWL_AUTH;delete process.env.OPENCRAWL_TOKEN;
 globalThis.fetch=(input,init)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
  if(url.origin!==api)throw Error('Non-fixture networking forbidden');
  return originalFetch(input,init);
 };
 const config={schemaVersion:1,hookMode:'native-v4',api,installationId:'synthetic-worker',owner:principal,
  installedAt:new Date(clock).toISOString(),harnesses:['antigravity','claude-code'],
  roots:{antigravity:nativeRoot,codex:join(dir,'codex'),'claude-code':claudeRoot},command:[]};
 raw.writeFileSync(join(captureRoot,'config.json'),JSON.stringify(config));
 const make=id=>{
  const folder=join(nativeRoot,'antigravity-cli','brain',id,'.system_generated','logs');raw.mkdirSync(folder,{recursive:true});
  const path=join(folder,'transcript_full.jsonl');
  raw.writeFileSync(path,JSON.stringify({step_index:0,source:'USER_EXPLICIT',type:'USER_INPUT',status:'DONE',created_at:'2026-11-15T12:00:00Z',content:'Synthetic '+id})+'\n');
  return path;
 };
 for(let n=0;n<1024;n++)raw.writeFileSync(join(sourceRoot,'001-pathless-'+String(n).padStart(4,'0')+'.json'),JSON.stringify({harness:'claude-code',sessionId:'missing-'+n}));
 for(let n=0;n<256;n++)raw.writeFileSync(join(sourceRoot,'002-absent-'+n+'.json'),JSON.stringify({harness:'claude-code',sessionId:'absent-'+n,path:join(dir,'absent',String(n))}));
 for(const id of ['source-a','source-b','source-c']){
  const path=make(id);sources.push(path);
  raw.writeFileSync(join(sourceRoot,'999-'+id+'.json'),JSON.stringify({harness:'antigravity',sessionId:id,path,origin:'cli'}));
 }
 mock.module('node:fs',()=>({...raw,
  readdirSync(path,...args){
   if(String(path)===join(claudeRoot,'projects')){lookups++;clock+=100;}
   const result=raw.readdirSync(path,...args);
   return String(path)===sourceRoot?result.sort():result;
  },
  openSync(path,...args){const fd=raw.openSync(path,...args);if(sources.includes(String(path)))fds.set(fd,String(path));return fd;},
  readSync(fd,...args){const n=raw.readSync(fd,...args),path=fds.get(fd);if(n>0&&path&&!charged.has(path)){charged.add(path);clock+=3000;}return n;},
  closeSync(fd){fds.delete(fd);return raw.closeSync(fd);},
 }));
 Date.now=()=>clock;
 const runtime=await import('../../src/capture/runtime.ts');
 if(runtime.captureDir()!==captureRoot)throw Error('Fixture configuration escaped');
 for(let n=0;n<7;n++){
  const id='ready-'+n;await runtime.captureTranscript(config,'antigravity',make(id),{conversationId:id});
 }
 const start=clock;
 await runtime.captureWorker({flushMs:0,idleMs:0,pollMs:1,flushBy:start+500});
 const firstPassLookups=lookups,firstPassDeferredSources=charged.size===0;
 // Separate invocations must resume past stale entries, not restart the same
 // prefix forever when each invocation has a bounded reconciliation pass.
 for(let pass=0;pass<20&&charged.size<sources.length;pass++)await runtime.captureWorker({flushMs:0,idleMs:0,pollMs:1});
 raw.appendFileSync(sources[0],JSON.stringify({step_index:1,source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE',created_at:'2026-11-15T12:01:00Z',content:'Synthetic late tail'})+'\n');
 for(let pass=0;pass<20&&uploads.filter(x=>x.sessionId==='source-a').flatMap(x=>x.events).length<2;pass++)await runtime.captureWorker({flushMs:0,idleMs:0,pollMs:1});
 const events=uploads.flatMap(x=>x.events);
 console.log(JSON.stringify({firstUploadClockMs:uploads[0]?.at-start,lookupsBeforeFirstUpload:uploads[0]?.lookups,
  firstPassLookups,firstPassDeferredSources,readySessionsUploaded:new Set(uploads.filter(x=>x.sessionId.startsWith('ready-')).map(x=>x.sessionId)).size,
  totalEvents:events.length,uniqueEvents:new Set(events.map(x=>x.id)).size,
  allSourcesUploaded:['source-a','source-b','source-c'].every(id=>uploads.some(x=>x.sessionId===id)),
  lateTailPreserved:uploads.filter(x=>x.sessionId==='source-a').flatMap(x=>x.events).length===2,
  sourceCursorsComplete:sources.every(path=>JSON.parse(raw.readFileSync(join(captureRoot,'state',hash('antigravity'+path)+'.json'),'utf8')).offset===raw.statSync(path).size),
  queueEmpty:raw.readdirSync(join(captureRoot,'queue')).filter(x=>x.endsWith('.json')).length===0,
 }));
}finally{
 Date.now=originalNow;globalThis.fetch=originalFetch;server?.stop(true);raw.rmSync(dir,{recursive:true,force:true});
}
