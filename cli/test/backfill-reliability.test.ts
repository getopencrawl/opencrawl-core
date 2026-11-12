import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {backfillPreview,backfill,type BackfillProgress} from '../src/capture/backfill.ts';
import {captureDir,captureStatus,captureTranscript,flushCaptures,type CaptureConfig} from '../src/capture/runtime.ts';
import {atomicJson,saveSession,readSession} from '../src/session.ts';
import {retryWindowsSharing} from '../src/filesystem.ts';
import {createSessionIngest} from '../../dist/src/sessions/ingest.mjs';
import {createLocalSessionStore} from '../../dist/src/sessions/local-store.mjs';

async function isolated(run:(dir:string)=>Promise<void>){
 const saved={...process.env},dir=mkdtempSync(join(tmpdir(),'opencrawl-backfill-reliability-'));
 for(const key of ['OPENCRAWL_TOKEN','OPENCRAWL_SESSIONS_TOKEN','OPENCRAWL_API_URL'])delete process.env[key];
 Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(dir,'config'),CLAUDE_CONFIG_DIR:join(dir,'claude'),CODEX_HOME:join(dir,'codex'),CLAUDE_DESKTOP_CONFIG_DIR:join(dir,'desktop')});
 try{await run(dir);}finally{for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);rmSync(dir,{recursive:true,force:true});}
}

test('history preview works before consent, install or login without creating state or parsing contents',async()=>isolated(async dir=>{
 const source=join(dir,'codex','sessions');mkdirSync(source,{recursive:true});
 writeFileSync(join(source,'not-readable-as-json.jsonl'),'not a transcript\n');
 const preview=backfillPreview('https://selfhost.example');
 expect(preview.owner).toBeNull();expect(preview.sources.map(s=>s.files)).toEqual([0,1]);
 expect(preview.sources[1].bytes).toBe(17);expect(existsSync(join(dir,'config'))).toBe(false);
 await expect(backfill('https://selfhost.example','all',false)).rejects.toMatchObject({code:'BACKFILL_CONSENT_REQUIRED'});
 expect(existsSync(join(dir,'config'))).toBe(false);
}));

test('large approved import survives refresh throttling, uploads four at a time, reports receipts and resumes',async()=>isolated(async dir=>{
 const owner={tenantId:'test',userId:'importer'},store=createLocalSessionStore(join(dir,'objects')),ingest=createSessionIngest({store});
 let active=0,peak=0,refreshes=0,denied=false;const starts:number[]=[];
 const accepted:any[]=[],progress:BackfillProgress[]=[];
 const server=createServer(async(req,res)=>{
  const send=(status:number,body:unknown,headers={})=>{res.writeHead(status,{'content-type':'application/json',...headers});res.end(JSON.stringify(body));};
  if(req.url==='/token'){
   refreshes++;
   if(denied)return send(401,{error:'invalid_grant'});
   if(refreshes===1)return send(429,{error:'too_many_requests'},{'retry-after':'0'});
   return send(200,{access_token:'valid',refresh_token:'rotated',expires_in:3600});
  }
  if(req.headers.authorization!=='Bearer valid')return send(401,{});
  if(req.url==='/api/sessions/identity')return send(200,{data:{principal:owner}});
  if(req.url==='/api/sessions/batches'){
   active++;peak=Math.max(peak,active);starts.push(Date.now());
   try{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const batch=JSON.parse(Buffer.concat(chunks).toString());
    await new Promise(resolve=>setTimeout(resolve,20));
    const receipt=await ingest.putBatch(owner,batch);accepted.push({batch,receipt});send(200,{data:receipt});
   }catch(error:any){send(error.status??500,{error:{code:'TEST_INGEST_ERROR'}});}finally{active--;}
   return;
  }
  send(404,{});
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const api='http://127.0.0.1:'+(server.address() as any).port;
 try{
  const config:CaptureConfig={schemaVersion:1,api,installationId:'fixture',owner,installedAt:new Date().toISOString(),roots:{'claude-code':join(dir,'claude'),codex:join(dir,'codex')},command:[]};
  atomicJson(join(captureDir(),'config.json'),config);
  for(const name of ['queue','state','blobs'])mkdirSync(join(captureDir(),name),{recursive:true});
  const auth={clientId:'fixture',tokenEndpoint:api+'/token',deviceAuthorizationEndpoint:api+'/device'};
  await saveSession(api,{auth,accessToken:'expired',refreshToken:'initial',expiresAt:0});
  const source=join(config.roots.codex,'sessions');mkdirSync(source,{recursive:true});
  const records=[{type:'session_meta',payload:{id:'large',source:'cli'}},...Array.from({length:6200},(_,i)=>({type:'response_item',payload:{type:'message',role:'user',content:'event '+i}}))];
  const text=records.map(record=>JSON.stringify(record)+'\n').join('');writeFileSync(join(source,'large.jsonl'),text);
  const result=await backfill(api,'codex',true,{retryDelays:[0,0],onProgress:p=>progress.push(p)});
  expect(refreshes).toBe(2);expect(readSession(api)?.refreshToken).toBe('rotated');
  expect(peak).toBe(4);expect(accepted).toHaveLength(7);expect(result.uploaded).toBe(7);
  expect(accepted.every(({batch})=>batch.events.length<=1000&&batch.captureMode==='history')).toBe(true);
  expect(accepted.flatMap(({batch})=>batch.events)).toHaveLength(6201);
  expect(new Set(accepted.flatMap(({batch})=>batch.events.map((event:any)=>event.id))).size).toBe(6201);
  for(const {batch,receipt} of accepted){expect(await ingest.getBatch(owner,{...receipt,harness:batch.harness,installationId:batch.installationId,sessionId:batch.sessionId})).not.toBeNull();}
  expect(progress.some(p=>p.status==='retrying')).toBe(true);
  expect(progress.at(-1)).toMatchObject({status:'complete',processed:1,totalFiles:1,processedBytes:Buffer.byteLength(text),uploaded:7});
  expect(captureStatus().backfill.status).toBe('complete');expect(captureStatus().queued).toBe(0);
  expect((await backfill(api,'codex',true)).uploaded).toBe(0);expect(accepted).toHaveLength(7);
  // Operator pacing deliberately trades throughput for server headroom.
  const paced=join(source,'paced.jsonl');writeFileSync(paced,records.slice(0,2201).map(record=>JSON.stringify(record)+'\n').join(''));
  await captureTranscript(config,'codex',paced,{},true);const first=starts.length;peak=0;
  await flushCaptures({concurrency:1,batchDelayMs:200});expect(peak).toBe(1);
  for(let i=first+1;i<starts.length;i++)expect(starts[i]-starts[i-1]).toBeGreaterThanOrEqual(100);
  await expect(backfill(api,'codex',true,{concurrency:0})).rejects.toMatchObject({code:'INVALID_USAGE'});
  await expect(backfill(api,'codex',true,{batchDelayMs:-1})).rejects.toMatchObject({code:'INVALID_USAGE'});
  // Small files also fill all workers instead of serializing on one receipt each.
  rmSync(join(source,'large.jsonl'));rmSync(paced);peak=0;const smallStart=accepted.length;
  for(let i=0;i<4;i++)writeFileSync(join(source,`small-${i}.jsonl`),JSON.stringify({type:'session_meta',payload:{id:`small-${i}`,source:'cli'}})+'\n'+JSON.stringify(records[1])+'\n');
  expect((await backfill(api,'codex',true)).uploaded).toBe(4);expect(peak).toBe(4);expect(accepted.length-smallStart).toBe(4);
  denied=true;await saveSession(api,{auth,accessToken:'expired',refreshToken:'revoked',expiresAt:0});
  const before=refreshes;
  await expect(backfill(api,'codex',true,{retryDelays:[0,0]})).rejects.toMatchObject({code:'AUTH_REQUIRED'});
  expect(refreshes-before).toBe(1);expect(captureStatus().backfill.status).toBe('failed');
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}),20000);

test('Windows sharing retries are bounded and other OS errors fail immediately',()=>{
 for(const code of ['EPERM','EBUSY','EACCES']){
  let attempts=0;const waits:number[]=[];
  expect(retryWindowsSharing(()=>{if(++attempts<3)throw Object.assign(new Error('busy'),{code});return 'saved';},'win32',ms=>{waits.push(ms);})).toBe('saved');
  expect(waits).toEqual([10,20]);
  attempts=0;expect(()=>retryWindowsSharing(()=>{attempts++;throw Object.assign(new Error('permanent'),{code});},'win32',()=>{})).toThrow('permanent');expect(attempts).toBe(7);
 }
 for(const [platform,code] of [['linux','EPERM'],['win32','ENOSPC'],['win32','EROFS']]){
  let attempts=0;expect(()=>retryWindowsSharing(()=>{attempts++;throw Object.assign(new Error('terminal'),{code});},platform,()=>{throw Error('must not wait');})).toThrow('terminal');expect(attempts).toBe(1);
 }
});
