import {withTestState} from '../../test/fixtures/memory-application-state.mjs';
import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,appendFileSync,symlinkSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {standaloneCapture} from '../../dist/tools/test-fixtures/capture.mjs';
import {createLocalSessionStore} from '../../dist/src/sessions/local-store.mjs';
import {createSessionIngest,digest} from '../../dist/src/sessions/ingest.mjs';
import {batchDocuments} from '../../dist/src/sessions/indexer.mjs';
import {transcriptEntries} from '../../dist/src/sessions/library.mjs';
import {installCapture,uninstallCapture,reasonExtensionSource} from '../src/capture/install.ts';
import {captureDir,captureStatus,readCaptureConfig,captureTranscript,captureHook,drainCaptureNotices,flushCaptures,assertSessionTranscriptPath,syncCaptures} from '../src/capture/runtime.ts';
import {daemonPathAllowed,recordNativeDaemonHook,daemonRegistration} from '../src/capture/daemon-handoff.ts';
import {backfill,backfillPreview,selection} from '../src/capture/backfill.ts';
import {excludeCapture} from '../src/capture/controls.ts';
import {collectCommand} from '../src/capture/command.ts';
import {parseRecord,readsTranscript,HARNESSES,reasonTranscriptName,reasonParentSessionId} from '../src/capture/parse.ts';

// A session a real Pi 1.5.2 agent wrote (one prompt, one bash tool call, a
// final answer, thinking on) and the three payloads the installed extension
// sent for it. Only the model endpoint was a local stub.
const nativeLog=readFileSync(resolve(import.meta.dir,'fixtures/reason/session.jsonl'),'utf8');
const nativeHooks:{args:string[];payload:any}[]=JSON.parse(readFileSync(resolve(import.meta.dir,'fixtures/reason/hooks.json'),'utf8'));
const nativeSession='01a1e63c-499f-719d-b503-3c66f563f3a3';
const nativeName='2026-11-16T21-21-13-120Z_'+nativeSession+'.jsonl';

function parseLog(log:string) {
 const parsed:any[]=[];let offset=0;
 for(const line of log.split('\n').slice(0,-1)){const record=parseRecord('reason',JSON.parse(line),offset);if(record)parsed.push(record);offset+=Buffer.byteLength(line)+1;}
 return parsed;
}

test('reason is a transcript harness',()=>{
 expect(HARNESSES).toContain('reason');
 expect(readsTranscript('reason')).toBe(true);
 expect(selection('reason')).toBe('reason');
 expect(reasonTranscriptName(nativeName,nativeSession)).toBe(true);
 expect(reasonTranscriptName(nativeName,'f563f3a3')).toBe(false);
 expect(reasonTranscriptName(nativeName+'.bak',nativeSession)).toBe(false);
 expect(reasonParentSessionId('/agent/sessions/--work--/'+nativeName)).toBe(nativeSession);
 expect(reasonParentSessionId('C:\\agent\\sessions\\--work--\\'+nativeName)).toBe(nativeSession);
 expect(reasonParentSessionId(undefined)).toBeNull();
});

test('a native session log maps to messages, thinking, tool calls and results in order',()=>{
 const records=parseLog(nativeLog);
 expect(records.map(record=>record.kind)).toEqual(['session_metadata','session_title','turn_metadata','turn_metadata','message','message','tool_result','message']);
 const [header,title,model,effort,prompt,call,result,answer]=records;
 expect(header).toMatchObject({sequence:0,timestamp:'2026-11-16T21:21:13.120Z',nativeId:null,parentId:null,data:{id:nativeSession,version:3,cwd:'/home/runner/pi-probe/run/proj'}});
 expect(title.data).toEqual({title:'Reason capture probe',titleType:'custom'});
 expect(model.data).toEqual({model:'stub-model',model_provider:'stub'});
 expect(effort.data).toEqual({effort:'high'});
 expect(prompt).toMatchObject({timestamp:'2026-11-16T21:21:13.344Z',nativeId:'c0362b2c',parentId:'27b24c80',data:{role:'user',content:[{type:'text',text:'Print the probe marker with echo.'}]}});
 expect(call).toMatchObject({nativeId:'26699b3b',parentId:'c0362b2c',data:{role:'assistant',model:'stub-model',provider:'stub',stop_reason:'toolUse',content:[
  {type:'thinking',thinking:'The user wants the marker printed. I will run echo.'},
  {type:'text',text:'Running the command now.'},
  {type:'tool_use',id:'call_probe_1',name:'bash',input:{command:'echo REASON_PROBE_MARKER'}},
 ]}});
 expect(call.data.usage).toMatchObject({input:120,output:30,totalTokens:150});
 expect(result).toMatchObject({nativeId:'10be76f7',parentId:'26699b3b',data:{type:'tool_result',tool_use_id:'call_probe_1',name:'bash',output:'REASON_PROBE_MARKER\n'}});
 expect(result.data.is_error).toBeUndefined();
 expect(answer.data.content).toEqual([{type:'thinking',thinking:'The command printed the marker.'},{type:'text',text:'Done: the command printed REASON_PROBE_MARKER.'}]);
 // Byte offsets order the events; every entry keeps its own time.
 const sequences=records.map(record=>record.sequence);
 expect(sequences).toEqual([...sequences].sort((a,b)=>a-b));
 expect(new Set(sequences).size).toBe(records.length);
 expect(records.every(record=>typeof record.timestamp==='string'&&!Number.isNaN(Date.parse(record.timestamp)))).toBe(true);
 // The system message repeats the prompt and tool declarations; provider replay data is opaque.
 const wire=JSON.stringify(records);
 expect(nativeLog).toContain('"role":"system"');
 expect(wire).not.toContain('toolsAdded');
 expect(wire).not.toContain('thinkingSignature');
});

test('the remaining session entry types follow the published session format',()=>{
 const entry=(fields:object)=>({id:'aaaa1111',parentId:'bbbb2222',timestamp:'2026-11-16T10:00:00.000Z',...fields});
 const message=(fields:object)=>entry({type:'message',message:{timestamp:1,...fields}});
 expect(parseRecord('reason',message({role:'user',content:'Plain string prompt'}),10)).toMatchObject({kind:'message',sequence:10,nativeId:'aaaa1111',parentId:'bbbb2222',data:{role:'user',content:[{type:'text',text:'Plain string prompt'}]}});
 expect(parseRecord('reason',message({role:'user',content:[{type:'text',text:'See this'},{type:'image',data:'aGVsbG8=',mimeType:'image/png'}]}),0)!.data.content)
  .toEqual([{type:'text',text:'See this'},{type:'image',source:{type:'base64',media_type:'image/png',data:'aGVsbG8='}}]);
 // Redacted thinking has no text; only its encrypted signature, which is never kept.
 expect(parseRecord('reason',message({role:'assistant',content:[{type:'thinking',thinking:'',thinkingSignature:'encrypted',redacted:true}]}),0)).toBeNull();
 expect(parseRecord('reason',message({role:'assistant',content:[],stopReason:'error',errorMessage:'429 rate limited'}),0)!.data).toEqual({role:'assistant',content:[],stop_reason:'error',error:'429 rate limited'});
 expect(parseRecord('reason',message({role:'toolResult',toolCallId:'call_9',toolName:'read',isError:true,content:[{type:'text',text:'ENOENT'},{type:'image',data:'aGVsbG8=',mimeType:'image/jpeg'}],details:{secret:'never kept'}}),0)!.data)
  .toEqual({type:'tool_result',tool_use_id:'call_9',name:'read',output:'ENOENT',content:[{type:'image',source:{type:'base64',media_type:'image/jpeg',data:'aGVsbG8='}}],is_error:true});
 expect(parseRecord('reason',message({role:'bashExecution',command:'git status',output:'clean',exitCode:0,cancelled:false,truncated:false}),0))
  .toMatchObject({kind:'exec_command_end',data:{type:'user_shell_command',command:'git status',aggregated_output:'clean',exit_code:0}});
 expect(parseRecord('reason',entry({type:'custom_message',customType:'review-reminder',content:'Review the final diff.',display:false}),0))
  .toMatchObject({kind:'automation_message',data:{source:'review-reminder',content:[{type:'text',text:'Review the final diff.'}]}});
 const compaction=parseRecord('reason',entry({type:'compaction',summary:'Earlier work summarized.',firstKeptEntryId:'cccc3333',tokensBefore:50000,systemMessage:{role:'system',content:'You are a coding assistant.'}}),0)!;
 expect(compaction).toMatchObject({kind:'compaction',data:{type:'compaction',summary:'Earlier work summarized.',firstKeptEntryId:'cccc3333',tokensBefore:50000}});
 expect(JSON.stringify(compaction)).not.toContain('coding assistant');
 expect(parseRecord('reason',entry({type:'branch_summary',fromId:'dddd4444',summary:'Abandoned approach A.'}),0)).toMatchObject({kind:'compaction',data:{type:'branch_summary',summary:'Abandoned approach A.',fromId:'dddd4444'}});
 expect(parseRecord('reason',{type:'session',version:3,id:'child-1',timestamp:'2026-11-16T10:00:00.000Z',cwd:'/work',parentSession:'/agent/sessions/--work--/2026-11-16T09-00-00-000Z_parent-1.jsonl'},0)!.data)
  .toEqual({id:'child-1',version:3,cwd:'/work',forked_from_id:'parent-1'});
 for(const ignored of [
  message({role:'system',content:'',sections:{preamble:'You are an expert coding assistant'},toolsAdded:[{name:'read'}]}),
  message({role:'custom',customType:'x',content:'duplicate of a custom_message entry',display:true}),
  entry({type:'usage',kind:'cache_warm',provider:'anthropic',model:'m',usage:{totalTokens:5}}),
  entry({type:'custom',customType:'my-extension',data:{count:42}}),
  entry({type:'label',targetId:'aaaa1111',label:'checkpoint-1'}),
  entry({type:'context_edit',targetId:'aaaa1111',replacement:null}),
  entry({type:'something_new'}),
 ])expect(parseRecord('reason',ignored,0)).toBeNull();
 // Views the server already has: transcript rendering needs no Reason-specific code.
 expect(transcriptEntries(compaction as any)).toEqual([{type:'note',label:'Context compacted',text:'Earlier work summarized.',truncated:false}]);
});

test('the installed extension is the reviewed text and starts the runner without a shell',()=>{
 const source=reasonExtensionSource(['/bin/sh',"/tmp/it's here/runner.sh",'collect','hook','--harness','reason']);
 expect(source.startsWith('// OpenCrawl session capture. Managed by `opencrawl collect install --harness reason`')).toBe(true);
 expect(source).toContain(`const command = ["/bin/sh","/tmp/it's here/runner.sh","collect","hook","--harness","reason"];`);
 for(const event of ['session_start','agent_end','session_compact','session_shutdown'])expect(source).toContain(event+':');
 expect(source).not.toContain('shell:');
 // Loadable as written: the factory registers one handler per event and a hook failure never throws.
 const registered:string[]=[];
 const factory=new Function('spawn',source.replace(/^import .*$/m,'').replace('export default function','return function'))(()=>{throw new Error('no runner');});
 factory({on:(event:string,handler:(event:unknown,ctx:unknown)=>void)=>{registered.push(event);handler({}, {sessionManager:{getSessionId:()=>'s',getSessionFile:()=>'/f.jsonl'},cwd:'/w'});handler({}, {sessionManager:{getSessionId:()=>'s',getSessionFile:()=>undefined}});}});
 expect(registered).toEqual(['session_start','agent_end','session_compact','session_shutdown']);
 // What a real agent sent through this extension.
 expect(nativeHooks.map(hook=>hook.payload.hook_event_name)).toEqual(['SessionStart','Stop','SessionEnd']);
 expect(nativeHooks.map(hook=>hook.args.includes('--managed'))).toEqual([true,true,false]);
 for(const hook of nativeHooks){
  expect(hook.args.slice(0,4)).toEqual(['collect','hook','--harness','reason']);
  expect(Object.keys(hook.payload).sort()).toEqual(['cwd','hook_event_name','session_id','transcript_path']);
  expect(hook.payload.session_id).toBe(nativeSession);
  expect(hook.payload.transcript_path.endsWith('/sessions/--home-runner-pi-probe-run-proj--/'+nativeName)).toBe(true);
 }
});

async function fixture(run:(ctx:{
 dir:string;api:string;principal:{tenantId:string;userId:string};agent:string;extension:string;
 batches:any[];documents:ReturnType<typeof batchDocuments>;
 /** Place the native log where the agent would have written it for this fixture. */
 nativeTranscript:(log?:string)=>{file:string;cwd:string;payload:(name:string)=>any};
})=>Promise<void>,{harnesses=['claude-code','codex','cursor','grok-bot','antigravity','devin','reason']}:{harnesses?:string[]}={}) {
 const dir=mkdtempSync(join(tmpdir(),'opencrawl-reason-')),saved={...process.env};
 const principal={tenantId:'tenant-reason',userId:'alice'},token='reason-test-token-012345678901234567890123';
 const store=createLocalSessionStore(join(dir,'objects')),ingest=createSessionIngest(withTestState({store}));
 const batches:any[]=[];
 const documents:ReturnType<typeof batchDocuments>=[];
 const handler=standaloneCapture(withTestState({token,principal,store}));
 const server=createServer(async(req,res)=>{
  if(req.method==='GET'&&req.url==='/api/sessions/identity'&&!harnesses.includes('reason')) {
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({schemaVersion:1,data:{principal,capabilities:{batchEncodings:['gzip'],harnesses}}}));return;
  }
  if(req.method==='POST'&&req.url==='/api/sessions/batches') {
   const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));
   const raw=Buffer.concat(chunks);
   const batch=JSON.parse(req.headers['content-encoding']==='gzip'?Bun.gunzipSync(raw).toString():raw.toString());batches.push(batch);
   const receipt=await ingest.putBatch(principal,batch);
   const stored=await ingest.getBatch(principal,{...batch,batchId:receipt.batchId});
   const key=`capture-v1/tenants/${digest(principal.tenantId)}/users/${digest(principal.userId)}/${batch.harness}/${digest(batch.installationId)}/${digest(batch.sessionId)}/${receipt.batchId}.json.gz`;
   documents.push(...batchDocuments({prefix:'capture-v1',key,batch:stored!,principal}));
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({schemaVersion:1,data:receipt}));return;
  }
  handler(req,res);
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const api='http://127.0.0.1:'+(server.address() as any).port,agent=join(dir,'pi-agent');
 Object.assign(process.env,{OPENCRAWL_NO_UPDATE:'1',OPENCRAWL_CONFIG_HOME:join(dir,'config'),OPENCRAWL_API_URL:api,OPENCRAWL_SESSIONS_TOKEN:token,
  CLAUDE_CONFIG_DIR:join(dir,'claude'),CODEX_HOME:join(dir,'codex'),ANTIGRAVITY_HOME:join(dir,'gemini'),PI_CODING_AGENT_DIR:agent});
 const nativeTranscript=(log=nativeLog)=>{
  const cwd=join(dir,'proj'),file=join(agent,'sessions','--proj--',nativeName);
  mkdirSync(dirname(file),{recursive:true});mkdirSync(cwd,{recursive:true});
  writeFileSync(file,log.replaceAll('/home/runner/pi-probe/run/proj',cwd));
  return {file,cwd,payload:(name:string)=>({...nativeHooks.find(hook=>hook.payload.hook_event_name===name)!.payload,transcript_path:file,cwd})};
 };
 try {
  await run({dir,api,principal,agent,extension:join(agent,'extensions','opencrawl-capture.ts'),batches,documents,nativeTranscript});
 } finally {
  server.closeAllConnections();
  await new Promise<void>(r=>server.close(()=>r()));
  for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];
  Object.assign(process.env,saved);
  rmSync(dir,{recursive:true,force:true});
 }
}

test('install writes one owned extension, keeps the rest of the agent directory, and uninstall removes only that file',async()=>fixture(async f=>{
 mkdirSync(join(f.agent,'extensions'),{recursive:true});
 writeFileSync(join(f.agent,'settings.json'),'{"theme":"dark"}\n');
 writeFileSync(join(f.agent,'extensions','mine.ts'),'export default function(){}\n');
 const installed:any=await installCapture(f.api,{home:f.dir,command:[process.execPath,'-e',''],harnesses:['reason']});
 expect(installed.harnesses).toEqual(['reason']);
 expect(installed.nextStep).toContain(f.extension);
 const config=readCaptureConfig()!;
 expect(config.roots.reason).toBe(f.agent);
 const source=readFileSync(f.extension,'utf8');
 expect(source).toBe(reasonExtensionSource([...(process.platform==='win32'?['cmd.exe','/d','/c']:['/bin/sh']),join(f.dir,'config','opencrawl','capture',process.platform==='win32'?'runner.cmd':'runner.sh'),'collect','hook','--harness','reason']));
 expect(readFileSync(join(f.agent,'settings.json'),'utf8')).toBe('{"theme":"dark"}\n');
 expect(readFileSync(join(f.agent,'extensions','mine.ts'),'utf8')).toBe('export default function(){}\n');
 // Other harness directories are not created or changed by a Reason-only install.
 expect(existsSync(join(f.dir,'claude','settings.json'))).toBe(false);
 expect(existsSync(join(f.dir,'codex','hooks.json'))).toBe(false);
 // Reinstalling is idempotent.
 await installCapture(f.api,{home:f.dir,command:[process.execPath,'-e',''],harnesses:['reason']});
 expect(readFileSync(f.extension,'utf8')).toBe(source);
 await uninstallCapture(f.dir);
 expect(existsSync(f.extension)).toBe(false);
 expect(existsSync(join(f.agent,'extensions','mine.ts'))).toBe(true);
 expect(readCaptureConfig()!.disabled).toBe(true);
}));

test('install refuses to replace a same-named extension it does not own and changes nothing',async()=>fixture(async f=>{
 mkdirSync(join(f.agent,'extensions'),{recursive:true});
 writeFileSync(f.extension,'// someone else\nexport default function(){}\n');
 await expect(installCapture(f.api,{home:f.dir,command:[process.execPath,'-e',''],harnesses:['reason']})).rejects.toMatchObject({code:'CAPTURE_INVALID_CONFIG'});
 expect(readFileSync(f.extension,'utf8')).toBe('// someone else\nexport default function(){}\n');
 expect(readCaptureConfig()).toBeNull();
}));

test('a receiver that does not list reason is refused before anything is written',async()=>fixture(async f=>{
 await expect(installCapture(f.api,{home:f.dir,command:[process.execPath,'-e',''],harnesses:['reason']})).rejects.toMatchObject({code:'CAPTURE_HARNESS_UNSUPPORTED'});
 expect(existsSync(f.extension)).toBe(false);
 expect(readCaptureConfig()).toBeNull();
},{harnesses:['claude-code','codex']}));

test('replacing the selection removes the extension of a harness that is no longer chosen',async()=>fixture(async f=>{
 await installCapture(f.api,{home:f.dir,command:[process.execPath,'-e',''],harnesses:['reason']});
 expect(existsSync(f.extension)).toBe(true);
 await installCapture(f.api,{home:f.dir,command:[process.execPath,'-e',''],harnesses:['claude-code'],selectionMode:'replace'});
 expect(existsSync(f.extension)).toBe(false);
 expect(readCaptureConfig()!.harnesses).toEqual(['claude-code']);
}));

test('collect install --harness reason enrolls through the command without importing history',async()=>fixture(async f=>{
 const result:any=await collectCommand('install',f.api,{harness:'reason',yes:true,json:true});
 expect(result.harnesses).toEqual(['reason']);
 expect(result.backfill).toEqual({status:'skipped'});
 expect(existsSync(f.extension)).toBe(true);
 await expect(collectCommand('install',f.api,{harness:'reasn',yes:true,json:true})).rejects.toMatchObject({code:'INVALID_USAGE'});
}));

test('native hooks capture a session once, in order, and later turns add only new events',async()=>fixture(async f=>{
 await installCapture(f.api,{home:f.dir,command:[process.execPath,'-e',''],harnesses:['reason']});
 const config=readCaptureConfig()!;
 const lines=nativeLog.split('\n').slice(0,-1);
 // The first turn ends after the tool result; the final answer arrives later.
 const native=f.nativeTranscript(lines.slice(0,8).join('\n')+'\n');
 await captureHook('reason',native.payload('SessionStart'));
 await captureHook('reason',native.payload('Stop'));
 expect(f.batches).toHaveLength(0); // A hook only hands off a durable notice.
 expect(captureStatus().pendingHooks).toBe(2);
 await drainCaptureNotices();
 await flushCaptures();
 expect(f.batches.every(batch=>batch.harness==='reason'&&batch.sessionId===nativeSession&&batch.cwd===native.cwd&&batch.captureMode==='live'&&batch.installationId===config.installationId)).toBe(true);
 const transcript=()=>f.batches.flatMap(batch=>batch.events).filter((event:any)=>event.kind!=='hook').sort((a:any,b:any)=>a.sequence-b.sequence);
 expect(transcript().map((event:any)=>event.kind)).toEqual(['session_metadata','session_title','turn_metadata','turn_metadata','message','message','tool_result']);
 expect(f.batches.flatMap(batch=>batch.events).filter((event:any)=>event.kind==='hook').map((event:any)=>event.data.hook_event_name)).toEqual(['SessionStart','Stop']);
 // The same hooks again, with nothing new in the log, upload no transcript event twice.
 await captureHook('reason',native.payload('Stop'));
 await drainCaptureNotices();await flushCaptures();
 expect(transcript()).toHaveLength(7);
 appendFileSync(native.file,lines[8]+'\n');
 await captureHook('reason',native.payload('Stop'));
 await captureHook('reason',native.payload('SessionEnd'));
 await drainCaptureNotices();await flushCaptures();
 const events=transcript();
 expect(events).toHaveLength(8);
 expect(new Set(events.map((event:any)=>event.id)).size).toBe(8);
 expect(events[7]).toMatchObject({kind:'message',nativeId:'a81328bc',parentId:'10be76f7',timestamp:'2026-11-16T21:21:13.412Z'});
 expect(events[7].data.content.at(-1)).toEqual({type:'text',text:'Done: the command printed REASON_PROBE_MARKER.'});
 // The receiver stores and indexes it with no Reason-specific projection.
 const text=f.documents.map(item=>item.document.text??'').join('\n');
 for(const expected of ['Print the probe marker with echo.','echo REASON_PROBE_MARKER','Done: the command printed REASON_PROBE_MARKER.'])expect(text).toContain(expected);
 expect(text).not.toContain('You are an expert coding assistant');
 expect(f.documents.length>0&&f.documents.every(item=>item.document.harness==='reason'&&item.document.sessionId===nativeSession)).toBe(true);
 expect(f.documents.find(item=>item.document.kind==='tool_result')!.document).toMatchObject({toolCallId:'call_probe_1',nativeId:'10be76f7',parentId:'26699b3b',timestamp:'2026-11-16T21:21:13.405Z'});
 expect(events.flatMap((event:any)=>transcriptEntries(event)).map((entry:any)=>entry.type)).toEqual(['message','message','tool_call','tool_result','message']);
 expect(captureStatus().pendingHooks).toBe(0);
 expect(captureStatus().queued).toBe(0);
}));

test('images in a prompt or a tool result are uploaded as attachments, never as inline base64',async()=>fixture(async f=>{
 await installCapture(f.api,{home:f.dir,command:[process.execPath,'-e',''],harnesses:['reason']});
 const png=Buffer.from('reason-native-image').toString('base64'),shot=Buffer.from('reason-tool-screenshot').toString('base64');
 const entry=(id:string,parentId:string|null,message:object)=>JSON.stringify({type:'message',id,parentId,timestamp:'2026-11-16T10:00:00.000Z',message:{timestamp:1,...message}});
 const native=f.nativeTranscript([
  JSON.stringify({type:'session',version:3,id:nativeSession,timestamp:'2026-11-16T10:00:00.000Z',cwd:'/home/runner/pi-probe/run/proj'}),
  entry('aaaa0001',null,{role:'user',content:[{type:'text',text:'What is in this picture?'},{type:'image',data:png,mimeType:'image/png'}]}),
  // A tool argument that merely looks like an attachment is never opened.
  entry('aaaa0002','aaaa0001',{role:'assistant',content:[{type:'toolCall',id:'call_shot',name:'screenshot',arguments:{type:'input_file',path:'/etc/hostname'}}],stopReason:'toolUse'}),
  entry('aaaa0003','aaaa0002',{role:'toolResult',toolCallId:'call_shot',toolName:'screenshot',isError:false,content:[{type:'text',text:'Captured the window.'},{type:'image',data:shot,mimeType:'image/jpeg'}]}),
 ].join('\n')+'\n');
 await captureHook('reason',native.payload('Stop'));
 await drainCaptureNotices();await flushCaptures();
 const events=f.batches.flatMap(batch=>batch.events);
 const prompt=events.find((event:any)=>event.nativeId==='aaaa0001'),result=events.find((event:any)=>event.nativeId==='aaaa0003'),call=events.find((event:any)=>event.nativeId==='aaaa0002');
 expect(prompt.data.content[1]).toMatchObject({type:'image',source:{type:'opencrawl_attachment',status:'captured',mimeType:'image/png',size:19}});
 expect(result.data).toMatchObject({output:'Captured the window.',content:[{type:'image',source:{type:'opencrawl_attachment',status:'captured',mimeType:'image/jpeg'}}]});
 expect(call.data.content[0].input).toEqual({type:'input_file',path:'/etc/hostname'});
 const attachments=f.batches.flatMap(batch=>batch.attachments);
 expect(attachments.map((attachment:any)=>attachment.status)).toEqual(['captured','captured']);
 expect(JSON.stringify(f.batches)).not.toContain(png);
 expect(JSON.stringify(f.batches)).not.toContain(shot);
}));

test('only a log in the sessions directory whose header names the registered session is read',async()=>fixture(async f=>{
 await installCapture(f.api,{home:f.dir,command:[process.execPath,'-e',''],harnesses:['reason']});
 const config=readCaptureConfig()!,native=f.nativeTranscript();
 const outside=join(f.dir,'elsewhere.jsonl');writeFileSync(outside,nativeLog);
 await expect(captureTranscript(config,'reason',outside,{session_id:nativeSession})).rejects.toMatchObject({code:'CAPTURE_PATH_REJECTED'});
 const extensionLog=join(f.agent,'extensions','notes.jsonl');writeFileSync(extensionLog,nativeLog);
 await expect(captureTranscript(config,'reason',extensionLog,{session_id:nativeSession})).rejects.toMatchObject({code:'CAPTURE_PATH_REJECTED'});
 expect(daemonPathAllowed(config,'reason',nativeSession,native.file)).toBe(true);
 expect(daemonPathAllowed(config,'reason','another-session',native.file)).toBe(false);
 expect(daemonPathAllowed(config,'reason',nativeSession,join(f.agent,'sessions',nativeName))).toBe(false);
 expect(daemonPathAllowed(config,'reason',nativeSession,outside)).toBe(false);
 expect(assertSessionTranscriptPath(config,'reason',nativeSession,native.file)).toMatchObject({sessionId:nativeSession});
 expect(()=>assertSessionTranscriptPath(config,'reason','another-session',native.file)).toThrow();
 if(process.platform!=='win32'){
  const link=join(f.agent,'sessions','--proj--','2026-11-16T00-00-00-000Z_linked.jsonl');symlinkSync(outside,link);
  expect(()=>assertSessionTranscriptPath(config,'reason','linked',link)).toThrow();
 }
 // A file named for one session whose header names another is refused, not relabelled.
 const renamed=join(f.agent,'sessions','--proj--','2026-11-16T00-00-00-000Z_impostor.jsonl');writeFileSync(renamed,nativeLog);
 await expect(captureTranscript(config,'reason',renamed,{session_id:'impostor'},false,undefined,undefined,{sessionScoped:true})).rejects.toMatchObject({code:'CAPTURE_SESSION_MISMATCH'});
 await flushCaptures();
 expect(f.batches).toHaveLength(0);
}));

test('the daemon handoff registers the native log named by the hook',async()=>fixture(async f=>{
 await installCapture(f.api,{home:f.dir,command:[process.execPath,'-e',''],harnesses:['reason'],daemon:true,daemonService:false});
 const config=readCaptureConfig()!,native=f.nativeTranscript();
 expect(recordNativeDaemonHook('reason',native.payload('Stop'))).toBe(true);
 const inbox=join(captureDir(),'daemon','inbox'),names=(await import('node:fs')).readdirSync(inbox);
 expect(names).toHaveLength(1);
 const notice=JSON.parse(readFileSync(join(inbox,names[0]!),'utf8'));
 expect(daemonRegistration(config,notice)).toMatchObject({harness:'reason',sessionId:nativeSession,path:native.file,cwd:native.cwd,endedAt:notice.at});
 expect(()=>daemonRegistration(config,{...notice,record:{...notice.record,event:{...notice.record.event,transcript_path:join(f.dir,'elsewhere.jsonl')}}})).toThrow();
}));

test('project exclusions, history preview and approved import use the header directory and the sessions folder',async()=>fixture(async f=>{
 await installCapture(f.api,{home:f.dir,command:[process.execPath,'-e',''],harnesses:['reason']});
 const native=f.nativeTranscript();
 expect(backfillPreview(f.api,'reason').sources).toEqual([{harness:'reason',files:1,bytes:Buffer.byteLength(readFileSync(native.file))}]);
 await excludeCapture(native.cwd,undefined);
 await captureHook('reason',native.payload('Stop'));
 await drainCaptureNotices();await flushCaptures();
 await backfill(f.api,'reason',true,{retryDelays:[]});
 expect(f.batches).toHaveLength(0);
}));

test('an approved history import and a later sync upload each event once',async()=>fixture(async f=>{
 const native=f.nativeTranscript();
 await installCapture(f.api,{home:f.dir,command:[process.execPath,'-e',''],harnesses:['reason']});
 const result:any=await backfill(f.api,'reason',true,{retryDelays:[]});
 expect(result.status).toBe('complete');
 const events=()=>f.batches.flatMap(batch=>batch.events);
 expect(events()).toHaveLength(8);
 expect(f.batches.every(batch=>batch.harness==='reason'&&batch.sessionId===nativeSession&&batch.captureMode==='history')).toBe(true);
 await syncCaptures();
 expect(events()).toHaveLength(8);
 expect(existsSync(native.file)).toBe(true);
}));
