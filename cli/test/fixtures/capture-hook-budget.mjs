// Controlled source-read cost, not a wall-clock latency benchmark. Synthetic
// transcripts and a loopback receiver only; never install/refresh native hooks.
import {mock} from 'bun:test';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';

const raw={...fs},dir=raw.realpathSync(raw.mkdtempSync(join(tmpdir(),'opencrawl-hook-budget-')));
const configHome=join(dir,'config'),captureRoot=join(configHome,'opencrawl','capture'),nativeRoot=join(dir,'gemini');
const originalNow=Date.now,originalFetch=globalThis.fetch,hash=value=>createHash('sha256').update(value).digest('hex');
let clock=originalNow(),server;
const sources=[],fds=new Map(),charged=new Set(),uploads=[];
try{
 for(const name of ['queue','state','blobs','notices','sources','rejected','uploads'])raw.mkdirSync(join(captureRoot,name),{recursive:true});
 const principal={tenantId:'synthetic-budget-tenant',userId:'synthetic-budget-user'},token='synthetic-budget-token';
 server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  if(request.headers.get('authorization')!=='Bearer '+token)return new Response('{}',{status:401});
  const path=new URL(request.url).pathname,response=data=>Response.json({schemaVersion:1,data});
  if(path==='/api/sessions/identity')return response({principal,capabilities:{batchEncodings:[],harnesses:['antigravity']}});
  if(path==='/api/sessions/batches'){
   const bytes=await request.text(),batch=JSON.parse(bytes);
   if(batch.harness!=='antigravity'||batch.owner.tenantId!==principal.tenantId||batch.owner.userId!==principal.userId)throw Error('Fixture scope');
   uploads.push({at:clock,sessionId:batch.sessionId,events:batch.events.map(e=>({id:e.id,kind:e.kind}))});
   return response({stored:true,batchId:hash(bytes),eventCount:batch.events.length});
  }
  return new Response('{}',{status:404});
 }});
 const api='http://127.0.0.1:'+server.port;
 Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:configHome,OPENCRAWL_API_URL:api,OPENCRAWL_SESSIONS_TOKEN:token,OPENCRAWL_NO_UPDATE:'1'});
 delete process.env.OPENCRAWL_AUTH;delete process.env.OPENCRAWL_TOKEN;
 globalThis.fetch=(input,init)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
  if(url.origin!==api)throw Error('Non-fixture networking forbidden');
  return originalFetch(input,init);
 };
 const config={schemaVersion:1,hookMode:'native-v4',api,installationId:'synthetic-budget',owner:principal,
  installedAt:new Date(clock).toISOString(),harnesses:['antigravity'],
  roots:{antigravity:nativeRoot,codex:join(dir,'codex'),'claude-code':join(dir,'claude')},command:[]};
 raw.writeFileSync(join(captureRoot,'config.json'),JSON.stringify(config));
 const make=id=>{
  const folder=join(nativeRoot,'antigravity-cli','brain',id,'.system_generated','logs');raw.mkdirSync(folder,{recursive:true});
  const file=join(folder,'transcript_full.jsonl');
  raw.writeFileSync(file,JSON.stringify({step_index:0,source:'USER_EXPLICIT',type:'USER_INPUT',status:'DONE',created_at:'2026-11-15T12:00:00Z',content:'Synthetic '+id})+'\n');
  return file;
 };
 const ready=make('ready');
 for(const id of ['source-a','source-b']){
  const path=make(id);sources.push(path);
  raw.writeFileSync(join(captureRoot,'sources',id+'.json'),JSON.stringify({harness:'antigravity',sessionId:id,path,origin:'cli'}));
 }
 // Each first read costs 3s on the controlled clock. The budget must stop the
 // next source from starting, leaving the existing queue time to get receipts.
 mock.module('node:fs',()=>({...raw,
  openSync(path,...args){const fd=raw.openSync(path,...args);if(sources.includes(String(path)))fds.set(fd,String(path));return fd;},
  readSync(fd,...args){const n=raw.readSync(fd,...args),path=fds.get(fd);if(n>0&&path&&!charged.has(path)){charged.add(path);clock+=3000;}return n;},
  closeSync(fd){fds.delete(fd);return raw.closeSync(fd);},
 }));
 Date.now=()=>clock;
 const runtime=await import('../../src/capture/runtime.ts');
 if(runtime.captureDir()!==captureRoot)throw Error('Fixture configuration escaped');
 await runtime.captureTranscript(config,'antigravity',ready,{conversationId:'ready'});
 const start=clock;
 await runtime.hookFlush({hookEventName:'Stop'},{now:()=>clock});
 const firstSourcesRead=charged.size,firstUploadClockMs=uploads[0]?.at-start;
 clock+=60000;await runtime.hookFlush({hookEventName:'Stop'},{now:()=>clock});
 raw.appendFileSync(sources[0],JSON.stringify({step_index:1,source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE',created_at:'2026-11-15T12:01:00Z',content:'Synthetic late tail'})+'\n');
 clock+=60000;await runtime.hookFlush({hookEventName:'Stop'},{now:()=>clock});
 const events=uploads.flatMap(x=>x.events);
 console.log(JSON.stringify({firstSourcesRead,firstUploadClockMs,readyUploaded:uploads.some(x=>x.sessionId==='ready'),
  totalEvents:events.length,uniqueEvents:new Set(events.map(x=>x.id)).size,
  bothSourcesUploaded:['source-a','source-b'].every(id=>uploads.some(x=>x.sessionId===id)),
  lateTailPreserved:uploads.filter(x=>x.sessionId==='source-a').flatMap(x=>x.events).length===2,
  sourceCursorsComplete:sources.every(path=>JSON.parse(raw.readFileSync(join(captureRoot,'state',hash('antigravity'+path)+'.json'),'utf8')).offset===raw.statSync(path).size),
  queueEmpty:raw.readdirSync(join(captureRoot,'queue')).filter(x=>x.endsWith('.json')).length===0,
 }));
}finally{
 Date.now=originalNow;globalThis.fetch=originalFetch;server?.stop(true);raw.rmSync(dir,{recursive:true,force:true});
}
