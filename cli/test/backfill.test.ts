import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,utimesSync,symlinkSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {standaloneCapture} from '../../dist/src/sessions/standalone.mjs';
import {createLocalSessionStore} from '../../dist/src/sessions/local-store.mjs';
import {createSessionIngest} from '../../dist/src/sessions/ingest.mjs';
import {installCapture} from '../src/capture/install.ts';
import {captureDir,captureStatus,readCaptureConfig,syncCaptures,captureTranscript,type CaptureConfig} from '../src/capture/runtime.ts';
import {backfillPreview,backfill,chooseBackfill,setupBackfill} from '../src/capture/backfill.ts';
import {collectCommand} from '../src/capture/command.ts';
import {hash} from '../src/capture/parse.ts';
import {claudeDesktopSessionsRoot,defaultClaudeDesktopSessionsRoot} from '../src/capture/desktop-history.ts';

// Native record shapes observed in Claude CLI/Desktop and Codex CLI/Desktop;
// content is synthetic so this end-to-end test never imports personal history.
test('optional backfill: four local surfaces, archives, consent, retry, receipts and isolation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'opencrawl-backfill-')),saved={...process.env};
 const principal={tenantId:'test',userId:'test-user'},token='backfill-test-token-01234567890123456789';
 const store=createLocalSessionStore(join(dir,'objects')),ingest=createSessionIngest({store,onStored:undefined});
 const receipts:any[]=[],batches:any[]=[];let requests=0,offline=false,failUpload=false,phase='setup';
 const handler=standaloneCapture({token,principal,store,prefix:undefined,search:undefined});
 const server=createServer(async(req,res)=>{
  requests++;
  if(offline || failUpload && req.url==='/api/sessions/batches'){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'OFFLINE'}}));return;}
  if(req.url==='/api/sessions/batches') {
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   const batch=JSON.parse(Buffer.concat(chunks).toString());batches.push(batch);
   const receipt=await ingest.putBatch(principal,batch);receipts.push({...receipt,harness:batch.harness,installationId:batch.installationId,sessionId:batch.sessionId});
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({schemaVersion:1,data:receipt}));return;
  }
  handler(req,res);
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const api='http://127.0.0.1:'+(server.address() as any).port;
 try {
  Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(dir,'config'),OPENCRAWL_SESSIONS_TOKEN:token,CLAUDE_CONFIG_DIR:join(dir,'claude'),CODEX_HOME:join(dir,'codex')});
  const paths:string[]=[];
  for(const harness of ['claude-code','codex'])for(const origin of ['cli','desktop']) {
   const path=join(harness==='codex'?process.env.CODEX_HOME!:process.env.CLAUDE_CONFIG_DIR!,harness==='codex'?(origin==='desktop'?'archived_sessions':'sessions'):'projects/project',origin+(harness==='codex'&&origin==='desktop'?'.jsonl.zst':'.jsonl'));
   mkdirSync(join(path,'..'),{recursive:true});paths.push(path);
   const id=harness+'-'+origin;
   const records=harness==='codex'?[
    {type:'session_meta',payload:{id,originator:origin==='desktop'?'Codex Desktop':'codex_cli_rs',source:origin==='desktop'?'vscode':'cli',base_instructions:'EXCLUDED'}},
    {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'historical '+id}]}},
    {type:'response_item',payload:{type:'function_call',name:'exec_command',call_id:id,arguments:'{"cmd":"pwd"}'}},
    {type:'response_item',payload:{type:'function_call_output',call_id:id,output:'fixture result'}},
   ]:[
    {type:'user',sessionId:id,entrypoint:origin==='desktop'?'claude-desktop':'cli',uuid:id,message:{role:'user',content:[{type:'text',text:'historical '+id},{type:'image',source:{type:'base64',media_type:'image/png',data:Buffer.from('fixture image').toString('base64')}}]}},
    {type:'assistant',sessionId:id,message:{role:'assistant',content:[{type:'tool_use',id,name:'Read',input:{file_path:'example'}}]}},
   ];
   const text=records.map(r=>JSON.stringify(r)+'\n').join('');
   writeFileSync(path,path.endsWith('.zst')?Bun.zstdCompressSync(text):text);utimesSync(path,1,1);
  }
  await installCapture(api,{background:false,home:dir,command:[process.execPath,'-e','']});
  async function cli(args:string[]) {
   const child=Bun.spawn([process.execPath,resolve(import.meta.dir,'../src/cli.ts'),'collect',...args,'--api',api,'--json'],{env:process.env,stdout:'pipe',stderr:'pipe'});
   const [stdout,stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
   expect(stderr).toBe('');return {exitCode,...JSON.parse(stdout)};
  }
  expect((await cli(['install','--yes','--no-background'])).data.backfill.status).toBe('decision_required');
  expect((await cli(['install','--yes','--no-background','--backfill','skip'])).data.backfill.status).toBe('skipped');
  expect((await cli(['backfill'])).data.status).toBe('decision_required');
  expect((await cli(['backfill','--harness','codex'])).error.code).toBe('BACKFILL_CONSENT_REQUIRED');
  expect((await cli(['backfill','--dry-run'])).data.status).toBe('preview');
  const start=requests;
  const preview=backfillPreview(api);
  expect(preview.sources.map(s=>s.files)).toEqual([2,2]);expect(requests).toBe(start);expect(captureStatus().queued).toBe(0);
  expect(readdirSync(join(captureDir(),'state'))).toHaveLength(0);
  expect((await setupBackfill(api,'ask',true)).status).toBe('decision_required');
  expect(await setupBackfill(api,'skip',true)).toEqual({status:'skipped'});
  await expect(backfill(api,'all',false)).rejects.toMatchObject({code:'BACKFILL_CONSENT_REQUIRED'});
  expect(requests).toBe(start);
  await syncCaptures();expect(batches).toHaveLength(0); // Historical mtimes are unchanged by install/skip.
  expect(readdirSync(join(captureDir(),'state'))).toHaveLength(0);
  principal.tenantId='current-team'; // The saved installation still has the previous team.
  await expect(backfill(api,'claude-code',true)).rejects.toMatchObject({code:'CAPTURE_DESTINATION_CHANGED'});
  await installCapture(api,{background:false,home:dir,command:[process.execPath,'-e','']}); // Explicit re-enrollment with an empty queue.
  expect((await backfill(api,'claude-code',true)).processed).toBe(2);
  expect(readCaptureConfig()!.owner.tenantId).toBe('current-team');
  expect(batches.every(b=>b.owner.tenantId==='current-team')).toBe(true);
  expect(batches.map(b=>b.harness)).toEqual(['claude-code','claude-code']);
  phase='offline-auth';offline=true;await expect(backfill(api,'codex',true)).rejects.toThrow();offline=false;
  phase='offline-upload';failUpload=true;await expect(backfill(api,'codex',true)).rejects.toThrow();expect(captureStatus().queued).toBe(1);failUpload=false;
  phase='resume';expect((await backfill(api,'codex',true)).processed).toBe(2);
  expect(new Set(batches.map(b=>b.harness+'/'+b.origin))).toEqual(new Set(['claude-code/cli','claude-code/desktop','codex/cli','codex/desktop']));
  expect(JSON.stringify(batches)).not.toContain('EXCLUDED');
  expect(batches.every(b=>b.captureMode==='history')).toBe(true);
  expect(batches.filter(b=>b.harness==='claude-code').every(b=>b.attachments[0].status==='captured')).toBe(true);
  for(const receipt of receipts){expect(await ingest.getBatch(principal,receipt)).not.toBeNull();expect(await ingest.getBatch({...principal,tenantId:'other'},receipt)).toBeNull();}
  const beforeReplay=requests;
  expect((await backfill(api,'all',true)).uploaded).toBe(0);
  expect(requests-beforeReplay).toBe(1); // One authentication, no per-file network work.
  // Invalid/mismatched commands fail without uploading or changing settings.
  await expect(collectCommand('install',api,{backfill:'invalid'})).rejects.toMatchObject({code:'INVALID_USAGE'});
  await expect(collectCommand('backfill',api,{harness:'invalid',yes:true})).rejects.toMatchObject({code:'INVALID_USAGE'});
  await expect(collectCommand('backfill',api,{'dry-run':true,yes:true})).rejects.toMatchObject({code:'INVALID_USAGE'});
  expect(()=>backfillPreview('https://other.example')).toThrow();
  // A bad transcript cannot hide partial success; successful files are resumable.
  const bad=join(process.env.CODEX_HOME!,'sessions','bad.jsonl');writeFileSync(bad,'invalid\n');
  await expect(backfill(api,'codex',true)).rejects.toMatchObject({code:'BACKFILL_INCOMPLETE'});
  rmSync(bad);expect((await backfill(api,'codex',true)).uploaded).toBe(0);
  phase='corrupt-archive';const corrupt=bad+'.zst';writeFileSync(corrupt,'not zstd');
  await expect(backfill(api,'codex',true)).rejects.toMatchObject({code:'BACKFILL_INCOMPLETE'});rmSync(corrupt);
  expect(readdirSync(join(captureDir(),'state')).some(name=>name.endsWith('.tmp'))).toBe(false);
  phase='symlinks';if(process.platform!=='win32') {
   const external=join(dir,'outside.jsonl');writeFileSync(external,'{}\n');
   symlinkSync(external,join(process.env.CODEX_HOME!,'sessions','link.jsonl'));
   expect(backfillPreview(api,'codex').sources[0].files).toBe(2);
  }
 } finally {
  if(process.env.GITHUB_ACTIONS)console.info('Backfill fixture final phase:',phase,'requests:',requests,'batches:',batches.length);
  server.closeAllConnections();
  await new Promise<void>(r=>server.close(()=>r()));
  for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);
  rmSync(dir,{recursive:true,force:true});
 }
},20000);

test('interactive setup choice defaults to skip and never interprets a generic yes as all sources',async()=>{
 for(const answer of ['','skip','s','no'])expect(await chooseBackfill(async()=>answer)).toBe('skip');
 for(const [answer,expected] of [['c','claude-code'],['codex','codex'],['both','all']] as const)expect(await chooseBackfill(async()=>answer)).toBe(expected);
 await expect(chooseBackfill(async()=>'yes')).rejects.toMatchObject({code:'INVALID_USAGE'});
});

test('Codex fork history preserves the leading session identity and origin across batches and resumes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'opencrawl-fork-history-')),saved=process.env.OPENCRAWL_CONFIG_HOME;
 process.env.OPENCRAWL_CONFIG_HOME=join(dir,'config');
 try {
  const config:CaptureConfig={schemaVersion:1,api:'http://127.0.0.1:1',installationId:'test',owner:{tenantId:'test',userId:'test'},installedAt:new Date().toISOString(),roots:{codex:join(dir,'codex'),'claude-code':join(dir,'claude')},command:[]};
  const path=join(config.roots.codex,'sessions','fork.jsonl');mkdirSync(join(path,'..'),{recursive:true});
  const records=[
   {type:'session_meta',payload:{id:'fork',source:'vscode',originator:'Codex Desktop',forked_from_id:'parent'}},
   {type:'session_meta',payload:{id:'parent',source:'cli',originator:'codex_cli_rs'}},
   ...Array.from({length:205},(_,i)=>({type:'response_item',payload:{type:'message',role:'user',content:'history '+i}})),
  ];
  writeFileSync(path,records.map(r=>JSON.stringify(r)+'\n').join(''));
  await captureTranscript(config,'codex',path);
  const queue=join(captureDir(),'queue');
  const batches=readdirSync(queue).map(p=>JSON.parse(readFileSync(join(queue,p),'utf8')));
  expect(batches).toHaveLength(2);
  expect(batches.every(b=>b.sessionId==='fork'&&b.parentSessionId==='parent'&&b.origin==='desktop')).toBe(true);
  expect(batches.reduce((n,b)=>n+b.events.length,0)).toBe(207);
  const resumed=[...records,{type:'response_item',payload:{type:'message',role:'assistant',content:'resumed'}}];
  writeFileSync(path,resumed.map(r=>JSON.stringify(r)+'\n').join(''));
  await captureTranscript(config,'codex',path);
  expect(readdirSync(queue).map(p=>JSON.parse(readFileSync(join(queue,p),'utf8'))).every(b=>b.sessionId==='fork'&&b.origin==='desktop')).toBe(true);
  const archive=join(config.roots.codex,'sessions','fork-archive.jsonl.zst');writeFileSync(archive,Bun.zstdCompressSync(resumed.map(r=>JSON.stringify(r)+'\n').join('')));
  expect((await captureTranscript(config,'codex',archive)).sessionId).toBe('fork');
 } finally {if(saved===undefined)delete process.env.OPENCRAWL_CONFIG_HOME;else process.env.OPENCRAWL_CONFIG_HOME=saved;rmSync(dir,{recursive:true,force:true});}
});

test('only approved history reconciliation upgrades old parser cursors, including compressed archives',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'opencrawl-parser-upgrade-')),saved=process.env.OPENCRAWL_CONFIG_HOME;
 process.env.OPENCRAWL_CONFIG_HOME=join(dir,'config');
 try {
  const config:CaptureConfig={schemaVersion:1,api:'http://127.0.0.1:1',installationId:'test',owner:{tenantId:'test',userId:'test'},installedAt:new Date().toISOString(),roots:{codex:join(dir,'codex'),'claude-code':join(dir,'claude')},command:[]};
  const records=[{type:'session_meta',payload:{id:'session',source:'cli'}},{type:'response_item',payload:{type:'agent_message',author:'/root/child',recipient:'/root',content:[{type:'input_text',text:'historical agent result'}]}}];
  const raw=records.map(r=>JSON.stringify(r)+'\n').join('');
  for(const suffix of ['.jsonl','.jsonl.zst']) {
   const path=join(config.roots.codex,'sessions','history'+suffix);mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,suffix.endsWith('.zst')?Bun.zstdCompressSync(raw):raw);
   await captureTranscript(config,'codex',path);
   const stateFile=join(captureDir(),'state',hash('codex'+realpathSync(path))+'.json'),state=JSON.parse(readFileSync(stateFile,'utf8'));delete state.parserVersion;writeFileSync(stateFile,JSON.stringify(state));
   for(const f of readdirSync(join(captureDir(),'queue')))rmSync(join(captureDir(),'queue',f));
   await captureTranscript(config,'codex',path);expect(readdirSync(join(captureDir(),'queue'))).toHaveLength(0);
   await captureTranscript(config,'codex',path,{},true);
   const names=readdirSync(join(captureDir(),'queue'));expect(names).toHaveLength(1);
   const batch=JSON.parse(readFileSync(join(captureDir(),'queue',names[0]),'utf8'));expect(batch.events.map((e:any)=>e.kind)).toEqual(['session_metadata','agent_message']);
   expect(JSON.parse(readFileSync(stateFile,'utf8')).parserVersion).toBe(2);
   rmSync(join(captureDir(),'queue',names[0]));await captureTranscript(config,'codex',path,{},true);expect(readdirSync(join(captureDir(),'queue'))).toHaveLength(0);
  }
 }finally{if(saved===undefined)delete process.env.OPENCRAWL_CONFIG_HOME;else process.env.OPENCRAWL_CONFIG_HOME=saved;rmSync(dir,{recursive:true,force:true});}
});

test('Claude Desktop mirrors preserve unmatched audit messages, session boundaries, consent and scope',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'opencrawl-desktop-')),saved={...process.env};
 const principal={tenantId:'test',userId:'desktop-user'},token='desktop-backfill-token-01234567890123456789';
 const store=createLocalSessionStore(join(dir,'objects')),ingest=createSessionIngest({store,onStored:undefined});
 const batches:any[]=[],receipts:any[]=[];let requests=0;
 const handler=standaloneCapture({token,principal,store,prefix:undefined,search:undefined});
 const server=createServer(async(req,res)=>{
  requests++;
  if(req.url==='/api/sessions/batches'){
   const chunks=[];for await(const c of req)chunks.push(c);
   const batch=JSON.parse(Buffer.concat(chunks).toString());batches.push(batch);
   const receipt=await ingest.putBatch(principal,batch);receipts.push({...receipt,harness:batch.harness,installationId:batch.installationId,sessionId:batch.sessionId});
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:receipt}));return;
  }
  handler(req,res);
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const api='http://127.0.0.1:'+(server.address() as any).port;
 try {
  Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(dir,'config'),OPENCRAWL_SESSIONS_TOKEN:token,CLAUDE_CONFIG_DIR:join(dir,'claude'),CODEX_HOME:join(dir,'codex'),CLAUDE_DESKTOP_CONFIG_DIR:join(dir,'desktop')});
  await installCapture(api,{background:false,home:dir,command:[]});
  const config=readCaptureConfig()!;
  rmSync(config.roots['claude-code'],{recursive:true,force:true});
  const runtime=join(config.claudeDesktopSessionsRoot!,'account','session','agent','runtime');
  const project=join(runtime,'.claude','projects','native'),parent=join(project,'parent.jsonl'),child=join(project,'parent','subagents','child.jsonl'),audit=join(runtime,'audit.jsonl');
  mkdirSync(join(child,'..'),{recursive:true});
  const native={type:'user',sessionId:'native-session',entrypoint:'local-agent',uuid:'native-uuid',message:{role:'user',content:'native message'}};
  const subagent={...native,uuid:'child-uuid',agentId:'child',message:{role:'user',content:'child message'}};
  writeFileSync(parent,JSON.stringify(native)+'\n');writeFileSync(child,JSON.stringify(subagent)+'\n');
  const rows=[
   {type:'user',uuid:'early',session_id:'desktop-runtime',_audit_timestamp:'2026-01-01T00:00:00Z',_audit_hmac:'DO_NOT_UPLOAD',message:{role:'user',content:'first unmatched message'}},
   {type:'user',uuid:'native-uuid',session_id:'native-session',message:native.message},
   {type:'user',uuid:'child-uuid',session_id:'native-session',message:subagent.message},
   {type:'system',subtype:'compact',session_id:'native-session',secret:'DO_NOT_UPLOAD'},
   {type:'assistant',uuid:'late',session_id:'native-session',parent_tool_use_id:'parent-tool',_audit_timestamp:'2026-01-01T01:00:00Z',_audit_hmac:'DO_NOT_UPLOAD',message:{role:'assistant',content:'second unmatched message'}},
   {type:'user',uuid:'again',session_id:'desktop-runtime',message:{role:'user',content:'return to runtime session'}},
  ];
  writeFileSync(audit,rows.map(r=>JSON.stringify(r)+'\n').join(''));
  const unrelated=join(config.claudeDesktopSessionsRoot!,'account','unrelated.jsonl');writeFileSync(unrelated,'invalid\n');
  if(process.platform!=='win32')symlinkSync(unrelated,join(project,'escape.jsonl'));
  const before=requests;
  expect(backfillPreview(api,'claude-code').sources[0].files).toBe(3);
  expect(backfillPreview(api,'codex').sources[0].files).toBe(0);
  await expect(backfill(api,'all',false)).rejects.toMatchObject({code:'BACKFILL_CONSENT_REQUIRED'});
  expect(requests).toBe(before);expect(captureStatus().queued).toBe(0);
  await expect(captureTranscript(config,'claude-code',parent)).rejects.toMatchObject({code:'CAPTURE_PATH_REJECTED'});
  await expect(captureTranscript(config,'claude-code',audit)).rejects.toMatchObject({code:'CAPTURE_PATH_REJECTED'});
  await expect(captureTranscript(config,'claude-code',unrelated,{},true)).rejects.toMatchObject({code:'CAPTURE_PATH_REJECTED'});
  expect((await backfill(api,'codex',true)).uploaded).toBe(0);expect(batches).toHaveLength(0);
  expect((await backfill(api,'claude-code',true)).processed).toBe(3);
  const events=batches.flatMap(b=>b.events.map((e:any)=>({session:b.sessionId,origin:b.origin,event:e})));
  expect(events).toHaveLength(5);
  expect(events.filter(e=>e.event.nativeId==='native-uuid')).toHaveLength(1);
  expect(events.filter(e=>e.event.nativeId==='child-uuid')).toHaveLength(1);
  expect(events.find(e=>e.event.nativeId==='child-uuid')?.session).toBe('native-session:child');
  expect(events.find(e=>e.event.nativeId==='early')).toMatchObject({session:'desktop-runtime',origin:'desktop',event:{timestamp:'2026-01-01T00:00:00Z'}});
  expect(events.find(e=>e.event.nativeId==='late')).toMatchObject({session:'native-session',event:{timestamp:'2026-01-01T01:00:00Z',parentId:'parent-tool'}});
  expect(events.find(e=>e.event.nativeId==='again')?.session).toBe('desktop-runtime');
  expect(JSON.stringify(batches)).not.toContain('DO_NOT_UPLOAD');
  for(const receipt of receipts){expect(await ingest.getBatch(principal,receipt)).not.toBeNull();expect(await ingest.getBatch({...principal,userId:'other'},receipt)).toBeNull();}
  expect((await backfill(api,'all',true)).uploaded).toBe(0);expect(captureStatus().queued).toBe(0);
  const only=join(config.claudeDesktopSessionsRoot!,'account','audit-only','agent','runtime','audit.jsonl');mkdirSync(join(only,'..'),{recursive:true});writeFileSync(only,'invalid\n');
  expect(backfillPreview(api,'all').sources[0].files).toBe(4);
  await expect(backfill(api,'claude-code',true)).rejects.toMatchObject({code:'BACKFILL_INCOMPLETE'});
  writeFileSync(only,JSON.stringify({...rows[0],session_id:'audit-only',uuid:'audit-only'})+'\n');
  expect((await backfill(api,'claude-code',true)).uploaded).toBe(1);expect(batches.at(-1).sessionId).toBe('audit-only');
 } finally {
  await new Promise<void>(r=>server.close(()=>r()));
  for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);
  rmSync(dir,{recursive:true,force:true});
 }
},20000);


test('desktop discovery upgrades default roots without expanding custom roots',()=>{
 const home=join(tmpdir(),'opencrawl-desktop-defaults');
 expect(claudeDesktopSessionsRoot({roots:{'claude-code':join(home,'.claude')}},home)).toBe(defaultClaudeDesktopSessionsRoot(home));
 expect(claudeDesktopSessionsRoot({roots:{'claude-code':join(home,'custom')}},home)).toBeUndefined();
 expect(claudeDesktopSessionsRoot({roots:{'claude-code':join(home,'custom')},claudeDesktopSessionsRoot:join(home,'explicit')},home)).toBe(join(home,'explicit'));
});
