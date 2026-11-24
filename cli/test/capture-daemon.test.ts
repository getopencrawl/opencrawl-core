import {test,expect,setDefaultTimeout,mock} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,appendFileSync,existsSync,readdirSync,rmSync,realpathSync,symlinkSync,utimesSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {createServer} from 'node:http';
import {installCapture,uninstallCapture} from '../src/capture/install.ts';
import {recordDaemonHook,runCaptureDaemon,daemonDir} from '../src/capture/daemon.ts';
import {captureDir,readCaptureConfig,spoolDaemonEvent,captureTranscript,captureStatus,flushCaptureWork,syncCaptures,captureCursorNotice} from '../src/capture/runtime.ts';
import {purgeLocalCapture} from '../src/capture/controls.ts';
import {hash} from '../src/capture/parse.ts';
import {randomUUID} from 'node:crypto';
import {atomicJson,withSessionLock} from '../src/session.ts';
import {recordNativeDaemonHook} from '../src/capture/daemon-handoff.ts';
import {Database} from 'bun:sqlite';
import {statePath,scopeKey} from '../src/setup/state.ts';
import {processSessionStartTask,startupObservation} from '../src/session-start-task.ts';

const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
setDefaultTimeout(15_000);
// Every case gets its own process and an empty fallback profile before imports
// or test cleanup run. A timeout cannot restore another case's environment.
function isolatedTest(name:string,run:()=>Promise<void>,timeout=15_000){
  test(name,async()=>{
    if(process.env.OPENCRAWL_DAEMON_CASE===name){await run();return;}
    const fallback=realpathSync(mkdtempSync(join(tmpdir(),'opencrawl-daemon-case-')));
    const child=Bun.spawn([process.execPath,'test',import.meta.path,'-t',name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')],{env:{...process.env,HOME:fallback,USERPROFILE:fallback,OPENCRAWL_AUTH:'',OPENCRAWL_TOKEN:'',OPENCRAWL_SESSIONS_TOKEN:'',OPENCRAWL_DAEMON_CASE:name,OPENCRAWL_CONFIG_HOME:join(fallback,'config'),CLAUDE_CONFIG_DIR:join(fallback,'claude'),CODEX_HOME:join(fallback,'codex'),CURSOR_CONFIG_DIR:join(fallback,'cursor'),ANTIGRAVITY_HOME:join(fallback,'agy')},stdout:'pipe',stderr:'pipe'});
    try{const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);if(code!==0)throw Error(stdout+stderr);}
    finally{child.kill();await child.exited;rmSync(fallback,{recursive:true,force:true});}
  },timeout);
}
async function until(check:()=>boolean,ms=5000){const end=Date.now()+ms;while(!check()){if(Date.now()>end)throw Error('Condition timed out');await sleep(10);}}
async function fixture(run:(f:any)=>Promise<void>){
  const dir=mkdtempSync(join(tmpdir(),'opencrawl-daemon-')),env={...process.env},batches:any[]=[],raws:string[]=[];
  let fail=false,loseAck=false,hold=false,requests=0;const held:Array<()=>void>=[];
  let recording:(()=>object)|undefined;
  const server=createServer(async(req,res)=>{
    requests++;
    if(req.url==='/api/sessions/identity'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:{principal:{tenantId:'fixture',userId:'fixture'},capabilities:{harnesses:['cursor','antigravity']},recording:recording?.()}}));return;}
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
    // Most handoff tests explicitly resume an otherwise inactive native chat.
    // Separate discovery cases below create their files after enrollment.
    const inactive=new Date(Date.now()-60_000);utimesSync(path,inactive,inactive);
    const start=async(options={})=>{controller=new AbortController();let ready=false;worker=runCaptureDaemon({signal:controller.signal,flushMs:20,reconcileMs:100,settleMs:40,retryMs:60,onReady:()=>{ready=true;},...options});await until(()=>ready);};
    const stop=async()=>{controller?.abort();await worker;};
    const event=(name='SessionStart',pid=process.pid)=>recordDaemonHook({session_id:'session',transcript_path:path,hook_event_name:name,cwd:dir},pid);
    await run({dir,api,path,record,batches,raws,start,stop,event,get requests(){return requests;},set recording(v:()=>object){recording=v;},set fail(v:boolean){fail=v;},set loseAck(v:boolean){loseAck=v;},set hold(v:boolean){hold=v;if(!v)for(const done of held.splice(0))done();}});
  }finally{
    hold=false;for(const done of held.splice(0))done();controller?.abort();await worker;
    // Service fixtures write only here; remove fake plists before ordinary teardown
    // so even a failed assertion cannot invoke the real launchctl boundary.
    const fakeAgents=join(dir,'Library','LaunchAgents');if(existsSync(fakeAgents))rmSync(fakeAgents,{recursive:true,force:true});
    // Injected service fixtures never installed an OS service. A retained fake
    // receipt must not make ordinary teardown invoke the real supervisor.
    const fakeService=join(dir,'config','opencrawl','capture','daemon','service.json');if(existsSync(fakeService))rmSync(fakeService);
    if(process.env.OPENCRAWL_CONFIG_HOME===join(dir,'config'))await uninstallCapture(dir);
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);rmSync(dir,{recursive:true,force:true});
  }
}
import {dirname} from 'node:path';

isolatedTest('paused uploader checks only for queued work and wakes at a timed deadline',async()=>fixture(async f=>{
  const config=readCaptureConfig()!,queue=join(captureDir(),'queue');
  // The server clock is ahead of this laptop. Use its reported time to schedule expiry.
  const observed=Date.now()+3_600_000,from=observed-1000,untilTime=observed+400;
  let paused=true,revision=randomUUID(),checks=0;
  f.recording=()=>{
    checks++;
    return {revision,paused,observedAt:observed,until:paused?untilTime:null,windows:[[from,untilTime]]};
  };
  function enqueue(id:string,time:number){
    const body=JSON.stringify({schemaVersion:1,owner:config.owner,installationId:config.installationId,sessionId:'poll',
      harness:'claude-code',origin:'cli',events:[{id,kind:'message',timestamp:new Date(time).toISOString(),data:{text:id}}],attachments:[]});
    atomicJson(join(queue,hash(body)+'.json'),JSON.parse(body));
  }
  const initialRequests=f.requests;
  await f.start();
  enqueue('private',from);
  await until(()=>checks===1 && readdirSync(queue).length===0);
  await sleep(550);
  expect(f.requests).toBe(initialRequests+1);
  enqueue('before',from-1);
  await until(()=>checks===2);
  enqueue('after',untilTime+1);
  await sleep(80);
  expect(f.requests).toBe(initialRequests+2);
  paused=false;revision=randomUUID();
  await until(()=>f.batches.length===2,2500);
  expect(checks).toBe(3);
  expect(f.raws.join('')).not.toContain('"private"');
}));

isolatedTest('the daemon discovers four selected native chats without hooks and resumes after downtime',async()=>fixture(async f=>{
  const harnesses=['codex','claude-code','antigravity','cursor'] as const;
  await installCapture(f.api,{home:f.dir,command:[],harnesses:[...harnesses],selectionMode:'replace',hookOwnership:'plugin',daemon:true,daemonService:false});
  const c=readCaptureConfig()!,id=randomUUID();
  const paths={
    codex:join(c.roots.codex,'sessions','2026','11','24','rollout-2026-11-24T12-00-00-'+id+'.jsonl'),
    'claude-code':join(c.roots['claude-code'],'projects','project',id+'.jsonl'),
    antigravity:join(c.roots.antigravity!,'antigravity-cli','brain',id,'.system_generated','logs','transcript_full.jsonl'),
    cursor:join(c.roots.cursor!,'projects','project','agent-transcripts',id,id+'.jsonl')
  };
  const writeTurn=(n:number)=>{
    for(const h of harnesses){
      const path=paths[h],text='hook-free turn '+n;
      mkdirSync(dirname(path),{recursive:true});
      const records=h==='codex'?[...(n===1?[{type:'session_meta',payload:{id,cwd:f.dir,source:'cli'}}]:[]),{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}}]:
        h==='claude-code'?[{uuid:'turn-'+n,sessionId:id,cwd:f.dir,type:'user',message:{role:'user',content:text}}]:
        h==='antigravity'?[{step_index:n,type:'USER_INPUT',source:'USER_EXPLICIT',status:'DONE',content:text}]:
        [{role:'user',message:{content:[{type:'text',text}]}}];
      for(const record of records)appendFileSync(path,JSON.stringify(record)+'\n');
    }
  };
  const observed=(n:number)=>harnesses.every(h=>f.batches.some((b:any)=>b.harness===h&&b.sessionId===id&&JSON.stringify(b.events).includes('hook-free turn '+n)));
  await f.start();writeTurn(1);await until(()=>observed(1));await f.stop();
  writeTurn(2);await f.start();await until(()=>observed(2));await f.stop();
  const count=f.batches.length;await f.start();await sleep(150);await f.stop();
  expect(f.batches.length).toBe(count);
  const stats=JSON.parse(readFileSync(join(daemonDir(),'status.json'),'utf8'));
  expect(stats.noticeReads).toBe(0);
  expect(f.batches.every((b:any)=>b.sessionId===id)).toBe(true);
}));

isolatedTest('hook-free Claude child activity recovers an idle parent and skips pre-selection content',async()=>fixture(async f=>{
  const line=(id:string,date:Date,child?:string)=>JSON.stringify({...JSON.parse(f.record(id,child)),timestamp:date.toISOString()})+'\n';
  const old=new Date(0);
  writeFileSync(f.path,line('before-selection',old));utimesSync(f.path,old,old);
  await f.start();await f.stop();
  const child=join(f.path.slice(0,-6),'subagents','agent-child.jsonl');
  mkdirSync(dirname(child),{recursive:true});
  writeFileSync(child,line('offline-child',new Date(),'child'));
  await f.start();await until(()=>f.batches.some((b:any)=>b.sessionId==='session:child'));await f.stop();
  expect(JSON.stringify(f.batches)).toContain('offline-child');
  expect(JSON.stringify(f.batches)).not.toContain('before-selection');
  expect(JSON.parse(readFileSync(join(daemonDir(),'status.json'),'utf8')).noticeReads).toBe(0);
}));

function nativeConfig(f:any,harness:'cursor'|'antigravity'|'codex'|'grok-bot'|'devin'){
  const config=readCaptureConfig()!;
  config.harnesses=[harness];config.roots[harness]=join(f.dir,harness);
  mkdirSync(config.roots[harness]!,{recursive:true});
  writeFileSync(join(captureDir(),'config.json'),JSON.stringify(config));
  return config;
}

isolatedTest('Cursor daemon preserves native tools and late transcript messages with no historical scan',async()=>fixture(async f=>{
  const config=nativeConfig(f,'cursor'),path=join(config.roots.cursor!,'projects','project','agent-transcripts','cursor-session','cursor-session.jsonl');
  mkdirSync(dirname(path),{recursive:true});
  const line=(role:string,text:string)=>JSON.stringify({role,message:{content:[{type:'text',text}]}})+'\n';
  writeFileSync(path,line('user','scoped cursor prompt'));
  const event=(name:string,rest={})=>recordNativeDaemonHook('cursor',{conversation_id:'cursor-session',workspace_roots:[f.dir],transcript_path:path,hook_event_name:name,...rest});
  event('beforeSubmitPrompt',{prompt:'scoped cursor prompt'});event('postToolUse',{tool_name:'read_file',tool_use_id:'tool-1',tool_input:{path:'fixture.txt'},tool_output:'native tool result'});
  await f.start();await until(()=>f.batches.some((batch:any)=>batch.events.some((event:any)=>event.kind==='tool_result')));
  appendFileSync(path,line('assistant','late cursor answer'));event('stop');
  await until(()=>JSON.stringify(f.batches).includes('late cursor answer'));await until(()=>readdirSync(join(daemonDir(),'sessions')).length===0);
  const events=f.batches.flatMap((batch:any)=>batch.events);
  expect(events.filter((event:any)=>event.kind==='message'&&event.data.role==='user')).toHaveLength(1);
  expect(events.find((event:any)=>event.kind==='tool_result').data).toMatchObject({call_id:'tool-1',output:'native tool result'});
  expect(existsSync(join(captureDir(),'sources'))?readdirSync(join(captureDir(),'sources')):[]).toHaveLength(0);
}));

isolatedTest('Antigravity watches the native full transcript and retains live tool verification evidence',async()=>fixture(async f=>{
  const config=nativeConfig(f,'antigravity'),path=join(config.roots.antigravity!,'antigravity-cli','brain','agy-session','.system_generated','logs','transcript.jsonl');
  mkdirSync(dirname(path),{recursive:true});
  const user=JSON.stringify({step_index:0,type:'USER_INPUT',source:'USER_EXPLICIT',status:'DONE',content:'<USER_REQUEST>\nAGY prompt\n</USER_REQUEST>'})+'\n';
  writeFileSync(path,user);
  const event=(name:string,rest={})=>recordNativeDaemonHook('antigravity',{conversationId:'agy-session',workspacePaths:[f.dir],transcriptPath:path,hookEventName:name,...rest});
  event('SessionStart');await f.start({settleMs:150});await until(()=>f.batches.length>0);
  event('PostToolUse',{stepIdx:1,toolCall:{name:'mcp_opencrawl_search_v1',args:{query:'fixture'}}});event('Stop',{fullyIdle:true});
  writeFileSync(join(dirname(path),'transcript_full.jsonl'),user+JSON.stringify({step_index:2,type:'PLANNER_RESPONSE',source:'MODEL',status:'DONE',content:'full AGY answer'})+'\n');
  await until(()=>JSON.stringify(f.batches).includes('full AGY answer'));await until(()=>readdirSync(join(daemonDir(),'sessions')).length===0);
  // Session retirement settles local reads; the independent upload lane may still have queued hooks.
  await until(()=>f.batches.some((batch:any)=>batch.events.some((event:any)=>event.kind==='hook'&&event.data.hookEventName==='PostToolUse')));
  const tools=f.batches.filter((batch:any)=>batch.events.some((event:any)=>event.kind==='hook'&&event.data.hookEventName==='PostToolUse'));
  expect(tools.length).toBeGreaterThan(0);expect(tools.every((batch:any)=>batch.captureMode==='live')).toBe(true);
}));

isolatedTest('Codex resolves only indexed native session and child identities without a transcript catalog',async()=>fixture(async f=>{
  const config=nativeConfig(f,'codex'),root=config.roots.codex,db=new Database(join(root,'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT, name TEXT, updated_at INTEGER, source TEXT)');
  const source=(id:string,parent?:string)=>{
    const path=join(root,'sessions','2026','11','16','rollout-2026-11-16-'+id+'.jsonl');mkdirSync(dirname(path),{recursive:true});
    writeFileSync(path,JSON.stringify({type:'session_meta',payload:{id,cwd:f.dir,source:parent?{subagent:{thread_spawn:{parent_thread_id:parent}}}:'cli'}})+'\n'+JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'native '+id}]}})+'\n');
    db.query('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)').run(id,path,'automatic','native title '+id,1794800000,parent?JSON.stringify({subagent:{thread_spawn:{parent_thread_id:parent}}}):'cli');return path;
  };
  source('parent');source('child','parent');source('unrelated');db.close();
  recordNativeDaemonHook('codex',{session_id:'parent',hook_event_name:'UserPromptSubmit',transcript_path:null,cwd:f.dir});
  recordNativeDaemonHook('codex',{session_id:'parent',hook_event_name:'SubagentStart',agent_id:'child',transcript_path:null,cwd:f.dir});
  await f.start();await until(()=>JSON.stringify(f.batches).includes('native child')&&JSON.stringify(f.batches).includes('native title parent'));
  expect(f.batches.every((batch:any)=>['parent','child'].includes(batch.sessionId))).toBe(true);
  expect(readdirSync(join(daemonDir(),'sessions'))).toHaveLength(2);
  expect(existsSync(join(captureDir(),'sources'))?readdirSync(join(captureDir(),'sources')):[]).toHaveLength(0);
}));

isolatedTest('native synchronous clients return after local handoff while config and upload are blocked',async()=>fixture(async f=>{
  nativeConfig(f,'cursor');f.hold=true;
  const marker='continues while upload blocked';
  const localRecords=(directory:string)=>readdirSync(directory).filter(name=>/\.json(?:\.held)?$/.test(name)).map(name=>({name,body:readFileSync(join(directory,name),'utf8')}));
  recordNativeDaemonHook('cursor',{conversation_id:'native-fast',hook_event_name:'beforeSubmitPrompt',prompt:'initial'});
  await f.start();await until(()=>f.raws.length>0);
  await withSessionLock('capture:configuration',async()=>{
    const start=performance.now(),child=Bun.spawn([process.execPath,resolve(import.meta.dir,'../src/cli.ts'),'collect','hook','--harness','cursor'],{env:process.env,stdin:new Blob([JSON.stringify({conversation_id:'native-fast',hook_event_name:'beforeSubmitPrompt',prompt:'continues while upload blocked'})]),stdout:'pipe',stderr:'pipe'});
    const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(exit).toBe(0);expect(stderr).toBe('');expect(JSON.parse(stdout)).toEqual({continue:true});expect(performance.now()-start).toBeLessThan(1000);
    // A successful native response must already have a durable local handoff,
    // whether the recording lane has converted the notice yet or not.
    expect([...localRecords(join(daemonDir(),'inbox')),...localRecords(join(captureDir(),'queue'))].some(record=>record.body.includes(marker))).toBe(true);
  });
  f.hold=false;
  try{await until(()=>JSON.stringify(f.batches).includes(marker));}
  catch(error){
    // Keep the failing lane visible in CI before fixture teardown removes it.
    // These profiles contain only the synthetic records created by this test.
    throw new Error('Native handoff did not drain: '+JSON.stringify({status:captureStatus(),inbox:localRecords(join(daemonDir(),'inbox')),queue:localRecords(join(captureDir(),'queue')),batches:f.batches,requests:f.requests}),{cause:error});
  }
}));

isolatedTest('idle daemon recovers missed inbox notifications without scanning transcripts',async()=>fixture(async f=>{
  nativeConfig(f,'cursor');
  const original={...await import('node:fs')};let muted=0;
  mock.module('node:fs',()=>({...original,watch:(...args:Parameters<typeof original.watch>)=>{
    if(String(args[0])===join(daemonDir(),'inbox')){args[args.length-1]=()=>{};muted++;}
    return Reflect.apply(original.watch,original,args);
  }}));
  await f.start();await sleep(40);expect(muted).toBe(1);
  expect(readdirSync(join(daemonDir(),'sessions'))).toHaveLength(0);
  recordNativeDaemonHook('cursor',{conversation_id:'missed-wakeup',hook_event_name:'beforeSubmitPrompt',prompt:'recover this exact pending event'});
  await until(()=>JSON.stringify(f.batches).includes('recover this exact pending event'),1000);
  await f.stop();
  expect(readdirSync(join(daemonDir(),'inbox'))).toHaveLength(0);
  expect(JSON.parse(readFileSync(join(daemonDir(),'status.json'),'utf8'))).toMatchObject({captures:0,sessionChecks:0,uploads:1});
  expect(existsSync(join(captureDir(),'sources'))?readdirSync(join(captureDir(),'sources')):[]).toHaveLength(0);
  // The same recovery clock must still serve approved startup when recording
  // is paused; it must not wake the uploader or scan transcripts in that state.
  const paused={...readCaptureConfig()!,disabled:true,backgroundStartup:true};atomicJson(join(captureDir(),'config.json'),paused);
  let handled=0;const requests=f.requests;
  await f.start({processStartupTask:async()=>{handled++;}});await sleep(40);
  const {path:task}=startupTask(paused);
  await until(()=>handled===1&&!existsSync(task),1000);await f.stop();
  expect(f.requests).toBe(requests);
  expect(JSON.parse(readFileSync(join(daemonDir(),'status.json'),'utf8'))).toMatchObject({captures:0,sessionChecks:0,uploads:0,startups:1});
}));

isolatedTest('pause observed during a transcript pass retains bounded startup recovery',async()=>fixture(async f=>{
  const config={...readCaptureConfig()!,backgroundStartup:true};atomicJson(join(captureDir(),'config.json'),config);
  const second=join(dirname(f.path),'second.jsonl');
  writeFileSync(second,JSON.stringify({type:'user',uuid:'second-event',sessionId:'second',message:{role:'user',content:'must remain unread after pause'}})+'\n');
  f.event();recordDaemonHook({session_id:'second',transcript_path:second,hook_event_name:'SessionStart',cwd:f.dir},process.pid);
  const originalFs={...await import('node:fs')},originalRuntime={...await import('../src/capture/runtime.ts')};
  // Suppress root notifications so a configuration/queue event cannot conceal
  // an infinite wait after a pause is observed between two enrolled sessions.
  const mutedRoots=new Set([captureDir(),join(daemonDir(),'inbox'),join(captureDir(),'queue')]);
  mock.module('node:fs',()=>({...originalFs,watch:(...args:Parameters<typeof originalFs.watch>)=>{
    if(mutedRoots.has(String(args[0])))args[args.length-1]=()=>{};
    return Reflect.apply(originalFs.watch,originalFs,args);
  }}));
  let paused=false,handled=0;
  mock.module('../src/capture/runtime.ts',()=>({...originalRuntime,captureTranscript:async(...args:Parameters<typeof originalRuntime.captureTranscript>)=>{
    const result=await originalRuntime.captureTranscript(...args);
    if(!paused){paused=true;atomicJson(join(captureDir(),'config.json'),{...config,disabled:true});}
    return result;
  }}));
  await f.start({processStartupTask:async()=>{handled++;}});await until(()=>paused);await sleep(40);
  const requests=f.requests,queued=startupTask(readCaptureConfig()!);
  await until(()=>handled===1&&!existsSync(queued.path),1000);await f.stop();
  expect(f.requests).toBe(requests);
  expect(JSON.parse(readFileSync(join(daemonDir(),'status.json'),'utf8'))).toMatchObject({captures:1,sessionChecks:1,startups:1});
  expect(f.batches.some((batch: {sessionId:string})=>batch.sessionId==='second')).toBe(false);
  expect(readFileSync(second,'utf8')).toContain('must remain unread after pause');
}));

isolatedTest('one damaged Cursor session cannot monopolize a backlog and repaired events retain order',async()=>fixture(async f=>{
  const config=nativeConfig(f,'cursor'),path=join(config.roots.cursor!,'projects','project','agent-transcripts','broken','broken.jsonl');
  mkdirSync(dirname(path),{recursive:true});writeFileSync(path,'broken JSON\n');
  for(let i=0;i<70;i++)recordNativeDaemonHook('cursor',{conversation_id:'broken',transcript_path:path,hook_event_name:'afterAgentResponse',text:'repair event '+i,extraNativePayload:'x'.repeat(8192)});
  recordNativeDaemonHook('cursor',{conversation_id:'healthy',hook_event_name:'afterAgentResponse',text:'healthy session continues'});
  await f.start();await until(()=>JSON.stringify(f.batches).includes('healthy session continues'));
  expect(f.batches.some((batch:any)=>batch.sessionId==='broken')).toBe(false);
  await sleep(350);
  // The healthy sibling still has the 5-second fairness bound above. Recovery
  // flushes 70 durable records; Windows disk IO is not a 5-second performance SLO.
  const recoveryMs=process.platform==='win32'?15_000:5000;
  writeFileSync(path,'');await until(()=>f.batches.flatMap((batch:any)=>batch.events).filter((event:any)=>event.kind==='message'&&event.data.content[0].text.startsWith('repair event ')).length===70,recoveryMs);
  const events=f.batches.flatMap((batch:any)=>batch.events).filter((event:any)=>event.kind==='message'&&event.data.content[0].text.startsWith('repair event ')).sort((a:any,b:any)=>a.sequence-b.sequence);
  expect(events.map((event:any)=>event.data.content[0].text)).toEqual(Array.from({length:70},(_,i)=>'repair event '+i));
  await f.stop();
  // Each blocked body is classified once, then read once when its predecessor
  // recovers. Waiting must not repeatedly read the entire queued backlog.
  expect(JSON.parse(readFileSync(join(daemonDir(),'status.json'),'utf8')).noticeReads).toBeLessThan(150);
}),process.platform==='win32'?30_000:15_000);

isolatedTest('idle native session watches retire and the next hook resumes the same byte cursor',async()=>fixture(async f=>{
  const config=nativeConfig(f,'cursor'),path=join(config.roots.cursor!,'projects','project','agent-transcripts','idle','idle.jsonl');
  mkdirSync(dirname(path),{recursive:true});
  const line=(text:string)=>JSON.stringify({role:'assistant',message:{content:[{type:'text',text}]}})+'\n';writeFileSync(path,line('before idle'));
  const event=()=>recordNativeDaemonHook('cursor',{conversation_id:'idle',transcript_path:path,hook_event_name:'sessionStart'});
  event();await f.start({idleMs:100});await until(()=>JSON.stringify(f.batches).includes('before idle'));await until(()=>readdirSync(join(daemonDir(),'sessions')).length===0);
  appendFileSync(path,line('after idle'));event();await until(()=>JSON.stringify(f.batches).includes('after idle'));
  expect(f.batches.flatMap((batch:any)=>batch.events).filter((event:any)=>event.kind==='message'&&event.data.content[0].text==='before idle')).toHaveLength(1);
}));

isolatedTest('Claude installs three async capture hooks and preserves unrelated hooks',async()=>fixture(async f=>{
  const hooks=JSON.parse(readFileSync(join(f.dir,'claude','settings.json'),'utf8')).hooks;
  expect(Object.keys(hooks).sort()).toEqual(['SessionEnd','SessionStart','UserPromptSubmit']);
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
  const child=Bun.spawn([process.execPath,resolve(import.meta.dir,'../src/cli.ts'),'collect','hook','--harness','claude-code'],{env:process.env,stdin:new Blob([JSON.stringify({session_id:'session',transcript_path:f.path,hook_event_name:'SessionStart'})]),stdout:'pipe',stderr:'pipe'});
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
  utimesSync(join(dirname(f.path),'unregistered.jsonl'),new Date(0),new Date(0));
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

isolatedTest('a queue making no upload progress backs off across restart and drains after its exclusion is removed',async()=>fixture(async f=>{
  const config=readCaptureConfig()!;
  await captureTranscript(config,'claude-code',f.path,{session_id:'session',cwd:f.dir});
  writeFileSync(join(captureDir(),'config.json'),JSON.stringify({...config,exclusions:{projects:[],sessions:['session']}}));
  await f.start({retryMs:1000});
  const retryFile=join(daemonDir(),'retry.json');
  await until(()=>existsSync(retryFile));
  const firstRetry=JSON.parse(readFileSync(retryFile,'utf8')),requests=f.requests;
  const pending=()=>readdirSync(join(captureDir(),'queue')).sort().map(name=>readFileSync(join(captureDir(),'queue',name),'utf8'));
  const bytes=pending();expect(bytes.length).toBeGreaterThan(0);expect(firstRetry.attempt).toBe(1);
  await sleep(150);expect(f.requests).toBe(requests);expect(f.raws).toHaveLength(0);
  await f.stop();await f.start({retryMs:1000});await sleep(150);
  expect(f.requests).toBe(requests);expect(pending()).toEqual(bytes);
  expect(JSON.parse(readFileSync(retryFile,'utf8'))).toEqual(firstRetry);
  await until(()=>JSON.parse(readFileSync(retryFile,'utf8')).attempt===2);
  const secondRetry=JSON.parse(readFileSync(retryFile,'utf8'));
  expect(secondRetry.dueAt-firstRetry.dueAt).toBeGreaterThanOrEqual(1900);
  expect(f.raws).toHaveLength(0);expect(pending()).toEqual(bytes);
  writeFileSync(join(captureDir(),'config.json'),JSON.stringify(config));
  await until(()=>f.batches.length>0&&pending().length===0);
  expect(f.batches.flatMap((batch:any)=>batch.events).map((event:any)=>event.nativeId)).toEqual(['one']);
  await until(()=>!existsSync(retryFile));
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

isolatedTest('removing forward consent stops an enrolled session without importing later bytes',async()=>fixture(async f=>{
  f.event();await f.start();await until(()=>f.batches.length>0);
  const config=readCaptureConfig()!;expect(config.captureWorker).toBe('daemon-v1');
  writeFileSync(join(captureDir(),'config.json'),JSON.stringify({...config,harnesses:[]}));
  await until(()=>readdirSync(join(daemonDir(),'sessions')).length===0);
  appendFileSync(f.path,f.record('after-consent-removed'));await sleep(200);
  expect(f.batches.flatMap((batch:any)=>batch.events).some((event:any)=>event.nativeId==='after-consent-removed')).toBe(false);
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


isolatedTest('same-owner wrong-install and unbound notices are held without reading a transcript',async()=>fixture(async f=>{
  for(const installationId of ['other-installation',undefined]){
    f.event();const name=readdirSync(join(daemonDir(),'inbox')).find(name=>name.endsWith('.json'))!;
    const path=join(daemonDir(),'inbox',name),notice=JSON.parse(readFileSync(path,'utf8'));
    if(installationId)notice.installationId=installationId;else delete notice.installationId;
    writeFileSync(path,JSON.stringify(notice));
    await f.start();await sleep(80);await f.stop();
    expect(existsSync(path+'.held')).toBe(true);expect(f.raws).toHaveLength(0);
  }
}));

isolatedTest('paused unbound and unselected profiles produce no new daemon notice',async()=>fixture(async f=>{
  const original=readCaptureConfig()!,path=join(captureDir(),'config.json');
  for(const patch of [{disabled:true},{authPending:true},{harnesses:['codex']}]){
    writeFileSync(path,JSON.stringify({...original,...patch}));expect(f.event()).toBe(false);
    expect(!existsSync(daemonDir())||!existsSync(join(daemonDir(),'inbox'))||readdirSync(join(daemonDir(),'inbox')).length===0).toBe(true);
  }
  writeFileSync(path,JSON.stringify(original));
}));

isolatedTest('generation replacement stops before the first transcript pass',async()=>fixture(async f=>{
  f.event();
  const controller=new AbortController();
  await runCaptureDaemon({signal:controller.signal,onReady:()=>writeFileSync(join(daemonDir(),'generation.json'),JSON.stringify({generation:'replacement'}))});
  expect(JSON.parse(readFileSync(join(daemonDir(),'status.json'),'utf8')).state).toBe('stopped');
}));

isolatedTest('supervisor result is factual and bootstrap failure propagates with enrollment retained',async()=>fixture(async f=>{
  // Inject all Darwin-specific inputs even when the fixture runs on Windows.
  const uid=Object.getOwnPropertyDescriptor(process,'getuid');
  Object.defineProperty(process,'getuid',{configurable:true,value:()=>501});
  try{
  const {installCaptureDaemon,launchAgent}=await import('../src/capture/daemon-service.ts');
  const config=readCaptureConfig()!,before=readFileSync(join(captureDir(),'config.json'),'utf8'),calls:string[][]=[];
  await expect(installCaptureDaemon({...config,installationId:'stale-installation'},{home:f.dir,platform:'darwin',run:(()=>{throw Error('must not run');}) as any})).rejects.toThrow('configuration changed');
  const run=((command:string,args:string[])=>{expect(command).toBe('launchctl');calls.push(args);return {status:args[0]==='bootstrap'?17:113,stderr:Buffer.from('Could not find service')};}) as any;
  await expect(installCaptureDaemon(config,{home:f.dir,platform:'darwin',run})).rejects.toThrow('Could not install');
  expect(readFileSync(join(captureDir(),'config.json'),'utf8')).toBe(before);
  expect(JSON.parse(readFileSync(join(daemonDir(),'service.json'),'utf8'))).toMatchObject({status:'failed',supervised:false});
  expect(calls.map(args=>args[0])).toEqual(['print','bootstrap']);
  expect(calls[0][1]).toMatch(/^gui\/501\/com\.getopencrawl\.capture\.[a-f0-9]{12}$/);expect(calls[1][1]).toBe('gui/501');
  // The fake's file is intentionally retained as the same failed installation would be.
  const service=await installCaptureDaemon(config,{home:f.dir,platform:'linux',service:false,ensure:async()=>{}});
  expect(service).toMatchObject({kind:'process',supervised:false});
  const plist=launchAgent({...config,command:['/selected CLI/opencrawl']});
  expect(plist).toContain('/selected CLI/opencrawl');expect(plist).toContain('collect');expect(plist).toContain('daemon');
  expect(plist).not.toContain('synthetic-daemon-token');
  }finally{
    if(uid)Object.defineProperty(process,'getuid',uid);else delete process.getuid;
    // Never invoke a real supervisor during cleanup of this fake installation,
    // including when an assertion above fails.
    const {unlinkSync}=await import('node:fs'),agentDir=join(f.dir,'Library','LaunchAgents');
    if(existsSync(agentDir))for(const name of readdirSync(agentDir))unlinkSync(join(agentDir,name));
  }
}));

isolatedTest('first forward opt-in excludes the existing transcript prefix while the daemon captures later appends',async()=>fixture(async f=>{
  const installed=readCaptureConfig()!,expectedOwner=installed.owner;
  await installCapture(f.api,{home:f.dir,command:[],harnesses:[],historyHarnesses:[],selectionMode:'replace',hookOwnership:'plugin',daemon:true,daemonService:false,expectedOwner,expectedConfig:installed});
  const before=readCaptureConfig()!,prefixBytes=Buffer.byteLength(readFileSync(f.path));
  await installCapture(f.api,{home:f.dir,command:[],harnesses:['claude-code'],historyHarnesses:[],selectionMode:'replace',hookOwnership:'plugin',daemon:true,daemonService:false,expectedOwner,expectedConfig:before});
  const state=join(captureDir(),'state',hash('claude-code'+realpathSync(f.path))+'.json');
  expect(JSON.parse(readFileSync(state,'utf8'))).toMatchObject({forwardBoundary:true,offset:prefixBytes});
  expect(readCaptureConfig()).toMatchObject({installationId:installed.installationId,owner:expectedOwner,historyHarnesses:[]});
  f.event();await f.start();await sleep(100);expect(f.batches).toHaveLength(0);
  appendFileSync(f.path,f.record('after-first-opt-in'));
  await until(()=>f.batches.some((batch:any)=>batch.events.some((event:any)=>event.nativeId==='after-first-opt-in')));
  expect(f.batches.flatMap((batch:any)=>batch.events).map((event:any)=>event.nativeId)).toEqual(['after-first-opt-in']);
}));

isolatedTest('daemon enrollment preserves guards, legacy alias, paused state and retained queue bytes',async()=>fixture(async f=>{
  const configFile=join(captureDir(),'config.json'),original=readCaptureConfig()!;
  const {captureWorker:_,...withoutWorker}=original;
  const legacy={...withoutWorker,claudeCapture:'daemon-v1' as const,disabled:true};writeFileSync(configFile,JSON.stringify(legacy));
  const queue=join(captureDir(),'queue','retained.json');writeFileSync(queue,'retained test bytes');
  await expect(installCapture(f.api,{home:f.dir,command:[],harnesses:[],selectionMode:'replace',daemon:true,daemonService:false,expectedOwner:{tenantId:'wrong',userId:'fixture'}})).rejects.toMatchObject({code:'SETUP_SCOPE_CHANGED'});
  await expect(installCapture(f.api,{home:f.dir,command:[],harnesses:[],selectionMode:'replace',daemon:true,daemonService:false,expectedConfig:original})).rejects.toMatchObject({code:'CAPTURE_CONFIG_CHANGED'});
  expect(JSON.parse(readFileSync(configFile,'utf8'))).toEqual(legacy);
  await installCapture(f.api,{home:f.dir,command:[],harnesses:[],historyHarnesses:[],selectionMode:'replace',hookOwnership:'plugin',daemonService:false,expectedConfig:legacy,expectedOwner:original.owner});
  expect(readCaptureConfig()).toMatchObject({installationId:original.installationId,owner:original.owner,disabled:true,harnesses:[],historyHarnesses:[],captureWorker:'daemon-v1'});
  expect(readFileSync(queue,'utf8')).toBe('retained test bytes');
}));


function startupTask(config:NonNullable<ReturnType<typeof readCaptureConfig>>,patch:Record<string,unknown>={}){
  const task={kind:'session-start',id:randomUUID(),at:Date.now(),api:config.api,installationId:config.installationId,owner:{tenantId:config.owner.tenantId,userId:config.owner.userId},harness:'claude-code',sessionId:'session',payload:{hook_event_name:'SessionStart',source:'startup'},...patch};
  const path=join(daemonDir(),'inbox','startup-'+task.id+'.json');atomicJson(path,task);return {path,task,bytes:readFileSync(path,'utf8')};
}

isolatedTest('disabled capture runs real bound startup registration without reading or uploading capture data',async()=>fixture(async f=>{
  const config={...readCaptureConfig()!,disabled:true,harnesses:[],backgroundStartup:true};
  atomicJson(join(captureDir(),'config.json'),config);
  const scope={api:f.api,...config.owner},setup={schemaVersion:1,scope,installationId:config.installationId,selections:{plugins:{'claude-code':true},forward:{'claude-code':false},history:{'claude-code':false}}};
  const setupFile=statePath(scopeKey(scope));atomicJson(setupFile,setup);
  const queue=join(captureDir(),'queue','retained.json');writeFileSync(queue,'previously queued bytes');
  const sourceBefore=readFileSync(f.path,'utf8'),configBefore=readFileSync(join(captureDir(),'config.json'),'utf8'),setupBefore=readFileSync(setupFile,'utf8');
  const queued=startupTask(config),requestsBefore=f.requests,paths:string[]=[];
  process.env.OPENCRAWL_TOKEN='synthetic-startup-token';
  const receiver=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=new URL(String(input)).pathname;paths.push(path);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-startup-token');
    if(path==='/api/cli/me')return Response.json({schemaVersion:1,data:{user:{id:config.owner.userId},workspace:{id:config.owner.tenantId}}});
    expect(path).toBe('/api/board/bootstrap');const body=JSON.parse(String(init?.body));
    return Response.json({schemaVersion:1,data:{workspace:config.owner.tenantId,session:body.session,agent:'a'.repeat(64),name:null,task:null}});
  }) as typeof fetch;
  await f.start({processStartupTask:(current:any,task:unknown)=>processSessionStartTask(current,task,receiver)});
  await until(()=>!existsSync(queued.path));await f.stop();
  expect(paths).toEqual(['/api/cli/me','/api/board/bootstrap']);expect(startupObservation(f.api,'claude-code','session')?.registration.workspace).toBe('fixture');
  expect(f.requests).toBe(requestsBefore);expect(f.raws).toHaveLength(0);expect(readFileSync(queue,'utf8')).toBe('previously queued bytes');
  expect(readFileSync(f.path,'utf8')).toBe(sourceBefore);expect(readdirSync(join(captureDir(),'state'))).toEqual([]);
  expect(readFileSync(join(captureDir(),'config.json'),'utf8')).toBe(configBefore);expect(readFileSync(setupFile,'utf8')).toBe(setupBefore);
  expect(JSON.parse(readFileSync(join(daemonDir(),'status.json'),'utf8'))).toMatchObject({captures:0,sessionChecks:0,uploads:0,startups:1});
}));

isolatedTest('slow startup work never blocks capture or upload and foreign task bindings are retained',async()=>fixture(async f=>{
  const config={...readCaptureConfig()!,backgroundStartup:true};atomicJson(join(captureDir(),'config.json'),config);
  const wrong=startupTask(config,{owner:{tenantId:'other',userId:'fixture'}}),task=startupTask(config);
  const mismatch=startupTask(config);const renamed=join(dirname(mismatch.path),'startup-'+randomUUID()+'.json');
  const {renameSync}=await import('node:fs');renameSync(mismatch.path,renamed);
  let started=false,release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});
  try{
    f.event();await f.start({processStartupTask:async()=>{started=true;await blocked;}});
    await until(()=>started&&f.batches.length>0);expect(existsSync(task.path)).toBe(true);
    appendFileSync(f.path,f.record('during-startup'));await until(()=>f.batches.some((batch:any)=>batch.events.some((event:any)=>event.nativeId==='during-startup')));
  }finally{release();}
  await until(()=>!existsSync(task.path)&&existsSync(wrong.path+'.held')&&existsSync(renamed+'.held'));await f.stop();
  expect(readFileSync(wrong.path+'.held','utf8')).toBe(wrong.bytes);expect(readFileSync(renamed+'.held','utf8')).toBe(mismatch.bytes);
}));

isolatedTest('startup failure and restart retain exact input until the bound callback succeeds',async()=>fixture(async f=>{
  const config={...readCaptureConfig()!,disabled:true,harnesses:[],backgroundStartup:true};atomicJson(join(captureDir(),'config.json'),config);
  const task=startupTask(config);let calls=0;
  await f.start({retryMs:1000,processStartupTask:async()=>{calls++;throw Error('synthetic unavailable');}});
  await until(()=>existsSync(join(daemonDir(),'startup-retry.json')));await f.stop();
  expect(calls).toBe(1);expect(readFileSync(task.path,'utf8')).toBe(task.bytes);
  await f.start({processStartupTask:async()=>{calls++;}});await until(()=>!existsSync(task.path));await f.stop();
  expect(calls).toBe(2);expect(f.raws).toHaveLength(0);
}));

isolatedTest('forward opt-out drains approved queue then exits without reading later transcript bytes',async()=>fixture(async f=>{
  f.fail=true;f.event();await f.start();await until(()=>f.raws.length>0);await f.stop();
  const config={...readCaptureConfig()!,harnesses:[],backgroundStartup:false};atomicJson(join(captureDir(),'config.json'),config);
  appendFileSync(f.path,f.record('after-opt-out'));f.fail=false;await f.start();
  await until(()=>JSON.parse(readFileSync(join(daemonDir(),'status.json'),'utf8')).state==='stopped');await f.stop();
  expect(readdirSync(join(captureDir(),'queue'))).toEqual([]);
  expect(f.batches.flatMap((batch:any)=>batch.events).map((event:any)=>event.nativeId)).toEqual(['one']);
}));

isolatedTest('removing enrollment during awaited capture cannot enqueue later bytes',async()=>fixture(async f=>{
  const config=readCaptureConfig()!,configFile=join(captureDir(),'config.json');
  writeFileSync(f.path,Array.from({length:201},(_,i)=>f.record('event-'+i)).join(''));
  let spooled=0;
  await expect(captureTranscript(config,'claude-code',f.path,{},false,async()=>{spooled++;rmSync(configFile);await Promise.resolve();})).rejects.toMatchObject({code:'CAPTURE_CONFIG_CHANGED'});
  expect(spooled).toBe(1);const batches=readdirSync(join(captureDir(),'queue')).map(name=>JSON.parse(readFileSync(join(captureDir(),'queue',name),'utf8')));
  expect(batches.flatMap(batch=>batch.events)).toHaveLength(200);expect(batches.flatMap(batch=>batch.events).some(event=>event.nativeId==='event-200')).toBe(false);
  atomicJson(configFile,config);
}));

isolatedTest('not-required supervisor preserves a paused queue and stops only its owned service',async()=>fixture(async f=>{
  const {installCaptureDaemon}=await import('../src/capture/daemon-service.ts');
  const config={...readCaptureConfig()!,disabled:true,harnesses:[],backgroundStartup:false};atomicJson(join(captureDir(),'config.json'),config);
  const queue=join(captureDir(),'queue','retained.json');writeFileSync(queue,'retained');
  const result=await installCaptureDaemon(config,{home:f.dir,platform:'linux',ensure:async()=>{throw Error('must not launch');}});
  expect(result).toMatchObject({kind:'not-required',supervised:false,queuedDataPreserved:true});expect(readFileSync(queue,'utf8')).toBe('retained');
}));


isolatedTest('revoked startup tasks are held so a later selected client can register',async()=>fixture(async f=>{
  const config={...readCaptureConfig()!,disabled:true,harnesses:[],backgroundStartup:true};atomicJson(join(captureDir(),'config.json'),config);
  const scope={api:f.api,...config.owner};atomicJson(statePath(scopeKey(scope)),{schemaVersion:1,scope,installationId:config.installationId,selections:{plugins:{'claude-code':true,codex:false},forward:{},history:{}}});
  // Sorted UUIDs force an entire first page of revoked tasks before the valid task.
  const revoked=Array.from({length:16},(_,i)=>startupTask(config,{id:'00000000-0000-4000-8000-'+i.toString(16).padStart(12,'0'),harness:'codex',payload:{hook_event_name:'SessionStart',source:'startup'}}));
  const valid=startupTask(config,{id:'ffffffff-ffff-4fff-8fff-ffffffffffff'}),paths:string[]=[];
  process.env.OPENCRAWL_TOKEN='synthetic-startup-token';
  const receiver=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=new URL(String(input)).pathname;paths.push(path);
    if(path==='/api/cli/me')return Response.json({schemaVersion:1,data:{user:{id:'fixture'},workspace:{id:'fixture'}}});
    expect(path).toBe('/api/board/bootstrap');const body=JSON.parse(String(init?.body));
    return Response.json({schemaVersion:1,data:{workspace:'fixture',session:body.session,agent:'a'.repeat(64),name:null,task:null}});
  }) as typeof fetch;
  await f.start({processStartupTask:(current:any,task:unknown)=>processSessionStartTask(current,task,receiver)});
  await until(()=>!existsSync(valid.path));await f.stop();
  for(const task of revoked)expect(readFileSync(task.path+'.held','utf8')).toBe(task.bytes);
  expect(paths).toEqual(['/api/cli/me','/api/board/bootstrap']);expect(f.raws).toHaveLength(0);
}));


isolatedTest('Cursor forward enrollment skips prior prefixes and off intervals while new files keep their first prompt',async()=>fixture(async f=>{
  const root=join(f.dir,'cursor');process.env.CURSOR_CONFIG_DIR=root;
  const path=join(root,'projects','project','agent-transcripts','consent','consent.jsonl');mkdirSync(dirname(path),{recursive:true});
  const line=(text:string)=>JSON.stringify({role:'user',message:{content:[{type:'text',text}]}})+'\n';
  writeFileSync(path,line('PRIVATE OLD PREFIX'));
  const select=async(harnesses:('cursor')[])=>installCapture(f.api,{home:f.dir,command:[],harnesses,historyHarnesses:[],selectionMode:'replace',hookOwnership:'plugin',daemon:true,daemonService:false,expectedOwner:readCaptureConfig()!.owner,expectedConfig:readCaptureConfig()});
  await select(['cursor']);expect(readCaptureConfig()?.historyHarnesses).toEqual([]);
  const event=(file=path,id='consent')=>recordNativeDaemonHook('cursor',{conversation_id:id,transcript_path:file,hook_event_name:'sessionStart'});
  appendFileSync(path,line('FIRST APPROVED APPEND'));event();await f.start();await until(()=>JSON.stringify(f.batches).includes('FIRST APPROVED APPEND'));await f.stop();
  expect(JSON.stringify(f.batches)).not.toContain('PRIVATE OLD PREFIX');
  await select([]);appendFileSync(path,line('PRIVATE OFF INTERVAL'));await select(['cursor']);
  appendFileSync(path,line('AFTER REOPTIN'));event();
  const fresh=join(root,'projects','project','agent-transcripts','fresh','fresh.jsonl');mkdirSync(dirname(fresh),{recursive:true});writeFileSync(fresh,line('FRESH FIRST PROMPT'));event(fresh,'fresh');
  await f.start();await until(()=>JSON.stringify(f.batches).includes('AFTER REOPTIN')&&JSON.stringify(f.batches).includes('FRESH FIRST PROMPT'));await f.stop();
  expect(JSON.stringify(f.batches)).not.toContain('PRIVATE OLD PREFIX');expect(JSON.stringify(f.batches)).not.toContain('PRIVATE OFF INTERVAL');
  expect(readCaptureConfig()).toMatchObject({harnesses:['cursor'],historyHarnesses:[]});
  expect(readFileSync(join(captureDir(),'state','cursor-'+hash('consent')+'.json'),'utf8')).not.toContain('PRIVATE');
}));

for(const harness of ['codex','antigravity'] as const)isolatedTest(harness+' daemon respects explicit forward prefix and captures a new file first prompt',async()=>fixture(async f=>{
  const root=join(f.dir,harness);process.env[harness==='codex'?'CODEX_HOME':'ANTIGRAVITY_HOME']=root;
  const file=(id:string)=>harness==='codex'?join(root,'sessions','2026','11','16','rollout-2026-11-16-'+id+'.jsonl'):join(root,'antigravity-cli','brain',id,'.system_generated','logs','transcript.jsonl');
  const content=(text:string,index:number)=>JSON.stringify(harness==='codex'?{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}}:{step_index:index,type:'USER_INPUT',source:'USER_EXPLICIT',status:'DONE',content:'<USER_REQUEST>\n'+text+'\n</USER_REQUEST>'})+'\n';
  const create=(id:string,text:string)=>{const path=file(id);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,(harness==='codex'?JSON.stringify({type:'session_meta',payload:{id,source:'cli'}})+'\n':'')+content(text,0));return path;};
  const old=create('existing','PRIVATE PREFIX '+harness);
  await installCapture(f.api,{home:f.dir,command:[],harnesses:[harness],historyHarnesses:[],selectionMode:'replace',hookOwnership:'plugin',daemon:true,daemonService:false,expectedOwner:readCaptureConfig()!.owner,expectedConfig:readCaptureConfig()});
  appendFileSync(old,content('APPROVED APPEND '+harness,1));const fresh=create('fresh','FIRST PROMPT '+harness);
  for(const [id,path]of [['existing',old],['fresh',fresh]])recordNativeDaemonHook(harness,harness==='codex'?{session_id:id,transcript_path:path,hook_event_name:'SessionStart'}:{conversationId:id,transcriptPath:path,hookEventName:'SessionStart'});
  await f.start();await until(()=>JSON.stringify(f.batches).includes('APPROVED APPEND '+harness)&&JSON.stringify(f.batches).includes('FIRST PROMPT '+harness));await f.stop();
  expect(JSON.stringify(f.batches)).not.toContain('PRIVATE PREFIX '+harness);expect(readCaptureConfig()?.historyHarnesses).toEqual([]);
}));

for(const harness of ['claude-code','codex','antigravity'] as const)isolatedTest(harness+' daemon rejects in-root redirects to another native session before reading',async()=>fixture(async f=>{
  const config=harness==='claude-code'?readCaptureConfig()!:nativeConfig(f,harness),root=config.roots[harness]!;
  const file=(id:string)=>harness==='claude-code'?join(root,'projects','fixture',id+'.jsonl'):harness==='codex'?join(root,'sessions','2026','11','16','rollout-'+id+'.jsonl'):join(root,'antigravity-cli','brain',id,'.system_generated','logs','transcript.jsonl');
  const target=file('other'),source=file('session');mkdirSync(dirname(target),{recursive:true});mkdirSync(dirname(source),{recursive:true});
  // Deliberately invalid JSON proves rejection occurs before any native parser.
  writeFileSync(target,'OTHER SESSION MUST NOT BE PARSED');if(existsSync(source))rmSync(source);symlinkSync(target,source);
  await expect(captureTranscript(config,harness,source,{session_id:'session'},false,undefined,undefined,{sessionScoped:true,sessionPath:source})).rejects.toMatchObject({code:'CAPTURE_SESSION_PATH_REJECTED'});
  expect(f.raws).toHaveLength(0);expect(readdirSync(join(captureDir(),'queue'))).toEqual([]);expect(readdirSync(join(captureDir(),'state'))).toEqual([]);
}));

for(const harness of ['claude-code','codex'] as const)isolatedTest(harness+' daemon refuses a mismatched native header without reassigning captured ownership',async()=>fixture(async f=>{
  const config=harness==='claude-code'?readCaptureConfig()!:nativeConfig(f,harness),path=harness==='claude-code'?f.path:join(config.roots.codex!,'sessions','2026','11','16','rollout-session.jsonl');mkdirSync(dirname(path),{recursive:true});
  const content=harness==='claude-code'?JSON.stringify({type:'user',uuid:'wrong-session',sessionId:'other',message:{role:'user',content:'must not capture'}})+'\n':JSON.stringify({type:'session_meta',payload:{id:'other',source:'cli'}})+'\n'+JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'must not capture'}]}})+'\n';
  writeFileSync(path,content);
  await expect(captureTranscript(config,harness,path,{session_id:'session'},false,undefined,undefined,{sessionScoped:true,sessionPath:path})).rejects.toMatchObject({code:'CAPTURE_SESSION_MISMATCH'});
  expect(readdirSync(join(captureDir(),'queue'))).toEqual([]);expect(readdirSync(join(captureDir(),'state'))).toEqual([]);
}));

isolatedTest('Claude daemon child identity stays bound to its registered parent subtree',async()=>fixture(async f=>{
  const config=readCaptureConfig()!,child=join(f.path.slice(0,-6),'subagents','agent-child.jsonl');mkdirSync(dirname(child),{recursive:true});
  writeFileSync(child,JSON.stringify({type:'user',uuid:'mismatch',sessionId:'session',agentId:'other',message:{role:'user',content:'must not capture'}})+'\n');
  await expect(captureTranscript(config,'claude-code',child,{session_id:'session'},false,undefined,undefined,{sessionScoped:true,sessionPath:f.path})).rejects.toMatchObject({code:'CAPTURE_SESSION_MISMATCH'});
  expect(readdirSync(join(captureDir(),'queue'))).toEqual([]);
  writeFileSync(child,f.record('legitimate-child','child'));
  const result=await captureTranscript(config,'claude-code',child,{session_id:'session'},false,undefined,undefined,{sessionScoped:true,sessionPath:f.path});
  expect(result).toMatchObject({sessionId:'session:child',parentSessionId:'session'});
  expect(readdirSync(join(captureDir(),'queue')).map(name=>JSON.parse(readFileSync(join(captureDir(),'queue',name),'utf8'))).flatMap(batch=>batch.events).map(event=>event.nativeId)).toEqual(['legitimate-child']);
}));

isolatedTest('Codex daemon preserves native fork parent headers after validating the leading child identity',async()=>fixture(async f=>{
  const config=nativeConfig(f,'codex'),path=join(config.roots.codex!,'sessions','2026','11','16','rollout-child.jsonl');mkdirSync(dirname(path),{recursive:true});
  const header=(id:string,parent?:string)=>JSON.stringify({type:'session_meta',payload:{id,forked_from_id:parent,source:'cli'}})+'\n';
  writeFileSync(path,header('child','parent')+header('parent')+JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'child message'}]}})+'\n');
  const result=await captureTranscript(config,'codex',path,{session_id:'child'},false,undefined,undefined,{sessionScoped:true,sessionPath:path});
  expect(result).toMatchObject({sessionId:'child',parentSessionId:'parent'});
}));

isolatedTest('Cursor forward boundary skips rewritten old prefixes and incomplete pre-consent records',async()=>fixture(async f=>{
  const root=join(f.dir,'cursor');process.env.CURSOR_CONFIG_DIR=root;
  const path=join(root,'projects','project','agent-transcripts','rewrite','rewrite.jsonl');mkdirSync(dirname(path),{recursive:true});
  const line=(text:string)=>JSON.stringify({role:'user',message:{content:[{type:'text',text}]}})+'\n';
  const partial=line('PRIVATE PARTIAL PREFIX');writeFileSync(path,partial.slice(0,-10));
  await installCapture(f.api,{home:f.dir,command:[],harnesses:['cursor'],historyHarnesses:[],selectionMode:'replace',hookOwnership:'plugin',daemon:true,daemonService:false});
  const event=()=>recordNativeDaemonHook('cursor',{conversation_id:'rewrite',transcript_path:path,hook_event_name:'sessionStart'});
  appendFileSync(path,partial.slice(-10)+line('APPROVED AFTER PARTIAL'));event();await f.start();await until(()=>JSON.stringify(f.batches).includes('APPROVED AFTER PARTIAL'));await f.stop();
  expect(JSON.stringify(f.batches)).not.toContain('PRIVATE PARTIAL PREFIX');
  // Native rotation/truncation makes the unknown prefix ambiguous. Rebase at
  // its current end instead of converting unapproved earlier content.
  rmSync(path);writeFileSync(path,line('PRIVATE REPLACEMENT'));event();await f.start();await until(()=>existsSync(join(captureDir(),'last-error.json')));await f.stop();
  expect(JSON.stringify(f.batches)).not.toContain('PRIVATE REPLACEMENT');
  appendFileSync(path,line('APPROVED AFTER REBASE'));event();await f.start();await until(()=>JSON.stringify(f.batches).includes('APPROVED AFTER REBASE'));await f.stop();
  writeFileSync(path,line('PRIVATE TRUNCATION'));event();await f.start();await sleep(150);await f.stop();
  expect(JSON.stringify(f.batches)).not.toContain('PRIVATE TRUNCATION');
  expect(readCaptureConfig()?.historyHarnesses).toEqual([]);
}));

isolatedTest('live title enrichment cannot bypass a forward revocation during recording',async()=>fixture(async f=>{
  const config=nativeConfig(f,'codex'),root=config.roots.codex,path=join(root,'sessions','rollout-title-session.jsonl');mkdirSync(dirname(path),{recursive:true});
  writeFileSync(path,JSON.stringify({type:'session_meta',payload:{id:'title-session',cwd:f.dir,source:'cli'}})+'\n'+JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'approved earlier bytes'}]}})+'\n');
  const db=new Database(join(root,'state_5.sqlite'));db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT, name TEXT, updated_at INTEGER, source TEXT)');
  db.query('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)').run('title-session',path,'revoked later title',null,1794800000,'cli');db.close();
  await expect(captureTranscript(config,'codex',path,{session_id:'title-session'},false,async()=>{
    writeFileSync(join(captureDir(),'config.json'),JSON.stringify({...config,harnesses:[]}));
  },undefined,{sessionScoped:true})).rejects.toMatchObject({code:'CAPTURE_CONSENT_CHANGED'});
  const queue=readdirSync(join(captureDir(),'queue')).map(name=>JSON.parse(readFileSync(join(captureDir(),'queue',name),'utf8')));
  expect(queue.flatMap(batch=>batch.events).some(event=>event.kind==='session_title')).toBe(false);
}));


isolatedTest('Antigravity daemon accepts an exact full-only transcript without its nominal compact file',async()=>fixture(async f=>{
  const config=nativeConfig(f,'antigravity'),path=join(config.roots.antigravity!,'antigravity-cli','brain','full-only','.system_generated','logs','transcript.jsonl');mkdirSync(dirname(path),{recursive:true});
  writeFileSync(join(dirname(path),'transcript_full.jsonl'),JSON.stringify({step_index:0,type:'USER_INPUT',source:'USER_EXPLICIT',status:'DONE',content:'<USER_REQUEST>\nfull-only prompt\n</USER_REQUEST>'})+'\n');
  recordNativeDaemonHook('antigravity',{conversationId:'full-only',transcriptPath:path,hookEventName:'SessionStart'});
  await f.start();await until(()=>JSON.stringify(f.batches).includes('full-only prompt'));await f.stop();
  expect(f.batches.every((batch:any)=>batch.sessionId==='full-only')).toBe(true);
}));

isolatedTest('native hook main entry skips update migration auth and service startup while daemon is offline',async()=>fixture(async f=>{
  nativeConfig(f,'cursor');const flag=join(f.dir,'forbidden-side-effect'),configBefore=readFileSync(join(captureDir(),'config.json'),'utf8'),requests=f.requests;
  const module=(name:string)=>JSON.stringify(resolve(import.meta.dir,'../src/'+name));
  const code=`import {mock} from 'bun:test';import {writeFileSync} from 'node:fs';
const forbidden=()=>{writeFileSync(${JSON.stringify(flag)},'unexpected');throw Error('unavailable in native hook');};
import * as distribution from ${module('distribution.ts')};
mock.module(${module('distribution.ts')},()=>({...distribution,compiled:()=>true,findLegacyLaunchers:forbidden,migrateLegacyLauncher:forbidden}));
import * as update from ${module('update.ts')};mock.module(${module('update.ts')},()=>({...update,scheduleCliUpdate:forbidden}));
import * as session from ${module('session.ts')};mock.module(${module('session.ts')},()=>({...session,accessToken:forbidden}));
import * as service from ${module('capture/daemon-service.ts')};mock.module(${module('capture/daemon-service.ts')},()=>({...service,ensureCaptureDaemon:forbidden,installCaptureDaemon:forbidden}));
globalThis.fetch=forbidden;delete process.env.OPENCRAWL_NO_UPDATE;
const {main}=await import(${module('cli.ts')});await main(['collect','hook','--harness','cursor','--managed']);`;
  await withSessionLock('capture:configuration',async()=>{
    const child=Bun.spawn([process.execPath,'-e',code],{env:process.env,stdin:new Blob([JSON.stringify({conversation_id:'offline-fast',hook_event_name:'beforeSubmitPrompt',prompt:'durable while offline'})]),stdout:'pipe',stderr:'pipe'});
    const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(exit).toBe(0);expect(stderr).toBe('');expect(JSON.parse(stdout)).toEqual({continue:true});
  });
  expect(existsSync(flag)).toBe(false);expect(f.requests).toBe(requests);expect(readFileSync(join(captureDir(),'config.json'),'utf8')).toBe(configBefore);
  expect(existsSync(join(daemonDir(),'status.json'))).toBe(false);
  const notices=readdirSync(join(daemonDir(),'inbox')).map(name=>JSON.parse(readFileSync(join(daemonDir(),'inbox',name),'utf8')));
  expect(notices).toHaveLength(1);expect(notices[0]).toMatchObject({api:f.api,installationId:readCaptureConfig()!.installationId,owner:readCaptureConfig()!.owner,record:{harness:'cursor',event:{prompt:'durable while offline'}}});
}));

isolatedTest('oversized Cursor tools become bounded evidence without fabricating a call or result',async()=>fixture(async f=>{
  nativeConfig(f,'cursor');expect(()=>recordNativeDaemonHook('cursor',{conversation_id:'large-metadata',hook_event_name:'postToolUse',tool_name:'x'.repeat(8*1024*1024)})).toThrow('Native hook metadata exceeds');
  recordNativeDaemonHook('cursor',{conversation_id:'large',hook_event_name:'postToolUse',tool_name:'mcp_verify',tool_use_id:'native-large',tool_input:{payload:'x'.repeat(8*1024*1024)},tool_output:'must not synthesize'});
  const files=readdirSync(join(daemonDir(),'inbox'));expect(files).toHaveLength(1);expect(readFileSync(join(daemonDir(),'inbox',files[0]!)).length).toBeLessThan(4096);
  await f.start();await until(()=>f.batches.length>0);await f.stop();
  const events=f.batches.flatMap((batch:any)=>batch.events);expect(events).toHaveLength(1);expect(events[0]).toMatchObject({kind:'hook',data:{captureStatus:'too_large',tool_use_id:'native-large'}});
}));
for(const harness of ['codex','antigravity'] as const)isolatedTest(harness+' oversized hook leaves the native source intact and reports a local error',async()=>fixture(async f=>{
  const config=nativeConfig(f,harness),path=harness==='codex'?join(config.roots.codex!,'sessions','rollout-large.jsonl'):join(config.roots.antigravity!,'antigravity-cli','brain','large','.system_generated','logs','transcript.jsonl');mkdirSync(dirname(path),{recursive:true});writeFileSync(path,'native source retained');
  const before=readFileSync(path),requests=f.requests;
  const event=harness==='codex'?{session_id:'large',transcript_path:path,hook_event_name:'PostToolUse',tool_input:'x'.repeat(8*1024*1024)}:{conversationId:'large',transcriptPath:path,hookEventName:'PostToolUse',toolCall:{args:'x'.repeat(8*1024*1024)}};
  const child=Bun.spawn([process.execPath,resolve(import.meta.dir,'../src/cli.ts'),'collect','hook','--harness',harness],{env:process.env,stdin:new Blob([JSON.stringify(event)]),stdout:'pipe',stderr:'pipe'});
  const [exit,,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(exit).toBe(0);expect(stderr).toBe('');
  expect(JSON.parse(readFileSync(join(captureDir(),'last-error.json'),'utf8'))).toMatchObject({code:'CAPTURE_HOOK_TOO_LARGE'});
  expect(existsSync(join(daemonDir(),'inbox'))?readdirSync(join(daemonDir(),'inbox')):[]).toEqual([]);expect(f.requests).toBe(requests);expect(readFileSync(path)).toEqual(before);
}));

isolatedTest('Cursor consent stays unpublished until every existing session boundary is durable',async()=>fixture(async f=>{
  const root=join(f.dir,'cursor');process.env.CURSOR_CONFIG_DIR=root;
  const file=(id:string)=>join(root,'projects','project','agent-transcripts',id,id+'.jsonl'),line=(text:string)=>JSON.stringify({role:'user',message:{content:[{type:'text',text}]}})+'\n';
  for(const id of ['a-first','z-later']){mkdirSync(dirname(file(id)),{recursive:true});writeFileSync(file(id),line('PRIVATE PREFIX '+id));}
  // Keep the existing Claude worker live while enrollment blocks on a later
  // Cursor session. Its hooks must still see the previous Cursor opt-out.
  await f.start();let installing!:Promise<unknown>;
  await withSessionLock('capture:cursor:z-later',async()=>{
    installing=installCapture(f.api,{home:f.dir,command:[],harnesses:['claude-code','cursor'],historyHarnesses:[],selectionMode:'replace',hookOwnership:'plugin',daemon:true,daemonService:false});
    await until(()=>existsSync(join(captureDir(),'state','cursor-'+hash('a-first')+'.json')));
    expect(readCaptureConfig()?.harnesses).toEqual(['claude-code']);
    expect(recordNativeDaemonHook('cursor',{conversation_id:'z-later',transcript_path:file('z-later'),hook_event_name:'sessionStart'})).toBe(false);
    f.event();await until(()=>readdirSync(join(captureDir(),'queue')).some(name=>JSON.parse(readFileSync(join(captureDir(),'queue',name),'utf8')).harness==='claude-code'));
    expect(f.batches.some((batch:any)=>batch.harness==='cursor')).toBe(false);
  });
  await installing;await f.stop();await f.start();appendFileSync(file('z-later'),line('APPROVED AFTER PUBLICATION'));
  recordNativeDaemonHook('cursor',{conversation_id:'z-later',transcript_path:file('z-later'),hook_event_name:'sessionStart'});
  await until(()=>JSON.stringify(f.batches).includes('APPROVED AFTER PUBLICATION'));await f.stop();
  expect(JSON.stringify(f.batches)).not.toContain('PRIVATE PREFIX');expect(readCaptureConfig()?.historyHarnesses).toEqual([]);
}));

isolatedTest('Cursor same-selection native-root and authenticated-scope changes refresh consent boundaries',async()=>fixture(async f=>{
  const original=nativeConfig(f,'cursor'),newRoot=join(f.dir,'new-cursor');process.env.CURSOR_CONFIG_DIR=newRoot;
  const file=join(newRoot,'projects','project','agent-transcripts','same-id','same-id.jsonl'),line=(text:string)=>JSON.stringify({role:'user',message:{content:[{type:'text',text}]}})+'\n';mkdirSync(dirname(file),{recursive:true});writeFileSync(file,line('PRIVATE NEW ROOT PREFIX'));
  await installCapture(f.api,{home:f.dir,command:[],harnesses:['cursor'],historyHarnesses:[],selectionMode:'replace',hookOwnership:'plugin',daemon:true,daemonService:false});
  const state=join(captureDir(),'state','cursor-'+hash('same-id')+'.json');expect(JSON.parse(readFileSync(state,'utf8')).offset).toBe(readFileSync(file).length);
  // An empty old destination can be replaced, but its native prefix is not
  // historical consent for the newly authenticated owner.
  atomicJson(join(captureDir(),'config.json'),{...readCaptureConfig()!,owner:{tenantId:'previous',userId:'previous'}});
  appendFileSync(file,line('PRIVATE PRIOR OWNER PREFIX'));
  await installCapture(f.api,{home:f.dir,command:[],harnesses:['cursor'],historyHarnesses:[],selectionMode:'replace',hookOwnership:'plugin',daemon:true,daemonService:false});
  expect(JSON.parse(readFileSync(state,'utf8')).offset).toBe(readFileSync(file).length);
  appendFileSync(file,line('NEW OWNER APPROVED'));recordNativeDaemonHook('cursor',{conversation_id:'same-id',transcript_path:file,hook_event_name:'sessionStart'});await f.start();await until(()=>JSON.stringify(f.batches).includes('NEW OWNER APPROVED'));await f.stop();
  expect(JSON.stringify(f.batches)).not.toContain('PRIVATE');expect(readCaptureConfig()).toMatchObject({installationId:original.installationId,owner:original.owner,harnesses:['cursor'],historyHarnesses:[]});
}));

isolatedTest('a destination switch refuses work that arrived while consent boundaries were being saved',async()=>fixture(async f=>{
  const old={...readCaptureConfig()!,owner:{tenantId:'previous',userId:'previous'}};atomicJson(join(captureDir(),'config.json'),old);const configBefore=readFileSync(join(captureDir(),'config.json'),'utf8');
  const root=join(f.dir,'cursor');process.env.CURSOR_CONFIG_DIR=root;
  for(const id of ['a-first','z-later']){const file=join(root,'projects','project','agent-transcripts',id,id+'.jsonl');mkdirSync(dirname(file),{recursive:true});writeFileSync(file,'private unparsed prefix\n');}
  f.fail=true;await f.start();let installing!:Promise<unknown>;
  await withSessionLock('capture:cursor:z-later',async()=>{
    installing=installCapture(f.api,{home:f.dir,command:[],harnesses:['claude-code','cursor'],historyHarnesses:[],selectionMode:'replace',hookOwnership:'plugin',daemon:true,daemonService:false});
    await until(()=>existsSync(join(captureDir(),'state','cursor-'+hash('a-first')+'.json')));
    f.event();await until(()=>readdirSync(join(captureDir(),'queue')).length>0);
  });
  await expect(installing).rejects.toMatchObject({code:'CAPTURE_PENDING_DESTINATION'});await f.stop();
  expect(readFileSync(join(captureDir(),'config.json'),'utf8')).toBe(configBefore);
  const queue=readdirSync(join(captureDir(),'queue')).map(name=>JSON.parse(readFileSync(join(captureDir(),'queue',name),'utf8')));expect(queue.length).toBeGreaterThan(0);expect(queue.every(batch=>batch.owner.tenantId==='previous'&&batch.owner.userId==='previous'&&batch.installationId===old.installationId)).toBe(true);
}));

isolatedTest('native-root rebinding stops the old worker and holds old registrations before new enrollment',async()=>fixture(async f=>{
  f.event();await f.start();await until(()=>f.batches.length>0);
  const original=readCaptureConfig()!,root=join(f.dir,'new-claude'),path=join(root,'projects','fixture','new-session.jsonl');mkdirSync(dirname(path),{recursive:true});
  const next={...original,roots:{...original.roots,'claude-code':root}};
  atomicJson(join(captureDir(),'config.json'),next);
  await until(()=>JSON.parse(readFileSync(join(daemonDir(),'status.json'),'utf8')).state==='stopped');await f.stop();
  appendFileSync(f.path,f.record('must-remain-in-old-root'));
  await f.start();await until(()=>readdirSync(join(daemonDir(),'sessions')).some(name=>name.endsWith('.held')));
  writeFileSync(path,JSON.stringify({type:'user',uuid:'new-root-event',sessionId:'new-session',message:{role:'user',content:'new registered root'}})+'\n');
  recordDaemonHook({session_id:'new-session',transcript_path:path,hook_event_name:'SessionStart',cwd:f.dir});
  await until(()=>f.batches.some((batch:any)=>batch.events.some((event:any)=>event.nativeId==='new-root-event')));await f.stop();
  expect(f.batches.flatMap((batch:any)=>batch.events).some((event:any)=>event.nativeId==='must-remain-in-old-root')).toBe(false);
  expect(readCaptureConfig()).toEqual(next);
}));

isolatedTest('daemon status separates capture ingress startup held work and registered sessions',async()=>fixture(async f=>{
  f.event();const inbox=join(daemonDir(),'inbox'),sessions=join(daemonDir(),'sessions');mkdirSync(sessions,{recursive:true});
  for(const name of ['startup-queued.json','startup-bad.json.held','bad-capture.json.held'])writeFileSync(join(inbox,name),'unread metadata fixture');
  for(const name of ['active.json','old.json.held'])writeFileSync(join(sessions,name),'unread metadata fixture');
  mkdirSync(join(captureDir(),'notices'),{recursive:true});writeFileSync(join(captureDir(),'notices','legacy.json'),'unread metadata fixture');
  const before=f.requests,status=captureStatus({state:'not_applicable',total:0,pending:0,disabled:0});
  expect(status).toMatchObject({pendingHooks:2,pendingLegacyHooks:1,daemonIngress:{capture:1,startup:1,heldCapture:1,heldStartup:1,sessions:1,heldSessions:1}});expect(f.requests).toBe(before);
}));

isolatedTest('daemon operator flush and sync upload only queued batches and leave ingress and historical catalogs untouched',async()=>fixture(async f=>{
  const config=readCaptureConfig()!;await captureTranscript(config,'claude-code',f.path,{session_id:'session'});
  f.event();const inbox=join(daemonDir(),'inbox');writeFileSync(join(inbox,'startup-pending.json'),'retained startup');
  const notices=Object.fromEntries(readdirSync(inbox).map(name=>[name,readFileSync(join(inbox,name),'utf8')]));
  mkdirSync(join(captureDir(),'sources'),{recursive:true});const catalog=join(captureDir(),'sources','poison.json');writeFileSync(catalog,'invalid legacy catalog must not be read');
  mkdirSync(join(captureDir(),'notices'),{recursive:true});const legacy=join(captureDir(),'notices','poison.json');writeFileSync(legacy,'invalid legacy notice must not be read');
  const unrelated=join(dirname(f.path),'unregistered.jsonl');writeFileSync(unrelated,'invalid historical native transcript must not be parsed\n');
  utimesSync(unrelated,new Date(0),new Date(0));
  // Main operator paths stay in the real queue uploader; the unopened poisoned
  // registries make legacy drain/reconciliation fail if accidentally invoked.
  const result=await flushCaptureWork();expect(result).toMatchObject({uploaded:1,mode:'daemon-queue-only',pendingHooks:2,daemonIngress:{capture:1,startup:1}});
  expect(f.batches.flatMap((batch:any)=>batch.events).map((event:any)=>event.nativeId)).toEqual(['one']);
  const synced=await syncCaptures();expect(synced).toMatchObject({uploaded:0,mode:'daemon-queue-only',pendingHooks:2,daemonIngress:{capture:1,startup:1}});
  expect(readFileSync(catalog,'utf8')).toBe('invalid legacy catalog must not be read');expect(readFileSync(legacy,'utf8')).toBe('invalid legacy notice must not be read');
  expect(Object.fromEntries(readdirSync(inbox).map(name=>[name,readFileSync(join(inbox,name),'utf8')]))).toEqual(notices);
}));

isolatedTest('Cursor rejects same-ID cross-project file and directory redirects even when the target project is excluded',async()=>fixture(async f=>{
  const config=nativeConfig(f,'cursor'),root=config.roots.cursor!,session='same-session';
  const file=(project:string)=>join(root,'projects',project,'agent-transcripts',session,session+'.jsonl'),target=file('private-project'),source=file('public-project');mkdirSync(dirname(target),{recursive:true});mkdirSync(dirname(source),{recursive:true});
  writeFileSync(target,JSON.stringify({role:'user',message:{content:[{type:'text',text:'EXCLUDED PROJECT CONTENT'}]}})+'\n');
  const next={...config,exclusions:{projects:['/private-project'],sessions:[]}};atomicJson(join(captureDir(),'config.json'),next);
  symlinkSync(target,source);
  const notice={id:'redirect',at:new Date().toISOString(),harness:'cursor' as const,event:{conversation_id:session,workspace_roots:['/public-project'],transcript_path:source,hook_event_name:'sessionStart'}};
  await expect(captureCursorNotice(next,notice)).rejects.toMatchObject({code:'CAPTURE_PATH_REJECTED'});rmSync(source);rmSync(dirname(source),{recursive:true});symlinkSync(dirname(target),dirname(source));
  await expect(captureCursorNotice(next,notice)).rejects.toMatchObject({code:'CAPTURE_PATH_REJECTED'});
  expect(readdirSync(join(captureDir(),'queue'))).toEqual([]);expect(f.raws).toEqual([]);
}));

isolatedTest('Codex incremental identity validation reads a small header and grows only for a long first record',async()=>fixture(async f=>{
  const config=nativeConfig(f,'codex'),path=join(config.roots.codex!,'sessions','rollout-bounded-header.jsonl');mkdirSync(dirname(path),{recursive:true});
  const child=async(padding:number)=>{
    writeFileSync(path,JSON.stringify({type:'session_meta',payload:{id:'bounded-header',source:'cli',padding:'x'.repeat(padding)}})+'\n'+' '.repeat(2*1024*1024));
    const {statSync}=await import('node:fs'),stat=statSync(path);
    atomicJson(join(captureDir(),'state',hash('codex'+realpathSync(path))+'.json'),{offset:stat.size,ino:stat.ino,parserVersion:2,meta:{harness:'codex',sessionId:'bounded-header',origin:'cli',parentSessionId:null,sourcePath:path}});
    const runtime=JSON.stringify(resolve(import.meta.dir,'../src/capture/runtime.ts'));
    const code=`import {mock} from 'bun:test';import * as fs from 'node:fs';const originalOpen=fs.openSync,originalRead=fs.readSync;let target=-1;const work=[];mock.module('node:fs',()=>({...fs,openSync:(path,...args)=>{const fd=originalOpen(path,...args);if(String(path)===${JSON.stringify(realpathSync(path))})target=fd;return fd;},readSync:(fd,buffer,offset,length,position)=>{if(fd===target)work.push({length,position});return originalRead(fd,buffer,offset,length,position);}}));globalThis.fetch=()=>{throw Error('No network');};const {captureTranscript,readCaptureConfig}=await import(${runtime});await captureTranscript(readCaptureConfig(),'codex',${JSON.stringify(path)},{session_id:'bounded-header'},false,undefined,undefined,{sessionScoped:true});process.stdout.write(JSON.stringify(work));`;
    const proc=Bun.spawn([process.execPath,'-e',code],{env:process.env,stdout:'pipe',stderr:'pipe'});const [exit,stdout,stderr]=await Promise.all([proc.exited,new Response(proc.stdout).text(),new Response(proc.stderr).text()]);expect(exit).toBe(0);expect(stderr).toBe('');return JSON.parse(stdout) as {length:number;position:number}[];
  };
  expect(await child(0)).toEqual([{length:4096,position:0}]);
  const long=await child(12000);expect(long[0]).toEqual({length:4096,position:0});expect(long.reduce((sum,row)=>sum+row.length,0)).toBe(16384);expect(long).toHaveLength(3);
}));


isolatedTest('worker environment is rejected by the actual CLI before delegation or session startup when misplaced or malformed',async()=>fixture(async f=>{
  const module=(name:string)=>JSON.stringify(resolve(import.meta.dir,'../src/'+name)),preload=join(f.dir,'worker-preflight.ts'),flag=join(f.dir,'forbidden-preflight');
  writeFileSync(preload,`import {mock} from 'bun:test';import {writeFileSync} from 'node:fs';const fail=()=>{writeFileSync(${JSON.stringify(flag)},'unexpected');throw Error('forbidden');};
import * as distribution from ${module('distribution.ts')};mock.module(${module('distribution.ts')},()=>({...distribution,delegateToNewest:fail}));
import * as startup from ${module('session-start.ts')};mock.module(${module('session-start.ts')},()=>({...startup,sessionStartCommand:fail}));globalThis.fetch=fail;`);
  const before=readFileSync(join(captureDir(),'config.json'),'utf8'),requests=f.requests;
  for(const args of [['session','start','--worker-environment','{}'],['setup','status','--local','--worker-environment','{}'],['collect','daemon','--worker-environment','null'],['collect','daemon','--worker-environment','{"OPENCRAWL_TOKEN":"synthetic-never-adopt"}']]){
    const child=Bun.spawn([process.execPath,'--preload',preload,resolve(import.meta.dir,'../src/cli.ts'),...args],{env:process.env,stdout:'pipe',stderr:'pipe'});
    const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(exit).toBe(64);expect(stdout).toBe('');expect(stderr).toContain('environment');expect(stderr).not.toContain('synthetic-never-adopt');
  }
  expect(existsSync(flag)).toBe(false);expect(readFileSync(join(captureDir(),'config.json'),'utf8')).toBe(before);expect(f.requests).toBe(requests);
}));

isolatedTest('daemon operator retries rejected batches only on explicit request and paused sync retains queued bytes',async()=>fixture(async f=>{
  const config=readCaptureConfig()!;await captureTranscript(config,'claude-code',f.path,{session_id:'session'});
  const names=readdirSync(join(captureDir(),'queue')).filter(name=>name.endsWith('.json'));expect(names).toHaveLength(1);const name=names[0]!,file=join(captureDir(),'queue',name),bytes=readFileSync(file);
  atomicJson(join(captureDir(),'rejected',name),{status:413,digest:hash(bytes),at:new Date().toISOString()});
  await expect(flushCaptureWork()).rejects.toMatchObject({code:'CAPTURE_BATCH_REJECTED'});expect(f.raws).toEqual([]);expect(readFileSync(file)).toEqual(bytes);
  atomicJson(join(captureDir(),'config.json'),{...config,disabled:true});expect(await syncCaptures()).toMatchObject({uploaded:0,mode:'daemon-queue-only'});expect(f.raws).toEqual([]);expect(readFileSync(file)).toEqual(bytes);
  expect(await flushCaptureWork({retryRejected:true})).toMatchObject({uploaded:1,mode:'daemon-queue-only'});expect(f.batches.flatMap((batch:any)=>batch.events).map((event:any)=>event.nativeId)).toEqual(['one']);
}));

isolatedTest('Cursor permits a configured root symlink without permitting redirected project paths',async()=>fixture(async f=>{
  const config=nativeConfig(f,'cursor'),root=config.roots.cursor!,alias=join(f.dir,'cursor-root-link'),id='root-alias',file=join(root,'projects','project','agent-transcripts',id,id+'.jsonl');mkdirSync(dirname(file),{recursive:true});
  writeFileSync(file,JSON.stringify({role:'user',message:{content:[{type:'text',text:'approved root alias'}]}})+'\n');symlinkSync(root,alias);
  const next={...config,roots:{...config.roots,cursor:alias}};atomicJson(join(captureDir(),'config.json'),next);
  await captureCursorNotice(next,{id:'root-link',at:new Date().toISOString(),harness:'cursor',event:{conversation_id:id,transcript_path:join(alias,'projects','project','agent-transcripts',id,id+'.jsonl'),hook_event_name:'sessionStart'}});
  appendFileSync(file,JSON.stringify({role:'assistant',message:{content:[{type:'text',text:'canonical root spelling'}]}})+'\n');
  await captureCursorNotice(next,{id:'canonical-root',at:new Date().toISOString(),harness:'cursor',event:{conversation_id:id,transcript_path:realpathSync(file),hook_event_name:'sessionStart'}});
  const queued=readdirSync(join(captureDir(),'queue')).map(name=>JSON.parse(readFileSync(join(captureDir(),'queue',name),'utf8')));expect(JSON.stringify(queued)).toContain('approved root alias');expect(JSON.stringify(queued)).toContain('canonical root spelling');expect(queued.every(batch=>batch.sessionId===id)).toBe(true);
}));

isolatedTest('Devin daemon captures native delivery and repeated executions without a transcript or process lifetime',async()=>fixture(async f=>{
  nativeConfig(f,'devin');
  const event=(fields:any)=>recordNativeDaemonHook('devin',{session_id:'devin-cloud-session',cwd:f.dir,transcript_path:'/unrelated/must-not-open.jsonl',...fields},-1);
  event({hook_event_name:'UserPromptSubmit',prompt:'Cloud native prompt'});
  const execution={hook_event_name:'PostToolUse',tool_name:'exec',tool_input:{command:'printf repeated'},tool_response:{success:true,output:'Output from command in shell fixture:\nrepeated\nExit code: 7'}};
  event(execution);event(execution);
  event({hook_event_name:'PostToolUse',tool_name:'message_user',tool_input:{message:'Cloud final answer',block_on_user:true},tool_response:{success:true}});
  event({hook_event_name:'Stop',last_assistant_message:''});
  const notices=readdirSync(join(daemonDir(),'inbox')).map(name=>JSON.parse(readFileSync(join(daemonDir(),'inbox',name),'utf8')));
  expect(notices.every(notice=>notice.pid===undefined&&notice.owner.userId==='fixture'&&notice.installationId!== 'pending')).toBe(true);
  expect(notices.every(notice=>Number.isSafeInteger(notice.record.sequence)&&notice.record.sequence%3===0)).toBe(true);
  await f.start();await until(()=>JSON.stringify(f.batches).includes('Cloud final answer')&&readdirSync(join(daemonDir(),'inbox')).length===0);
  const events=f.batches.flatMap((batch:any)=>batch.events),results=events.filter((e:any)=>e.kind==='tool_result'&&e.data.name==='exec');
  expect(results).toHaveLength(2);expect(results[0].data.call_id).not.toBe(results[1].data.call_id);
  expect(results.every((event:any)=>event.data.is_error&&event.data.exit_code===7)).toBe(true);
  expect(events.filter((e:any)=>e.kind==='message').map((e:any)=>e.data.role).sort()).toEqual(['assistant','user']);
  expect(readdirSync(join(daemonDir(),'sessions'))).toHaveLength(0);
  expect(f.batches.every((batch:any)=>batch.harness==='devin'&&batch.sessionId==='devin-cloud-session'&&batch.origin==='cloud'&&batch.captureMode==='live')).toBe(true);
}));

// Devin Cloud's native overflow pool is Linux-only and rejects symlinked roots.
(process.platform==='win32'?test.skip:isolatedTest)('Devin overflow is recovered by the worker and sealed retry bytes survive restart',async()=>fixture(async f=>{
  nativeConfig(f,'devin');
  const path=join(homedir(),'.devin-files','devin-remote-overflows-'+process.getuid?.(),'shell-test','content.txt');
  mkdirSync(dirname(path),{recursive:true});writeFileSync(path,'before handoff');
  recordNativeDaemonHook('devin',{session_id:'devin-overflow',hook_event_name:'PostToolUse',tool_name:'exec',tool_response:{success:true,output:'truncated',overflow_path:path}});
  const file=join(daemonDir(),'inbox',readdirSync(join(daemonDir(),'inbox'))[0]!);
  expect(readFileSync(file,'utf8')).not.toContain('before handoff');
  writeFileSync(path,'worker recovered full output');f.fail=true;
  await f.start();await until(()=>f.raws.length>0);await f.stop();
  const first=f.raws[0];expect(first).toContain('worker recovered full output');expect(first).not.toContain('truncated');
  writeFileSync(path,'changed after durable spool');f.fail=false;await f.start();
  await until(()=>readdirSync(join(captureDir(),'queue')).length===0&&f.batches.length>0);
  expect(f.raws.filter((raw:string)=>raw===first).length).toBeGreaterThanOrEqual(2);
  expect(JSON.stringify(f.batches)).not.toContain('changed after durable spool');
}));

isolatedTest('Devin refuses unbound hooks and holds an inbox from another installation',async()=>fixture(async f=>{
  const config=nativeConfig(f,'devin'),file=join(captureDir(),'config.json');
  writeFileSync(file,JSON.stringify({...config,authPending:true,installationId:'pending'}));
  const event={session_id:'devin-bound',hook_event_name:'UserPromptSubmit',prompt:'must stay with original owner'};
  recordNativeDaemonHook('devin',event);expect(existsSync(join(daemonDir(),'inbox'))?readdirSync(join(daemonDir(),'inbox')):[]).toHaveLength(0);
  writeFileSync(file,JSON.stringify(config));recordNativeDaemonHook('devin',event);
  const notice=join(daemonDir(),'inbox',readdirSync(join(daemonDir(),'inbox'))[0]!);
  writeFileSync(file,JSON.stringify({...config,installationId:'replacement'}));
  await f.start();await until(()=>existsSync(notice+'.held'));expect(f.batches).toHaveLength(0);
}));

isolatedTest('Devin rechecks enrollment and consent after asynchronous overflow recovery',async()=>fixture(async f=>{
  const config=nativeConfig(f,'devin'),file=join(captureDir(),'config.json');
  const notice={id:'config-race',at:new Date().toISOString(),sequence:3,harness:'devin' as const,event:{session_id:'devin-race',hook_event_name:'PostToolUse',tool_name:'exec',tool_response:{success:true,output:'must not queue',overflow_path:'/outside/content.txt'}}};
  for(const replacement of [{...config,owner:{tenantId:'another',userId:'another'}},{...config,harnesses:[]},null]){
    writeFileSync(file,JSON.stringify(config));const pending=spoolDaemonEvent(config,notice);
    if(replacement)writeFileSync(file,JSON.stringify(replacement));else rmSync(file);
    await expect(pending).rejects.toHaveProperty('code',replacement?.harnesses?.length===0?'CAPTURE_CONSENT_CHANGED':'CAPTURE_CONFIG_CHANGED');
    expect(readdirSync(join(captureDir(),'queue'))).toHaveLength(0);
  }
  writeFileSync(file,JSON.stringify(config));
}));

isolatedTest('Devin native hook returns after bounded local handoff while the configuration lock is held',async()=>fixture(async f=>{
  nativeConfig(f,'devin');
  await withSessionLock('capture:configuration',async()=>{
    const child=Bun.spawn([process.execPath,resolve(import.meta.dir,'../src/cli.ts'),'collect','hook','--harness','devin'],{env:process.env,stdin:'pipe',stdout:'pipe',stderr:'pipe'});
    child.stdin.write(JSON.stringify({session_id:'devin-fast',hook_event_name:'UserPromptSubmit',prompt:'bounded Cloud hook'})+'\n');
    try{
      const code=await Promise.race([child.exited,sleep(1500).then(()=>{throw Error('Hook waited with stdin left open');})]);
      expect(code).toBe(0);expect(await new Response(child.stdout).text()).toBe('');expect(await new Response(child.stderr).text()).toBe('');
      expect(readdirSync(join(daemonDir(),'inbox'))).toHaveLength(1);
    }finally{child.stdin.end();child.kill();await child.exited;}
  });
}));

isolatedTest('migrated Cursor daemon uploads late legacy hook notices while excluding the old worker',async()=>fixture(async f=>{
  const {upgradeCaptureDaemon}=await import('../src/capture/daemon-upgrade.ts');
  const {awaitDaemonActivation,waitForDaemonReady}=await import('../src/capture/daemon-bootstrap.ts');
  const config=nativeConfig(f,'cursor');delete config.captureWorker;delete config.claudeCapture;
  atomicJson(join(captureDir(),'config.json'),config);
  let started:Promise<void>|undefined;
  const upgraded=await upgradeCaptureDaemon({install:async()=>{
    started=awaitDaemonActivation({pollMs:1}).then(async activated=>{if(activated)await f.start();});return {supervised:true};
  },ready:stage=>waitForDaemonReady(stage,1000),cleanup:()=>{}});
  expect(upgraded.state).toBe('activated');await started;
  await expect(withSessionLock('capture:worker',async()=>{},0)).rejects.toMatchObject({code:'SESSION_BUSY'});
  const notice={id:'late-native-cursor',at:new Date().toISOString(),sequence:50,harness:'cursor',event:{conversation_id:'late-session',hook_event_name:'beforeSubmitPrompt',prompt:'late migration capture survives'}};
  atomicJson(join(captureDir(),'notices',notice.id+'.json'),notice);
  await until(()=>JSON.stringify(f.batches).includes('late migration capture survives'));
  expect(existsSync(join(captureDir(),'notices',notice.id+'.json'))).toBe(false);
  await f.stop();
}));

isolatedTest('Claude user prompt repairs a missed initial session notice without scanning history',async()=>fixture(async f=>{
  const line=(id:string)=>JSON.stringify({...JSON.parse(f.record(id)),timestamp:new Date().toISOString()})+'\n';
  writeFileSync(f.path,line('one'));
  const inactive=new Date(Date.now()-60_000);utimesSync(f.path,inactive,inactive);
  await f.start();
  appendFileSync(f.path,line('recovered-after-missed-start'));
  f.event('UserPromptSubmit');
  await until(()=>JSON.stringify(f.batches).includes('recovered-after-missed-start'));
  expect(JSON.stringify(f.batches)).toContain('synthetic one');
  await f.stop();
}));
