import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,chmodSync,statSync,utimesSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {standaloneCapture} from '../../dist/tools/test-fixtures/capture.mjs';
import {createLocalSessionStore} from '../../dist/src/sessions/local-store.mjs';
import {createSessionIngest,digest} from '../../dist/src/sessions/ingest.mjs';
import {batchDocuments} from '../../dist/src/sessions/indexer.mjs';
import {installCapture,uninstallCapture,upgradeCaptureHooks} from '../src/capture/install.ts';
import {captureDir,captureStatus,readCaptureConfig,captureTranscript,flushCaptures} from '../src/capture/runtime.ts';
import {backfill,backfillPreview,chooseBackfill} from '../src/capture/backfill.ts';
import {excludeCapture} from '../src/capture/controls.ts';
import {parseRecord,normalizeHarness,finalizeEventIdentity} from '../src/capture/parse.ts';
import {transcriptEntries} from '../../dist/src/sessions/library.mjs';
import {antigravityResponse} from '../src/capture/command.ts';
import {refreshMemories} from '../src/capture/memory.ts';

test('parseRecord maps Antigravity transcript steps and strips wrapper metadata without reading tool-arg paths',()=>{
 const userStep={
  step_index:0,source:'USER_EXPLICIT',type:'USER_INPUT',status:'DONE',created_at:'2026-11-13T23:22:38Z',
  content:'<USER_REQUEST>\nShip Antigravity support\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-13\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nThinking Effort Level: high\n</USER_SETTINGS_CHANGE>',
  media:[{mime_type:'image/png',uri:'file:///tmp/screenshot.png'},{mime_type:'image/jpeg',uri:'https://example.com/diagram.jpg'}],
 };
 const parsedUser=parseRecord('antigravity',userStep,0)!;
 expect(parsedUser.kind).toBe('message');
 expect(parsedUser.nativeId).toBe('0');
 expect(parsedUser.timestamp).toBe('2026-11-13T23:22:38Z');
 expect(parsedUser.data).toEqual({
  role:'user',
  content:[
   {type:'text',text:'Ship Antigravity support'},
   {type:'input_file',path:'/tmp/screenshot.png',media_type:'image/png'},
   {type:'url',url:'https://example.com/diagram.jpg',media_type:'image/jpeg'},
  ],
 });
 expect(JSON.stringify(parsedUser)).not.toContain('ADDITIONAL_METADATA');

 const autoStep={step_index:1,source:'SYSTEM',type:'USER_INPUT',status:'DONE',created_at:'2026-11-13T23:22:39Z',content:'<SYSTEM_MESSAGE>Task finished</SYSTEM_MESSAGE>'};
 expect(parseRecord('antigravity',autoStep,100)).toMatchObject({kind:'automation_message',nativeId:'1',data:{source:'SYSTEM',content:'<SYSTEM_MESSAGE>Task finished</SYSTEM_MESSAGE>'}});

 const plannerStep={
  step_index:2,source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE',created_at:'2026-11-13T23:22:40Z',
  thinking:'Check src/sessions/types.mts.',content:'Updating harness list.',
  tool_calls:[{name:'read_file',args:{Path:'/etc/passwd',type:'input_file',path:'/etc/passwd'}}],
 };
 const parsedPlanner=parseRecord('antigravity',plannerStep,200)!;
 expect(parsedPlanner.kind).toBe('message');
 expect(parsedPlanner.data).toEqual({
  role:'assistant',
  content:[
   {type:'thinking',thinking:'Check src/sessions/types.mts.'},
   {type:'text',text:'Updating harness list.'},
   {type:'tool_use',name:'read_file',input:{Path:'/etc/passwd',type:'input_file',path:'/etc/passwd'}},
  ],
 });

 expect(parseRecord('antigravity',{step_index:3,source:'MODEL',type:'GENERIC',status:'DONE',created_at:'2026-11-13T23:22:41Z',content:'1: export const SESSION_HARNESSES'},300))
  .toMatchObject({kind:'tool_result',data:{type:'tool_result',output:'1: export const SESSION_HARNESSES'}});
 expect(parseRecord('antigravity',{step_index:4,source:'MODEL',type:'GENERIC',status:'ERROR',error:'ENOENT',content:'file does not exist'},400))
  .toMatchObject({kind:'tool_result',data:{type:'tool_result',output:'file does not exist',is_error:true,error:'ENOENT'}});
 expect(parseRecord('antigravity',{step_index:5,source:'SYSTEM',type:'CHECKPOINT',status:'DONE',content:'# Resuming from a compaction'},500))
  .toMatchObject({kind:'compaction',data:{content:'# Resuming from a compaction'}});
 expect(parseRecord('antigravity',{step_index:6,source:'SYSTEM',type:'ERROR_MESSAGE',status:'DONE',error:'tls retry'},600))
  .toMatchObject({kind:'error',data:{error:'tls retry'}});
 expect(normalizeHarness('agy')).toBe('antigravity');
 expect(normalizeHarness('antigravity')).toBe('antigravity');
 expect(antigravityResponse({hookEventName:'Stop'})).toEqual({decision:'allow'});
 expect(antigravityResponse(null,'Stop')).toEqual({decision:'allow'});
 expect(antigravityResponse({hookEventName:'PostToolUse'})).toEqual({});
 expect(antigravityResponse({hookEventName:'SessionStart'},undefined,'Paused')).toEqual({injectSteps:[{systemMessage:{systemMessage:'Paused',metadata:{user_markdown:'Paused'}}}]});
});

async function fixture(run:(ctx:{
 dir:string;api:string;token:string;principal:{tenantId:string;userId:string};
 batches:any[];documents:ReturnType<typeof batchDocuments>;attachments:Map<string,Buffer>;hooksFile:string;
})=>Promise<void>) {
 const dir=mkdtempSync(join(tmpdir(),'opencrawl-agy-')),saved={...process.env};
 const principal={tenantId:'tenant-agy',userId:'alice'},token='antigravity-test-token-01234567890123456789';
 const store=createLocalSessionStore(join(dir,'objects')),ingest=createSessionIngest({store});
 const batches:any[]=[],attachments=new Map<string,Buffer>();
 const documents:ReturnType<typeof batchDocuments>=[];
 const handler=standaloneCapture({token,principal,store});
 const server=createServer(async(req,res)=>{
  if(req.method==='PUT'&&req.url?.startsWith('/api/sessions/attachments/')) {
   const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));
   const bytes=Buffer.concat(chunks),url=new URL(req.url,'http://127.0.0.1');
   const sha=url.pathname.split('/').pop()!;
   attachments.set(sha,bytes);
   const receipt=await ingest.putAttachment(principal,sha,bytes,{
    harness:url.searchParams.get('harness')??'',installationId:url.searchParams.get('installationId')??'',sessionId:url.searchParams.get('sessionId')??'',
   });
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({schemaVersion:1,data:receipt}));return;
  }
  if(req.method==='POST'&&req.url==='/api/sessions/batches') {
   const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));
   const raw=Buffer.concat(chunks);
   const json=req.headers['content-encoding']==='gzip'?Bun.gunzipSync(raw).toString():raw.toString();
   const batch=JSON.parse(json);batches.push(batch);
   const receipt=await ingest.putBatch(principal,batch);
   const stored=await ingest.getBatch(principal,{...batch,batchId:receipt.batchId});
   const key=`capture-v1/tenants/${digest(principal.tenantId)}/users/${digest(principal.userId)}/${batch.harness}/${digest(batch.installationId)}/${digest(batch.sessionId)}/${receipt.batchId}.json.gz`;
   documents.push(...batchDocuments({prefix:'capture-v1',key,batch:stored!,principal}));
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({schemaVersion:1,data:receipt}));return;
  }
  handler(req,res);
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const api='http://127.0.0.1:'+(server.address() as any).port;
 Object.assign(process.env,{
  OPENCRAWL_NO_UPDATE:'1',
  OPENCRAWL_CONFIG_HOME:join(dir,'config'),
  OPENCRAWL_API_URL:api,
  OPENCRAWL_SESSIONS_TOKEN:token,
  CLAUDE_CONFIG_DIR:join(dir,'claude'),
  CODEX_HOME:join(dir,'codex'),
  ANTIGRAVITY_HOME:join(dir,'gemini'),
 });
 try {
  await run({dir,api,token,principal,batches,documents,attachments,hooksFile:join(dir,'gemini','config','hooks.json')});
 } finally {
  server.closeAllConnections();
  await new Promise<void>(r=>server.close(()=>r()));
  for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];
  Object.assign(process.env,saved);
  rmSync(dir,{recursive:true,force:true});
 }
}

test('native step identity survives compact/full offsets and JSON formatting but preserves content revisions',()=>{
 const step={step_index:1,type:'PLANNER_RESPONSE',content:'Same answer',created_at:'2026-11-13T23:00:01Z'};
 const wire=(record:object,offset:number)=>finalizeEventIdentity(parseRecord('antigravity',record,offset));
 const compact=wire({...step,truncated_fields:[]},120);
 const full=wire({content:step.content,created_at:step.created_at,type:step.type,step_index:1},450);
 expect(full).toEqual(compact);
 expect(wire({...step,content:'A fuller answer'},450).id).not.toBe(compact.id);
 expect(wire({...step,step_index:2},450).id).not.toBe(compact.id);
 // Legacy records without a native step still distinguish repeated text.
 const {step_index,...legacy}=step;
 expect(wire(legacy,120).id).not.toBe(wire(legacy,450).id);
});

test('native tool and assistant media survive capture without reading attachment-shaped tool arguments or output',async()=>fixture(async f=>{
 await installCapture(f.api,{home:f.dir,command:[process.execPath,'-e',''],harnesses:['antigravity']});
 const logs=join(f.dir,'gemini','antigravity-cli','brain','conv-tool-media','.system_generated','logs');
 mkdirSync(logs,{recursive:true});
 const image=join(logs,'image.png'),generated=join(logs,'generated.png'),unopened=join(logs,'unopened.txt');
 writeFileSync(image,'native-tool-image');writeFileSync(generated,'native-generated-image');writeFileSync(unopened,'must-not-be-uploaded');
 const media=(path:string)=>[{mime_type:'image/png',uri:pathToFileURL(path).href}];
 const spoof={type:'input_file',path:unopened};
 const file=join(logs,'transcript_full.jsonl');
 writeFileSync(file,[
  {step_index:0,type:'PLANNER_RESPONSE',tool_calls:[{name:'read_file',args:spoof}]},
  {step_index:1,type:'GENERIC',status:'DONE',content:'Showing binary file of type image/png',media:media(image)},
  {step_index:2,type:'GENERIC',status:'DONE',media:media(image)},
  {step_index:3,type:'PLANNER_RESPONSE',media:media(generated)},
  {step_index:4,type:'GENERIC',status:'DONE',content:JSON.stringify(spoof)},
 ].map(row=>JSON.stringify(row)+'\n').join(''));
 await captureTranscript(readCaptureConfig()!,'antigravity',file);
 await flushCaptures();
 const events=f.batches.flatMap(batch=>batch.events);
 expect(events.filter(event=>event.kind==='tool_result')).toHaveLength(3);
 expect(events.find(event=>event.nativeId==='1').data).toMatchObject({output:'Showing binary file of type image/png',content:[{type:'opencrawl_attachment',status:'captured',mimeType:'image/png'}]});
 expect(events.find(event=>event.nativeId==='2').data.content[0].status).toBe('captured');
 expect(events.find(event=>event.nativeId==='3').data.content[0].status).toBe('captured');
 expect([...f.attachments.values()].map(bytes=>bytes.toString()).sort()).toEqual(['native-generated-image','native-tool-image']);
 expect(f.documents.some(item=>item.document.text?.includes('Showing binary file of type image/png'))).toBe(true);
 expect(captureStatus().queued).toBe(0);
}));

test('native background task completion is captured as automation while startup prompts stay filtered',async()=>fixture(async f=>{
 await installCapture(f.api,{home:f.dir,command:[process.execPath,'-e',''],harnesses:['antigravity']});
 const logs=join(f.dir,'gemini','antigravity','brain','conv-background','.system_generated','logs');
 mkdirSync(logs,{recursive:true});
 const notification='The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-14T21:19:04Z sender=conv-background/task-23 priority=MESSAGE_PRIORITY_HIGH content=Task id "conv-background/task-23" finished with result:\nCommand exited with code 7.\n\nCommand output:\nBACKGROUND_SIGNAL_80\n</SYSTEM_MESSAGE>';
 const file=join(logs,'transcript_full.jsonl');
 writeFileSync(file,[
  {step_index:0,type:'SYSTEM_MESSAGE',source:'SYSTEM_SDK',content:'SessionStart hook: repeated startup instructions'},
  {step_index:1,type:'SYSTEM_MESSAGE',source:'SYSTEM',content:notification},
  {step_index:2,type:'SYSTEM_MESSAGE',source:'SYSTEM',content:'Repeated environment instructions'},
 ].map(row=>JSON.stringify(row)+'\n').join(''));
 await captureTranscript(readCaptureConfig()!,'antigravity',file);await flushCaptures();
 const events=f.batches.flatMap(batch=>batch.events);
 expect(events).toHaveLength(1);
 expect(events[0]).toMatchObject({kind:'automation_message',nativeId:'1',data:{source:'SYSTEM',content:notification}});
 expect(transcriptEntries(events[0])).toEqual([{type:'note',label:'Automation',text:notification,truncated:false}]);
 expect(f.documents.some(item=>item.document.text?.includes('BACKGROUND_SIGNAL_80'))).toBe(true);
}));

test('compact-to-full capture, resume and retry keep one indexed copy of unchanged steps and searchable errors',async()=>fixture(async f=>{
 await installCapture(f.api,{home:f.dir,command:[process.execPath,'-e',''],harnesses:['antigravity']});
 const config=readCaptureConfig()!;
 const logs=join(f.dir,'gemini','antigravity-cli','brain','conv-transition','.system_generated','logs');
 mkdirSync(logs,{recursive:true});
 const compact=join(logs,'transcript.jsonl'),full=join(logs,'transcript_full.jsonl');
 const prompt={step_index:0,type:'USER_INPUT',content:'Short prompt'};
 const answer={step_index:1,type:'PLANNER_RESPONSE',content:'Unchanged assistant answer'};
 const write=(file:string,records:object[])=>writeFileSync(file,records.map(record=>JSON.stringify(record)+'\n').join(''));
 write(compact,[{...prompt,truncated_fields:['content']},answer]);
 await captureTranscript(config,'antigravity',compact);
 await flushCaptures();
 write(full,[{...prompt,content:'The complete longer prompt'},answer]);
 await captureTranscript(config,'antigravity',compact);
 await flushCaptures();
 const resumed={step_index:2,type:'ERROR_MESSAGE',content:'Model request failed',error:'quota exhausted'};
 write(full,[{...prompt,content:'The complete longer prompt'},answer,resumed]);
 await captureTranscript(config,'antigravity',compact);
 await flushCaptures();
 const count=f.batches.length;
 await captureTranscript(config,'antigravity',compact);
 await flushCaptures();
 expect(f.batches.length).toBe(count);
 expect(captureStatus().queued).toBe(0);
 const events=f.batches.flatMap(b=>b.events);
 const copies=events.filter(event=>event.nativeId==='1');
 expect(copies.length).toBe(2); // Replayed source, same immutable event identity.
 expect(new Set(copies.map(event=>event.id)).size).toBe(1);
 expect(new Set(events.filter(event=>event.nativeId==='0').map(event=>event.id)).size).toBe(2);
 expect(new Set(f.documents.filter(item=>item.document.text?.includes('Unchanged assistant answer')).map(item=>item.id)).size).toBe(1);
 expect(f.documents.some(item=>item.document.kind==='error'&&item.document.text?.includes('quota exhausted'))).toBe(true);
 const failure=events.find(event=>event.kind==='error');
 expect(failure).toBeDefined();
 expect(transcriptEntries(failure)).toEqual([{type:'note',label:'Error',text:'Model request failed\nquota exhausted',truncated:false}]);
}));

test('disabled Antigravity capture survives unrelated enrollment, reinstall and hook upgrades',async()=>fixture(async f=>{
 await installCapture(f.api,{home:f.dir,command:[process.execPath,'-e',''],harnesses:['antigravity']});
 const hooks=JSON.parse(readFileSync(f.hooksFile,'utf8'));
 hooks['opencrawl-capture'].enabled=false;
 hooks['user-linter']={enabled:false,Stop:[{type:'command',command:'./lint.sh'}]};
 writeFileSync(f.hooksFile,JSON.stringify(hooks));
 const preserved=()=>{
  const current=JSON.parse(readFileSync(f.hooksFile,'utf8'));
  expect(current['opencrawl-capture'].enabled).toBe(false);
  expect(current['opencrawl-capture'].SessionStart).toHaveLength(1);
  expect(current['user-linter']).toEqual(hooks['user-linter']);
 };
 await installCapture(f.api,{home:f.dir,command:[process.execPath,'-e',''],harnesses:['claude-code']});
 preserved();
 const reinstalled=await installCapture(f.api,{home:f.dir,command:[process.execPath,'-e',''],harnesses:['antigravity']});
 expect(reinstalled.nextStep).toContain('Antigravity capture remains disabled');
 expect(reinstalled.nextStep).not.toContain('Claude');
 expect(reinstalled.nextStep).not.toContain('Codex');
 preserved();
 const config=readCaptureConfig()!;
 writeFileSync(join(captureDir(),'config.json'),JSON.stringify({...config,hookMode:'legacy-disabled-fixture'}));
 await upgradeCaptureHooks();
 expect(readCaptureConfig()?.hookMode).toBe(config.hookMode);
 preserved();
}));

test('auto-detection, agy alias, hooks.json coexistence, rollback and uninstall preserve unrelated hooks',async()=>fixture(async f=>{
 // When Antigravity directory exists, plain installCapture auto-enrolls antigravity.
 mkdirSync(join(f.dir,'gemini','antigravity-cli'),{recursive:true});
 mkdirSync(join(f.dir,'gemini','config'),{recursive:true});
 const userHooks={
  'user-linter':{PostToolUse:[{matcher:'run_command',hooks:[{type:'command',command:'./lint.sh',timeout:10}]}]},
  'opencrawl-startup':{SessionStart:[{type:'command',command:'startup-cmd',timeout:7}]},
 };
 writeFileSync(f.hooksFile,JSON.stringify(userHooks,null,4)+'\n',{mode:0o640});
 if(process.platform!=='win32')chmodSync(f.hooksFile,0o640);

 const auto=await installCapture(f.api,{home:f.dir,command:[process.execPath,'-e','']});
 expect(auto.harnesses).toEqual(['claude-code','codex','antigravity']);
 const written=JSON.parse(readFileSync(f.hooksFile,'utf8'));
 expect(written['user-linter']).toEqual(userHooks['user-linter']);
 expect(written['opencrawl-startup']).toEqual(userHooks['opencrawl-startup']);
 expect(Object.keys(written['opencrawl-capture']).sort()).toEqual(['PostInvocation','PostToolUse','SessionStart','Stop']);
 expect(written['opencrawl-capture'].PostToolUse[0].matcher).toBe('*');
 expect(written['opencrawl-capture'].Stop[0].command).toContain('--event');
 if(process.platform!=='win32')expect(statSync(f.hooksFile).mode&0o777).toBe(0o640);
 expect(readFileSync(f.hooksFile,'utf8')).toContain('\n    "user-linter"');

 // Invalid existing hooks.json aborts without partial changes.
 writeFileSync(f.hooksFile,'["not-an-object"]\n');
 await expect(installCapture(f.api,{home:f.dir,command:[process.execPath,'-e',''],harnesses:['agy' as any]})).rejects.toMatchObject({code:'CAPTURE_INVALID_CONFIG'});
 expect(readFileSync(f.hooksFile,'utf8')).toBe('["not-an-object"]\n');

 // Restore valid file, install via 'agy' alias, then uninstall removes only opencrawl-capture.
 writeFileSync(f.hooksFile,JSON.stringify(userHooks,null,2)+'\n');
 const viaAlias=await installCapture(f.api,{home:f.dir,command:[process.execPath,'-e',''],harnesses:['agy' as any]});
 expect(viaAlias.harnesses).toContain('antigravity');
 await uninstallCapture(f.dir);
 const afterUninstall=JSON.parse(readFileSync(f.hooksFile,'utf8'));
 expect(afterUninstall['opencrawl-capture']).toBeUndefined();
 expect(afterUninstall['user-linter']).toEqual(userHooks['user-linter']);
 expect(afterUninstall['opencrawl-startup']).toEqual(userHooks['opencrawl-startup']);
}));

test('synchronous Antigravity hooks prefer transcript_full.jsonl, capture media, ignore scratch jsonl, honor exclusions and never block',async()=>fixture(async f=>{
 const cli=resolve(import.meta.dir,'../src/cli.ts');
 await installCapture(f.api,{home:f.dir,command:[process.execPath,cli],harnesses:['antigravity']});

 // Ensure GEMINI.md / AGENTS.md under ~/.gemini are never scanned as native memories.
 mkdirSync(join(f.dir,'gemini','config'),{recursive:true});
 writeFileSync(join(f.dir,'gemini','config','GEMINI.md'),'rule instructions');
 await refreshMemories();

 const convId='conv-live-001',workspace=join(f.dir,'workspace');
 const convRoot=join(f.dir,'gemini','antigravity-cli','brain',convId);
 const logsDir=join(convRoot,'.system_generated','logs'),scratchDir=join(convRoot,'scratch');
 mkdirSync(logsDir,{recursive:true});mkdirSync(scratchDir,{recursive:true});mkdirSync(workspace,{recursive:true});
 const mediaFile=join(workspace,'mockup.png');writeFileSync(mediaFile,'fake-png-content');
 const fakeToolTarget=join(workspace,'never-read.txt');writeFileSync(fakeToolTarget,'do-not-read-as-attachment');
 writeFileSync(join(scratchDir,'temp.jsonl'),'{"step_index":99,"type":"USER_INPUT","content":"scratch"}\n');

 // Compact transcript has truncated content; sibling transcript_full.jsonl has full content.
 const compactPath=join(logsDir,'transcript.jsonl'),fullPath=join(logsDir,'transcript_full.jsonl');
 writeFileSync(compactPath,JSON.stringify({step_index:0,source:'USER_EXPLICIT',type:'USER_INPUT',status:'DONE',created_at:'2026-11-13T23:00:00Z',content:'<USER_REQUEST>\ncompact-elided-prompt\n</USER_REQUEST>',truncated_fields:['content']})+'\n');
 writeFileSync(fullPath,[
  {step_index:0,source:'USER_EXPLICIT',type:'USER_INPUT',status:'DONE',created_at:'2026-11-13T23:00:00Z',content:'<USER_REQUEST>\nFull untruncated user prompt\n</USER_REQUEST>',media:[{mime_type:'image/png',uri:pathToFileURL(mediaFile).href}]},
  {step_index:1,source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE',created_at:'2026-11-13T23:00:01Z',thinking:'Reasoning trace',content:'Full assistant reply',tool_calls:[{name:'read_file',args:{type:'input_file',path:fakeToolTarget}}]},
  {step_index:2,source:'MODEL',type:'GENERIC',status:'DONE',created_at:'2026-11-13T23:00:02Z',content:'tool output line'},
 ].map(r=>JSON.stringify(r)+'\n').join(''));

 const runHook=async(eventName:string,payload:any,keepOpen=false)=>{
  const child=Bun.spawn([process.execPath,cli,'collect','hook','--harness','antigravity','--event',eventName],{
   stdin:'pipe',stdout:'pipe',stderr:'pipe',env:{...process.env},
  });
  child.stdin.write(JSON.stringify(payload));
  if(!keepOpen)child.stdin.end();
  const [exit,stdout]=await Promise.all([child.exited,new Response(child.stdout).text()]);
  if(keepOpen)try{child.stdin.end();}catch{}
  return {exit,json:JSON.parse(stdout.trim())};
 };

 // Hook passes compact transcriptPath AND keeps stdin open: must answer {"decision":"allow"}, exit 0, and read transcript_full.jsonl!
 const res=await runHook('Stop',{
  conversationId:convId,
  workspacePaths:[workspace],
  transcriptPath:compactPath,
  hookEventName:'Stop',
  cwd:workspace,
 },true);
 expect(res.exit).toBe(0);
 expect(res.json).toEqual({decision:'allow'});
 expect(captureStatus().pendingHooks).toBe(0);
 expect(captureStatus().queued).toBe(0);
 expect(f.batches.length).toBeGreaterThan(0);
 expect(f.batches.every(b=>b.harness==='antigravity'&&b.sessionId===convId&&b.origin==='cli')).toBe(true);
 const allEvents=f.batches.flatMap(b=>b.events);
 expect(JSON.stringify(allEvents)).toContain('Full untruncated user prompt');
 expect(JSON.stringify(allEvents)).not.toContain('compact-elided-prompt');
 expect(JSON.stringify(allEvents)).toContain('"mimeType":"image/png"');
 expect(JSON.stringify(allEvents)).not.toContain('scratch');
 // Only media[] was uploaded as an attachment; fakeToolTarget in tool_calls args was NOT read!
 expect(f.attachments.size).toBe(1);
 expect([...f.attachments.values()][0]!.toString()).toBe('fake-png-content');

 // Verify core indexer accepts the uploaded Antigravity batch cleanly.
 const mainBatch=f.batches.find(b=>b.events.some((e:any)=>e.kind==='message'))!;
 expect(mainBatch).toBeDefined();

 // Excluded workspace drops subsequent hooks without uploading.
 const excludedDir=join(f.dir,'secret-repo');mkdirSync(excludedDir,{recursive:true});
 excludeCapture(excludedDir,undefined);
 const beforeCount=f.batches.length;
 const blocked=await runHook('PostInvocation',{conversationId:'conv-excluded',workspacePaths:[excludedDir],hookEventName:'PostInvocation',cwd:excludedDir});
 expect(blocked.exit).toBe(0);expect(blocked.json).toEqual({});
 expect(f.batches.length).toBe(beforeCount);
}));

test('backfill discovers CLI, desktop and IDE Antigravity surfaces, prefers transcript_full.jsonl, and supports agy alias',async()=>fixture(async f=>{
 await installCapture(f.api,{home:f.dir,command:[process.execPath,'-e',''],harnesses:['antigravity']});
 const surfaces:[string,'cli'|'desktop'][]=[
  ['antigravity-cli','cli'],
  ['antigravity','desktop'],
  ['antigravity-ide','desktop'],
 ];
 for(const [surface] of surfaces) {
  const logs=join(f.dir,'gemini',surface,'brain',`hist-${surface}`,'.system_generated','logs');
  mkdirSync(logs,{recursive:true});
  // Put both transcript_full.jsonl and transcript.jsonl in antigravity-cli to prove single-file deduplication.
  if(surface==='antigravity-cli') {
   const p=join(logs,'transcript.jsonl');
   writeFileSync(p,JSON.stringify({step_index:0,source:'USER_EXPLICIT',type:'USER_INPUT',status:'DONE',content:'compact copy'})+'\n');
   utimesSync(p,1,1);
  }
  const full=join(logs,surface==='antigravity-ide'?'transcript.jsonl':'transcript_full.jsonl');
  writeFileSync(full,JSON.stringify({step_index:0,source:'USER_EXPLICIT',type:'USER_INPUT',status:'DONE',created_at:'2026-11-01T00:00:00Z',content:`<USER_REQUEST>\nHistory from ${surface}\n</USER_REQUEST>`})+'\n');
  utimesSync(full,1,1);
 }

 expect(await chooseBackfill(async()=>'g')).toBe('antigravity');
 expect(await chooseBackfill(async()=>'agy')).toBe('antigravity');
 expect(await chooseBackfill(async()=>'antigravity')).toBe('antigravity');

 const preview=backfillPreview(f.api,'antigravity');
 expect(preview.sources).toEqual([{harness:'antigravity',files:3,bytes:preview.sources[0]!.bytes}]);
 const allPreview=backfillPreview(f.api,'all');
 expect(allPreview.sources.map(s=>s.harness)).toEqual(['claude-code','codex','antigravity']);

 const imported=await backfill(f.api,'antigravity',true);
 expect(imported.processed).toBe(3);
 expect(f.batches.map(b=>[b.sessionId,b.origin]).sort()).toEqual([
  ['hist-antigravity','desktop'],
  ['hist-antigravity-cli','cli'],
  ['hist-antigravity-ide','desktop'],
 ]);
 expect(JSON.stringify(f.batches)).not.toContain('compact copy');
}));
