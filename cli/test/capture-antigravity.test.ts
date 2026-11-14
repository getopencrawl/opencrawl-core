import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,chmodSync,statSync,utimesSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {standaloneCapture} from '../../dist/tools/test-fixtures/capture.mjs';
import {createLocalSessionStore} from '../../dist/src/sessions/local-store.mjs';
import {createSessionIngest} from '../../dist/src/sessions/ingest.mjs';
import {batchDocuments} from '../../dist/src/sessions/indexer.mjs';
import {installCapture,uninstallCapture} from '../src/capture/install.ts';
import {captureDir,captureStatus,readCaptureConfig} from '../src/capture/runtime.ts';
import {backfill,backfillPreview,chooseBackfill} from '../src/capture/backfill.ts';
import {excludeCapture} from '../src/capture/controls.ts';
import {parseRecord,normalizeHarness} from '../src/capture/parse.ts';
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
 expect(parseRecord('antigravity',{step_index:6,source:'SYSTEM',type:'ERROR_MESSAGE',status:'DONE',error:'tls retry'},600)).toBeNull();
 expect(normalizeHarness('agy')).toBe('antigravity');
 expect(normalizeHarness('antigravity')).toBe('antigravity');
 expect(antigravityResponse({hookEventName:'Stop'})).toEqual({decision:'allow'});
 expect(antigravityResponse(null,'Stop')).toEqual({decision:'allow'});
 expect(antigravityResponse({hookEventName:'PostToolUse'})).toEqual({});
 expect(antigravityResponse({hookEventName:'SessionStart'},undefined,'Paused')).toEqual({injectSteps:[{systemMessage:{systemMessage:'Paused',metadata:{user_markdown:'Paused'}}}]});
});

async function fixture(run:(ctx:{
 dir:string;api:string;token:string;principal:{tenantId:string;userId:string};
 batches:any[];attachments:Map<string,Buffer>;hooksFile:string;
})=>Promise<void>) {
 const dir=mkdtempSync(join(tmpdir(),'opencrawl-agy-')),saved={...process.env};
 const principal={tenantId:'tenant-agy',userId:'alice'},token='antigravity-test-token-01234567890123456789';
 const store=createLocalSessionStore(join(dir,'objects')),ingest=createSessionIngest({store});
 const batches:any[]=[],attachments=new Map<string,Buffer>();
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
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({schemaVersion:1,data:receipt}));return;
  }
  handler(req,res);
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const api='http://127.0.0.1:'+(server.address() as any).port;
 Object.assign(process.env,{
  OPENCRAWL_CONFIG_HOME:join(dir,'config'),
  OPENCRAWL_API_URL:api,
  OPENCRAWL_SESSIONS_TOKEN:token,
  CLAUDE_CONFIG_DIR:join(dir,'claude'),
  CODEX_HOME:join(dir,'codex'),
  ANTIGRAVITY_HOME:join(dir,'gemini'),
 });
 try {
  await run({dir,api,token,principal,batches,attachments,hooksFile:join(dir,'gemini','config','hooks.json')});
 } finally {
  server.closeAllConnections();
  await new Promise<void>(r=>server.close(()=>r()));
  for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];
  Object.assign(process.env,saved);
  rmSync(dir,{recursive:true,force:true});
 }
}

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
