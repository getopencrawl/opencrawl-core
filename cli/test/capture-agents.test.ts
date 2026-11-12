import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync,statSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {standaloneCapture} from '../../dist/src/sessions/standalone.mjs';
import {createLocalSessionStore} from '../../dist/src/sessions/local-store.mjs';
import {createSessionIngest} from '../../dist/src/sessions/ingest.mjs';
import {transcriptEntries} from '../../dist/src/sessions/library.mjs';
import {batchDocuments} from '../../dist/src/sessions/indexer.mjs';
import {SESSION_HARNESSES} from '../../dist/src/sessions/types.mjs';
import {installCapture,uninstallCapture} from '../src/capture/install.ts';
import {captureHook,captureDir,captureStatus,readCaptureConfig,hookFlush,bindHookIdentity,flushCaptures,flushCaptureWork,ingestInbox,acceptedHarnesses,serverHarnesses} from '../src/capture/runtime.ts';
import {purgeLocalCapture} from '../src/capture/controls.ts';
import {cursorAdapter,CURSOR_HOOK_EVENTS} from '../src/capture/cursor.ts';
import {museAdapter,MUSE_HOOK_EVENTS} from '../src/capture/muse.ts';
import {openCodeAdapter,openCodePlugin} from '../src/capture/opencode.ts';
import {payloadAdapter} from '../src/capture/adapters.ts';
import {agentRoots,detectAgents,prepareOpenCode} from '../src/capture/agents.ts';
import {HARNESSES,HARNESS_NAMES,hash} from '../src/capture/parse.ts';
import {skillTargets} from '../src/skills.ts';

const cli=resolve(import.meta.dir,'../src/cli.ts');
const notice=(event:any,sequence=10,context:any=undefined)=>({id:'notice',at:'2026-11-12T12:00:00.000Z',sequence,...(context?{context}:{}),event});

// Field names and shapes are what the shipped clients send: Cursor's from its
// Agent SDK's own hook runner, Muse Code's from the `muse` binary, OpenCode's
// from a logging plugin under opencode 1.19.5. Content is synthetic.
const cursorBase={conversation_id:'agent-4699879d-179d-475e-9a78-4996bd02fcae',generation_id:'gen-1',model:'composer-2',model_id:'composer-2',session_id:'agent-4699879d-179d-475e-9a78-4996bd02fcae',cursor_version:'1.0.0',workspace_roots:['/home/dev/shop'],user_email:null,transcript_path:null};
const cursor=(name:string,fields:Record<string,unknown>={})=>({...cursorBase,hook_event_name:name,...fields});
const museBase={cwd:'/home/dev/shop',model:'muse-spark-1.2',permission_mode:'default',session_id:'01a1cef0-ed84-7f23-88a5-3f37d303147d',transcript_path:null};
const muse=(name:string,fields:Record<string,unknown>={})=>({...museBase,hook_event_name:name,...fields});
const museChat={chat:museBase.session_id,thread:museBase.session_id};
const ocSession={id:'ses_e31065491ffeywRbfa3LtC56eJ',directory:'/home/dev/shop',version:'1.19.5'};
const opencode=(event:any,extra:Record<string,unknown>={})=>({hook_event_name:'opencode',v:1,at:1794473832216,mode:'run',session:ocSession,event,...extra});
const ocPart=(part:any,extra:Record<string,unknown>={})=>opencode({type:'message.part.updated',properties:{part:{sessionID:ocSession.id,messageID:'msg_1cef9ad29001ETFYvgjrRxD2JC',...part}}},extra);

async function fixture(run:(f:any)=>Promise<void>) {
  const dir=mkdtempSync(join(tmpdir(),'opencrawl-agents-')),saved={...process.env};
  const principal={tenantId:'tenant-test',userId:'user-test',name:'Agent Owner',email:'owner@example.com'},token='agents-capture-token-0123456789012345';
  const store=createLocalSessionStore(join(dir,'objects')),ingest=createSessionIngest({store,onStored:undefined});
  const handler=standaloneCapture({token,principal,store,prefix:undefined,search:undefined}),batches:any[]=[];
  // An older deployment: its identity response names no agents, and it rejects
  // a batch for one it has never heard of.
  let fail=false,legacy=false,rejected=0;
  const server=createServer(async(req,res)=>{
    const json=(status:number,body:unknown)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
    if(legacy&&req.url==='/api/sessions/identity'){req.resume();return json(req.headers.authorization==='Bearer '+token?200:401,{schemaVersion:1,data:{principal}});}
    if(req.url==='/api/sessions/batches'&&req.method==='POST'){
      if(fail){req.resume();return json(500,{error:{code:'BROKEN'}});}
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      let batch:any;try{batch=JSON.parse(Buffer.concat(chunks).toString());}catch{return json(400,{error:{code:'JSON'}});}
      if(legacy&&!['claude-code','codex','grok-bot'].includes(batch.harness)){rejected++;return json(400,{error:{code:'CAPTURE_REJECTED',message:'Invalid capture batch'}});}
      batches.push(batch);
      return json(200,{schemaVersion:1,data:await ingest.putBatch(principal,batch)});
    }
    handler(req,res);
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const api='http://127.0.0.1:'+(server.address() as any).port;process.env.OPENCRAWL_API_URL=api;
  try {
    // A CLI started by a test resolves every agent's directory under this home.
    Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(dir,'config'),OPENCRAWL_SESSIONS_TOKEN:token,CLAUDE_CONFIG_DIR:join(dir,'.claude'),CODEX_HOME:join(dir,'.codex'),OPENCRAWL_NO_UPDATE:'1',HOME:dir,USERPROFILE:dir});
    delete process.env.CLAUDE_CODE_REMOTE;
    const install=(harnesses?:any[],options:Record<string,unknown>={})=>installCapture(api,{home:dir,command:[process.execPath,'-e',''],detect:()=>[],prepare:()=>'ready',...(harnesses?{harnesses}:{}),...options});
    await run({dir,api,principal,token,ingest,batches,install,roots:agentRoots(dir),
      hook:async(harness:string,event:any)=>{
        const child=Bun.spawn(['bun',cli,'collect','hook','--harness',harness],{stdin:event===undefined?'ignore':Buffer.from(JSON.stringify(event)),stdout:'pipe',stderr:'pipe',env:{...process.env}});
        const [exit,stdout]=await Promise.all([child.exited,new Response(child.stdout).text()]);
        return {exit,stdout};
      },
      get rejected(){return rejected;},set fail(value:boolean){fail=value;},set legacy(value:boolean){legacy=value;}});
  } finally {
    try{await uninstallCapture(dir);}catch{}
    server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
    for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);rmSync(dir,{recursive:true,force:true});
  }
}
const sorted=(batches:any[])=>batches.flatMap(batch=>batch.events).sort((a:any,b:any)=>a.sequence-b.sequence);

test('the agents a client can enroll are the agents the deployment stores',()=>{
  expect([...SESSION_HARNESSES].sort()).toEqual([...HARNESSES].sort());
  for(const harness of ['opencode','cursor','muse'] as const){expect(payloadAdapter(harness)).not.toBeNull();expect(HARNESS_NAMES[harness]).toBeTruthy();}
  for(const harness of ['claude-code','codex','grok-bot','copilot',null,undefined])expect(payloadAdapter(harness)).toBeNull();
  // A deployment that answers without a list predates it and stores these three.
  expect(serverHarnesses(undefined)).toEqual(['claude-code','codex','grok-bot']);
  expect(serverHarnesses(['claude-code','codex','grok-bot','opencode','cursor','muse','NOT a name',7])).toEqual(['claude-code','codex','grok-bot','opencode','cursor','muse']);
});

test('Cursor hook payloads become message, reasoning, tool and compaction events',()=>{
  const {events}=cursorAdapter;
  const prompt=events(notice(cursor('beforeSubmitPrompt',{prompt:'List the files and say hi',attachments:[{type:'file',file_path:'/home/dev/shop/README.md'},{type:'rule'}],composer_mode:'agent'})));
  expect(prompt).toEqual([{id:'notice',kind:'message',sequence:10,timestamp:'2026-11-12T12:00:00.000Z',nativeId:null,parentId:null,turnId:'gen-1',agentId:null,
    data:{role:'user',content:[{type:'text',text:'List the files and say hi'}],attachments:[{type:'file',file_path:'/home/dev/shop/README.md'}]}}]);
  expect(events(notice(cursor('afterAgentResponse',{text:'Hi! The folder has README.md.',input_tokens:1200,output_tokens:40})))[0]).toMatchObject({kind:'message',data:{role:'assistant',content:[{type:'text',text:'Hi! The folder has README.md.'}],model:'composer-2'}});
  expect(events(notice(cursor('afterAgentThought',{text:'The user wants a listing; I will run ls.',duration_ms:1234})))[0]).toMatchObject({kind:'reasoning_summary',data:{summary:[{type:'summary_text',text:'The user wants a listing; I will run ls.'}],duration_ms:1234}});
  // The tool result arrives JSON-stringified, the input as an object.
  const [call,result]=events(notice(cursor('postToolUse',{tool_name:'Shell',tool_input:{command:'ls -la',cwd:'/home/dev/shop'},tool_output:'{"output":"README.md\\n","exitCode":0}',duration:13,tool_use_id:'tool_lab_0001',cwd:'/home/dev/shop'})));
  expect(call).toMatchObject({id:'notice:call',kind:'tool_call',sequence:10,nativeId:'tool_lab_0001',data:{type:'tool_use',name:'Shell',input:{command:'ls -la',cwd:'/home/dev/shop'},call_id:'tool_lab_0001'}});
  expect(result).toMatchObject({id:'notice:result',kind:'tool_result',sequence:11,data:{type:'tool_result',name:'Shell',call_id:'tool_lab_0001',output:{output:'README.md\n',exitCode:0},duration_ms:13}});
  const failed=events(notice(cursor('postToolUseFailure',{tool_name:'Read',tool_input:{file_path:'/home/dev/shop/missing.txt'},error_message:'File not found',failure_type:'error',duration:3,tool_use_id:'tool_lab_0002',is_interrupt:false})))[1];
  expect(failed.data).toEqual({type:'tool_result',name:'Read',call_id:'tool_lab_0002',output:'File not found',is_error:true,failure_type:'error',is_interrupt:false,duration_ms:3});
  expect(events(notice(cursor('preCompact',{trigger:'auto',context_usage_percent:91,messages_to_compact:30,is_first_compaction:true})))[0]).toMatchObject({kind:'compaction',data:{trigger:'auto',context_usage_percent:91,messages_to_compact:30,is_first_compaction:true}});
  // Lifecycle hooks and unusable payloads are retained as evidence, never indexed as conversation.
  for(const event of [cursor('stop',{status:'completed',loop_count:0}),cursor('sessionStart',{is_background_agent:false}),cursor('sessionEnd',{reason:'completed'}),cursor('beforeSubmitPrompt',{prompt:'  '}),cursor('postToolUse',{tool_output:'orphan'})])
    expect(events(notice(event)).map(e=>e.kind)).toEqual(['hook']);
  // Rendered by the same server code as Claude Code and Codex events.
  expect(transcriptEntries(prompt[0])).toEqual([{type:'message',role:'user',text:'List the files and say hi'}]);
  expect(transcriptEntries(call)).toEqual([{type:'tool_call',name:'Shell',input:'{\n  "command": "ls -la",\n  "cwd": "/home/dev/shop"\n}',truncated:false}]);
  expect(transcriptEntries(failed)).toEqual([{type:'tool_result',text:'File not found',truncated:false}]);
});

test('one Cursor conversation is one session in its workspace; its hooks never withhold a permission',()=>{
  const {session,response,boundary}=cursorAdapter;
  expect(session(cursor('stop'),'')).toEqual({sessionId:cursorBase.conversation_id,cwd:'/home/dev/shop',version:'1.0.0',origin:'unknown',originEvidence:'Cursor hook',parentSessionId:null});
  // A tool call's own directory does not move the session out of its workspace.
  expect(session(cursor('postToolUse',{cwd:'/home/dev/shop/packages/api'}),'')!.cwd).toBe('/home/dev/shop');
  expect(session({hook_event_name:'postToolUse',session_id:'only-session',cwd:'/srv/app'},'')).toMatchObject({sessionId:'only-session',cwd:'/srv/app',version:null});
  expect(session(cursor('sessionStart',{is_background_agent:true}),'')).toMatchObject({origin:'cloud'});
  expect(session(cursor('postToolUse',{conversation_id:'child-1',parent_conversation_id:cursorBase.conversation_id}),'')).toMatchObject({sessionId:'child-1',origin:'subagent',parentSessionId:cursorBase.conversation_id});
  expect(session(cursor('subagentStop',{parent_conversation_id:cursorBase.conversation_id}),'')).toMatchObject({origin:'unknown',parentSessionId:null});
  expect(session(cursor('stop',{conversation_id:'has spaces / slashes'}),'')!.sessionId).toMatch(/^session-[a-f0-9]{32}$/);
  for(const event of [{hook_event_name:'workspaceOpen',cursor_version:'1.0.0',workspace_roots:['/home/dev/shop']},cursor('stop',{conversation_id:'',session_id:' '}),null])expect(session(event,'')).toBeNull();
  expect(response(cursor('beforeSubmitPrompt'))).toEqual({continue:true});
  for(const name of ['preToolUse','subagentStart','beforeShellExecution','beforeMCPExecution','beforeReadFile'])expect(response(cursor(name))).toEqual({permission:'allow'});
  for(const name of ['postToolUse','stop','sessionStart','afterAgentResponse','preCompact'])expect(response(cursor(name))).toEqual({});
  expect(response(null)).toEqual({});
  for(const name of ['stop','sessionStart','sessionEnd'])expect(boundary(cursor(name))).toBe(true);
  for(const name of ['postToolUse','afterAgentResponse','beforeSubmitPrompt'])expect(boundary(cursor(name))).toBe(false);
  // Cursor drops the whole hooks file, the person's own hooks included, when it
  // holds an event name it does not know or a permission hook answers badly.
  expect([...CURSOR_HOOK_EVENTS]).toEqual(['sessionStart','sessionEnd','beforeSubmitPrompt','afterAgentResponse','afterAgentThought','postToolUse','postToolUseFailure','preCompact','stop']);
});

test('install adds Cursor entries beside the person\'s own; repeat, rollback and uninstall leave theirs intact',async()=>fixture(async f=>{
  const file=join(f.dir,'.cursor','hooks.json'),other={command:'./hooks/format.sh',timeout:3,failClosed:false};
  mkdirSync(join(f.dir,'.cursor'));
  writeFileSync(file,JSON.stringify({version:1,hooks:{afterFileEdit:[other],postToolUse:[other]}}));
  chmodSync(join(f.dir,'.cursor'),0o755);chmodSync(file,0o644);
  const first=await f.install(['cursor']);
  if(process.platform!=='win32'){expect(statSync(join(f.dir,'.cursor')).mode&0o777).toBe(0o755);expect(statSync(file).mode&0o777).toBe(0o644);}
  expect(first.harnesses).toEqual(['cursor']);expect(first.nextStep).toContain('Cursor hooks installed in '+file);expect(first.nextStep).toContain('cloud agents do not read this file');
  expect(first.notice).toContain('Agents recorded on this machine: Cursor.');expect(first.notice).toContain('their earlier conversations are not read');
  expect(readCaptureConfig()!.roots.cursor).toBe(join(f.dir,'.cursor'));
  const installed=JSON.parse(readFileSync(file,'utf8'));
  expect(installed.version).toBe(1);
  expect(Object.keys(installed.hooks).sort()).toEqual([...CURSOR_HOOK_EVENTS,'afterFileEdit'].sort());
  expect(installed.hooks.afterFileEdit).toEqual([other]);expect(installed.hooks.postToolUse[0]).toEqual(other);
  const ours=installed.hooks.postToolUse[1];
  // Cursor's own entry shape and nothing else: a matcher group here would make it ignore the file.
  expect(Object.keys(ours).sort()).toEqual(['command','timeout']);expect(ours.timeout).toBe(30);
  if(process.platform!=='win32')expect(ours.command).toBe([Bun.which('node'),join(captureDir(),'runner.cjs'),'collect','hook','--harness','cursor'].join(' '));
  for(const event of CURSOR_HOOK_EVENTS)expect(installed.hooks[event].filter((entry:any)=>entry.command===ours.command)).toHaveLength(1);
  // Claude Code and Codex are untouched unless they are requested too.
  expect(existsSync(join(f.dir,'.claude'))).toBe(false);expect(existsSync(join(f.dir,'.codex'))).toBe(false);
  expect((await f.install(['cursor'])).installationId).toBe(first.installationId);
  expect(readFileSync(file,'utf8')).toBe(JSON.stringify(installed,null,2)+'\n');
  // A file Cursor would not read as version 1 is left exactly as found.
  const strange=JSON.stringify({version:2,hooks:{}});
  writeFileSync(file,strange);
  await expect(f.install(['cursor'])).rejects.toMatchObject({code:'CAPTURE_INVALID_CONFIG'});
  expect(readFileSync(file,'utf8')).toBe(strange);
  writeFileSync(file,JSON.stringify(installed,null,2)+'\n');
  expect((await uninstallCapture(f.dir)).installed).toBe(false);
  expect(JSON.parse(readFileSync(file,'utf8'))).toEqual({version:1,hooks:{afterFileEdit:[other],postToolUse:[other]}});
}));

test('Cursor and Grok Bot read one hooks file, so it has one owner: found agents never displace it, a named one does',async()=>fixture(async f=>{
  const file=join(f.dir,'.cursor','hooks.json'),owners=()=>[...new Set(Object.values(JSON.parse(readFileSync(file,'utf8')).hooks).flat().map((entry:any)=>/--harness (\S+)$/.exec(entry.command)![1]))];
  await expect(f.install(['cursor','grok-bot'])).rejects.toMatchObject({code:'INVALID_USAGE'});
  expect(existsSync(file)).toBe(false);
  expect((await f.install(['grok-bot'])).harnesses).toEqual(['grok-bot']);
  expect(owners()).toEqual(['grok-bot']);
  // A plain install on a Bot's computer finds ~/.cursor and must not record every Bot twice.
  const plain=await f.install(undefined,{detect:()=>['cursor']});
  expect(plain.harnesses).toEqual(['grok-bot','claude-code','codex']);
  expect(plain.skipped).toEqual([{harness:'cursor',reason:expect.stringContaining('Grok Bot capture owns the hooks file Cursor reads')}]);
  expect(plain.nextStep).toContain('collect install --harness cursor');
  expect(owners()).toEqual(['grok-bot']);
  // Naming Cursor is a decision: its entries replace Grok Bot's, and the output says so.
  const named=await f.install(['cursor']);
  expect(named.harnesses).toEqual(['claude-code','codex','cursor']);
  expect(named.nextStep).toContain('Grok Bot capture was removed from this machine');
  expect(owners()).toEqual(['cursor']);
  expect((await f.install(['grok-bot'])).harnesses).toEqual(['claude-code','codex','grok-bot']);
  expect(owners()).toEqual(['grok-bot']);
}));

test('a Cursor conversation is recorded from hooks alone, uploaded at the turn boundary and readable by teammates',async()=>fixture(async f=>{
  await f.install(['cursor']);
  const image=Buffer.from('synthetic screenshot bytes');
  const turn=[
    cursor('sessionStart',{is_background_agent:false}),
    cursor('beforeSubmitPrompt',{prompt:'Why is checkout failing?',attachments:[]}),
    cursor('afterAgentThought',{text:'Look at the failing request first.',duration_ms:400}),
    cursor('postToolUse',{tool_name:'Shell',tool_input:{command:'npm test'},tool_output:'{"output":"1 failed","exitCode":1}',tool_use_id:'tool-1',cwd:'/home/dev/shop/packages/api',duration:210}),
    cursor('postToolUse',{tool_name:'Screenshot',tool_input:{},tool_output:JSON.stringify({content:[{type:'image',source:{type:'base64',media_type:'image/png',data:image.toString('base64')}}]}),tool_use_id:'tool-2',duration:900}),
    cursor('afterAgentResponse',{text:'The cart total is rounded twice. Fixed in cart.ts.'}),
  ];
  for(const event of turn){await captureHook('cursor',event);await hookFlush(event,{boundary:cursorAdapter.boundary(event)});}
  // sessionStart is a boundary and uploads at once; later mid-turn hooks only hand off locally.
  expect(captureStatus().pendingHooks).toBe(turn.length-1);
  const stop=cursor('stop',{status:'completed',loop_count:0});
  await captureHook('cursor',stop);await hookFlush(stop,{boundary:true});
  expect(captureStatus()).toMatchObject({pendingHooks:0,queued:0,lastError:null});
  expect(f.batches).toHaveLength(2);
  for(const batch of f.batches as any[])expect(batch).toMatchObject({harness:'cursor',sessionId:cursorBase.conversation_id,origin:'unknown',captureMode:'live',harnessVersion:'1.0.0',cwd:'/home/dev/shop',parentSessionId:null,owner:f.principal});
  const events=sorted(f.batches);
  expect(events.map(event=>event.kind)).toEqual(['hook','message','reasoning_summary','tool_call','tool_result','tool_call','tool_result','message','hook']);
  expect(events.every(event=>/^wire1:[a-f0-9]{64}$/.test(event.id))).toBe(true);expect(new Set(events.map(event=>event.id)).size).toBe(events.length);
  // Inline image bytes travel as an attachment, never as indexed base64 text.
  expect(f.batches.flatMap((batch:any)=>batch.attachments)).toEqual([expect.objectContaining({sha256:hash(image),size:image.length,mimeType:'image/png',status:'captured'})]);
  expect(JSON.stringify(f.batches)).not.toContain(image.toString('base64'));
  const sent=f.batches[1],stored=await f.ingest.getBatch(f.principal,{harness:'cursor',installationId:sent.installationId,sessionId:sent.sessionId,batchId:hash(JSON.stringify(sent))});
  expect(stored?.owner.name).toBe('Agent Owner');
  const entries=events.flatMap(event=>transcriptEntries(event));
  expect(entries.map(entry=>entry.type)).toEqual(['message','note','tool_call','tool_result','tool_call','tool_result','message']);
  expect(entries[0]).toEqual({type:'message',role:'user',text:'Why is checkout failing?'});
  expect(entries.at(-1)).toEqual({type:'message',role:'assistant',text:'The cart total is rounded twice. Fixed in cart.ts.'});
  const key=`capture-v1/tenants/${hash(f.principal.tenantId)}/users/${hash(f.principal.userId)}/cursor/${hash(sent.installationId)}/${hash(sent.sessionId)}/${hash(JSON.stringify(sent))}.json.gz`;
  const documents=batchDocuments({prefix:'capture-v1',key,batch:stored!,principal:f.principal}).map(item=>item.document);
  expect(documents.find(d=>d.kind==='tool_call'&&d.toolCallId==='tool-1')).toMatchObject({harness:'cursor',toolNames:['Shell'],role:null});
  expect(documents.find(d=>d.kind==='message'&&d.role==='assistant')?.text).toContain('rounded twice');
  expect(documents.some(d=>d.kind==='hook')).toBe(false);
  // Status says what the agent delivered, so one conversation shows whether its hooks load.
  expect(captureStatus().agents).toEqual({cursor:{firstDelivery:expect.any(String),lastDelivery:expect.any(String),note:null,recorded:{prompts:1,replies:1,toolCalls:2},
    deliveries:{sessionStart:1,beforeSubmitPrompt:1,afterAgentThought:1,postToolUse:2,afterAgentResponse:1,stop:1}}});
}));

test('the hook process answers each agent in its own terms and always exits 0, installed or not',async()=>fixture(async f=>{
  // Not installed: still the explicit answer, and nothing is recorded.
  expect(await f.hook('cursor',cursor('beforeSubmitPrompt',{prompt:'hello'}))).toEqual({exit:0,stdout:'{"continue":true}\n'});
  expect(await f.hook('muse',muse('UserPromptSubmit',{prompt:'hello'}))).toEqual({exit:0,stdout:'{}\n'});
  expect(await f.hook('opencode',undefined)).toEqual({exit:0,stdout:'{}\n'});
  expect(existsSync(join(captureDir(),'notices'))).toBe(false);
  await f.install(['cursor','muse']);
  expect(await f.hook('cursor',cursor('beforeSubmitPrompt',{prompt:'hello'}))).toEqual({exit:0,stdout:'{"continue":true}\n'});
  expect(await f.hook('cursor',cursor('postToolUse',{tool_name:'Shell',tool_input:{},tool_output:'{}',tool_use_id:'x'}))).toEqual({exit:0,stdout:'{}\n'});
  // A hook someone wired by hand is never denied by capture.
  expect(await f.hook('cursor',cursor('preToolUse',{tool_name:'Shell'}))).toEqual({exit:0,stdout:'{"permission":"allow"}\n'});
  expect(await f.hook('muse',muse('Stop',{last_assistant_message:'done',turn_id:'t1'}))).toEqual({exit:0,stdout:'{}\n'});
  // Not JSON at all: still a valid answer and a clean exit.
  const child=Bun.spawn(['bun',cli,'collect','hook','--harness','cursor'],{stdin:Buffer.from('not json'),stdout:'pipe',stderr:'pipe',env:{...process.env}});
  expect([await child.exited,await new Response(child.stdout).text()]).toEqual([0,'{}\n']);
  expect(sorted(f.batches).filter((event:any)=>event.kind==='message').map((event:any)=>event.data.role)).toEqual(['user','assistant']);
}),60_000);

test('Muse Code hook payloads become prompt, tool and reply events; its helper agents are not sessions',()=>{
  const {events,session,response,boundary}=museAdapter,context=museAdapter.context!;
  const prompt=events(notice(muse('UserPromptSubmit',{prompt:'Second run with hooks registered',turn_id:'01a1cef0-ee76-7082-9a46-c8051d57694b'})));
  expect(prompt).toEqual([{id:'notice',kind:'message',sequence:10,timestamp:'2026-11-12T12:00:00.000Z',nativeId:null,parentId:null,turnId:'01a1cef0-ee76-7082-9a46-c8051d57694b',agentId:null,
    data:{role:'user',content:[{type:'text',text:'Second run with hooks registered'}]}}]);
  expect(events(notice(muse('Stop',{last_assistant_message:'All four tests pass now.',stop_hook_active:false,turn_id:'t1'})))[0]).toMatchObject({kind:'message',turnId:'t1',data:{role:'assistant',content:[{type:'text',text:'All four tests pass now.'}],model:'muse-spark-1.2'}});
  // A model the runtime cannot name is not recorded as one.
  expect(events(notice(muse('Stop',{last_assistant_message:'ok',model:'unknown'})))[0].data).toEqual({role:'assistant',content:[{type:'text',text:'ok'}]});
  const [call,result]=events(notice(muse('PostToolUse',{tool_name:'bash',tool_input:{command:'npm test'},tool_response:{exit_code:0,stdout:'4 passed'},tool_use_id:'call-1',turn_id:'t1'})));
  expect(call).toMatchObject({id:'notice:call',kind:'tool_call',nativeId:'call-1',data:{type:'tool_use',name:'bash',input:{command:'npm test'},call_id:'call-1'}});
  expect(result).toMatchObject({id:'notice:result',kind:'tool_result',sequence:11,data:{type:'tool_result',name:'bash',call_id:'call-1',output:{exit_code:0,stdout:'4 passed'}}});
  expect(events(notice(muse('PostToolUseFailure',{tool_name:'bash',tool_input:{command:'npm test'},error:'command timed out',tool_use_id:'call-2'})))[1].data).toMatchObject({output:'command timed out',is_error:true,call_id:'call-2'});
  expect(events(notice(muse('PostCompact',{trigger:'auto'})))[0]).toMatchObject({kind:'compaction',data:{trigger:'auto'}});
  for(const event of [muse('SessionStart',{source:'startup'}),muse('SessionEnd',{reason:'other'}),muse('StopFailure',{}),muse('Stop',{last_assistant_message:''}),muse('UserPromptSubmit',{prompt:' '}),muse('PostToolUse',{tool_response:'orphan'})])
    expect(events(notice(event)).map(e=>e.kind)).toEqual(['hook']);
  expect(transcriptEntries(call)).toEqual([{type:'tool_call',name:'bash',input:'{\n  "command": "npm test"\n}',truncated:false}]);
  // Muse Code names the top-level chat and the running chat in the hook's
  // environment. A helper or subagent runs under another session than the chat.
  expect(context({MUSE_SESSION_ID:'chat-1',MUSE_THREAD_ID:'chat-1',PATH:'/usr/bin'})).toEqual({chat:'chat-1',thread:'chat-1'});
  expect(context({PATH:'/usr/bin'})).toBeNull();
  expect(session(muse('Stop'),'',museChat)).toEqual({sessionId:museBase.session_id,cwd:'/home/dev/shop',version:null,origin:'cli',originEvidence:'Muse Code hook',parentSessionId:null});
  expect(session(muse('Stop'),'',null)).toMatchObject({sessionId:museBase.session_id});
  expect(session(muse('Stop',{session_id:'01a1cef0-eecc-7cd3-a71b-72c7ba4d545e'}),'',museChat)).toBeNull();
  expect(session(muse('Stop',{session_id:''}),'',museChat)).toBeNull();
  // An empty object changes nothing in any hook; anything else could.
  for(const name of MUSE_HOOK_EVENTS)expect(response(muse(name))).toEqual({});
  for(const name of ['Stop','StopFailure','SessionStart','SessionEnd'])expect(boundary(muse(name))).toBe(true);
  for(const name of ['UserPromptSubmit','PostToolUse'])expect(boundary(muse(name))).toBe(false);
  // Hooks that decide an action, or carry the whole conversation with its system prompt, are never registered.
  for(const name of ['PreToolUse','PermissionRequest','PreLLMCall','PostLLMCall','SubagentStart','SubagentStop'])expect(MUSE_HOOK_EVENTS as readonly string[]).not.toContain(name);
});

test('install writes Muse Code hooks into a schema_version 1 settings file and nothing else',async()=>fixture(async f=>{
  const file=join(f.roots.muse,'settings.json'),ownHook={hooks:[{type:'command',command:'/usr/local/bin/lint-on-stop'}]};
  // No settings yet: the file Muse Code requires, with only the hooks in it.
  const first=await f.install(['muse']);
  expect(first.harnesses).toEqual(['muse']);expect(first.nextStep).toContain('Muse Code hooks installed in '+file);expect(first.nextStep).toContain('start a new session');
  const created=JSON.parse(readFileSync(file,'utf8'));
  expect(Object.keys(created)).toEqual(['schema_version','hooks']);expect(created.schema_version).toBe(1);
  expect(Object.keys(created.hooks).sort()).toEqual([...MUSE_HOOK_EVENTS].sort());
  const ours=created.hooks.Stop[0].hooks[0];
  expect(Object.keys(ours).sort()).toEqual(['command','type']);expect(ours.type).toBe('command');
  // Muse Code clears most of a hook's environment: both paths are absolute.
  if(process.platform!=='win32')expect(ours.command).toBe(`exec '${Bun.which('node')}' '${join(captureDir(),'runner.cjs')}' collect hook --harness muse`);
  await uninstallCapture(f.dir);
  expect(JSON.parse(readFileSync(file,'utf8'))).toEqual({schema_version:1});
  // Existing settings and the person's own hooks are kept, in their order.
  const settings={schema_version:1,model:{default:'muse-spark-1.2'},mcp_servers:{docs:{transport:'streamable_http',url:'https://docs.example/mcp'}},hooks:{Stop:[ownHook],PreToolUse:[ownHook]},telemetry:{enabled:false}};
  writeFileSync(file,JSON.stringify(settings,null,4)+'\n');
  await f.install(['muse']);
  const merged=JSON.parse(readFileSync(file,'utf8'));
  expect({...merged,hooks:undefined}).toEqual({...settings,hooks:undefined});
  expect(merged.hooks.PreToolUse).toEqual([ownHook]);expect(merged.hooks.Stop).toHaveLength(2);expect(merged.hooks.Stop[0]).toEqual(ownHook);
  // Their indentation, too.
  expect(readFileSync(file,'utf8')).toContain('\n    "schema_version": 1');
  await f.install(['muse']);
  expect(JSON.parse(readFileSync(file,'utf8')).hooks.Stop).toHaveLength(2);
  await uninstallCapture(f.dir);
  expect(JSON.parse(readFileSync(file,'utf8'))).toEqual(settings);
  // Muse Code rejects a settings file that is not schema_version 1, and every
  // command with it. Such a file is not ours to repair: it is left as found.
  for(const broken of [JSON.stringify({model:{default:'x'}}),JSON.stringify({schema_version:2}),JSON.stringify({schema_version:1,hooks:[]}),'[]']) {
    writeFileSync(file,broken);
    await expect(f.install(['muse'])).rejects.toMatchObject({code:'CAPTURE_INVALID_CONFIG'});
    expect(readFileSync(file,'utf8')).toBe(broken);
  }
}));

test('a Muse Code chat is recorded from its hooks; deliveries from its helper agents are counted, not recorded',async()=>fixture(async f=>{
  await f.install(['muse']);
  const saved={session:process.env.MUSE_SESSION_ID,thread:process.env.MUSE_THREAD_ID};
  try {
    Object.assign(process.env,{MUSE_SESSION_ID:museBase.session_id,MUSE_THREAD_ID:museBase.session_id});
    const turn=[muse('SessionStart',{source:'startup'}),muse('UserPromptSubmit',{prompt:'Make the tests pass',turn_id:'t1'}),
      muse('PostToolUse',{tool_name:'bash',tool_input:{command:'npm test'},tool_response:{exit_code:1,stdout:'1 failed'},tool_use_id:'call-1',turn_id:'t1'})];
    for(const event of turn){await captureHook('muse',event);await hookFlush(event,{boundary:museAdapter.boundary(event)});}
    // A reminder agent Muse Code runs beside the chat: its own session, under the same top-level chat.
    process.env.MUSE_THREAD_ID='01a1cef0-eecc-7cd3-a71b-72c7ba4d545e';
    await captureHook('muse',muse('Stop',{session_id:'01a1cef0-eecc-7cd3-a71b-72c7ba4d545e',last_assistant_message:'decision: none',turn_id:'helper'}));
    process.env.MUSE_THREAD_ID=museBase.session_id;
    const stop=muse('Stop',{last_assistant_message:'All four tests pass now.',turn_id:'t1'});
    await captureHook('muse',stop);await hookFlush(stop,{boundary:true});
  } finally {for(const [key,value] of [['MUSE_SESSION_ID',saved.session],['MUSE_THREAD_ID',saved.thread]] as const){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
  expect(captureStatus()).toMatchObject({pendingHooks:0,queued:0,lastError:null});
  for(const batch of f.batches as any[])expect(batch).toMatchObject({harness:'muse',sessionId:museBase.session_id,origin:'cli',cwd:'/home/dev/shop',captureMode:'live'});
  const events=sorted(f.batches);
  expect(events.map(event=>event.kind)).toEqual(['hook','message','tool_call','tool_result','message']);
  expect(events.flatMap(event=>transcriptEntries(event))).toEqual([
    {type:'message',role:'user',text:'Make the tests pass'},
    {type:'tool_call',name:'bash',input:'{\n  "command": "npm test"\n}',truncated:false},
    {type:'tool_result',text:'{\n  "exit_code": 1,\n  "stdout": "1 failed"\n}',truncated:false},
    {type:'message',role:'assistant',text:'All four tests pass now.'}]);
  expect(JSON.stringify(f.batches)).not.toContain('decision: none');
  expect(captureStatus().agents!.muse).toMatchObject({deliveries:{SessionStart:1,UserPromptSubmit:1,PostToolUse:1,Stop:2},recorded:{prompts:1,replies:1,toolCalls:1},note:null});
}));

test('install writes the OpenCode plugin as the collector\'s own file; uninstall removes it',async()=>fixture(async f=>{
  const file=join(f.roots.opencode,'plugins','opencrawl.js'),other=join(f.roots.opencode,'plugins','team-notify.js');
  mkdirSync(join(f.roots.opencode,'plugins'),{recursive:true});writeFileSync(other,'export const TeamNotify = async () => ({});\n');
  writeFileSync(join(f.roots.opencode,'opencode.json'),'{"model":"anthropic/claude"}');
  const first=await f.install(['opencode']);
  expect(first.harnesses).toEqual(['opencode']);expect(first.nextStep).toContain('OpenCode capture plugin installed at '+file);expect(first.nextStep).toContain('restart running OpenCode sessions and servers');
  const source=readFileSync(file,'utf8');
  expect(source).toBe(openCodePlugin([Bun.which('node')!,join(captureDir(),'runner.cjs'),'collect','hook','--harness','opencode'],join(captureDir(),'inbox','opencode')));
  // Only Node built-ins, and only the plugin function exported: OpenCode
  // fails the load of a plugin file that exports anything else.
  expect([...source.matchAll(/^import .* from "([^"]+)";$/gm)].map(match=>match[1])).toEqual(['node:fs','node:path','node:child_process']);
  expect([...source.matchAll(/^export (?:const|function|default|let|var|class|\{)\s*(\w*)/gm)].map(match=>match[1])).toEqual(['OpenCrawlCapture']);
  // OpenCode's own configuration and other plugins are not touched.
  expect(readFileSync(join(f.roots.opencode,'opencode.json'),'utf8')).toBe('{"model":"anthropic/claude"}');
  const stamp=statSync(file).mtimeMs;
  await f.install(['opencode']);
  expect(statSync(file).mtimeMs).toBe(stamp);
  // A local edit is replaced: the file belongs to the collector.
  writeFileSync(file,'// edited');await f.install(['opencode']);expect(readFileSync(file,'utf8')).toBe(source);
  await uninstallCapture(f.dir);
  expect(existsSync(file)).toBe(false);expect(readFileSync(other,'utf8')).toContain('TeamNotify');
  // OpenCode always reads its global directory; OPENCODE_CONFIG_DIR only adds
  // another for the processes started with it. Cursor's path never moves.
  expect(agentRoots(f.dir,{OPENCODE_CONFIG_DIR:'/srv/opencode'}).opencode).toBe(join(f.dir,'.config','opencode'));
  expect(agentRoots(f.dir,{XDG_CONFIG_HOME:'/srv/config',CURSOR_CONFIG_DIR:'/srv/cursor'})).toEqual({opencode:join('/srv/config','opencode'),muse:join('/srv/config','muse'),cursor:join(f.dir,'.cursor')});
}));

test('OpenCode\'s plugin support package is installed up front, and no plugin is left where it cannot be',async()=>fixture(async f=>{
  const file=join(f.roots.opencode,'plugins','opencrawl.js'),support=join(f.roots.opencode,'node_modules','@opencode-ai','plugin','package.json');
  // OpenCode is not on this machine yet: the plugin is written and the output says what its first start will do.
  const early=await f.install(['opencode'],{prepare:()=>'unknown'});
  expect(early.harnesses).toEqual(['opencode']);expect(existsSync(file)).toBe(true);
  expect(early.nextStep).toContain('installs OpenCode\'s plugin support package, about 60 MB');expect(early.nextStep).toContain('every start waits about a minute');
  await uninstallCapture(f.dir);
  // OpenCode ran and could not install it. Named: an error, and nothing written.
  rmSync(join(captureDir()),{recursive:true,force:true});
  await expect(f.install(['opencode'],{prepare:()=>'unavailable'})).rejects.toMatchObject({code:'CAPTURE_OPENCODE_SUPPORT',message:expect.stringContaining('could not install its plugin support package')});
  expect(existsSync(file)).toBe(false);expect(readCaptureConfig()).toBeNull();
  // Found by a plain install: left out with the reason, and the other agents are enrolled.
  const plain=await f.install(undefined,{detect:()=>['opencode','muse'],prepare:()=>'unavailable'});
  expect(plain.harnesses).toEqual(['claude-code','codex','muse']);
  expect(plain.skipped).toEqual([{harness:'opencode',reason:expect.stringContaining('so OpenCode capture was not installed')}]);
  expect(plain.nextStep).not.toContain('OpenCode capture plugin installed');expect(plain.notice).toContain('Agents recorded on this machine: Claude Code, Codex, Muse Code.');
  expect(existsSync(file)).toBe(false);expect(readCaptureConfig()!.harnesses).toEqual(['claude-code','codex','muse']);
  // The real check: present when OpenCode has installed it, otherwise it asks
  // OpenCode's own command, which is not on this machine.
  expect(prepareOpenCode(f.roots.opencode)).toBe('unknown');
  mkdirSync(join(support,'..'),{recursive:true});writeFileSync(support,'{"name":"@opencode-ai/plugin"}');
  expect(prepareOpenCode(f.roots.opencode)).toBe('ready');
  const ready=await f.install(['opencode'],{prepare:prepareOpenCode});
  expect(ready.harnesses).toEqual(['claude-code','codex','muse','opencode']);expect(ready.nextStep).not.toContain('about 60 MB');expect(existsSync(file)).toBe(true);
}));

test('the OpenCode plugin forwards what is finished, once, and nothing while it streams',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'opencrawl-opencode-plugin-')),inbox=join(dir,'inbox'),ran=join(dir,'ran.txt');
  try {
    // Stands in for the collector's runner: records that it was started, and how.
    const runner=join(dir,'runner.cjs');
    writeFileSync(runner,`require('node:fs').appendFileSync(${JSON.stringify(ran)},process.argv.slice(2).join(' ')+'\\n');`);
    const file=join(dir,'opencrawl.js');
    writeFileSync(file,openCodePlugin([process.execPath,runner,'collect','hook','--harness','opencode'],inbox));
    const hooks=await (await import(pathToFileURL(file).href)).OpenCrawlCapture({directory:'/home/dev/shop'});
    expect(Object.keys(hooks).sort()).toEqual(['chat.message','event']);
    const send=(type:string,properties:any)=>hooks.event({event:{id:'evt',type,properties}});
    const delivered=()=>existsSync(inbox)?readdirSync(inbox).sort().map(name=>JSON.parse(readFileSync(join(inbox,name),'utf8'))):[];
    const sid=ocSession.id,user='msg_user',assistant='msg_assistant';
    // The sequence opencode 1.19.5 emits for one turn with a shell command.
    await send('session.created',{sessionID:sid,info:{id:sid,version:'1.19.5',directory:'/home/dev/shop',title:'New session - 2026-11-12T08:57:11.278Z'}});
    await hooks['chat.message']({sessionID:sid},{message:{id:user,role:'user',sessionID:sid},parts:[{type:'text',text:'Run the marker command',messageID:user,sessionID:sid,id:'prt_user'}]});
    await send('message.updated',{sessionID:sid,info:{id:user,role:'user',sessionID:sid}});
    await send('message.part.updated',{sessionID:sid,part:{type:'text',text:'Run the marker command',messageID:user,sessionID:sid,id:'prt_user'}});
    await send('message.updated',{sessionID:sid,info:{id:assistant,role:'assistant',sessionID:sid,modelID:'lab-model'}});
    await send('session.updated',{sessionID:sid,info:{id:sid,version:'1.19.5',directory:'/home/dev/shop',title:'Marker command'}});
    await send('session.updated',{sessionID:sid,info:{id:sid,version:'1.19.5',directory:'/home/dev/shop',title:'Marker command'}});
    for(const status of ['pending','running'])await send('message.part.updated',{sessionID:sid,part:{id:'prt_tool',messageID:assistant,sessionID:sid,type:'tool',tool:'bash',callID:'call_1',state:{status,input:{command:'echo marker'}}}});
    const done={id:'prt_tool',messageID:assistant,sessionID:sid,type:'tool',tool:'bash',callID:'call_1',state:{status:'completed',input:{command:'echo marker'},output:'marker\n',title:'echo marker',time:{start:1794473832175,end:1794473832216}}};
    await send('message.part.updated',{sessionID:sid,part:done});
    await send('message.part.updated',{sessionID:sid,part:done});
    await send('message.part.updated',{sessionID:sid,part:{id:'prt_text',messageID:assistant,sessionID:sid,type:'text',text:'',time:{start:1794473832282}}});
    await send('message.part.delta',{sessionID:sid,messageID:assistant,partID:'prt_text',field:'text',delta:'DONE'});
    await send('message.part.updated',{sessionID:sid,part:{id:'prt_text',messageID:assistant,sessionID:sid,type:'text',text:'DONE after tool.',time:{start:1794473832282,end:1794473832340}}});
    // Text OpenCode injects itself is not something the person or the agent said.
    await send('message.part.updated',{sessionID:sid,part:{id:'prt_synthetic',messageID:user,sessionID:sid,type:'text',text:'<system-reminder>',synthetic:true}});
    await send('session.idle',{sessionID:sid});
    const first=delivered();
    expect(first.map(item=>item.event.type+(item.event.properties.part?':'+item.event.properties.part.id:''))).toEqual(['message.part.updated:prt_user','session.updated','message.part.updated:prt_tool','message.part.updated:prt_text','session.idle']);
    for(const item of first)expect(item).toMatchObject({hook_event_name:'opencode',v:1,at:expect.any(Number),session:{id:sid,directory:'/home/dev/shop',version:'1.19.5'}});
    expect(first[0]).toMatchObject({role:'user'});expect(first[3]).toMatchObject({role:'assistant',model:'lab-model'});
    expect(first[1].event.properties.info).toEqual({id:sid,title:'Marker command'});
    // The newer session engine reports a different family of events for a
    // session; a session is recorded from the first engine that reports it.
    const next='ses_next',stamp={epochMilliseconds:1794474052920};
    await send('session.next.prompt.admitted',{sessionID:next,messageID:'msg_n1',timestamp:stamp,prompt:{text:'V2 turn'}});
    await send('session.next.prompted',{sessionID:next,messageID:'msg_n1',timestamp:stamp,prompt:{text:'V2 turn'}});
    await send('session.next.tool.input.delta',{sessionID:next,callID:'call_n1',delta:'{'});
    await send('session.next.tool.called',{sessionID:next,timestamp:stamp,assistantMessageID:'msg_n2',callID:'call_n1',tool:'bash',input:{command:'pwd'}});
    await send('session.next.tool.success',{sessionID:next,timestamp:stamp,assistantMessageID:'msg_n2',callID:'call_n1',content:[{type:'text',text:'/home/dev/shop'}],structured:{exit:0}});
    await send('session.next.text.delta',{sessionID:next,assistantMessageID:'msg_n3',textID:'text-0',delta:'DO'});
    await send('session.next.text.ended',{sessionID:next,assistantMessageID:'msg_n3',timestamp:stamp,textID:'text-0',text:'DONE'});
    await send('session.next.text.ended',{sessionID:next,assistantMessageID:'msg_n3',timestamp:stamp,textID:'text-0',text:'DONE'});
    await send('message.part.updated',{sessionID:next,part:{id:'prt_other_engine',messageID:'msg_n3',sessionID:next,type:'text',text:'DONE',time:{start:1,end:2}}});
    await send('session.next.step.ended',{sessionID:next,assistantMessageID:'msg_n3',timestamp:stamp,finish:'stop'});
    await send('session.next.text.ended',{sessionID:sid,assistantMessageID:assistant,timestamp:stamp,textID:'text-0',text:'other engine for the first session'});
    const second=delivered().slice(first.length);
    expect(second.map(item=>item.event.type)).toEqual(['session.next.prompted','session.next.tool.called','session.next.tool.success','session.next.text.ended','session.next.step.ended']);
    expect(second[2]).toMatchObject({tool:'bash',session:{id:next,directory:'/home/dev/shop'}});
    // The collector was started, never awaited, and with nothing piped to it.
    await Bun.sleep(1500);
    const starts=readFileSync(ran,'utf8').trim().split('\n');
    expect(starts.length).toBeGreaterThanOrEqual(1);expect(new Set(starts)).toEqual(new Set(['collect hook --harness opencode']));
    // A handler never throws into OpenCode, whatever it is handed.
    for(const input of [undefined,null,{},{event:null},{event:{type:7}},{event:{type:'message.part.updated'}},{event:{type:'session.updated',properties:{info:null}}}])await hooks.event(input as any);
    await hooks['chat.message'](undefined,undefined);
    // With the collector gone, nothing more is written.
    rmSync(runner);const before=delivered().length;
    await send('session.idle',{sessionID:sid});
    expect(delivered()).toHaveLength(before);
  } finally {rmSync(dir,{recursive:true,force:true});}
},20_000);

test('OpenCode deliveries become the same events from either session engine, and the same event if delivered twice',()=>{
  const {events,session,boundary}=openCodeAdapter;
  const prompt=events(notice(ocPart({type:'text',text:'Run the marker command',id:'prt_user',messageID:'msg_user'},{role:'user'})));
  expect(prompt).toEqual([{id:'opencode:'+hash('prt_user'),kind:'message',sequence:1794473832216000,timestamp:'2026-11-12T08:57:12.216Z',nativeId:'prt_user',parentId:null,turnId:'msg_user',agentId:null,
    data:{role:'user',content:[{type:'text',text:'Run the marker command'}]}}]);
  // Collected again later, from another notice: the same event.
  expect(events({id:'another-notice',at:'2026-11-12T13:00:00.000Z',sequence:99,event:ocPart({type:'text',text:'Run the marker command',id:'prt_user',messageID:'msg_user'},{role:'user'})})).toEqual(prompt);
  const reply=events(notice(ocPart({type:'text',text:'DONE after tool.',id:'prt_text',time:{start:1794473832282,end:1794473832340}},{role:'assistant',model:'lab-model'})))[0];
  expect(reply).toMatchObject({kind:'message',timestamp:'2026-11-12T08:57:12.340Z',sequence:1794473832340000,data:{role:'assistant',content:[{type:'text',text:'DONE after tool.'}],model:'lab-model'}});
  expect(events(notice(ocPart({type:'reasoning',text:'Thinking step by step.',id:'prt_reason',time:{start:1794473931719,end:1794473931737}})))[0]).toMatchObject({kind:'reasoning_summary',data:{summary:[{type:'summary_text',text:'Thinking step by step.'}],duration_ms:18}});
  const [call,result]=events(notice(ocPart({type:'tool',tool:'bash',callID:'call_lab_70',id:'prt_tool',state:{status:'completed',input:{command:'echo lab-marker-70 && pwd',description:'Print a marker'},output:'lab-marker-70\n/home/dev/shop\n',metadata:{exit:0},title:'echo lab-marker-70 && pwd',time:{start:1794473832175,end:1794473832216}}})));
  expect(call).toMatchObject({id:'opencode:'+hash('prt_tool:call'),kind:'tool_call',nativeId:'call_lab_70',timestamp:'2026-11-12T08:57:12.175Z',data:{type:'tool_use',name:'bash',input:{command:'echo lab-marker-70 && pwd',description:'Print a marker'},call_id:'call_lab_70'}});
  expect(result).toMatchObject({id:'opencode:'+hash('prt_tool:result'),kind:'tool_result',timestamp:'2026-11-12T08:57:12.216Z',data:{type:'tool_result',name:'bash',call_id:'call_lab_70',output:'lab-marker-70\n/home/dev/shop\n',title:'echo lab-marker-70 && pwd',duration_ms:41}});
  expect(call.sequence).toBeLessThan(result.sequence);
  const denied=events(notice(ocPart({type:'tool',tool:'read',callID:'call_lab_87',id:'prt_denied',state:{status:'error',input:{filePath:'/etc/hostname'},error:'The user rejected permission to use this specific tool call.',time:{start:1794473944901,end:1794473944909}}})))[1];
  expect(denied.data).toMatchObject({output:'The user rejected permission to use this specific tool call.',is_error:true,duration_ms:8});
  // An attached image becomes a stored attachment; a file on disk stays a reference.
  expect(events(notice(ocPart({type:'file',id:'prt_file',mime:'image/png',filename:'shot.png',url:'data:image/png;base64,AAAA'},{role:'user'})))[0].data).toEqual({role:'user',content:[{type:'file',filename:'shot.png',mime:'image/png',image_url:'data:image/png;base64,AAAA'}]});
  // OpenCode names a session before its first reply; that placeholder is not a title.
  expect(events(notice(opencode({type:'session.updated',properties:{info:{id:ocSession.id,title:'New session - 2026-11-12T08:57:11.278Z'}}})))).toEqual([]);
  expect(events(notice(opencode({type:'session.updated',properties:{info:{id:ocSession.id,title:'Marker command'}}})))[0]).toMatchObject({kind:'session_title',data:{title:'Marker command',titleType:'auto'}});
  expect(events(notice(opencode({type:'session.compacted',properties:{sessionID:ocSession.id}})))[0]).toMatchObject({kind:'compaction'});
  expect(events(notice(ocPart({type:'text',text:'Summary of the work so far.',id:'prt_summary',time:{start:1,end:2}},{role:'assistant',summary:true})))[0]).toMatchObject({kind:'compaction',data:{summary:'Summary of the work so far.'}});
  // The newer engine: one event per finished thing, the tool call and its result apart.
  const stamp={epochMilliseconds:1794474052920};
  expect(events(notice(opencode({type:'session.next.prompted',properties:{sessionID:ocSession.id,messageID:'msg_n1',timestamp:stamp,prompt:{text:'V2 API turn one.'}}})))[0]).toMatchObject({kind:'message',timestamp:'2026-11-12T09:00:52.920Z',nativeId:'msg_n1',data:{role:'user',content:[{type:'text',text:'V2 API turn one.'}]}});
  const called=events(notice(opencode({type:'session.next.tool.called',properties:{sessionID:ocSession.id,timestamp:stamp,assistantMessageID:'msg_n2',callID:'call_lab_94',tool:'bash',input:{command:'pwd'}}})));
  const succeeded=events(notice(opencode({type:'session.next.tool.success',properties:{sessionID:ocSession.id,timestamp:{epochMilliseconds:1794474052997},assistantMessageID:'msg_n2',callID:'call_lab_94',structured:{exit:0,truncated:false},content:[{type:'text',text:'/home/dev/shop\n'},{type:'text',text:'Command exited with code 0.'}]}},{tool:'bash'})));
  expect(called).toEqual([expect.objectContaining({kind:'tool_call',nativeId:'call_lab_94',turnId:'msg_n2',data:{type:'tool_use',name:'bash',input:{command:'pwd'},call_id:'call_lab_94'}})]);
  expect(succeeded).toEqual([expect.objectContaining({kind:'tool_result',nativeId:'call_lab_94',data:{type:'tool_result',name:'bash',call_id:'call_lab_94',output:'/home/dev/shop\n\nCommand exited with code 0.',structured:{exit:0,truncated:false}}})]);
  expect(called[0].sequence).toBeLessThan(succeeded[0].sequence);
  expect(events(notice(opencode({type:'session.next.tool.failed',properties:{sessionID:ocSession.id,timestamp:stamp,callID:'call_x',error:{message:'permission denied'}}})))[0].data).toMatchObject({output:'permission denied',is_error:true});
  expect(events(notice(opencode({type:'session.next.text.ended',properties:{sessionID:ocSession.id,assistantMessageID:'msg_n3',timestamp:stamp,textID:'text-0',text:'DONE after tool.'}},{model:'lab-model'})))[0]).toMatchObject({kind:'message',data:{role:'assistant',content:[{type:'text',text:'DONE after tool.'}],model:'lab-model'}});
  expect(events(notice(opencode({type:'session.next.reasoning.ended',properties:{sessionID:ocSession.id,assistantMessageID:'msg_n3',timestamp:stamp,text:'Considering.'}})))[0]).toMatchObject({kind:'reasoning_summary'});
  // Inside OpenCode the timestamp is an instant object; written by the plugin it is ISO text.
  expect(events(notice(opencode({type:'session.next.text.ended',properties:{sessionID:ocSession.id,assistantMessageID:'msg_n4',timestamp:'2026-11-12T09:26:38.846Z',textID:'text-0',text:'From the plugin.'}})))[0]).toMatchObject({timestamp:'2026-11-12T09:26:38.846Z',sequence:Date.parse('2026-11-12T09:26:38.846Z')*1000});
  // Boundaries are evidence, and the cue to upload.
  for(const event of [{type:'session.idle',properties:{sessionID:ocSession.id}},{type:'session.next.step.ended',properties:{sessionID:ocSession.id,finish:'stop'}},{type:'session.next.step.failed',properties:{sessionID:ocSession.id}}]) {
    expect(events(notice(opencode(event))).map(e=>e.kind)).toEqual(['hook']);expect(boundary(opencode(event))).toBe(true);
  }
  expect(boundary(opencode({type:'session.next.step.ended',properties:{finish:'tool-calls'}}))).toBe(false);expect(boundary(ocPart({type:'text',id:'x'}))).toBe(false);
  // The opencode command in any mode, with the mode kept as evidence, or a subagent of it.
  expect(session(opencode({type:'session.idle'}),'')).toEqual({sessionId:ocSession.id,cwd:'/home/dev/shop',version:'1.19.5',origin:'cli',originEvidence:'OpenCode plugin (run)',parentSessionId:null});
  expect(session({...opencode({type:'session.idle'}),mode:'serve'},'')).toMatchObject({origin:'cli',originEvidence:'OpenCode plugin (serve)'});
  expect(session({...opencode({type:'session.idle'}),session:{...ocSession,id:'ses_child',parentID:ocSession.id}},'')).toMatchObject({sessionId:'ses_child',origin:'subagent',parentSessionId:ocSession.id});
  expect(session({hook_event_name:'opencode',event:{type:'session.idle'}},'')).toBeNull();
  expect(transcriptEntries(call)).toEqual([{type:'tool_call',name:'bash',input:'{\n  "command": "echo lab-marker-70 && pwd",\n  "description": "Print a marker"\n}',truncated:false}]);
  expect(transcriptEntries(succeeded[0])).toEqual([{type:'tool_result',text:'/home/dev/shop\n\nCommand exited with code 0.',truncated:false}]);
});

test('the collector takes OpenCode\'s inbox in order through the hook command, and a file leaves only once recorded',async()=>fixture(async f=>{
  await f.install(['opencode']);
  const inbox=join(captureDir(),'inbox','opencode');mkdirSync(inbox,{recursive:true});
  let n=0;
  const drop=(delivery:any)=>writeFileSync(join(inbox,String(1794473832000+(++n)).padStart(15,'0')+'-'+String(n).padStart(8,'0')+'-77.json'),JSON.stringify(delivery));
  // The plugin stamps each delivery when it writes it; a finished part also says when it finished.
  drop(ocPart({type:'text',text:'Run the marker command',id:'prt_user',messageID:'msg_user'},{role:'user',at:1794473831318}));
  drop(opencode({type:'session.updated',properties:{info:{id:ocSession.id,title:'Marker command'}}},{at:1794473831900}));
  drop(ocPart({type:'tool',tool:'bash',callID:'call_1',id:'prt_tool',state:{status:'completed',input:{command:'echo marker'},output:'marker\n',time:{start:1794473832175,end:1794473832216}}}));
  writeFileSync(join(inbox,'.000001794473833000-00000009-77.json.tmp'),'{"half":');   // still being written by the plugin
  expect(captureStatus().pendingHooks).toBe(3);
  // Mid-turn: recorded locally, nothing uploaded since no turn has ended... except the first pass.
  expect(await f.hook('opencode',undefined)).toEqual({exit:0,stdout:'{}\n'});
  expect(readdirSync(inbox).filter(name=>name.endsWith('.json'))).toEqual([]);
  drop(ocPart({type:'text',text:'DONE after tool.',id:'prt_text',time:{start:1794473832282,end:1794473832340}},{role:'assistant',model:'lab-model'}));
  drop(opencode({type:'session.idle',properties:{sessionID:ocSession.id}},{at:1794473832400}));
  writeFileSync(join(inbox,'000001794473899000-00000099-77.json'),'not json');   // unreadable: dropped, never blocks the rest
  expect(await f.hook('opencode',undefined)).toEqual({exit:0,stdout:'{}\n'});
  expect(readdirSync(inbox)).toEqual(['.000001794473833000-00000009-77.json.tmp']);
  expect(captureStatus()).toMatchObject({pendingHooks:0,queued:0,lastError:null});
  for(const batch of f.batches as any[])expect(batch).toMatchObject({harness:'opencode',sessionId:ocSession.id,origin:'cli',cwd:'/home/dev/shop',harnessVersion:'1.19.5',captureMode:'live'});
  // Each item carries the time it finished, so the session reads in the order it happened.
  const events=sorted(f.batches);
  expect(events.filter(event=>event.kind!=='hook').map(event=>event.kind)).toEqual(['message','session_title','tool_call','tool_result','message']);
  expect(events.flatMap(event=>transcriptEntries(event))).toEqual([
    {type:'message',role:'user',text:'Run the marker command'},
    {type:'tool_call',name:'bash',input:'{\n  "command": "echo marker"\n}',truncated:false},
    {type:'tool_result',text:'marker\n',truncated:false},
    {type:'message',role:'assistant',text:'DONE after tool.'}]);
  expect(events.filter(event=>event.kind==='message').map(event=>event.data.role).sort()).toEqual(['assistant','user']);
  expect(events.find(event=>event.kind==='session_title')?.data).toEqual({title:'Marker command',titleType:'auto'});
  expect(captureStatus().agents!.opencode).toMatchObject({recorded:{prompts:1,replies:1,toolCalls:1},deliveries:{'message.part.updated':3,'session.updated':1,'session.idle':1}});
  // collect flush takes the inbox too, and a local purge removes what is still in it.
  drop(ocPart({type:'text',text:'One more thing',id:'prt_user2',messageID:'msg_user2'},{role:'user'}));
  expect((await flushCaptureWork()).uploaded).toBe(1);
  expect(readdirSync(inbox).filter(name=>name.endsWith('.json'))).toEqual([]);
  drop(ocPart({type:'text',text:'Never uploaded',id:'prt_user3',messageID:'msg_user3'},{role:'user'}));
  await uninstallCapture(f.dir);
  expect(readdirSync(inbox).filter(name=>name.endsWith('.json'))).toHaveLength(1);
  expect((await purgeLocalCapture(true)).localCaptureDataDeleted).toBe(true);
  expect(existsSync(inbox)).toBe(false);
}),60_000);

test('a delivery that fails to record stays in the inbox for the next collector',async()=>fixture(async f=>{
  await f.install(['opencode']);
  const inbox=join(captureDir(),'inbox','opencode');mkdirSync(inbox,{recursive:true});
  for(const [index,id] of ['prt_a','prt_b','prt_c'].entries())writeFileSync(join(inbox,`00000179447383200${index}-0000000${index}-77.json`),JSON.stringify(ocPart({type:'text',text:'message '+id,id,messageID:'msg_'+id},{role:'user'})));
  const seen:string[]=[];
  await expect(ingestInbox('opencode',async delivery=>{seen.push(delivery.event.properties.part.id);if(seen.length===2)throw new Error('disk full');})).rejects.toThrow('disk full');
  expect(seen).toEqual(['prt_a','prt_b']);
  expect(readdirSync(inbox).sort()).toEqual(['000001794473832001-00000001-77.json','000001794473832002-00000002-77.json']);
  expect(await ingestInbox('opencode',async delivery=>{seen.push(delivery.event.properties.part.id);})).toBe(2);
  expect(seen).toEqual(['prt_a','prt_b','prt_b','prt_c']);
  expect(await ingestInbox('opencode',async()=>{throw new Error('nothing to take');})).toBe(0);
}));

test('a plain install records Claude Code and Codex and the other agents it finds, and creates nothing for one it does not',async()=>fixture(async f=>{
  // Nothing else on the machine: exactly what a plain install always enrolled.
  const bare=await f.install();
  expect(bare.harnesses).toEqual(['claude-code','codex']);expect(bare.skipped).toBeUndefined();
  for(const root of Object.values(f.roots) as string[])expect(existsSync(root)).toBe(false);
  // OpenCode's and Muse Code's directories exist; Cursor is not here.
  mkdirSync(f.roots.opencode,{recursive:true});mkdirSync(f.roots.muse,{recursive:true});
  expect(detectAgents({home:f.dir,which:()=>null})).toEqual(['opencode','muse']);
  // An agent whose command is on PATH counts before it has ever run.
  expect(detectAgents({home:f.dir,which:name=>name==='cursor-agent'?'/usr/local/bin/cursor-agent':null})).toEqual(['opencode','cursor','muse']);
  const found=await f.install(undefined,{detect:(options:any)=>detectAgents({...options,which:()=>null})});
  expect(found.harnesses).toEqual(['claude-code','codex','opencode','muse']);
  expect(found.nextStep).toContain('OpenCode capture plugin installed');expect(found.nextStep).toContain('Muse Code hooks installed');expect(found.nextStep).not.toContain('Cursor hooks installed');
  expect(found.nextStep).toContain('To confirm OpenCode, Muse Code');
  expect(existsSync(join(f.roots.opencode,'plugins','opencrawl.js'))).toBe(true);expect(existsSync(join(f.roots.muse,'settings.json'))).toBe(true);
  expect(existsSync(f.roots.cursor)).toBe(false);
  // Claude's own cloud keeps its single agent.
  process.env.CLAUDE_CODE_REMOTE='true';
  try{expect((await installCapture(f.api,{home:f.dir,command:[process.execPath,'-e',''],detect:()=>['cursor']})).harnesses).toEqual(['claude-code','codex','opencode','muse']);expect(existsSync(f.roots.cursor)).toBe(false);}
  finally{delete process.env.CLAUDE_CODE_REMOTE;}
  // Uninstall removes each agent's registration.
  await uninstallCapture(f.dir);
  expect(existsSync(join(f.roots.opencode,'plugins','opencrawl.js'))).toBe(false);expect(JSON.parse(readFileSync(join(f.roots.muse,'settings.json'),'utf8'))).toEqual({schema_version:1});
}));

test('the command line names several agents at once and rejects one it does not know',async()=>fixture(async f=>{
  const run=async(args:string[])=>{
    const child=Bun.spawn(['bun',cli,'collect',...args,'--api',f.api,'--json'],{stdin:'ignore',stdout:'pipe',stderr:'pipe',env:{...process.env}});
    const [exit,stdout]=await Promise.all([child.exited,new Response(child.stdout).text()]);
    return {exit,...JSON.parse(stdout)};
  };
  // Before anything is installed, the consent notice names the agents a plain
  // install would cover here: the two it always enrolls and the one it finds.
  mkdirSync(f.roots.opencode,{recursive:true});
  const asked=await run(['install']);
  expect(asked.data.status).toBe('consent_required');
  expect(asked.data.notice).toMatch(/Agents recorded on this machine: Claude Code, Codex, OpenCode[.,]/);
  expect(readCaptureConfig()).toBeNull();expect(readdirSync(f.roots.opencode)).toEqual([]);
  const installed=await run(['install','--yes','--harness','opencode, muse']);
  expect(installed.exit).toBe(0);expect(installed.data.harnesses).toEqual(['opencode','muse']);
  // None of the named agents keeps local history, so none is offered for import.
  expect(installed.data.backfill).toEqual({status:'skipped'});
  expect(existsSync(join(f.roots.opencode,'plugins','opencrawl.js'))).toBe(true);expect(existsSync(join(f.roots.muse,'settings.json'))).toBe(true);
  expect(existsSync(join(f.dir,'.claude','settings.json'))).toBe(false);
  // Muse Code reads skills from the shared directory OpenCode and Codex use.
  expect(installed.data.skills.results.find((result:any)=>result.clients.includes('muse'))).toMatchObject({directory:join(f.dir,'.agents','skills','opencrawl'),status:'installed'});
  expect(skillTargets({home:f.dir,env:{},which:()=>null}).find(target=>target.clients.includes('muse'))?.clients).toEqual(expect.arrayContaining(['opencode','muse']));
  const unknown=await run(['install','--yes','--harness','opencode,copilot']);
  expect(unknown.exit).toBe(64);expect(unknown.error).toMatchObject({code:'INVALID_USAGE',message:expect.stringContaining('opencode, cursor, muse')});
  const status=await run(['status']);
  expect(Object.keys(status.data.agents)).toEqual(['opencode','muse']);
  expect(status.data.agents.muse.note).toContain('Nothing from Muse Code has reached capture on this machine yet');
}),60_000);

test('an agent the deployment does not store yet is not enrolled, and never holds back the agents it does',async()=>fixture(async f=>{
  f.legacy=true;
  // Named: refused, with what to do. Found: left out, and the output says why.
  await expect(f.install(['opencode'])).rejects.toMatchObject({code:'CAPTURE_HARNESS_UNSUPPORTED',message:expect.stringContaining('does not store OpenCode sessions yet')});
  expect(readCaptureConfig()).toBeNull();expect(existsSync(f.roots.opencode)).toBe(false);
  const plain=await f.install(undefined,{detect:()=>['opencode','muse']});
  expect(plain.harnesses).toEqual(['claude-code','codex']);
  expect(plain.skipped.map((item:any)=>item.harness)).toEqual(['opencode','muse']);
  expect(plain.nextStep).toContain('This deployment does not store OpenCode sessions yet. Update the OpenCrawl server, then run collect install again.');
  expect(existsSync(f.roots.opencode)).toBe(false);
  // A prepared image cannot ask: it enrolls what it is told, and the batches wait.
  const prepared=await f.install(['cursor','claude-code'],{deferAuth:true});
  expect(prepared.harnesses).toEqual(['claude-code','codex','cursor']);
  const prompt=cursor('beforeSubmitPrompt',{prompt:'Recorded before the server knows Cursor'}),stop=cursor('stop',{status:'completed'});
  for(const event of [prompt,stop]){await bindHookIdentity(event,{boundary:cursorAdapter.boundary(event)});await captureHook('cursor',event);await hookFlush(event,{boundary:cursorAdapter.boundary(event)});}
  expect(acceptedHarnesses(f.api)).toEqual(['claude-code','codex','grok-bot']);
  // A Claude Code batch queued beside it still uploads on the same pass.
  const queue=join(captureDir(),'queue'),held=readdirSync(queue);
  expect(held.length).toBeGreaterThan(0);
  const held0=JSON.parse(readFileSync(join(queue,held[0]),'utf8'));
  const claude={...held0,harness:'claude-code',sessionId:'claude-session',origin:'cli',events:[{id:'wire1:'+'a'.repeat(64),kind:'message',sequence:1,timestamp:'2026-11-12T12:00:00.000Z',data:{role:'user',content:'from Claude Code'}}]};
  writeFileSync(join(queue,hash(JSON.stringify(claude))+'.json'),JSON.stringify(claude));
  expect(await flushCaptures()).toEqual({uploaded:1,held:held.length});
  expect(f.rejected).toBe(0);expect(f.batches.map((batch:any)=>batch.harness)).toEqual(['claude-code']);
  expect(readdirSync(queue).sort()).toEqual(held.sort());
  const waiting=captureStatus();
  expect(waiting.queued).toBe(held.length);expect(waiting.lastError).toBeNull();
  // Beside the Codex trust note, which asks for something else.
  expect(waiting.attention).toContain(`This deployment does not store Cursor sessions yet: ${held.length} batch${held.length===1?' is':'es are'} kept on this machine and upload once the OpenCrawl server is updated.`);
  // The deployment is updated: the next pass learns it and sends what waited.
  f.legacy=false;
  expect(await flushCaptures()).toEqual({uploaded:held.length});
  expect(acceptedHarnesses(f.api)).toEqual(expect.arrayContaining(['opencode','cursor','muse']));
  expect(captureStatus().queued).toBe(0);expect(captureStatus().attention).not.toContain('does not store');
  expect(sorted(f.batches.filter((batch:any)=>batch.harness==='cursor')).map((event:any)=>event.kind)).toEqual(['message','hook']);
  // And the same install now enrolls what it left out before.
  expect((await f.install(undefined,{detect:()=>['opencode','muse']})).harnesses).toEqual(['claude-code','codex','cursor','opencode','muse']);
}));

test('a prepared machine records nothing until a credential is there, then keeps the first prompt while it signs in',async()=>fixture(async f=>{
  // The image step: hooks installed, nobody identified, no credential on the machine.
  delete process.env.OPENCRAWL_SESSIONS_TOKEN;
  const prepared=await f.install(['cursor'],{deferAuth:true});
  expect(prepared.owner).toBeNull();expect(existsSync(join(captureDir(),'receiver-token.json'))).toBe(false);
  const early=cursor('beforeSubmitPrompt',{prompt:'Nobody opted in on this machine'});
  await bindHookIdentity(early);await captureHook('cursor',early);await hookFlush(early);
  expect(captureStatus()).toMatchObject({pendingHooks:0,queued:0,authenticationPending:true});
  // Counted, so status shows the hooks do run; nothing they carried is kept.
  expect(captureStatus().agents!.cursor).toMatchObject({deliveries:{beforeSubmitPrompt:1},recorded:{prompts:0,replies:0,toolCalls:0}});
  // The platform injects the person's upload credential. The receiver is slow
  // to answer the first hook, and the prompt arrives before identity is bound.
  process.env.OPENCRAWL_SESSIONS_TOKEN=f.token;
  f.fail=false;
  const prompt=cursor('beforeSubmitPrompt',{prompt:'The first prompt of a new machine'});
  await captureHook('cursor',prompt);
  expect(captureStatus()).toMatchObject({pendingHooks:1,authenticationPending:true});
  const stop=cursor('stop',{status:'completed'});
  await bindHookIdentity(stop,{boundary:true});await captureHook('cursor',stop);await hookFlush(stop,{boundary:true});
  expect(captureStatus()).toMatchObject({pendingHooks:0,queued:0,authenticationPending:false,owner:f.principal});
  expect(sorted(f.batches).filter((event:any)=>event.kind==='message').map((event:any)=>event.data.content[0].text)).toEqual(['The first prompt of a new machine']);
  expect(JSON.stringify(f.batches)).not.toContain('Nobody opted in');
}));
