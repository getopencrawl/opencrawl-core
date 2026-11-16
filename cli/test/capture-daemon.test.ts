import {test,expect,setDefaultTimeout} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,appendFileSync,existsSync,readdirSync,rmSync,realpathSync,symlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {installCapture,uninstallCapture} from '../src/capture/install.ts';
import {recordDaemonHook,runCaptureDaemon,daemonDir} from '../src/capture/daemon.ts';
import {captureDir,readCaptureConfig} from '../src/capture/runtime.ts';
import {purgeLocalCapture} from '../src/capture/controls.ts';
import {hash} from '../src/capture/parse.ts';

const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
setDefaultTimeout(15_000);
// Every case gets its own process and an empty fallback profile before imports
// or test cleanup run. A timeout cannot restore another case's environment.
function isolatedTest(name:string,run:()=>Promise<void>,timeout=15_000){
  test(name,async()=>{
    if(process.env.OPENCRAWL_DAEMON_CASE===name){await run();return;}
    const fallback=mkdtempSync(join(tmpdir(),'opencrawl-daemon-case-'));
    const child=Bun.spawn([process.execPath,'test',import.meta.path,'-t',name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')],{env:{...process.env,OPENCRAWL_DAEMON_CASE:name,OPENCRAWL_CONFIG_HOME:join(fallback,'config'),CLAUDE_CONFIG_DIR:join(fallback,'claude'),CODEX_HOME:join(fallback,'codex'),CURSOR_CONFIG_DIR:join(fallback,'cursor'),ANTIGRAVITY_HOME:join(fallback,'agy')},stdout:'pipe',stderr:'pipe'});
    try{const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);if(code!==0)throw Error(stdout+stderr);}
    finally{child.kill();await child.exited;rmSync(fallback,{recursive:true,force:true});}
  },timeout);
}
async function until(check:()=>boolean,ms=5000){const end=Date.now()+ms;while(!check()){if(Date.now()>end)throw Error('Condition timed out');await sleep(10);}}
async function fixture(run:(f:any)=>Promise<void>){
  const dir=mkdtempSync(join(tmpdir(),'opencrawl-daemon-')),env={...process.env},batches:any[]=[],raws:string[]=[];
  let fail=false,loseAck=false,hold=false,requests=0;const held:Array<()=>void>=[];
  const server=createServer(async(req,res)=>{
    requests++;
    if(req.url==='/api/sessions/identity'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:{principal:{tenantId:'fixture',userId:'fixture'}}}));return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks).toString();
    if(req.url==='/api/sessions/batches'){
      raws.push(raw);
      if(hold)await new Promise<void>(done=>held.push(done));
      if(fail){res.writeHead(500,{'content-type':'application/json'});res.end('{}');return;}
      batches.push(JSON.parse(raw));
      if(loseAck){loseAck=false;res.writeHead(500,{'content-type':'application/json'});res.end('{}');return;}
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:{stored:true,batchId:hash(raw)}}));return;
    }
    res.writeHead(404);res.end();
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const api='http://127.0.0.1:'+(server.address() as any).port;
  let controller:AbortController|undefined,worker:Promise<void|undefined>|undefined;
  try{
    Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(dir,'config'),OPENCRAWL_API_URL:api,OPENCRAWL_SESSIONS_TOKEN:'synthetic-daemon-token',CLAUDE_CONFIG_DIR:join(dir,'claude'),CODEX_HOME:join(dir,'codex'),OPENCRAWL_NO_UPDATE:'1'});
    delete process.env.CLAUDE_CODE_REMOTE;
    await installCapture(api,{home:dir,command:[],harnesses:['claude-code'],daemon:true,daemonService:false});
    const path=join(dir,'claude','projects','fixture','session.jsonl');mkdirSync(dirname(path),{recursive:true});
    const record=(id:string,child?:string)=>JSON.stringify({type:'user',uuid:id,sessionId:'session',...(child?{agentId:child}:{}),message:{role:'user',content:'synthetic '+id}})+'\n';
    writeFileSync(path,record('one'));
    const start=async(options={})=>{controller=new AbortController();let ready=false;worker=runCaptureDaemon({signal:controller.signal,flushMs:20,reconcileMs:100,settleMs:40,retryMs:60,onReady:()=>{ready=true;},...options});await until(()=>ready);};
    const stop=async()=>{controller?.abort();await worker;};
    const event=(name='SessionStart',pid=process.pid)=>recordDaemonHook({session_id:'session',transcript_path:path,hook_event_name:name,cwd:dir},pid);
    await run({dir,api,path,record,batches,raws,start,stop,event,get requests(){return requests;},set fail(v:boolean){fail=v;},set loseAck(v:boolean){loseAck=v;},set hold(v:boolean){hold=v;if(!v)for(const done of held.splice(0))done();}});
  }finally{
    hold=false;for(const done of held.splice(0))done();controller?.abort();await worker;if(process.env.OPENCRAWL_CONFIG_HOME===join(dir,'config'))await uninstallCapture(dir);
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);rmSync(dir,{recursive:true,force:true});
  }
}
import {dirname} from 'node:path';

isolatedTest('Claude installs two async capture hooks and preserves unrelated hooks',async()=>fixture(async f=>{
  const hooks=JSON.parse(readFileSync(join(f.dir,'claude','settings.json'),'utf8')).hooks;
  expect(Object.keys(hooks).sort()).toEqual(['SessionEnd','SessionStart']);
  for(const group of Object.values(hooks) as any[])expect(group[0].hooks[0]).toMatchObject({async:true,timeout:10});
  hooks.SessionStart.push({hooks:[{type:'command',command:'echo unrelated',timeout:10}]});
  writeFileSync(join(f.dir,'claude','settings.json'),JSON.stringify({hooks}));
  await installCapture(f.api,{home:f.dir,command:[],harnesses:['claude-code'],daemon:true,daemonService:false});
  expect(JSON.parse(readFileSync(join(f.dir,'claude','settings.json'),'utf8')).hooks.SessionStart.some((group:any)=>group.hooks.some((hook:any)=>hook.command==='echo unrelated'))).toBe(true);
}));

isolatedTest('actual CLI hook records locally and exits without waiting for upload',async()=>fixture(async f=>{
  f.hold=true;f.event();await f.start();await until(()=>f.raws.length>0);
  appendFileSync(f.path,f.record('while-request-blocked'));
  const start=performance.now();
  const child=Bun.spawn([process.execPath,resolve(import.meta.dir,'../src/cli.ts'),'collect','hook','--daemon','--harness','claude-code'],{env:process.env,stdin:new Blob([JSON.stringify({session_id:'session',transcript_path:f.path,hook_event_name:'SessionStart'})]),stdout:'pipe',stderr:'pipe'});
  const [exit,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()]);
  expect(stderr).toBe('');expect(exit).toBe(0);expect(performance.now()-start).toBeLessThan(1000);
  const state=join(captureDir(),'state',hash('claude-code'+realpathSync(f.path))+'.json');
  await until(()=>JSON.parse(readFileSync(state,'utf8')).offset===Buffer.byteLength(readFileSync(f.path)));
  expect(f.batches).toHaveLength(0);f.hold=false;
}));

isolatedTest('an unfinished final record remains registered until its newline arrives',async()=>fixture(async f=>{
  f.event();await f.start();await until(()=>f.batches.length>0);
  const line=f.record('late-complete');appendFileSync(f.path,line.slice(0,-1));f.event('SessionEnd');
  await sleep(250);expect(readdirSync(join(daemonDir(),'sessions'))).toHaveLength(1);
  appendFileSync(f.path,'\n');await until(()=>f.batches.some((batch:any)=>batch.events.some((event:any)=>event.nativeId==='late-complete')));
  await until(()=>readdirSync(join(daemonDir(),'sessions')).length===0);
}));

isolatedTest('a destination change stops the daemon and preserves the original queued author',async()=>fixture(async f=>{
  f.fail=true;f.event();await f.start();await until(()=>f.raws.length>0);
  const config=readCaptureConfig()!,file=join(captureDir(),'config.json');
  writeFileSync(file,JSON.stringify({...config,owner:{...config.owner,tenantId:'different'}}));
  await until(()=>JSON.parse(readFileSync(join(daemonDir(),'status.json'),'utf8')).state==='stopped');
  expect(readdirSync(join(captureDir(),'queue')).length).toBeGreaterThan(0);
  for(const name of readdirSync(join(captureDir(),'queue')))expect(JSON.parse(readFileSync(join(captureDir(),'queue',name),'utf8')).owner.tenantId).toBe('fixture');
}));

isolatedTest('worker captures only registered session and its subagents, including files created later',async()=>fixture(async f=>{
  // The old 2,345-entry registry and unrelated native history must never be visited.
  mkdirSync(join(captureDir(),'sources'),{recursive:true});
  for(let n=0;n<2345;n++)writeFileSync(join(captureDir(),'sources',n+'.json'),'not even valid JSON');
  writeFileSync(join(dirname(f.path),'unregistered.jsonl'),'not valid JSON either');
  f.event();await f.start();await until(()=>f.batches.some((b:any)=>b.events.some((e:any)=>e.nativeId==='one')));
  const child=join(f.path.slice(0,-6),'subagents','agent-child.jsonl');mkdirSync(dirname(child),{recursive:true});writeFileSync(child,f.record('child-one','child'));
  appendFileSync(f.path,f.record('two'));
  await until(()=>f.batches.some((b:any)=>b.sessionId==='session:child'));
  f.event('SessionEnd');appendFileSync(f.path,f.record('last'));
  await until(()=>readdirSync(join(daemonDir(),'sessions')).length===0);
  await until(()=>readdirSync(join(captureDir(),'queue')).length===0);
  expect(new Set(f.batches.flatMap((b:any)=>b.events).map((e:any)=>e.nativeId))).toEqual(new Set(['one','two','last','child-one']));
  const requests=f.requests;await sleep(200);expect(f.requests).toBe(requests);
}));

isolatedTest('offline upload does not stop recording; restart preserves retry bytes and original destination',async()=>fixture(async f=>{
  f.fail=true;f.event();await f.start();await until(()=>f.raws.length>0);
  const first=f.raws[0];appendFileSync(f.path,f.record('while-offline'));
  const state=join(captureDir(),'state',hash('claude-code'+realpathSync(f.path))+'.json');
  await until(()=>existsSync(state)&&JSON.parse(readFileSync(state,'utf8')).offset===Buffer.byteLength(readFileSync(f.path)));
  await f.stop();expect(readdirSync(join(captureDir(),'queue')).length).toBeGreaterThan(0);
  f.fail=false;await f.start();await until(()=>readdirSync(join(captureDir(),'queue')).length===0);
  expect(f.raws.filter((raw:string)=>raw===first).length).toBeGreaterThanOrEqual(2);
  expect(new Set(f.batches.flatMap((b:any)=>b.events).map((e:any)=>e.nativeId))).toEqual(new Set(['one','while-offline']));
}));

isolatedTest('a saved registration cannot cross destinations before the first upload',async()=>fixture(async f=>{
  f.event();
  const file=join(captureDir(),'config.json'),original=readCaptureConfig()!;
  writeFileSync(file,JSON.stringify({...original,owner:{tenantId:'different',userId:'different'}}));
  await expect(installCapture(f.api,{home:f.dir,command:[],harnesses:['claude-code'],daemon:true,daemonService:false})).rejects.toMatchObject({code:'CAPTURE_PENDING_DESTINATION'});
  await f.start();await sleep(200);await f.stop();
  expect(f.raws).toHaveLength(0);expect(readdirSync(join(daemonDir(),'inbox')).some(name=>name.endsWith('.held'))).toBe(true);
  await uninstallCapture(f.dir);await purgeLocalCapture(true);expect(existsSync(daemonDir())).toBe(false);
}));

isolatedTest('a damaged registration cannot stop a healthy session',async()=>fixture(async f=>{
  f.event();writeFileSync(join(daemonDir(),'inbox','damaged.json'),'{');
  await f.start();await until(()=>f.batches.length>0);
  expect(existsSync(join(daemonDir(),'inbox','damaged.json.held'))).toBe(true);
}));

isolatedTest('a symlinked subagent directory is never traversed',async()=>fixture(async f=>{
  const outside=join(f.dir,'unrelated');mkdirSync(join(outside,'subagents'),{recursive:true});
  writeFileSync(join(outside,'subagents','agent-foreign.jsonl'),f.record('must-not-read','foreign'));
  symlinkSync(outside,f.path.slice(0,-6),process.platform==='win32'?'junction':'dir');
  f.event('SessionStart',2_147_483_647);await f.start();await until(()=>f.batches.length>0);
  await until(()=>readdirSync(join(daemonDir(),'sessions')).length===0);
  expect(f.batches.flatMap((batch:any)=>batch.events).map((event:any)=>event.nativeId)).toEqual(['one']);
}));

isolatedTest('lost acknowledgement retries identical payload and process-exit recovery needs no SessionEnd',async()=>fixture(async f=>{
  f.loseAck=true;f.event('SessionStart',2_147_483_647);await f.start();
  await until(()=>f.raws.length>=2);
  expect(f.raws[1]).toBe(f.raws[0]);
  await until(()=>readdirSync(join(daemonDir(),'sessions')).length===0);
  await until(()=>readdirSync(join(captureDir(),'queue')).length===0);
}));

isolatedTest('idle daemon makes no network calls or repeated historical scans',async()=>fixture(async f=>{
  const before=f.requests;await f.start();await sleep(350);expect(f.requests).toBe(before);
  await f.stop();const status=JSON.parse(readFileSync(join(daemonDir(),'status.json'),'utf8'));
  expect(status).toMatchObject({captures:0,sessionChecks:0,uploads:0});
}));

isolatedTest('kernel singleton and SIGKILL preserve registration and upload recovery',async()=>fixture(async f=>{
  f.event();f.fail=true;
  const module=resolve(import.meta.dir,'../src/capture/daemon.ts');
  const child=Bun.spawn([process.execPath,'-e',`import {runCaptureDaemon} from ${JSON.stringify(module)};await runCaptureDaemon({flushMs:10,reconcileMs:100,retryMs:100});`],{env:process.env,stdout:'ignore',stderr:'pipe'});
  try{
    await until(()=>f.raws.length>0);let duplicateReady=false;
    await runCaptureDaemon({onReady:()=>{duplicateReady=true;}});expect(duplicateReady).toBe(false);
    child.kill('SIGKILL');await child.exited;
    appendFileSync(f.path,f.record('after-crash'));f.fail=false;
    await f.start();await until(()=>f.batches.some((b:any)=>b.events.some((e:any)=>e.nativeId==='after-crash')));
    await until(()=>readdirSync(join(captureDir(),'queue')).length===0);
    expect(f.batches.flatMap((b:any)=>b.events).some((e:any)=>e.nativeId==='one')).toBe(true);
  }finally{child.kill();await child.exited;}
}),10_000);
