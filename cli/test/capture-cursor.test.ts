import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync,appendFileSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {hash} from '../src/capture/parse.ts';
import {cursorSession,cursorEvents,cursorUserHookInstalled,cursorTranscript} from '../src/capture/cursor.ts';
import {installCapture,uninstallCapture} from '../src/capture/install.ts';
import {captureHook,captureDir,captureStatus,readCaptureConfig,drainCaptureNotices,hookFlush} from '../src/capture/runtime.ts';
import {excludeCapture} from '../src/capture/controls.ts';
import {startupHooks} from '../src/startup-install.ts';
import {sessionStart} from '../src/session-start.ts';
import {createSessionIngest} from '../../dist/src/sessions/ingest.mjs';
import {createLocalSessionStore} from '../../dist/src/sessions/local-store.mjs';
import {batchDocuments} from '../../dist/src/sessions/indexer.mjs';
import {transcriptEntries} from '../../dist/src/sessions/library.mjs';
const base={conversation_id:'cursor-native-chat',generation_id:'generation-1',cursor_version:'3.1.0',workspace_roots:['/work/project'],transcript_path:null};
const hook=(name:string,data:any={})=>({...base,hook_event_name:name,...data});

test('Cursor uses the native conversation identity across turns and days, and rejects anonymous activity',()=>{
 expect(cursorSession(hook('stop')).sessionId).toBe(base.conversation_id);
 expect(cursorSession(hook('stop',{generation_id:'generation-2'})).sessionId).toBe(base.conversation_id);
 expect(cursorSession(hook('sessionStart',{session_id:base.conversation_id}))).toMatchObject({origin:'unknown',cwd:'/work/project'});
 expect(cursorSession(hook('sessionStart',{is_background_agent:true})).origin).toBe('cloud');
 expect(cursorSession(hook('postToolUse',{cwd:'/another/project'})).cwd).toBe('/work/project');
 expect(cursorSession(hook('sessionStart',{parent_conversation_id:'parent-chat'}))).toMatchObject({origin:'subagent',parentSessionId:'parent-chat'});
 for(const conversation_id of [null,'','../escape','has spaces','x'.repeat(201)])expect(()=>cursorSession(hook('stop',{conversation_id}))).toThrow('native conversation ID');
 const events=cursorEvents({id:'event',at:'2026-11-14T00:00:00Z',event:hook('postToolUse',{tool_name:'Shell',tool_input:{command:'echo marker'},tool_output:'{"stdout":"marker"}',tool_use_id:'tool-1'})});
 expect(events.map(e=>e.kind)).toEqual(['tool_call','tool_result']);
 expect(events.flatMap(transcriptEntries)).toEqual([{type:'tool_call',name:'Shell',input:'{\n  "command": "echo marker"\n}',truncated:false},{type:'tool_result',text:'{\n  "stdout": "marker"\n}',truncated:false}]);
});

async function fixture(run:(f:any)=>Promise<void>) {
 const dir=mkdtempSync(join(tmpdir(),'opencrawl-cursor-')),saved={...process.env};
 const owner={tenantId:'selfhost-team',userId:'owner'},batches:any[]=[],store=createLocalSessionStore(join(dir,'objects')),ingest=createSessionIngest({store});let unavailable=false,supported=true;
 const server=createServer(async(req,res)=>{
  const send=(status:number,data:any)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({schemaVersion:1,data}));};
  if(req.headers.authorization!=='Bearer cursor-test-token'){send(401,{});return;}
  if(req.url==='/api/sessions/identity'){send(200,{principal:owner,capabilities:{harnesses:supported?['cursor','codex','claude-code']:['codex','claude-code']}});return;}
  if(req.url==='/api/sessions/batches'){
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   if(unavailable){send(500,{});return;}
   const batch=JSON.parse(Buffer.concat(chunks).toString());batches.push(batch);send(200,await ingest.putBatch(owner,batch));return;
  }
  send(404,{});
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const api='http://127.0.0.1:'+(server.address() as any).port;
 Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(dir,'config'),OPENCRAWL_API_URL:api,OPENCRAWL_SESSIONS_TOKEN:'cursor-test-token',CLAUDE_CONFIG_DIR:join(dir,'claude'),CODEX_HOME:join(dir,'codex'),CURSOR_CONFIG_DIR:join(dir,'.cursor'),OPENCRAWL_NO_UPDATE:'1'});
 delete process.env.CLAUDE_CODE_REMOTE;
 try{await run({dir,api,owner,batches,store,ingest,install:()=>installCapture(api,{home:dir,command:[process.execPath,'-e',''],harnesses:['cursor']}),set unavailable(value:boolean){unavailable=value;},set supported(value:boolean){supported=value;}});}
 finally{try{await uninstallCapture(dir);}catch{}server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);rmSync(dir,{recursive:true,force:true});}
}

test('Cursor install preserves other clients and foreign hooks, remains idempotent, and uninstalls only owned hooks',async()=>fixture(async f=>{
 await installCapture(f.api,{home:f.dir,command:[process.execPath,'-e',''],harnesses:['codex','claude-code']});
 const id=readCaptureConfig()!.installationId,other={command:'echo vendor',timeout:2};
 mkdirSync(join(f.dir,'.cursor'));writeFileSync(join(f.dir,'.cursor/hooks.json'),JSON.stringify({version:1,hooks:{postToolUse:[other],preToolUse:[other]}}));
 const first=await f.install();expect(first.installationId).toBe(id);expect(first.harnesses).toEqual(['codex','claude-code','cursor']);
 await f.install();const file=join(f.dir,'.cursor/hooks.json'),config=JSON.parse(readFileSync(file,'utf8'));
 expect(config.hooks.postToolUse).toHaveLength(2);expect(config.hooks.postToolUse[0]).toEqual(other);expect(config.hooks.preToolUse).toEqual([other]);
 expect(cursorUserHookInstalled(join(f.dir,'.cursor'),'postToolUse')).toBe(true);
 expect(cursorUserHookInstalled(join(f.dir,'.cursor'),'unknown')).toBe(false);
 const child=Bun.spawn([process.execPath,join(import.meta.dir,'../src/cli.ts'),'collect','hook','--harness','cursor','--plugin-hook'],{env:process.env,stdin:Buffer.from(JSON.stringify(hook('beforeSubmitPrompt',{prompt:'must not duplicate'}))),stdout:'pipe',stderr:'pipe'});
 expect(await child.exited).toBe(0);expect(await new Response(child.stdout).text()).toBe('{\"continue\":true}\n');expect(captureStatus().pendingHooks).toBe(0);
 const before=readFileSync(file,'utf8');
 await expect(installCapture(f.api,{home:f.dir,harnesses:['grok-bot']})).rejects.toThrow('share a hooks directory');expect(readFileSync(file,'utf8')).toBe(before);
 await uninstallCapture(f.dir);expect(JSON.parse(readFileSync(file,'utf8')).hooks).toEqual({postToolUse:[other],preToolUse:[other]});
}));

test('Cursor prompts, responses, reasoning, tools and compaction survive queue retry and become authorized searchable documents',async()=>fixture(async f=>{
 await f.install();const secret='sk-test-abcdefghijklmnopqrstuvwxyz123456';
 for(const event of [hook('beforeSubmitPrompt',{prompt:'Cursor capture harbor marker'}),hook('afterAgentThought',{text:'Check evidence first.'}),hook('postToolUse',{tool_name:'Shell',tool_input:{command:'echo harbor',api_key:secret},tool_output:'{"stdout":"harbor result"}',tool_use_id:'tool-1'}),hook('postToolUseFailure',{tool_name:'Shell',tool_input:{command:'false'},tool_use_id:'tool-2',error_message:'failed',failure_type:'error'}),hook('afterAgentResponse',{text:'Cursor reply harbor marker'}),hook('preCompact',{trigger:'auto',message_count:4})])await captureHook('cursor',event);
 await drainCaptureNotices();expect(captureStatus().pendingHooks).toBe(0);expect(captureStatus().queued).toBeGreaterThan(0);
 const queue=()=>readdirSync(join(captureDir(),'queue')).filter(n=>n.endsWith('.json')).map(n=>readFileSync(join(captureDir(),'queue',n),'utf8'));
 const before=queue();expect(before.join('')).not.toContain(secret);expect(before.join('')).toContain('[REDACTED]');
 f.unavailable=true;await expect(hookFlush(hook('stop'))).rejects.toThrow();const eventBytes=(items:string[])=>items.flatMap(item=>JSON.parse(item).events.map((event:unknown)=>JSON.stringify(event))).sort();expect(eventBytes(queue())).toEqual(eventBytes(before));
 f.unavailable=false;await hookFlush(hook('stop'),{now:()=>Date.now()+901_000});expect(captureStatus().lastUpload).toMatchObject({harness:'cursor',sessionId:base.conversation_id,stored:true});
 const events=f.batches.flatMap((b:any)=>b.events);expect(events.map((e:any)=>e.kind)).toEqual(['message','reasoning_summary','tool_call','tool_result','tool_call','tool_result','message','compaction']);
 const batch=f.batches[0];expect(batch).toMatchObject({harness:'cursor',sessionId:base.conversation_id,origin:'unknown',cwd:'/work/project',captureMode:'live',owner:f.owner});
 const receipt=await f.ingest.putBatch(f.owner,batch);expect(await f.ingest.getBatch({...f.owner,tenantId:'another-team'},{...batch,batchId:receipt.batchId})).toBeNull();
 const docs=batchDocuments({prefix:'capture-v1',key:`capture-v1/tenants/${hash(f.owner.tenantId)}/users/${hash(f.owner.userId)}/cursor/${hash(batch.installationId)}/${hash(batch.sessionId)}/${hash(JSON.stringify(batch))}.json.gz`,batch,principal:f.owner}).map(x=>x.document);
 expect(docs.filter(d=>d.role==='user').map(d=>d.text)).toEqual(['Cursor capture harbor marker']);expect(docs.some(d=>d.harness==='cursor'&&d.kind==='tool_result'&&d.text?.includes('harbor result'))).toBe(true);
 await excludeCapture(undefined,base.conversation_id);await captureHook('cursor',hook('afterAgentResponse',{text:'excluded'}));expect(captureStatus().pendingHooks).toBe(0);
}));

test('Cursor startup uses native hook shape, preserves capture hooks and registers its conversation',async()=>fixture(async f=>{
 await f.install();const options={home:f.dir,env:process.env,command:[process.execPath,'-e','']};
 expect(startupHooks(['cursor'],'install',options)[0].status).toBe('installed');expect(startupHooks(['cursor'],'install',options)[0].status).toBe('unchanged');
 const config=JSON.parse(readFileSync(join(f.dir,'.cursor/hooks.json'),'utf8'));expect(config.hooks.sessionStart).toHaveLength(2);
 let registered:any;const output=await sessionStart(f.api,'cursor',hook('sessionStart',{session_id:base.conversation_id}),async(_api,_operation,args)=>{registered=args;return {session:base.conversation_id,workspace:f.owner.tenantId,agent:'a'.repeat(64),name:null,task:null};});
 expect(registered).toEqual({session:base.conversation_id,harness:'cursor'});expect(output.additional_context).toContain('registered');
 expect((await sessionStart(f.api,'cursor',hook('stop'))).additional_context).toContain('unavailable');
}));

test('native Cursor JSONL fills missing content hooks, deduplicates hooks and transcript, and checkpoints partial records and notice replay',async()=>fixture(async f=>{
 await f.install();const root=readCaptureConfig()!.roots.cursor!,directory=join(root,'projects','workspace','agent-transcripts',base.conversation_id),file=join(directory,base.conversation_id+'.jsonl');mkdirSync(directory,{recursive:true});
 const message=(role:string,text:string)=>JSON.stringify({role,message:{content:[{type:'text',text}]}})+'\n';
 writeFileSync(file,message('user','<timestamp>Friday, Nov 13, 2026, 6:20 PM (UTC-8)</timestamp>\n<user_query>\nNative harbor prompt\n</user_query>'));
 await captureHook('cursor',hook('sessionStart'));await captureHook('cursor',hook('beforeSubmitPrompt',{prompt:'Native harbor prompt'}));
 await captureHook('cursor',hook('postToolUse',{transcript_path:file,tool_name:'Read',tool_use_id:'read-1',tool_input:{file_path:'acceptance.txt'},tool_output:{content_length:9}}));
 await drainCaptureNotices();
 const reply=message('assistant','Native harbor reply');appendFileSync(file,reply.slice(0,-1));
 await captureHook('cursor',hook('stop',{transcript_path:file}));await drainCaptureNotices();
 appendFileSync(file,'\n');await captureHook('cursor',hook('sessionEnd',{transcript_path:file}));
 const notices=join(captureDir(),'notices'),name=readdirSync(notices).find(n=>n.endsWith('.json'))!,saved=readFileSync(join(notices,name));
 await drainCaptureNotices();writeFileSync(join(notices,name),saved);await drainCaptureNotices(); // crash after checkpoint, before unlink
 await captureHook('cursor',hook('afterAgentResponse',{text:'Native harbor reply',transcript_path:file}));await drainCaptureNotices();
 // A genuine repeated prompt is a second message, not a duplicate delivery.
 appendFileSync(file,message('user','Native harbor prompt'));await captureHook('cursor',hook('sessionEnd',{transcript_path:file}));await drainCaptureNotices();
 await hookFlush(hook('stop'));
 const messages=f.batches.flatMap((b:any)=>b.events).filter((e:any)=>e.kind==='message');
 expect(messages.filter((e:any)=>e.data.role==='user').map((e:any)=>e.data.content[0].text)).toEqual(['Native harbor prompt','Native harbor prompt']);
 expect(messages.filter((e:any)=>e.data.role==='assistant').map((e:any)=>e.data.content[0].text)).toEqual(['Native harbor reply']);
 expect(captureStatus().pendingHooks).toBe(0);
 // Neither a forged project path nor a symlink can turn a hook into a file reader.
 const outside=join(f.dir,'outside.jsonl');writeFileSync(outside,message('user','private outside'));expect(()=>[...cursorTranscript(root,base.conversation_id,outside)]).toThrow('outside');
 if(process.platform!=='win32'){rmSync(file);symlinkSync(outside,file);expect(()=>[...cursorTranscript(root,base.conversation_id,file)]).toThrow('outside');}
}));

test('an older receiver cannot enroll Cursor and parked Cursor batches never block existing client uploads',async()=>fixture(async f=>{
 f.supported=false;await expect(f.install()).rejects.toThrow('does not support Cursor');expect(readCaptureConfig()).toBeNull();
 f.supported=true;await installCapture(f.api,{home:f.dir,command:[process.execPath,'-e',''],harnesses:['codex']});await f.install();
 await captureHook('codex',{session_id:'existing-codex',hook_event_name:'Stop',cwd:f.dir});
 await captureHook('cursor',hook('beforeSubmitPrompt',{prompt:'wait for compatible receiver'}));await drainCaptureNotices();
 f.supported=false;const {flushCaptures}=await import('../src/capture/runtime.ts');const held=await flushCaptures();expect(held).toMatchObject({uploaded:1,unsupportedHarnesses:['cursor']});expect(f.batches.map((b:any)=>b.harness)).toEqual(['codex']);expect(captureStatus().queued).toBeGreaterThan(0);
 f.supported=true;expect((await flushCaptures()).uploaded).toBeGreaterThan(0);expect(f.batches.at(-1).harness).toBe('cursor');
}));
