import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,appendFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {installCapture,uninstallCapture} from '../src/capture/install.ts';
import {captureHook,captureWorker,captureDir,captureStatus,readCaptureConfig,flushCaptures,drainCaptureNotices} from '../src/capture/runtime.ts';
import {withSessionLock,sessionFile} from '../src/session.ts';
import {backfill} from '../src/capture/backfill.ts';
import {hash} from '../src/capture/parse.ts';

const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(fn:()=>boolean,ms=5000){const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw Error('condition timed out');await sleep(10);}}
async function fixture(run:(f:any)=>Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),'opencrawl-worker-')),saved={...process.env};
 const owner={tenantId:'fixture',userId:'fixture'},batches:any[]=[],payloads:string[]=[];
 let requests=0,delay=0,loseAck=false;
 const server=createServer(async(req,res)=>{
  requests++;if(delay)await sleep(delay);
  if(req.url==='/api/sessions/identity'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:{principal:owner}}));return;}
  const parts=[];for await(const c of req)parts.push(c);const raw=Buffer.concat(parts).toString();
  if(req.url==='/api/sessions/batches'){
   payloads.push(raw);batches.push(JSON.parse(raw));
   if(loseAck){loseAck=false;res.writeHead(502,{'content-type':'application/json'});res.end('{}');return;}
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:{stored:true,batchId:hash(raw)}}));return;
  }
  res.writeHead(404);res.end();
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const api='http://127.0.0.1:'+(server.address() as any).port;
 try{
  Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(dir,'config'),OPENCRAWL_SESSIONS_TOKEN:'synthetic-worker-token',CLAUDE_CONFIG_DIR:join(dir,'claude'),CODEX_HOME:join(dir,'codex'),OPENCRAWL_NO_UPDATE:'1'});
  delete process.env.CLAUDE_CODE_REMOTE;
  await installCapture(api,{home:dir,command:[]});
  const path=join(dir,'claude','projects','fixture','session.jsonl');mkdirSync(join(path,'..'),{recursive:true});
  const record=(id:string)=>JSON.stringify({type:'user',uuid:id,sessionId:'session',message:{role:'user',content:'synthetic '+id}})+'\n';
  writeFileSync(path,record('one'));
  await run({dir,api,path,record,batches,payloads,get requests(){return requests;},set delay(v:number){delay=v;},set loseAck(v:boolean){loseAck=v;}});
 }finally{
  try{uninstallCapture(dir);}catch{}
  server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
  for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);rmSync(dir,{recursive:true,force:true});
 }
}

test('hooks only hand off locally even with invalid transcripts and a busy uploader',async()=>fixture(async f=>{
 writeFileSync(f.path,'not valid JSON\n');let release!:()=>void;
 const held=withSessionLock('capture:flush',()=>new Promise<void>(r=>{release=r;}));
 const before=f.requests,start=Date.now();
 try {
  await Promise.all(Array.from({length:16},()=>captureHook('claude-code',{session_id:'session',transcript_path:f.path,prompt:'synthetic'})));
  expect(Date.now()-start).toBeLessThan(1500);expect(f.requests).toBe(before);
  expect(captureStatus().pendingHooks).toBe(16);expect(captureStatus().queued).toBe(0);
  expect(readdirSync(join(captureDir(),'state'))).toEqual([]);
 }finally{release();await held;}
}));

test('worker tails after Stop, uploads identical retries, and resumes an old source on the next run',async()=>fixture(async f=>{
 f.loseAck=true;
 await captureHook('claude-code',{session_id:'session',transcript_path:f.path,hook_event_name:'Stop'});
 const worker=captureWorker({idleMs:150,pollMs:10});
 await until(()=>f.payloads.length>=1);
 appendFileSync(f.path,f.record('two'));
 await worker;
 expect(f.payloads[0]).toBe(f.payloads[1]);
 expect(f.batches.flatMap((b:any)=>b.events).some((e:any)=>e.nativeId==='two')).toBe(true);
 expect(captureStatus().pendingHooks).toBe(0);expect(captureStatus().queued).toBe(0);
 // An append after the tail window is retained in the source and found on wake.
 appendFileSync(f.path,f.record('three'));
 await captureWorker({idleMs:20,pollMs:5});
 expect(f.batches.flatMap((b:any)=>b.events).filter((e:any)=>e.nativeId==='three')).toHaveLength(1);
}));

test('notice replay after crash keeps the hook identity and published batch stable',async()=>fixture(async f=>{
 await captureHook('claude-code',{session_id:'session',transcript_path:f.path,prompt:'synthetic'});
 const notice=join(captureDir(),'notices',readdirSync(join(captureDir(),'notices'))[0]),raw=readFileSync(notice);
 await drainCaptureNotices();const names=readdirSync(join(captureDir(),'queue'));
 writeFileSync(notice,raw);await drainCaptureNotices();
 expect(readdirSync(join(captureDir(),'queue')).sort()).toEqual(names.sort());
 await flushCaptures();expect(captureStatus().queued).toBe(0);
}));

test('backfill waits beyond the old 20-second upload-lock deadline and reports complete only after receipts',async()=>fixture(async f=>{
 let release!:()=>void;
 const held=withSessionLock('capture:flush',()=>new Promise<void>(r=>{release=r;}));
 let complete=false;const importing=backfill(f.api,'claude-code',true).then(r=>{complete=true;return r;});
 try{
  await sleep(20_100);expect(complete).toBe(false);expect(captureStatus().queued).toBeGreaterThan(0);
 }finally{release();await held;}
 expect((await importing).status).toBe('complete');expect(captureStatus().queued).toBe(0);expect(f.batches.length).toBeGreaterThan(0);
}),30000);

test('a killed detached worker leaves durable notices for a new invocation',async()=>fixture(async f=>{
 const cli=resolve(import.meta.dir,'../src/cli.ts');
 f.delay=500;
 await captureHook('claude-code',{session_id:'session',transcript_path:f.path,prompt:'synthetic'});
 const worker=Bun.spawn([process.execPath,cli,'collect','worker'],{env:process.env,stdout:'ignore',stderr:'ignore'});
 const lock=sessionFile('capture:worker')+'.lock';
 try {
  await until(()=>existsSync(lock)&&readFileSync(lock,'utf8')===String(worker.pid));worker.kill('SIGKILL');await worker.exited;
  f.delay=0;
  await captureWorker({idleMs:20,pollMs:5});
  expect(captureStatus().queued).toBe(0);expect(captureStatus().pendingHooks).toBe(0);
  expect(f.batches.flatMap((b:any)=>b.events).some((e:any)=>e.nativeId==='one')).toBe(true);
 }finally{worker.kill();await worker.exited;}
}),10000);

test('credential-free cloud preparation returns before network; first hook stays local and worker binds identity',async()=>fixture(async f=>{
 const before=f.requests;
 delete process.env.OPENCRAWL_SESSIONS_TOKEN;
 rmSync(join(captureDir(),'receiver-token.json'));
 rmSync(join(captureDir(),'config.json'));
 const setup=await installCapture(f.api,{home:f.dir,command:[],harnesses:['claude-code'],deferAuth:true});
 expect(setup.owner).toBeNull();expect(f.requests).toBe(before);expect(readCaptureConfig()!.installationId).toBe('pending');
 await captureHook('claude-code',{session_id:'session',transcript_path:f.path,hook_event_name:'SessionStart'});
 expect(f.requests).toBe(before);expect(captureStatus().pendingHooks).toBe(1);expect(captureStatus().queued).toBe(0);
 process.env.OPENCRAWL_SESSIONS_TOKEN='synthetic-runtime-token';
 await captureWorker({idleMs:20,pollMs:5});
 expect(readCaptureConfig()!.authPending).toBe(false);expect(readCaptureConfig()!.installationId).not.toBe('pending');
 expect(f.batches.every((b:any)=>b.owner.userId==='fixture'&&b.installationId!=='pending')).toBe(true);
 expect(f.batches.length).toBeGreaterThan(0);expect(captureStatus().pendingHooks).toBe(0);
}));

test('competing worker processes exit successfully while one drains the durable queue',async()=>fixture(async f=>{
 f.delay=150;
 await captureHook('claude-code',{session_id:'session',transcript_path:f.path,prompt:'synthetic'});
 const runtime=resolve(import.meta.dir,'../src/capture/runtime.ts');
 const code=`import {captureWorker} from ${JSON.stringify(runtime)}; await captureWorker({idleMs:40,pollMs:5});`;
 const workers=Array.from({length:12},()=>Bun.spawn([process.execPath,'-e',code],{env:process.env,stdout:'ignore',stderr:'pipe'}));
 try{
  expect(await Promise.all(workers.map(p=>p.exited))).toEqual(Array(12).fill(0));
  const events=f.batches.flatMap((b:any)=>b.events);
  expect(events.filter((e:any)=>e.nativeId==='one')).toHaveLength(1);
  expect(events.filter((e:any)=>e.kind==='hook')).toHaveLength(1);
  expect(captureStatus().pendingHooks).toBe(0);expect(captureStatus().queued).toBe(0);
 }finally{for(const p of workers)p.kill();await Promise.all(workers.map(p=>p.exited));}
}),15000);

test('SubagentStop enrolls the child transcript separately and preserves both late tails',async()=>fixture(async f=>{
 const child=join(f.path.slice(0,-6),'subagents','agent-child.jsonl');mkdirSync(join(child,'..'),{recursive:true});
 const record=(id:string)=>JSON.stringify({type:'assistant',uuid:id,sessionId:'session',agentId:'child',message:{role:'assistant',content:'synthetic child'}})+'\n';
 writeFileSync(child,record('child-one'));
 await captureHook('claude-code',{session_id:'session',transcript_path:f.path,agent_transcript_path:child,hook_event_name:'SubagentStop'});
 await captureWorker({idleMs:20,pollMs:5});
 appendFileSync(f.path,f.record('parent-two'));appendFileSync(child,record('child-two'));
 await captureWorker({idleMs:20,pollMs:5});
 for(const id of ['child-one','child-two'])expect(f.batches.filter((b:any)=>b.sessionId==='session:child'&&b.events.some((e:any)=>e.nativeId===id))).toHaveLength(1);
 expect(f.batches.filter((b:any)=>b.sessionId==='session'&&b.events.some((e:any)=>e.nativeId==='parent-two'))).toHaveLength(1);
}));
