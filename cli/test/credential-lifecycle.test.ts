import {test,expect} from 'bun:test';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {saveSession,readSession,accessToken,withSessionLock} from '../src/session.ts';
import {installCapture,uninstallCapture} from '../src/capture/install.ts';
import {captureDir,captureHook,drainCaptureNotices,flushCaptures,readCaptureConfig} from '../src/capture/runtime.ts';
import {hash} from '../src/capture/parse.ts';
import {sealLiveBatches} from '../src/capture/live-batches.ts';

const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(condition:()=>boolean){const end=Date.now()+5000;while(!condition()){if(Date.now()>end)throw new Error('Credential lifecycle probe timed out');await sleep(10);}}
async function fixture(run:(f:any)=>Promise<void>){
 const directory=mkdtempSync(join(tmpdir(),'opencrawl-credential-lifecycle-')),saved={...process.env};
 let requests=0,rejections=0,delay=0,uploads=0,active='refresh-0',onRefresh=()=>{},stallBody=false,refreshGate:Promise<void>|undefined;
 const owner={tenantId:'fixture',userId:'fixture'};
 const server=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks).toString();
  if(req.url==='/token'){
   requests++;
   if(new URLSearchParams(body).get('refresh_token')!==active){rejections++;res.statusCode=400;res.end(JSON.stringify({error:'invalid_grant'}));return;}
   active='refresh-'+requests;onRefresh();
   if(stallBody){res.writeHead(200);res.write('{"access_token":');return;}
   await sleep(delay);await refreshGate;
   res.end(JSON.stringify({access_token:'access-'+requests,refresh_token:active,expires_in:3600}));return;
  }
  if(req.url==='/api/sessions/identity'){res.end(JSON.stringify({data:{principal:owner}}));return;}
  if(req.url==='/api/sessions/batches'){uploads++;res.end(JSON.stringify({data:{stored:true,batchId:hash(body)}}));return;}
  res.statusCode=404;res.end('{}');
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const api='http://127.0.0.1:'+(server.address() as any).port;
 try{
  for(const key of ['OPENCRAWL_TOKEN','OPENCRAWL_SESSIONS_TOKEN','OPENCRAWL_AUTH','CLAUDE_CODE_REMOTE'])delete process.env[key];
  Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(directory,'config'),OPENCRAWL_API_URL:api,OPENCRAWL_NO_UPDATE:'1',CLAUDE_CONFIG_DIR:join(directory,'claude'),CODEX_HOME:join(directory,'codex')});
  const session={auth:{clientId:'fixture',tokenEndpoint:api+'/token',deviceAuthorizationEndpoint:api+'/device'},accessToken:'access-0',refreshToken:'refresh-0',expiresAt:0};
  await saveSession(api,session);
  await run({directory,api,session,get requests(){return requests;},get rejections(){return rejections;},get uploads(){return uploads;},set delay(value:number){delay=value;},set onRefresh(value:()=>void){onRefresh=value;},set stallBody(value:boolean){stallBody=value;},set refreshGate(value:Promise<void>|undefined){refreshGate=value;}});
 }finally{
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);
  rmSync(directory,{recursive:true,force:true});
 }
}

test('cancellation after a one-use refresh was sent saves its reply before stopping',async()=>fixture(async f=>{
 const controller=new AbortController();f.delay=120;f.onRefresh=()=>controller.abort(new Error('Caller stopped'));
 await expect(accessToken(f.api,undefined,fetch,controller.signal)).rejects.toThrow('Caller stopped');
 expect(readSession(f.api)).toMatchObject({accessToken:'access-1',refreshToken:'refresh-1'});
 expect(await accessToken(f.api)).toBe('access-1');expect(f.requests).toBe(1);expect(f.rejections).toBe(0);
}));

test('cancellation before dispatch or while waiting for the credential lock never rotates',async()=>fixture(async f=>{
 const cancelled=AbortSignal.abort(new Error('Already stopped'));
 await expect(accessToken(f.api,undefined,fetch,cancelled)).rejects.toThrow('Already stopped');
 let release=()=>{},locked=false;const held=withSessionLock(f.api,()=>new Promise<void>(resolve=>{release=resolve;locked=true;}));
 await until(()=>locked);
 try{
  const controller=new AbortController(),pending=accessToken(f.api,undefined,fetch,controller.signal);controller.abort();
  await expect(pending).rejects.toMatchObject({name:'AbortError'});expect(f.requests).toBe(0);
 }finally{release();await held;}
}));

test('shutdown waits for every concurrent deployment rotation and fences new work',async()=>fixture(async f=>{
 const apis=['https://first.example','https://second.example'];
 for(const [index,api]of apis.entries())await saveSession(api,{...f.session,auth:{...f.session.auth,tokenEndpoint:api+'/token'},refreshToken:'refresh-'+index});
 const session=resolve(import.meta.dir,'../src/session.ts');
 const script=`import{accessToken,exitAfterCredentialRotation}from ${JSON.stringify(session)};
 let requests=0;
 const fetcher=async(input,init)=>{
  requests++;
  if(requests===2)setTimeout(()=>exitAfterCredentialRotation(0),20);
  const first=String(input).includes('first.example');await Bun.sleep(first?300:70);
  return Response.json({access_token:'next-access',refresh_token:'next-refresh',expires_in:3600});
 };
 await Promise.allSettled(${JSON.stringify(apis)}.map(api=>accessToken(api,undefined,fetcher).then(()=>{throw Error('work resumed during shutdown');})));
 `;
 const child=Bun.spawn([process.execPath,'-e',script],{env:process.env,stdout:'pipe',stderr:'pipe'});
 try{
  expect(await child.exited).toBe(0);
  for(const api of apis)expect(readSession(api)).toMatchObject({accessToken:'next-access',refreshToken:'next-refresh'});
 }finally{child.kill();await child.exited;}
}));

test('shutdown remains bounded when a refresh server sends headers but stalls its body',async()=>fixture(async f=>{
 f.stallBody=true;
 const session=resolve(import.meta.dir,'../src/session.ts');
 const script=`import{accessToken,exitAfterCredentialRotation}from ${JSON.stringify(session)};setTimeout(()=>exitAfterCredentialRotation(0),200);await accessToken(${JSON.stringify(f.api)}).catch(()=>{});`;
 const started=Date.now(),child=Bun.spawn([process.execPath,'-e',script],{env:process.env,stdout:'pipe',stderr:'pipe'});
 try{
  await until(()=>f.requests===1);expect(await child.exited).toBe(0);
  expect(Date.now()-started).toBeGreaterThanOrEqual(14_000);expect(Date.now()-started).toBeLessThan(20_000);
  expect(f.requests).toBe(1);
  // A server/network that never supplies its rotated secret remains ambiguous;
  // the client must not pretend to recover it or loop on the spent credential.
  expect(readSession(f.api)?.refreshToken).toBe('refresh-0');
 }finally{child.kill();await child.exited;}
}),22_000);

for(const termination of ['deadline','owner-exit'] as const)test(`capture ${termination} waits for rotated credentials and preserves its queued bytes`,async()=>fixture(async f=>{
 await saveSession(f.api,{...f.session,expiresAt:Date.now()+3600_000});
 await installCapture(f.api,{home:f.directory,command:[],harnesses:['claude-code']});
 const transcript=join(f.directory,'claude','projects','fixture','session.jsonl');mkdirSync(join(transcript,'..'),{recursive:true});
 writeFileSync(transcript,JSON.stringify({type:'user',uuid:'one',sessionId:'session',message:{role:'user',content:'Retained credential rotation fixture'}})+'\n');
 await captureHook('claude-code',{session_id:'session',transcript_path:transcript,prompt:'fixture'});await drainCaptureNotices();
 const queue=join(captureDir(),'queue'),original=readdirSync(queue).map(name=>JSON.parse(readFileSync(join(queue,name),'utf8'))),config=readCaptureConfig()!;
 const originalIds=original.flatMap(batch=>batch.events.map((event:any)=>event.id)).sort();expect(originalIds.length).toBeGreaterThan(0);
 // This case tests immutable retry bytes after the normal pre-HTTP live seal.
 // Sealing may combine the newly live hook and transcript but must lose nothing.
 await withSessionLock('capture:flush',async()=>sealLiveBatches(captureDir()));
 const before=new Map(readdirSync(queue).map(name=>[name,readFileSync(join(queue,name),'utf8')])),sealed=[...before.values()].map(bytes=>JSON.parse(bytes));
 expect(before.size).toBeGreaterThan(0);
 const sealedIds=sealed.flatMap(batch=>batch.events.map((event:any)=>event.id)).sort();
 expect(sealedIds).toHaveLength(originalIds.length);expect(sealedIds).toEqual(originalIds);
 for(const batch of [...original,...sealed]){expect(batch.owner).toEqual(config.owner);expect(batch.installationId).toBe(config.installationId);}
 await saveSession(f.api,f.session);f.delay=700;
 let releaseRefresh=()=>{};
 if(termination==='owner-exit')f.refreshGate=new Promise<void>(resolve=>{releaseRefresh=resolve;});
 const runtime=resolve(import.meta.dir,'../src/capture/runtime.ts'),output=join(f.directory,'worker-exit.json'),childLog=join(f.directory,'child.log');
 const code=`import{ownedCaptureWorker}from ${JSON.stringify(runtime)};import{writeFileSync}from'node:fs';process.on('exit',code=>writeFileSync(${JSON.stringify(output)},JSON.stringify({code})));await ownedCaptureWorker({flushMs:0,maxMs:${termination==='deadline'?300:30_000},parentPollMs:20});`;
 let pid:number|undefined,child:ReturnType<typeof Bun.spawn>|undefined;
 try{
  if(termination==='deadline'){
   child=Bun.spawn([process.execPath,'-e',code],{env:process.env,stdout:'ignore',stderr:'pipe'});pid=child.pid;
  }else{
   const pidFile=join(f.directory,'worker.pid'),releaseFile=join(f.directory,'release-parent');
   // Windows otherwise puts the worker in a kill-on-close Job Object: parent
   // exit would hard-kill it before the cooperative owner check can run.
   const parent=`import{spawn}from'node:child_process';import{writeFileSync,existsSync,openSync}from'node:fs';const fd=openSync(${JSON.stringify(childLog)},'w');const child=spawn(${JSON.stringify(process.execPath)},['-e',${JSON.stringify(code)}],{env:process.env,detached:process.platform==='win32',stdio:['ignore',fd,fd]});writeFileSync(${JSON.stringify(pidFile)},String(child.pid));child.unref();const timer=setInterval(()=>{if(existsSync(${JSON.stringify(releaseFile)})){clearInterval(timer);process.exit(0);}},10);`;
   child=Bun.spawn([process.execPath,'-e',parent],{env:process.env,stdout:'ignore',stderr:'pipe'});
   await until(()=>existsSync(pidFile));pid=Number(readFileSync(pidFile,'utf8'));
   await until(()=>f.requests===1);writeFileSync(releaseFile,'exit');expect(await child.exited).toBe(0);
   await sleep(50);expect(()=>process.kill(pid!,0)).not.toThrow();expect(existsSync(output)).toBe(false);releaseRefresh();
  }
  await until(()=>existsSync(output));
  expect(JSON.parse(readFileSync(output,'utf8')).code).toBe(0);
  if(termination==='deadline')expect(await child!.exited).toBe(0);
  expect(readSession(f.api)).toMatchObject({accessToken:'access-1',refreshToken:'refresh-1'});
  expect(f.uploads).toBe(0);
  for(const [name,bytes]of before)expect(readFileSync(join(queue,name),'utf8')).toBe(bytes);
  f.delay=0;await flushCaptures({wait:false});expect(f.requests).toBe(1);expect(f.rejections).toBe(0);expect(f.uploads).toBe(before.size);
 }catch(error){
  let alive=false;try{if(pid){process.kill(pid,0);alive=true;}}catch{}
  throw new Error('Credential lifecycle child failed: '+JSON.stringify({termination,pid,alive,exited:existsSync(output),log:existsSync(childLog)?readFileSync(childLog,'utf8'):''}),{cause:error});
 }finally{
  releaseRefresh();if(pid)try{process.kill(pid,'SIGKILL');}catch{}if(child){child.kill();await child.exited;}
  await uninstallCapture(f.directory);
 }
}),10_000);
