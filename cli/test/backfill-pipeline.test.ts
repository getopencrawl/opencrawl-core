import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {backfill} from '../src/capture/backfill.ts';
import {captureDir,flushCaptures,type CaptureConfig} from '../src/capture/runtime.ts';
import {atomicJson} from '../src/session.ts';
import {createSessionIngest} from '../../dist/src/sessions/ingest.mjs';
import {createLocalSessionStore} from '../../dist/src/sessions/local-store.mjs';

for(const fail of [false,true])test('backfill bounds parsing ahead of blocked uploads'+(fail?' and resumes a failed wave':''),async()=>{
 const saved={...process.env},dir=mkdtempSync(join(tmpdir(),'backfill-pipeline-')),owner={tenantId:'team',userId:'owner'};
 const ingest=createSessionIngest({store:createLocalSessionStore(join(dir,'objects'))});
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 let firstWave!:()=>void;const started=new Promise<void>(r=>firstWave=r);
 let active=0,peak=0,requests=0,deny=fail;const batches=new Map<string,any>();
 const server=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.url==='/api/sessions/identity'){res.end(JSON.stringify({data:{principal:owner}}));return;}
  active++;peak=Math.max(peak,active);const number=++requests;if(active===4)firstWave();
  try{
   const chunks=[];for await(const chunk of req)chunks.push(chunk);const batch=JSON.parse(Buffer.concat(chunks).toString());
   if(number<=4)await gate;
   if(deny&&number===1){res.writeHead(403);res.end(JSON.stringify({error:{code:'DENIED'}}));return;}
   if(!fail&&number===1){res.writeHead(503);res.end(JSON.stringify({error:{code:'TEST_BUSY'}}));return;}
   const receipt=await ingest.putBatch(owner,batch);batches.set(receipt.batchId,batch);res.end(JSON.stringify({data:receipt}));
  }catch(error:any){res.writeHead(error.status??500);res.end(JSON.stringify({error:{code:'TEST_INGEST_ERROR'}}));}finally{active--;}
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 let pending:Promise<any>|undefined;
 try{
  const api='http://127.0.0.1:'+(server.address() as any).port;
  Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(dir,'config'),OPENCRAWL_API_URL:api,OPENCRAWL_SESSIONS_TOKEN:'fixture-token'});
  const config:CaptureConfig={schemaVersion:1,api,owner,installationId:'device',installedAt:'2026-11-12T00:00:00Z',roots:{codex:join(dir,'codex'),'claude-code':join(dir,'claude')},command:[]};
  atomicJson(join(captureDir(),'config.json'),config);
  const source=join(config.roots.codex,'sessions');mkdirSync(source,{recursive:true});
  const records=[{type:'session_meta',payload:{id:'large',source:'cli'}},...Array.from({length:20000},(_,i)=>({type:'response_item',payload:{type:'message',role:'user',content:'event '+i}}))];
  writeFileSync(join(source,'large.jsonl'),records.map(x=>JSON.stringify(x)+'\n').join(''));
  pending=backfill(api,'codex',true,{retryDelays:[]}).then(value=>({value}),error=>({error}));
  await Promise.race([started,pending.then(result=>{throw result.error??new Error('Import completed before the blocked wave');})]);
  const queued=()=>readdirSync(join(captureDir(),'queue')).filter(x=>x.endsWith('.json')).length;
  const deadline=Date.now()+5000;while(queued()<16&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
  expect(queued()).toBe(16);expect(active).toBe(4);
  await new Promise(r=>setTimeout(r,30));expect(queued()).toBe(16);
  // The upload lock remains owned even while the producer is paused.
  expect(await flushCaptures({wait:false})).toEqual({uploaded:0});
  release();const result=await pending;
  expect(active).toBe(0);expect(peak).toBe(4);
  if(fail){expect(result.error?.code).toBe('CAPTURE_UPLOAD_FAILED');expect(queued()).toBeGreaterThan(0);deny=false;expect((await backfill(api,'codex',true,{retryDelays:[]})).status).toBe('complete');}
  else expect(result.value.status).toBe('complete');
  const ids=[...batches.values()].flatMap(batch=>batch.events.map((event:any)=>event.id));
  expect(ids).toHaveLength(20001);expect(new Set(ids).size).toBe(20001);expect(queued()).toBe(0);
  if(!fail)expect(requests).toBeGreaterThan(batches.size);
  expect((await backfill(api,'codex',true)).uploaded).toBe(0);
 }finally{
  release();await pending;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
  for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);rmSync(dir,{recursive:true,force:true});
 }
},20000);
