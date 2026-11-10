import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync,statSync,chmodSync,utimesSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {standaloneCapture} from '../../dist/src/sessions/standalone.mjs';
import {createLocalSessionStore} from '../../dist/src/sessions/local-store.mjs';
import {createSessionIngest} from '../../dist/src/sessions/ingest.mjs';
import {transcriptEntries} from '../../dist/src/sessions/library.mjs';
import {batchDocuments} from '../../dist/src/sessions/indexer.mjs';
import {createOnboardingStatus} from '../../dist/src/onboarding-status.mjs';
import {installCapture,uninstallCapture} from '../src/capture/install.ts';
import {captureHook,captureDir,captureStatus,readCaptureConfig,drainCaptureNotices,hookFlush,bindHookIdentity,syncCaptures} from '../src/capture/runtime.ts';
import {saveSession,readSession,withSessionLock} from '../src/session.ts';
import {excludeCapture} from '../src/capture/controls.ts';
import {grokBotEvents,grokBotSession,grokBotResponse,GROK_BOT_HOOK_EVENTS} from '../src/capture/grok-bot.ts';
import {hash} from '../src/capture/parse.ts';

// Payload shapes follow Cursor's published hook reference, which Grok Bot's
// cloud computer loads from ~/.cursor/hooks.json. Content is synthetic.
const base={conversation_id:'6f1c2d3e-0000-4000-8000-bot-conversation',generation_id:'gen-1',model:'grok-4.7-thinking',model_id:'grok-4.7',cursor_version:'3.1.0',workspace_roots:['/home/bot/expenses'],user_email:'owner@example.com',transcript_path:null};
const hook=(name:string,fields:Record<string,unknown>={})=>({...base,hook_event_name:name,...fields});
const notice=(event:any,sequence=10)=>({id:'notice',at:'2026-11-10T12:00:00.000Z',sequence,event});

test('Grok Bot hook payloads become message, reasoning, tool and compaction events',()=>{
  const prompt=grokBotEvents(notice(hook('beforeSubmitPrompt',{prompt:'Expense the conference pass',attachments:[{type:'file',file_path:'/home/bot/expenses/policy.md'},{type:'rule'}]})));
  expect(prompt).toEqual([{id:'notice',kind:'message',sequence:10,timestamp:'2026-11-10T12:00:00.000Z',nativeId:null,parentId:null,turnId:'gen-1',agentId:null,
    data:{role:'user',content:[{type:'text',text:'Expense the conference pass'}],attachments:[{type:'file',file_path:'/home/bot/expenses/policy.md'}]}}]);
  expect(grokBotEvents(notice(hook('afterAgentResponse',{text:'Booked and logged.'})))[0]).toMatchObject({kind:'message',data:{role:'assistant',content:[{type:'text',text:'Booked and logged.'}],model:'grok-4.7'}});
  expect(grokBotEvents(notice(hook('afterAgentThought',{text:'Check last year first.',duration_ms:900})))[0]).toMatchObject({kind:'reasoning_summary',data:{summary:[{type:'summary_text',text:'Check last year first.'}],duration_ms:900}});
  const [call,result]=grokBotEvents(notice(hook('postToolUse',{tool_name:'Shell',tool_input:{command:'npm test'},tool_output:'{"exitCode":0,"stdout":"All tests passed"}',tool_use_id:'tool-1',cwd:'/home/bot/expenses',duration:5432})));
  expect(call).toMatchObject({id:'notice:call',kind:'tool_call',sequence:10,nativeId:'tool-1',data:{type:'tool_use',name:'Shell',input:{command:'npm test'},call_id:'tool-1'}});
  expect(result).toMatchObject({id:'notice:result',kind:'tool_result',sequence:11,nativeId:'tool-1',data:{type:'tool_result',name:'Shell',call_id:'tool-1',output:{exitCode:0,stdout:'All tests passed'},duration_ms:5432}});
  const failed=grokBotEvents(notice(hook('postToolUseFailure',{tool_name:'Shell',tool_input:{command:'npm test'},tool_use_id:'tool-2',error_message:'Command timed out after 30s',failure_type:'timeout',duration:30000,is_interrupt:false})))[1];
  expect(failed.data).toEqual({type:'tool_result',name:'Shell',call_id:'tool-2',output:'Command timed out after 30s',is_error:true,failure_type:'timeout',is_interrupt:false,duration_ms:30000});
  expect(grokBotEvents(notice(hook('preCompact',{trigger:'auto',context_usage_percent:85,messages_to_compact:30})))[0]).toMatchObject({kind:'compaction',data:{trigger:'auto',context_usage_percent:85,messages_to_compact:30}});
  // Lifecycle hooks and unusable payloads are retained as evidence, never indexed as conversation.
  for(const event of [hook('stop',{status:'completed',loop_count:0}),hook('sessionStart',{session_id:base.conversation_id}),hook('beforeSubmitPrompt',{prompt:'  '}),hook('postToolUse',{tool_output:'orphan'})])
    expect(grokBotEvents(notice(event)).map(e=>e.kind)).toEqual(['hook']);
  // Rendered and indexed by the same server code as Claude Code and Codex events.
  expect(transcriptEntries(prompt[0])).toEqual([{type:'message',role:'user',text:'Expense the conference pass'}]);
  expect(transcriptEntries(call)).toEqual([{type:'tool_call',name:'Shell',input:'{\n  "command": "npm test"\n}',truncated:false}]);
  expect(transcriptEntries(failed)).toEqual([{type:'tool_result',text:'Command timed out after 30s',truncated:false}]);
});

test('a Grok Bot session is one Bot on one UTC day, or a workspace and day when the runtime sends no ID',()=>{
  const at='2026-11-10T23:59:59.000Z';
  // A Bot keeps one conversation ID for life; a day bounds the session.
  expect(grokBotSession(hook('stop'),at)).toMatchObject({sessionId:base.conversation_id+':2026-11-10',conversationId:base.conversation_id,identified:true,cwd:'/home/bot/expenses',version:'3.1.0',title:null});
  expect(grokBotSession(hook('stop'),'2026-11-11T00:00:00.000Z').sessionId).toBe(base.conversation_id+':2026-11-11');
  expect(grokBotSession({session_id:'only-session',hook_event_name:'sessionStart'},at).sessionId).toBe('only-session:2026-11-10');
  expect(grokBotSession(hook('stop',{conversation_id:'has spaces / slashes'}),at).sessionId).toMatch(/^conversation-[a-f0-9]{32}:2026-11-10$/);
  const long=grokBotSession(hook('stop',{conversation_id:'x'.repeat(400)}),at);
  expect(long.sessionId).toMatch(/^conversation-[a-f0-9]{32}:2026-11-10$/);expect(long.conversationId).toBeNull();
  const blank=hook('postToolUse',{conversation_id:'',session_id:'  ',cwd:'/home/bot/expenses/src'});
  const activity=grokBotSession(blank,at);
  expect(activity).toMatchObject({identified:false,cwd:'/home/bot/expenses/src',title:'Grok Bot activity in expenses on 2026-11-10'});
  expect(activity.sessionId).toBe('activity-'+hash('/home/bot/expenses').slice(0,16)+'-2026-11-10');
  expect(grokBotSession(blank,'2026-11-11T00:00:00.000Z').sessionId).not.toBe(activity.sessionId);
  expect(grokBotSession({...blank,workspace_roots:['/home/bot/travel']},at).sessionId).not.toBe(activity.sessionId);
  expect(grokBotSession({hook_event_name:'postToolUse'},at)).toMatchObject({identified:false,cwd:null,title:'Grok Bot activity in an unknown workspace on 2026-11-10'});
});

test('Grok Bot hook answers never withhold a permission',()=>{
  expect(grokBotResponse(hook('beforeSubmitPrompt'))).toEqual({continue:true});
  for(const name of ['preToolUse','subagentStart','beforeShellExecution','beforeMCPExecution','beforeReadFile'])expect(grokBotResponse(hook(name))).toEqual({permission:'allow'});
  for(const name of ['postToolUse','stop','sessionStart','afterAgentResponse','preCompact'])expect(grokBotResponse(hook(name))).toEqual({});
  expect(grokBotResponse(null)).toEqual({});
  // Registering a permission hook would let a capture failure block the Bot.
  for(const name of ['preToolUse','subagentStart','beforeShellExecution','beforeMCPExecution','beforeReadFile'])expect(GROK_BOT_HOOK_EVENTS as readonly string[]).not.toContain(name);
});

async function fixture(run:(f:any)=>Promise<void>) {
  const dir=mkdtempSync(join(tmpdir(),'opencrawl-grok-bot-')),saved={...process.env};
  const principal={tenantId:'tenant-test',userId:'user-test',name:'Bot Owner',email:'owner@example.com'},token='grok-bot-capture-token-0123456789012345';
  const store=createLocalSessionStore(join(dir,'objects')),ingest=createSessionIngest({store,onStored:undefined});
  const handler=standaloneCapture({token,principal,store,prefix:undefined,search:undefined}),batches:any[]=[];
  let uploads=0,fail=false,stall=false;
  const server=createServer(async(req,res)=>{
    if(req.url==='/api/sessions/batches'){
      uploads++;
      if(stall)return; // accept the request and never answer
      if(fail){req.resume();res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'BROKEN'}}));return;}
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const batch=JSON.parse(Buffer.concat(chunks).toString());batches.push(batch);
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({schemaVersion:1,data:await ingest.putBatch(principal,batch)}));return;
    }
    handler(req,res);
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const api='http://127.0.0.1:'+(server.address() as any).port;process.env.OPENCRAWL_API_URL=api;
  try {
    Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(dir,'config'),OPENCRAWL_SESSIONS_TOKEN:token,CLAUDE_CONFIG_DIR:join(dir,'claude'),CODEX_HOME:join(dir,'codex'),OPENCRAWL_NO_UPDATE:'1'});
    delete process.env.CLAUDE_CODE_REMOTE;
    await run({dir,api,principal,ingest,batches,hooksFile:join(dir,'.cursor','hooks.json'),install:()=>installCapture(api,{home:dir,command:[process.execPath,'-e',''],harnesses:['grok-bot']}),
      get uploads(){return uploads;},set fail(value:boolean){fail=value;},set stall(value:boolean){stall=value;}});
  } finally {
    try{await uninstallCapture(dir);}catch{}
    server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
    for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);rmSync(dir,{recursive:true,force:true});
  }
}

test('install adds passive Cursor-format hooks beside existing ones; repeat, rollback and uninstall leave them intact',async()=>fixture(async f=>{
  const other={command:'/opt/vendor/audit.sh --quiet',timeout:3,failClosed:false};
  mkdirSync(join(f.dir,'.cursor'));
  writeFileSync(f.hooksFile,JSON.stringify({version:1,hooks:{postToolUse:[other],preToolUse:[other]}}));
  chmodSync(join(f.dir,'.cursor'),0o755);chmodSync(f.hooksFile,0o644); // explicit: the process umask may be stricter
  const first=await f.install();
  // The directory and file belong to Grok Bot; their permissions are left alone.
  if(process.platform!=='win32'){expect(statSync(join(f.dir,'.cursor')).mode&0o777).toBe(0o755);expect(statSync(f.hooksFile).mode&0o777).toBe(0o644);}
  expect(first.harnesses).toEqual(['grok-bot']);expect(first.nextStep).toContain('newly created Bot');
  expect(readCaptureConfig()!.roots['grok-bot']).toBe(join(f.dir,'.cursor'));
  const installed=JSON.parse(readFileSync(f.hooksFile,'utf8'));
  expect(installed.version).toBe(1);
  expect(Object.keys(installed.hooks).sort()).toEqual([...GROK_BOT_HOOK_EVENTS,'preToolUse'].sort());
  expect(installed.hooks.preToolUse).toEqual([other]);expect(installed.hooks.postToolUse[0]).toEqual(other);
  const ours=installed.hooks.postToolUse[1];
  expect(Object.keys(ours).sort()).toEqual(['command','timeout']);expect(ours.timeout).toBe(30);
  // No shell syntax on a Bot's Linux computer: the command must also work when
  // split on spaces. Windows paths need quoting and are not a Grok Bot target.
  if(process.platform!=='win32')expect(ours.command).toBe([Bun.which('node'),join(captureDir(),'runner.cjs'),'collect','hook','--harness','grok-bot'].join(' '));
  expect(ours.command).toContain(join(captureDir(),'runner.cjs'));expect(ours.command.endsWith(' collect hook --harness grok-bot')).toBe(true);
  for(const event of GROK_BOT_HOOK_EVENTS)expect(installed.hooks[event].filter((entry:any)=>entry.command===ours.command)).toHaveLength(1);
  // Claude Code and Codex are untouched unless they are requested too.
  expect(readdirSync(f.dir)).not.toContain('claude');expect(readdirSync(f.dir)).not.toContain('codex');
  expect(first.nextStep).not.toContain('Neither Claude Code nor Codex');
  expect((await f.install()).installationId).toBe(first.installationId);
  expect(readFileSync(f.hooksFile,'utf8')).toBe(JSON.stringify(installed,null,2)+'\n');
  // An unknown file version is left exactly as found.
  const unsupported=JSON.stringify({version:2,hooks:{}});writeFileSync(f.hooksFile,unsupported);
  await expect(f.install()).rejects.toThrow('version 1');
  expect(readFileSync(f.hooksFile,'utf8')).toBe(unsupported);
  if(process.platform!=='win32'){expect(statSync(join(f.dir,'.cursor')).mode&0o777).toBe(0o755);expect(statSync(f.hooksFile).mode&0o777).toBe(0o644);}
  writeFileSync(f.hooksFile,JSON.stringify(installed));
  expect((await uninstallCapture(f.dir)).installed).toBe(false);
  expect(JSON.parse(readFileSync(f.hooksFile,'utf8'))).toEqual({version:1,hooks:{postToolUse:[other],preToolUse:[other]}});
  await captureHook('grok-bot',hook('stop'));expect(captureStatus().pendingHooks).toBe(0);
}));

test('a Bot conversation is recorded from hooks alone, uploaded at the turn boundary and readable by teammates',async()=>fixture(async f=>{
  await f.install();
  const image=Buffer.from('synthetic screenshot bytes');
  const turn=[
    hook('sessionStart',{session_id:base.conversation_id,is_background_agent:true}),
    hook('beforeSubmitPrompt',{prompt:'Sign me up for the same conference as last year'}),
    hook('afterAgentThought',{text:'Find the receipt first.',duration_ms:400}),
    hook('postToolUse',{tool_name:'MCP:gmail_search',tool_input:{query:'conference receipt'},tool_output:'{"redacted":true}',tool_use_id:'tool-1',duration:210}),
    hook('postToolUse',{tool_name:'Computer',tool_input:{action:'screenshot'},tool_output:JSON.stringify({content:[{type:'image',source:{type:'base64',media_type:'image/png',data:image.toString('base64')}}]}),tool_use_id:'tool-2',cwd:'/home/bot/expenses',duration:900}),
    hook('postToolUseFailure',{tool_name:'Shell',tool_input:{command:'curl https://intranet'},tool_use_id:'tool-3',error_message:'Network policy denied the request',failure_type:'permission_denied',duration:12}),
    hook('afterAgentResponse',{text:'You are registered. I logged the expense.'}),
  ];
  for(const event of turn){await captureHook('grok-bot',event);await hookFlush(event);}
  // The first hook passes once; later mid-turn hooks only hand off locally.
  expect(captureStatus().pendingHooks).toBe(turn.length-1);
  const stop=hook('stop',{status:'completed',loop_count:0});
  await captureHook('grok-bot',stop);await hookFlush(stop);
  expect(captureStatus()).toMatchObject({pendingHooks:0,queued:0,lastError:null});
  expect(f.batches).toHaveLength(2);
  const session=f.batches[0].sessionId;
  expect(session).toMatch(new RegExp('^'+base.conversation_id+':\\d{4}-\\d{2}-\\d{2}$'));
  expect(captureStatus().lastUpload).toMatchObject({harness:'grok-bot',sessionId:session,stored:true});
  for(const batch of f.batches as any[])expect(batch).toMatchObject({harness:'grok-bot',sessionId:session,conversationId:base.conversation_id,origin:'cloud',captureMode:'live',harnessVersion:'3.1.0',cwd:'/home/bot/expenses',owner:f.principal});
  const events:any[]=f.batches.flatMap((batch:any)=>batch.events).sort((a:any,b:any)=>a.sequence-b.sequence);
  expect(events.map(event=>event.kind)).toEqual(['hook','message','reasoning_summary','tool_call','tool_result','tool_call','tool_result','tool_call','tool_result','message','hook']);
  expect(events.every(event=>/^wire1:[a-f0-9]{64}$/.test(event.id))).toBe(true);expect(new Set(events.map(event=>event.id)).size).toBe(events.length);
  // Inline image bytes travel as an attachment, never as indexed base64 text.
  const attachments=f.batches.flatMap((batch:any)=>batch.attachments);
  expect(attachments).toEqual([expect.objectContaining({sha256:hash(image),size:image.length,mimeType:'image/png',status:'captured'})]);
  expect(JSON.stringify(f.batches)).not.toContain(image.toString('base64'));
  // The receiver stored what teammates read back, attributed to the computer's owner.
  const sent=f.batches[1],stored=await f.ingest.getBatch(f.principal,{harness:'grok-bot',installationId:sent.installationId,sessionId:sent.sessionId,batchId:hash(JSON.stringify(sent))});
  expect(stored?.owner.name).toBe('Bot Owner');
  expect(await f.ingest.getBatch({...f.principal,tenantId:'other-team'},{harness:'grok-bot',installationId:sent.installationId,sessionId:sent.sessionId,batchId:hash(JSON.stringify(sent))})).toBeNull();
  const entries=events.flatMap(event=>transcriptEntries(event));
  expect(entries.map(entry=>entry.type)).toEqual(['message','note','tool_call','tool_result','tool_call','tool_result','tool_call','tool_result','message']);
  expect(entries[0]).toEqual({type:'message',role:'user',text:'Sign me up for the same conference as last year'});
  expect(entries.at(-1)).toEqual({type:'message',role:'assistant',text:'You are registered. I logged the expense.'});
  const key=`capture-v1/tenants/${hash(f.principal.tenantId)}/users/${hash(f.principal.userId)}/grok-bot/${hash(sent.installationId)}/${hash(sent.sessionId)}/${hash(JSON.stringify(sent))}.json.gz`;
  const documents=batchDocuments({prefix:'capture-v1',key,batch:stored!,principal:f.principal}).map(item=>item.document);
  expect(documents.find(d=>d.kind==='tool_call'&&d.toolCallId==='tool-2')).toMatchObject({harness:'grok-bot',origin:'cloud',toolNames:['Computer'],role:null});
  expect(documents.find(d=>d.kind==='tool_result'&&d.toolCallId==='tool-2')?.attachments).toEqual([expect.objectContaining({sha256:hash(image)})]);
  expect(documents.find(d=>d.kind==='message'&&d.role==='assistant')?.text).toContain('I logged the expense.');
  expect(documents.some(d=>d.kind==='hook')).toBe(false);
  // Hook-derived capture has no transcript directory for sync to walk.
  expect(await syncCaptures()).toEqual({uploaded:0});
}));

test('tool-only runtimes without conversation IDs still produce a named, searchable activity log',async()=>fixture(async f=>{
  await f.install();
  const blank={conversation_id:'',generation_id:'',transcript_path:null};
  await captureHook('grok-bot',hook('postToolUse',{...blank,tool_name:'Shell',tool_input:{command:'ls'},tool_output:'{"exitCode":0}',tool_use_id:'a'}));
  await captureHook('grok-bot',hook('postToolUse',{...blank,tool_name:'Read',tool_input:{file_path:'notes.md'},tool_output:'"notes"',tool_use_id:'b',workspace_roots:['/home/bot/travel']}));
  expect(await drainCaptureNotices()).toBe(2);
  const queued=readdirSync(join(captureDir(),'queue')).map(name=>JSON.parse(readFileSync(join(captureDir(),'queue',name),'utf8')));
  expect(queued.map(batch=>batch.sessionId).sort()).toEqual([grokBotSession({workspace_roots:['/home/bot/expenses']},new Date().toISOString()).sessionId,grokBotSession({workspace_roots:['/home/bot/travel']},new Date().toISOString()).sessionId].sort());
  const expenses=queued.find(batch=>batch.cwd==='/home/bot/expenses');
  expect(expenses.originEvidence).toContain('without a conversation ID');
  expect(expenses.events.map((event:any)=>event.kind)).toEqual(['session_title','tool_call','tool_result']);
  expect(expenses.events[0].data.title).toMatch(/^Grok Bot activity in expenses on \d{4}-\d{2}-\d{2}$/);
  expect(expenses.events[1].turnId).toBeNull();
  // The title is the same event in every batch of the day, so repeats are idempotent.
  await captureHook('grok-bot',hook('postToolUse',{...blank,tool_name:'Shell',tool_input:{command:'pwd'},tool_output:'{"exitCode":0}',tool_use_id:'c'}));
  await drainCaptureNotices();
  const titles=readdirSync(join(captureDir(),'queue')).map(name=>JSON.parse(readFileSync(join(captureDir(),'queue',name),'utf8'))).filter(batch=>batch.cwd==='/home/bot/expenses').map(batch=>batch.events[0]);
  expect(titles).toHaveLength(2);expect(titles[0]).toEqual(titles[1]);
  // A recorded tool call proves live Grok Bot capture; other harnesses still need a message.
  const status=createOnboardingStatus({store:createLocalSessionStore(join(f.dir,'onboarding'))});
  await status.session(f.principal,{...expenses,harness:'codex'});expect((await status.read(f.principal)).session).toBeNull();
  await status.session(f.principal,expenses);expect((await status.read(f.principal)).session).toMatchObject({harness:'grok-bot'});
  const stop=hook('stop');await captureHook('grok-bot',stop);await hookFlush(stop);
  expect(captureStatus()).toMatchObject({pendingHooks:0,queued:0});
}));

test('uploads from hooks are bounded: a cadence mid-turn, a pass at each boundary, and a minute of backoff after a failure',async()=>fixture(async f=>{
  await f.install();
  let clock=Date.parse('2026-11-10T12:00:00Z');const now=()=>clock;
  const tool=(id:string)=>hook('postToolUse',{tool_name:'Shell',tool_input:{command:id},tool_output:'{}',tool_use_id:id}),stop=hook('stop');
  await captureHook('grok-bot',tool('one'));await hookFlush(tool('one'),{now});
  expect(f.uploads).toBe(1);
  clock+=19_000;await captureHook('grok-bot',tool('two'));await hookFlush(tool('two'),{now});
  expect(f.uploads).toBe(1);expect(captureStatus().pendingHooks).toBe(1);
  clock+=1_000;await hookFlush(tool('two'),{now});
  expect(f.uploads).toBe(2);
  await captureHook('grok-bot',stop);await hookFlush(stop,{now});
  expect(f.uploads).toBe(3);
  f.fail=true;
  await captureHook('grok-bot',stop);await expect(hookFlush(stop,{now})).rejects.toThrow('Capture request failed (500)');
  const failures=f.uploads;
  expect(JSON.parse(readFileSync(join(captureDir(),'hook-flush.json'),'utf8')).ok).toBe(false);
  clock+=59_000;await captureHook('grok-bot',stop);await hookFlush(stop,{now});
  expect(f.uploads).toBe(failures);expect(captureStatus().queued).toBeGreaterThan(0);
  // A second failure doubles the wait, so a receiver that stays down costs less and less.
  clock+=1_000;await expect(hookFlush(stop,{now})).rejects.toThrow('Capture request failed (500)');
  const again=f.uploads;expect(again).toBeGreaterThan(failures);
  clock+=119_000;await hookFlush(stop,{now});expect(f.uploads).toBe(again);
  f.fail=false;clock+=1_000;await hookFlush(stop,{now});
  expect(captureStatus()).toMatchObject({pendingHooks:0,queued:0});
  expect(JSON.parse(readFileSync(join(captureDir(),'hook-flush.json'),'utf8'))).toEqual({at:new Date(clock).toISOString(),ok:true});
}));

test('batches stay small enough for one pass, and a payload that cannot be spooled does not strand its neighbours',async()=>fixture(async f=>{
  await f.install();
  // A screenshot-heavy turn: twenty tool results, each with its own inline image.
  for(let n=0;n<20;n++)await captureHook('grok-bot',hook('postToolUse',{tool_name:'Computer',tool_input:{action:'screenshot',n},tool_use_id:'shot-'+n,
    tool_output:JSON.stringify({content:[{type:'image',source:{type:'base64',media_type:'image/png',data:Buffer.from('screenshot '+n).toString('base64')}}]})}));
  // JSON nested deeper than an event may be: once as an object, once as the usual string.
  let deep:any='leaf';for(let level=0;level<200;level++)deep={next:deep};
  await captureHook('grok-bot',hook('beforeSubmitPrompt',{prompt:'before the deep payload'}));
  await captureHook('grok-bot',hook('postToolUse',{tool_name:'Parse',tool_input:deep,tool_output:'{}',tool_use_id:'deep-object'}));
  await captureHook('grok-bot',hook('postToolUse',{tool_name:'Parse',tool_input:{file:'a.json'},tool_output:JSON.stringify(deep),tool_use_id:'deep-string'}));
  await captureHook('grok-bot',hook('afterAgentResponse',{text:'after the deep payload'}));
  expect(await drainCaptureNotices()).toBe(24);expect(captureStatus().pendingHooks).toBe(0);
  const queued=readdirSync(join(captureDir(),'queue')).map(name=>JSON.parse(readFileSync(join(captureDir(),'queue',name),'utf8')));
  expect(queued.length).toBeGreaterThanOrEqual(3);
  for(const batch of queued)expect(batch.attachments.length).toBeLessThanOrEqual(8);
  expect(queued.flatMap(batch=>batch.attachments)).toHaveLength(20);
  const events=queued.flatMap(batch=>batch.events);
  // The object that nests too deep is kept as evidence; the same JSON as text is an ordinary result.
  expect(events.find((event:any)=>event.kind==='hook')?.data).toMatchObject({captureStatus:'unsupported',tool_name:'Parse',tool_use_id:'deep-object'});
  expect(typeof events.find((event:any)=>event.kind==='tool_result'&&event.nativeId==='deep-string')?.data.output).toBe('string');
  expect(events.filter((event:any)=>event.kind==='message').map((event:any)=>event.data.content[0].text).sort()).toEqual(['after the deep payload','before the deep payload']);
  const stop=hook('stop');await captureHook('grok-bot',stop);await hookFlush(stop);
  expect(captureStatus()).toMatchObject({pendingHooks:0,queued:0,lastError:null});
}));

test('a computer prepared without sign-in records nothing until an identity is bound',async()=>fixture(async f=>{
  const token=process.env.OPENCRAWL_SESSIONS_TOKEN!;delete process.env.OPENCRAWL_SESSIONS_TOKEN;
  await installCapture(f.api,{home:f.dir,command:[process.execPath,'-e',''],harnesses:['grok-bot'],deferAuth:true});
  expect(captureStatus()).toMatchObject({authenticationPending:true,owner:null});
  let clock=Date.parse('2026-11-10T12:00:00Z');const now=()=>clock;
  const prompt=hook('beforeSubmitPrompt',{prompt:'said before anyone signed in'});
  // The same order as the hook command: bind, record, upload. With no sign-in
  // on the computer this is quiet and local: no request, no error, no backoff.
  const before=f.uploads;
  for(let n=0;n<3;n++){await bindHookIdentity(prompt,{now});await captureHook('grok-bot',prompt);await hookFlush(prompt,{now});}
  expect(captureStatus()).toMatchObject({pendingHooks:0,queued:0,authenticationPending:true,lastError:null});
  expect(existsSync(join(captureDir(),'notices'))&&readdirSync(join(captureDir(),'notices')).length>0).toBe(false);
  expect(existsSync(join(captureDir(),'hook-flush.json'))).toBe(false);expect(f.uploads).toBe(before);
  // The owner signs in (here: an upload credential appears). The very next hook binds and records.
  process.env.OPENCRAWL_SESSIONS_TOKEN=token;
  const later=hook('beforeSubmitPrompt',{prompt:'said after signing in'}),stop=hook('stop');
  await bindHookIdentity(later,{now});
  expect(captureStatus()).toMatchObject({authenticationPending:false,owner:{userId:f.principal.userId}});
  await captureHook('grok-bot',later);await captureHook('grok-bot',stop);await hookFlush(stop,{now});
  expect(captureStatus()).toMatchObject({pendingHooks:0,queued:0});
  const texts=f.batches.flatMap((batch:any)=>batch.events).filter((event:any)=>event.kind==='message').map((event:any)=>event.data.content[0].text);
  expect(texts).toEqual(['said after signing in']);
  expect(f.batches.every((batch:any)=>batch.owner.userId===f.principal.userId&&batch.installationId!=='pending')).toBe(true);
}));

test('an uploader lock that is merely busy is quiet; one that leaves old notices waiting is reported',async()=>fixture(async f=>{
  await f.install();
  const stop=hook('stop');await captureHook('grok-bot',stop);
  let release!:()=>void;const held=withSessionLock('capture:worker',()=>new Promise<void>(resolve=>{release=resolve;}));
  try {
    await hookFlush(stop);expect(captureStatus().pendingHooks).toBe(1);
    const notice=join(captureDir(),'notices',readdirSync(join(captureDir(),'notices'))[0]),old=new Date(Date.now()-11*60_000);
    utimesSync(notice,old,old);
    await expect(hookFlush(stop)).rejects.toMatchObject({code:'CAPTURE_UPLOADER_BUSY'});
  } finally {release();await held;}
  await hookFlush(stop);expect(captureStatus()).toMatchObject({pendingHooks:0,queued:0});
}));

test('excluded workspaces and oversized payloads never leave the computer',async()=>fixture(async f=>{
  await f.install();
  await excludeCapture('/home/bot/private');
  await captureHook('grok-bot',hook('beforeSubmitPrompt',{prompt:'private request',workspace_roots:['/home/bot/private/taxes']}));
  // With a project exclusion in place, an unknown working directory is excluded too.
  await captureHook('grok-bot',{hook_event_name:'beforeSubmitPrompt',conversation_id:'no-workspace',prompt:'unknown location'});
  expect(captureStatus().pendingHooks).toBe(0);
  // Excluding a Bot's conversation ID excludes every day of that Bot.
  await excludeCapture(undefined,base.conversation_id);
  await captureHook('grok-bot',hook('beforeSubmitPrompt',{prompt:'excluded Bot'}));
  expect(captureStatus().pendingHooks).toBe(0);
  await captureHook('grok-bot',hook('beforeSubmitPrompt',{conversation_id:'another-bot',prompt:'still recorded'}));
  expect(captureStatus().pendingHooks).toBe(1);await drainCaptureNotices();
  rmSync(join(captureDir(),'queue'),{recursive:true});mkdirSync(join(captureDir(),'queue'));
  await captureHook('grok-bot',hook('postToolUse',{conversation_id:'another-bot',tool_name:'Shell',tool_input:{command:'cat big'},tool_output:'x'.repeat(15*1024*1024+1),tool_use_id:'big',duration:5}));
  await drainCaptureNotices();
  const batch=JSON.parse(readFileSync(join(captureDir(),'queue',readdirSync(join(captureDir(),'queue'))[0]),'utf8'));
  expect(batch.events).toHaveLength(1);
  expect(batch.events[0]).toMatchObject({kind:'hook',data:{hook_event_name:'postToolUse',tool_name:'Shell',tool_use_id:'big',captureStatus:'too_large'}});
  expect(batch.events[0].data.bytes).toBeGreaterThan(15*1024*1024);expect(JSON.stringify(batch).length).toBeLessThan(2000);
  await expect(captureHook('grok-bot',['not','an','object'])).rejects.toThrow('not an object');
}));

test('the hook process always exits 0 with the answer Grok Bot expects, installed or not',async()=>fixture(async f=>{
  const cli=resolve(import.meta.dir,'../src/cli.ts');
  // Asynchronous, so this process can serve the receiver the hook uploads to.
  const run=async(input:string,env:Record<string,string>={})=>{
    const started=Date.now(),child=Bun.spawn(['bun',cli,'collect','hook','--harness','grok-bot'],{stdin:Buffer.from(input),stdout:'pipe',stderr:'pipe',env:{...process.env,...env}});
    const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    return {exit,stdout,stderr,ms:Date.now()-started};
  };
  // Before installation, and for input that is not JSON, the Bot is simply allowed to continue.
  expect(await run(JSON.stringify(hook('beforeSubmitPrompt',{prompt:'hello'})))).toMatchObject({exit:0,stdout:'{"continue":true}\n',stderr:''});
  expect(await run('not json')).toMatchObject({exit:0,stdout:'{}\n',stderr:''});
  expect(existsSync(join(captureDir(),'notices'))).toBe(false);
  await f.install();
  const recorded=await run(JSON.stringify(hook('postToolUse',{tool_name:'Shell',tool_input:{command:'date'},tool_output:'{"exitCode":0}',tool_use_id:'spawned'})));
  expect(recorded).toMatchObject({exit:0,stdout:'{}\n',stderr:''});
  expect(f.batches.flatMap((batch:any)=>batch.events).map((event:any)=>event.kind)).toEqual(['tool_call','tool_result']);
  // A missing sign-in is recorded for collect status; it never fails or blocks the hook.
  const signedOut=await run(JSON.stringify(hook('stop')),{OPENCRAWL_SESSIONS_TOKEN:''});
  expect(signedOut).toMatchObject({exit:0,stdout:'{}\n',stderr:''});
  rmSync(join(captureDir(),'receiver-token.json'),{force:true});
  const unauthenticated=await run(JSON.stringify(hook('stop')),{OPENCRAWL_SESSIONS_TOKEN:''});
  expect(unauthenticated).toMatchObject({exit:0,stdout:'{}\n',stderr:''});
  // Recorded and spooled locally; the batches wait for a sign-in.
  expect(captureStatus()).toMatchObject({pendingHooks:0,lastError:{code:'AUTH_REQUIRED'}});expect(captureStatus().queued).toBeGreaterThan(0);
  expect(Math.max(recorded.ms,signedOut.ms,unauthenticated.ms)).toBeLessThan(5000);
}),30_000);

test('a plain install that finds neither Claude Code nor Codex points the agent at the Grok Bot command',async()=>fixture(async f=>{
  // The setup prompt is the same for every agent. A Bot that runs the plain
  // command on its computer must be told, in the output it reads, what to run.
  const path=process.env.PATH,node=Bun.which('node')!;
  try {
    process.env.PATH=join(node,'..'); // no claude or codex command, and their directories do not exist yet
    const plain=await installCapture(f.api,{home:f.dir,command:[process.execPath,'-e','']});
    expect(plain.harnesses).toEqual(['claude-code','codex']);
    expect(plain.nextStep).toContain('Neither Claude Code nor Codex was found on this machine.');
    expect(plain.nextStep).toContain('opencrawl collect install --yes --harness grok-bot');
    expect(existsSync(f.hooksFile)).toBe(false);
    // Once either agent has a directory here, a plain install says nothing about Grok Bot.
    expect((await installCapture(f.api,{home:f.dir,command:[process.execPath,'-e','']})).nextStep).not.toContain('Grok Bot');
    // Following the pointer adds the Bot's hooks beside the ones already installed.
    const added=await f.install();
    expect(added.harnesses).toEqual(['claude-code','codex','grok-bot']);expect(added.nextStep).not.toContain('Neither Claude Code nor Codex');
    expect(JSON.parse(readFileSync(f.hooksFile,'utf8')).hooks.stop).toHaveLength(1);
  } finally {process.env.PATH=path;}
}));

test('Claude Code and Codex hooks stand aside when a Cursor-format runtime runs them',async()=>fixture(async f=>{
  // Cursor, and so Grok Bot, also loads ~/.claude/settings.json hooks and waits on them.
  await installCapture(f.api,{home:f.dir,command:[process.execPath,'-e','']});
  const cli=resolve(import.meta.dir,'../src/cli.ts');
  const run=async(args:string[],event:any)=>{
    const started=Date.now(),child=Bun.spawn(['bun',cli,'collect','hook',...args],{stdin:Buffer.from(JSON.stringify(event)),stdout:'pipe',stderr:'pipe',env:{...process.env}});
    const [exit,stdout]=await Promise.all([child.exited,new Response(child.stdout).text()]);
    return {exit,stdout,ms:Date.now()-started};
  };
  const cursor={...hook('postToolUse',{tool_name:'Shell',tool_input:{command:'ls'},tool_output:'{}',tool_use_id:'x'}),session_id:'cursor-session'};
  // The managed hook would otherwise hold the Bot for as long as its uploader stays alive.
  for(const harness of ['claude-code','codex'])expect(await run(['--managed','--harness',harness],cursor)).toMatchObject({exit:0,stdout:''});
  expect(captureStatus().pendingHooks).toBe(0);
  // The same hook still records a native session.
  expect(await run(['--harness','claude-code'],{session_id:'claude-session',hook_event_name:'PostToolUse'})).toMatchObject({exit:0});
  expect(captureStatus().pendingHooks).toBe(1);
}),30_000);

test('the hook answers as soon as the payload arrives, even if the runtime keeps the pipe open',async()=>fixture(async f=>{
  await f.install();
  const started=Date.now(),child=Bun.spawn(['bun',resolve(import.meta.dir,'../src/cli.ts'),'collect','hook','--harness','grok-bot'],{stdin:'pipe',stdout:'pipe',stderr:'pipe',env:{...process.env}});
  child.stdin.write(JSON.stringify(hook('beforeSubmitPrompt',{prompt:'pipe stays open'})));child.stdin.flush();
  const [exit,stdout]=await Promise.all([child.exited,new Response(child.stdout).text()]);
  expect({exit,stdout}).toEqual({exit:0,stdout:'{"continue":true}\n'});expect(Date.now()-started).toBeLessThan(4000);
  expect(f.batches.flatMap((batch:any)=>batch.events).map((event:any)=>event.kind)).toEqual(['message']);
}),30_000);

test('a sign-in renewal in flight at the deadline is saved before the hook exits',async()=>{
  // A refresh token is single-use: exiting after the server rotated it would lose the sign-in.
  const dir=mkdtempSync(join(tmpdir(),'opencrawl-grok-bot-renew-')),saved={...process.env},owner={tenantId:'team',userId:'owner'};
  let refreshes=0,delay=0,uploaded=0;
  const server=createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/token'){refreshes++;const issued=refreshes;await new Promise(resolve=>setTimeout(resolve,delay));res.end(JSON.stringify({access_token:'access-'+issued,refresh_token:'refresh-'+issued,expires_in:3600}));return;}
    if(req.url==='/api/sessions/identity'){res.end(JSON.stringify({data:{principal:owner}}));return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    if(req.url==='/api/sessions/batches'){uploaded++;res.end(JSON.stringify({data:{stored:true,batchId:hash(Buffer.concat(chunks).toString())}}));return;}
    res.statusCode=404;res.end('{}');
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const api='http://127.0.0.1:'+(server.address() as any).port;process.env.OPENCRAWL_API_URL=api;
  try {
    for(const key of ['OPENCRAWL_SESSIONS_TOKEN','OPENCRAWL_TOKEN','CLAUDE_CODE_REMOTE'])delete process.env[key];
    Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(dir,'config'),CLAUDE_CONFIG_DIR:join(dir,'claude'),CODEX_HOME:join(dir,'codex'),OPENCRAWL_NO_UPDATE:'1'});
    const auth={clientId:'public',deviceAuthorizationEndpoint:api+'/device',tokenEndpoint:api+'/token'};
    await saveSession(api,{auth,accessToken:'access-0',refreshToken:'refresh-0',expiresAt:Date.now()+3600_000} as any);
    await installCapture(api,{home:dir,command:[process.execPath,'-e',''],harnesses:['grok-bot']});
    // The access token has expired and the token endpoint is slower than the hook's five seconds.
    await saveSession(api,{...readSession(api)!,expiresAt:Date.now()-1000});delay=6000;
    const started=Date.now(),child=Bun.spawn(['bun',resolve(import.meta.dir,'../src/cli.ts'),'collect','hook','--harness','grok-bot'],{stdin:Buffer.from(JSON.stringify(hook('stop'))),stdout:'pipe',stderr:'pipe',env:{...process.env}});
    const [exit,stdout]=await Promise.all([child.exited,new Response(child.stdout).text()]);
    expect({exit,stdout}).toEqual({exit:0,stdout:'{}\n'});
    expect(Date.now()-started).toBeGreaterThanOrEqual(6000);expect(refreshes).toBe(1);
    expect(readSession(api)).toMatchObject({accessToken:'access-1',refreshToken:'refresh-1'});
    // The pass itself was cut off and says so; the next due pass uploads with the saved sign-in.
    expect(captureStatus().lastError?.code).toBe('CAPTURE_HOOK_DEADLINE');expect(uploaded).toBe(0);
    delay=0;rmSync(join(captureDir(),'hook-flush.json'));
    const next=Bun.spawn(['bun',resolve(import.meta.dir,'../src/cli.ts'),'collect','hook','--harness','grok-bot'],{stdin:Buffer.from(JSON.stringify(hook('stop'))),stdout:'pipe',stderr:'pipe',env:{...process.env}});
    expect(await next.exited).toBe(0);
    expect(refreshes).toBe(1);expect(uploaded).toBeGreaterThan(0);expect(captureStatus()).toMatchObject({pendingHooks:0,queued:0,lastError:null});
  } finally {
    server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
    for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);rmSync(dir,{recursive:true,force:true});
  }
},30_000);

test('a receiver that never answers costs the Bot five seconds once, then a minute of local-only hooks',async()=>fixture(async f=>{
  const cli=resolve(import.meta.dir,'../src/cli.ts');
  const run=async(event:any)=>{
    const started=Date.now(),child=Bun.spawn(['bun',cli,'collect','hook','--harness','grok-bot'],{stdin:Buffer.from(JSON.stringify(event)),stdout:'pipe',stderr:'pipe',env:{...process.env}});
    const [exit,stdout]=await Promise.all([child.exited,new Response(child.stdout).text()]);
    return {exit,stdout,ms:Date.now()-started};
  };
  await f.install();f.stall=true;
  const stalled=await run(hook('stop'));
  expect(stalled).toMatchObject({exit:0,stdout:'{}\n'});
  expect(stalled.ms).toBeGreaterThanOrEqual(4500);expect(stalled.ms).toBeLessThan(8000);
  expect(captureStatus().queued).toBe(1);expect(f.uploads).toBe(1);
  // The cut-off pass counts as a failure: the next boundary does not try again yet.
  const next=await run(hook('stop'));
  expect(next).toMatchObject({exit:0,stdout:'{}\n'});expect(next.ms).toBeLessThan(2000);
  expect(f.uploads).toBe(1);expect(captureStatus()).toMatchObject({pendingHooks:1,queued:1});
}),30_000);
