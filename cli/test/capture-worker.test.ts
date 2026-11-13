import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,appendFileSync,existsSync,utimesSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {installCapture,uninstallCapture,upgradeCaptureHooks} from '../src/capture/install.ts';
import {captureHook,captureWorker,captureDir,captureStatus,readCaptureConfig,flushCaptures,flushCaptureWork,drainCaptureNotices} from '../src/capture/runtime.ts';
import {withSessionLock,sessionFile} from '../src/session.ts';
import {backfill} from '../src/capture/backfill.ts';
import {hash} from '../src/capture/parse.ts';

const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(fn:()=>boolean,ms=5000){const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw Error('condition timed out');await sleep(10);}}
async function fixture(run:(f:any)=>Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),'opencrawl-worker-')),saved={...process.env};
 const owner={tenantId:'fixture',userId:'fixture'},batches:any[]=[],payloads:string[]=[];
 let requests=0,delay=0,loseAck=false,holdAck=false;
 const server=createServer(async(req,res)=>{
  requests++;if(delay)await sleep(delay);
  if(req.url==='/api/sessions/identity'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:{principal:owner}}));return;}
  const parts=[];for await(const c of req)parts.push(c);const raw=Buffer.concat(parts).toString();
  if(req.url==='/api/sessions/batches'){
   payloads.push(raw);batches.push(JSON.parse(raw));
   if(holdAck)return;
   if(loseAck){loseAck=false;res.writeHead(502,{'content-type':'application/json'});res.end('{}');return;}
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:{stored:true,batchId:hash(raw)}}));return;
  }
  res.writeHead(404);res.end();
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const api='http://127.0.0.1:'+(server.address() as any).port;process.env.OPENCRAWL_API_URL=api;
 try{
  Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(dir,'config'),OPENCRAWL_SESSIONS_TOKEN:'synthetic-worker-token',CLAUDE_CONFIG_DIR:join(dir,'claude'),CODEX_HOME:join(dir,'codex'),OPENCRAWL_NO_UPDATE:'1'});
  delete process.env.CLAUDE_CODE_REMOTE;
  await installCapture(api,{home:dir,command:[]});
  const path=join(dir,'claude','projects','fixture','session.jsonl');mkdirSync(join(path,'..'),{recursive:true});
  const record=(id:string)=>JSON.stringify({type:'user',uuid:id,sessionId:'session',message:{role:'user',content:'synthetic '+id}})+'\n';
  writeFileSync(path,record('one'));
  await run({dir,api,path,record,batches,payloads,owner,get requests(){return requests;},set delay(v:number){delay=v;},set loseAck(v:boolean){loseAck=v;},set holdAck(v:boolean){holdAck=v;}});
 }finally{
  try{await uninstallCapture(dir);}catch{}
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
 const worker=captureWorker({flushMs:0,idleMs:150,pollMs:10});
 await until(()=>f.payloads.length>=1);
 appendFileSync(f.path,f.record('two'));
 await worker;
 expect(f.payloads.filter((payload:string)=>payload===f.payloads[0])).toHaveLength(2);
 expect(f.batches.flatMap((b:any)=>b.events).some((e:any)=>e.nativeId==='two')).toBe(true);
 expect(captureStatus().pendingHooks).toBe(0);expect(captureStatus().queued).toBe(0);
 // An append after the tail window is retained in the source and found on wake.
 appendFileSync(f.path,f.record('three'));
 await captureWorker({flushMs:0,idleMs:20,pollMs:5});
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

test('a killed owned worker leaves durable notices for a new invocation',async()=>fixture(async f=>{
 const cli=resolve(import.meta.dir,'../src/cli.ts');
 f.delay=500;
 await captureHook('claude-code',{session_id:'session',transcript_path:f.path,prompt:'synthetic'});
 const worker=Bun.spawn([process.execPath,cli,'collect','worker'],{env:process.env,stdout:'ignore',stderr:'ignore'});
 const lock=sessionFile('capture:worker')+'.lock';
 try {
  await until(()=>existsSync(lock)&&readFileSync(lock,'utf8')===String(worker.pid));worker.kill('SIGKILL');await worker.exited;
  f.delay=0;
  await captureWorker({flushMs:0,idleMs:20,pollMs:5});
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
 await captureWorker({flushMs:0,idleMs:20,pollMs:5});
 expect(readCaptureConfig()!.authPending).toBe(false);expect(readCaptureConfig()!.installationId).not.toBe('pending');
 expect(f.batches.every((b:any)=>b.owner.userId==='fixture'&&b.installationId!=='pending')).toBe(true);
 expect(f.batches.length).toBeGreaterThan(0);expect(captureStatus().pendingHooks).toBe(0);
}));

test('repeated cloud preparation preserves enrollment and pending notices across a team or author change',async()=>fixture(async f=>{
 const original=readCaptureConfig()!;
 await captureHook('claude-code',{session_id:'session',transcript_path:f.path,hook_event_name:'SessionStart'});
 expect(captureStatus().pendingHooks).toBe(1);
 const before=f.requests;
 delete process.env.OPENCRAWL_SESSIONS_TOKEN;
 rmSync(join(captureDir(),'receiver-token.json'));
 const setup=await installCapture(f.api,{home:f.dir,command:[],harnesses:['claude-code'],deferAuth:true});
 expect(f.requests).toBe(before);
 expect(setup.owner).toEqual(original.owner);
 expect(setup.installationId).toBe(original.installationId);
 expect(readCaptureConfig()!.authPending).not.toBe(true);
 process.env.OPENCRAWL_SESSIONS_TOKEN='synthetic-runtime-token';
 for(const changed of [{...original.owner,tenantId:'other-team'},{...original.owner,userId:'other-user'}]){
  Object.assign(f.owner,changed);
  await expect(flushCaptureWork()).rejects.toMatchObject({code:'CAPTURE_DESTINATION_CHANGED'});
  expect(f.payloads).toHaveLength(0);
  const queued=readdirSync(join(captureDir(),'queue')).map(name=>JSON.parse(readFileSync(join(captureDir(),'queue',name),'utf8')));
  expect(queued.length).toBeGreaterThan(0);
  expect(queued.every(batch=>batch.owner.tenantId===original.owner.tenantId&&batch.owner.userId===original.owner.userId)).toBe(true);
 }
 Object.assign(f.owner,original.owner);
 await flushCaptureWork();
 expect(f.batches.length).toBeGreaterThan(0);
 expect(f.batches.every((batch:any)=>batch.owner.tenantId===original.owner.tenantId&&batch.owner.userId===original.owner.userId)).toBe(true);
 expect(captureStatus().queued).toBe(0);
 expect(captureStatus().pendingHooks).toBe(0);
}));

test('competing worker processes exit successfully while one drains the durable queue',async()=>fixture(async f=>{
 f.delay=150;
 await captureHook('claude-code',{session_id:'session',transcript_path:f.path,prompt:'synthetic'});
 const runtime=resolve(import.meta.dir,'../src/capture/runtime.ts');
 const code=`import {captureWorker} from ${JSON.stringify(runtime)}; await captureWorker({flushMs:0,idleMs:40,pollMs:5});`;
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
 await captureWorker({flushMs:0,idleMs:20,pollMs:5});
 appendFileSync(f.path,f.record('parent-two'));appendFileSync(child,record('child-two'));
 await captureWorker({flushMs:0,idleMs:20,pollMs:5});
 for(const id of ['child-one','child-two'])expect(f.batches.filter((b:any)=>b.sessionId==='session:child'&&b.events.some((e:any)=>e.nativeId===id))).toHaveLength(1);
 expect(f.batches.filter((b:any)=>b.sessionId==='session'&&b.events.some((e:any)=>e.nativeId==='parent-two'))).toHaveLength(1);
}));

// Exercise the actual generated command, including the shell and stable runner.
test('async hook retains its harness-owned PID on Unix; legacy upgrade preserves identity and queue',async()=>fixture(async f=>{
 const cli=resolve(import.meta.dir,'../src/cli.ts');
 const output=join(f.dir,'pid.json');
 const code=`require('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify({pid:process.pid,ppid:process.ppid}));`;
 await installCapture(f.api,{home:f.dir,command:[process.execPath,'-e',code]});
 const config=readCaptureConfig()!;
 const hooksFile=join(config.roots['claude-code'],'settings.json');
 const hook=JSON.parse(readFileSync(hooksFile,'utf8')).hooks.Stop[0].hooks[0];
 expect(hook.async).toBe(true);
 // Let Node quote cmd.exe's /s /c payload; CRT argv escaping is not cmd syntax.
 const shell=process.platform==='win32'?[Bun.which('node')!,'-e',`const r=require('node:child_process').spawnSync(${JSON.stringify(hook.command)},{shell:true,stdio:'inherit'});process.exit(r.status??1);`]:['/bin/sh','-c',hook.command];
 const child=Bun.spawn(shell,{env:process.env,stdout:'pipe',stderr:'pipe'});
 const exit=await child.exited;
 if(exit!==0)throw new Error(await new Response(child.stderr).text());
 expect(exit).toBe(0);
 const observed=JSON.parse(readFileSync(output,'utf8'));
 if(process.platform!=='win32')expect(observed.pid).toBe(child.pid);
 // A legacy synchronous hook must queue locally, not wait on network or spawn.
 writeFileSync(join(captureDir(),'config.json'),JSON.stringify({...config,hookMode:undefined,command:[process.execPath,cli]}));
 const before=f.requests;
 const legacy=Bun.spawn([process.execPath,cli,'collect','hook','--harness','claude-code'],{env:process.env,stdin:new Blob([JSON.stringify({session_id:'session',transcript_path:f.path})]),stdout:'pipe',stderr:'pipe'});
 expect(await legacy.exited).toBe(0);expect(f.requests).toBe(before);
 expect(captureStatus().pendingHooks).toBe(1);
 expect(readCaptureConfig()!.installationId).toBe(config.installationId);
 expect(readCaptureConfig()!.owner).toEqual(config.owner);
 expect(readCaptureConfig()!.hookMode).toBe('managed-v3');
 expect(JSON.parse(readFileSync(hooksFile,'utf8')).hooks.Stop[0].hooks[0].async).toBe(true);
 const upgraded=readFileSync(hooksFile,'utf8');await upgradeCaptureHooks();expect(readFileSync(hooksFile,'utf8')).toBe(upgraded);
 // Installs from the first managed hook layout are rewritten once by the next hook.
 writeFileSync(join(captureDir(),'config.json'),JSON.stringify({...readCaptureConfig()!,hookMode:'managed'}));
 const firstLayout=JSON.parse(readFileSync(join(config.roots.codex,'hooks.json'),'utf8'));
 firstLayout.hooks.SessionEnd[0].hooks[0]={...firstLayout.hooks.Stop[0].hooks[0]};
 writeFileSync(join(config.roots.codex,'hooks.json'),JSON.stringify(firstLayout));
 await upgradeCaptureHooks();
 expect(readCaptureConfig()!.hookMode).toBe('managed-v3');
 expect(JSON.parse(readFileSync(join(config.roots.codex,'hooks.json'),'utf8')).hooks.SessionEnd[0].hooks[0]).toMatchObject({timeout:3});
 // Installing one harness also upgrades the dispatcher for already enrolled ones.
 const codexFile=join(config.roots.codex,'hooks.json');
 const codex=JSON.parse(readFileSync(codexFile,'utf8'));codex.hooks.Stop[0].hooks[0].async=false;
 writeFileSync(codexFile,JSON.stringify(codex));
 await installCapture(f.api,{home:f.dir,command:[process.execPath,cli],harnesses:['claude-code']});
 expect(JSON.parse(readFileSync(codexFile,'utf8')).hooks.Stop[0].hooks[0].async).toBe(true);
}));


test('owned worker deadline interrupts an infinite notice-lock wait and preserves the notice',async()=>fixture(async f=>{
 await captureHook('claude-code',{session_id:'session',transcript_path:f.path,prompt:'retained deadline'});
 const before=readdirSync(join(captureDir(),'notices')).map(n=>readFileSync(join(captureDir(),'notices',n),'utf8'));
 let release!:()=>void;
 const held=withSessionLock('capture:notices',()=>new Promise<void>(r=>{release=r;}));
 const runtime=resolve(import.meta.dir,'../src/capture/runtime.ts');
 const child=Bun.spawn([process.execPath,'-e',`import {ownedCaptureWorker} from ${JSON.stringify(runtime)}; await ownedCaptureWorker({flushMs:0,maxMs:350,parentPollMs:25});`],{env:process.env,stdout:'ignore',stderr:'pipe'});
 try{
  expect(await child.exited).toBe(0);
  expect(readdirSync(join(captureDir(),'notices')).map(n=>readFileSync(join(captureDir(),'notices',n),'utf8'))).toEqual(before);
 }finally{child.kill();await child.exited;release();await held;}
 await captureWorker({flushMs:0,idleMs:20,pollMs:5});
 expect(captureStatus().queued).toBe(0);expect(captureStatus().pendingHooks).toBe(0);
}),5000);

test('owned worker deadline interrupts a lost acknowledgement and retries the exact durable bytes',async()=>fixture(async f=>{
 await captureHook('claude-code',{session_id:'session',transcript_path:f.path,prompt:'retained lost acknowledgement'});
 await drainCaptureNotices();
 const before=new Map(readdirSync(join(captureDir(),'queue')).map(n=>[n,readFileSync(join(captureDir(),'queue',n),'utf8')]));
 f.holdAck=true;
 const runtime=resolve(import.meta.dir,'../src/capture/runtime.ts');
 const child=Bun.spawn([process.execPath,'-e',`import {ownedCaptureWorker} from ${JSON.stringify(runtime)}; await ownedCaptureWorker({flushMs:0,maxMs:600,parentPollMs:25});`],{env:process.env,stdout:'ignore',stderr:'pipe'});
 try{
  await until(()=>f.payloads.length>0);
  expect(await child.exited).toBe(0);
  for(const [name,bytes] of before)expect(readFileSync(join(captureDir(),'queue',name),'utf8')).toBe(bytes);
  f.holdAck=false;
  appendFileSync(f.path,f.record('new-during-retry'));
  await captureWorker({flushMs:0,idleMs:20,pollMs:5});
  expect(f.payloads.filter((v:string)=>v===f.payloads[0])).toHaveLength(2);
  expect(f.batches.flatMap((b:any)=>b.events).filter((e:any)=>e.nativeId==='new-during-retry')).toHaveLength(1);
  expect(captureStatus().queued).toBe(0);
 }finally{child.kill();await child.exited;}
}),5000);


test('large synchronous transcript backlogs yield to the owned process deadline and resume intact',async()=>fixture(async f=>{
 const records=Array.from({length:16000},(_,n)=>JSON.stringify({type:'user',uuid:'cpu-'+n,sessionId:'session',message:{role:'user',content:'synthetic '+n+' '+'.'.repeat(1000)}})+'\n').join('');
 writeFileSync(f.path,records);
 await captureHook('claude-code',{session_id:'session',transcript_path:f.path,prompt:'cpu deadline'});
 const runtime=resolve(import.meta.dir,'../src/capture/runtime.ts');
 const child=Bun.spawn([process.execPath,'-e',`import {ownedCaptureWorker} from ${JSON.stringify(runtime)}; await ownedCaptureWorker({flushMs:0,maxMs:100,parentPollMs:25});`],{env:process.env,stdout:'ignore',stderr:'pipe'});
 try{
  expect(await child.exited).toBe(0);
  expect(captureStatus().pendingHooks).toBe(1);
  // A slow filesystem can consume the short deadline before the first batch.
  // The durable notice must remain, and resuming must still recover every record.
  await captureWorker({flushMs:0,idleMs:20,pollMs:5});
  const ids=new Set(f.batches.flatMap((b:any)=>b.events).filter((e:any)=>e.nativeId?.startsWith('cpu-')).map((e:any)=>e.nativeId));
  expect(ids.size).toBe(16000);expect(captureStatus().queued).toBe(0);expect(captureStatus().pendingHooks).toBe(0);
 }finally{child.kill();await child.exited;}
}),20000);

test('the default ten-second window records independently and combines a live burst',async()=>fixture(async f=>{
 await captureHook('claude-code',{session_id:'session',transcript_path:f.path,hook_event_name:'Stop'});
 const worker=captureWorker({idleMs:30,pollMs:10});
 try {
  await until(()=>existsSync(join(captureDir(),'live-window.json')));
  const deadline=JSON.parse(readFileSync(join(captureDir(),'live-window.json'),'utf8')).dueAt;
  expect(deadline-Date.now()).toBeGreaterThan(9500);
  for(let i=0;i<6;i++){
   appendFileSync(f.path,f.record('burst-'+i+'-a')+f.record('burst-'+i+'-b'));
   await captureHook('claude-code',{session_id:'session',transcript_path:f.path,hook_event_name:'PostToolUse'});
   await sleep(30);
  }
  await until(()=>captureStatus().pendingHooks===0);
  expect(captureStatus().queued).toBeGreaterThan(2);expect(f.payloads).toHaveLength(0);
  // Every record is already in OpenCrawl's independent durable queue. Removing
  // the original native transcript before the network window cannot lose it.
  rmSync(f.path);
  expect(JSON.parse(readFileSync(join(captureDir(),'live-window.json'),'utf8')).dueAt).toBe(deadline);
  await until(()=>f.payloads.length>0,12_000);
  expect(Date.now()).toBeGreaterThanOrEqual(deadline);
  await worker;
  expect(f.batches).toHaveLength(2);
  expect(f.batches.find((b:any)=>b.events.some((e:any)=>e.nativeId))?.events).toHaveLength(13);
  expect(f.batches.find((b:any)=>b.events.every((e:any)=>e.kind==='hook'))?.events).toHaveLength(7);
  expect(captureStatus().pendingHooks).toBe(0);expect(captureStatus().queued).toBe(0);
 }finally{await worker;}
}),15000);

test('continued activity cannot extend a live flush deadline',async()=>fixture(async f=>{
 await captureHook('claude-code',{session_id:'session',transcript_path:f.path});
 const start=Date.now(),worker=captureWorker({flushMs:150,idleMs:30,pollMs:5});
 let appended=0;
 const writer=setInterval(()=>{appendFileSync(f.path,f.record('sustained-'+appended++));},20);
 try {
  await until(()=>f.payloads.length>0);
  expect(Date.now()-start).toBeLessThan(500);
  expect(appended).toBeGreaterThan(1);
  await sleep(200);
 }finally{clearInterval(writer);await worker;}
 const ids=new Set(f.batches.flatMap((b:any)=>b.events).filter((e:any)=>e.nativeId?.startsWith('sustained-')).map((e:any)=>e.nativeId));
 expect(ids.size).toBe(appended);
}));

test('explicit flush bypasses a pending live window',async()=>fixture(async f=>{
 await captureHook('claude-code',{session_id:'session',transcript_path:f.path});
 const worker=captureWorker({flushMs:500,idleMs:20,pollMs:5});
 try {
  await until(()=>existsSync(join(captureDir(),'live-window.json')));
  const deadline=JSON.parse(readFileSync(join(captureDir(),'live-window.json'),'utf8')).dueAt;
  await flushCaptureWork();
  expect(Date.now()).toBeLessThan(deadline);
  expect(f.batches.flatMap((b:any)=>b.events).some((e:any)=>e.nativeId==='one')).toBe(true);
 }finally{await worker;}
}));

test('a killed pre-flush worker resumes the original deadline and all local records',async()=>fixture(async f=>{
 await captureHook('claude-code',{session_id:'session',transcript_path:f.path});
 const runtime=resolve(import.meta.dir,'../src/capture/runtime.ts');
 const child=Bun.spawn([process.execPath,'-e',`import {captureWorker} from ${JSON.stringify(runtime)};await captureWorker({flushMs:600,idleMs:20,pollMs:5});`],{env:process.env,stdout:'ignore',stderr:'pipe'});
 try {
  await until(()=>existsSync(join(captureDir(),'live-window.json')));
  const deadline=JSON.parse(readFileSync(join(captureDir(),'live-window.json'),'utf8')).dueAt;
  child.kill('SIGKILL');await child.exited;
  expect(f.payloads).toHaveLength(0);expect(captureStatus().queued).toBeGreaterThan(0);
  appendFileSync(f.path,f.record('after-crash'));
  // Restart's longer interval must not reset the deadline saved by its predecessor.
  const restarted=captureWorker({flushMs:5000,idleMs:20,pollMs:5});
  await until(()=>f.payloads.length>0,2000);await restarted;
  expect(Date.now()).toBeGreaterThanOrEqual(deadline);
  const ids=f.batches.flatMap((b:any)=>b.events).filter((e:any)=>e.nativeId).map((e:any)=>e.nativeId);
  expect(ids.sort()).toEqual(['after-crash','one']);
 }finally{child.kill();await child.exited;}
}));

test('an owned worker flushes its final local window before the hard process deadline',async()=>fixture(async f=>{
 await captureHook('claude-code',{session_id:'session',transcript_path:f.path});
 const runtime=resolve(import.meta.dir,'../src/capture/runtime.ts');
 const child=Bun.spawn([process.execPath,'-e',`import {ownedCaptureWorker} from ${JSON.stringify(runtime)};await ownedCaptureWorker({maxMs:1600,flushMs:1200,parentPollMs:25});`],{env:process.env,stdout:'ignore',stderr:'pipe'});
 try {
  await until(()=>f.payloads.length>0,1500);
  expect(await child.exited).toBe(0);
  expect(f.batches.flatMap((b:any)=>b.events).some((e:any)=>e.nativeId==='one')).toBe(true);
  expect(captureStatus().queued).toBe(0);
 }finally{child.kill();await child.exited;}
}));

test('restart after enqueue but before window persistence uses the original recording time',async()=>fixture(async f=>{
 await captureHook('claude-code',{session_id:'session',transcript_path:f.path});await drainCaptureNotices();
 const recordedAt=new Date(Date.now()-10_000);
 for(const name of readdirSync(join(captureDir(),'live')))utimesSync(join(captureDir(),'live',name),recordedAt,recordedAt);
 expect(existsSync(join(captureDir(),'live-window.json'))).toBe(false);
 const worker=captureWorker({flushMs:5000,idleMs:20,pollMs:5});
 await until(()=>f.payloads.length>0,500);await worker;
 expect(captureStatus().queued).toBe(0);
 expect(f.batches.flatMap((b:any)=>b.events).some((e:any)=>e.nativeId==='one')).toBe(true);
}));

test('sealing between another process enqueue and cursor commit preserves replay identities',async()=>fixture(async f=>{
 await captureHook('claude-code',{session_id:'session',transcript_path:f.path});
 const runtime=resolve(import.meta.dir,'../src/capture/runtime.ts'),marker=join(f.dir,'spooled-before-cursor');
 const code=`import {captureTranscript,readCaptureConfig} from ${JSON.stringify(runtime)};import {writeFileSync} from 'node:fs';await captureTranscript(readCaptureConfig(),'claude-code',${JSON.stringify(f.path)},{session_id:'session'},false,async()=>{writeFileSync(${JSON.stringify(marker)},'ready');await new Promise(()=>setInterval(()=>{},1000));});`;
 const child=Bun.spawn([process.execPath,'-e',code],{env:process.env,stdout:'ignore',stderr:'pipe'});
 try {
  await until(()=>existsSync(marker));
  // Upload ownership is independent of the source cursor lock. Seal/send while
  // the producer is paused immediately after its durable local enqueue.
  await flushCaptures();expect(f.batches).toHaveLength(1);
  const original=f.batches[0].events[0].id;
  child.kill('SIGKILL');await child.exited;
  appendFileSync(f.path,f.record('after-cursor-crash'));
  await captureWorker({flushMs:0,idleMs:20,pollMs:5});
  const events=f.batches.flatMap((b:any)=>b.events).filter((e:any)=>e.nativeId);
  expect(events.filter((e:any)=>e.nativeId==='one').map((e:any)=>e.id)).toEqual([original,original]);
  expect(new Set(events.map((e:any)=>e.id)).size).toBe(2);
  expect(events.filter((e:any)=>e.nativeId==='after-cursor-crash')).toHaveLength(1);
  expect(captureStatus().queued).toBe(0);expect(captureStatus().pendingHooks).toBe(0);
 }finally{child.kill();await child.exited;}
}));
