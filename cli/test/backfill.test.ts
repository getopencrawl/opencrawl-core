import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,utimesSync,symlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {standaloneCapture} from '../../src/sessions/standalone.mjs';
import {createLocalSessionStore} from '../../src/sessions/local-store.mjs';
import {createSessionIngest} from '../../src/sessions/ingest.mjs';
import {installCapture} from '../src/capture/install.ts';
import {captureDir,captureStatus,readCaptureConfig,syncCaptures} from '../src/capture/runtime.ts';
import {backfillPreview,backfill,chooseBackfill,setupBackfill} from '../src/capture/backfill.ts';
import {collectCommand} from '../src/capture/command.ts';

// Native record shapes observed in Claude CLI/Desktop and Codex CLI/Desktop;
// content is synthetic so this end-to-end test never imports personal history.
test('optional backfill: four local surfaces, archives, consent, retry, receipts and isolation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'opencrawl-backfill-')),saved={...process.env};
 const principal={tenantId:'test',userId:'test-user'},token='backfill-test-token-01234567890123456789';
 const store=createLocalSessionStore(join(dir,'objects')),ingest=createSessionIngest({store,onStored:undefined});
 const receipts:any[]=[],batches:any[]=[];let requests=0,offline=false,wrongOwner=false,failUpload=false;
 const handler=standaloneCapture({token,principal,store,prefix:undefined,search:undefined});
 const server=createServer(async(req,res)=>{
  requests++;
  if(offline || failUpload && req.url==='/api/sessions/batches'){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'OFFLINE'}}));return;}
  if(wrongOwner && req.url==='/api/sessions/identity'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:{principal:{...principal,userId:'other'}}}));return;}
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
   const path=join(harness==='codex'?process.env.CODEX_HOME!:process.env.CLAUDE_CONFIG_DIR!,harness==='codex'?(origin==='desktop'?'archived_sessions':'sessions'):'projects/project',origin+'.jsonl');
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
   writeFileSync(path,records.map(r=>JSON.stringify(r)+'\n').join(''));utimesSync(path,1,1);
  }
  await installCapture(api,{background:false,home:dir,command:[process.execPath,'-e','']});
  async function cli(args:string[]) {
   const child=Bun.spawn([process.execPath,resolve(import.meta.dir,'../src/cli.ts'),'collect',...args,'--api',api,'--json'],{env:process.env,stdout:'pipe',stderr:'pipe'});
   const [stdout,stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
   expect(stderr).toBe('');return {exitCode,...JSON.parse(stdout)};
  }
  expect((await cli(['install','--no-background'])).data.backfill.status).toBe('decision_required');
  expect((await cli(['install','--no-background','--backfill','skip'])).data.backfill.status).toBe('skipped');
  expect((await cli(['backfill'])).error.code).toBe('BACKFILL_CONSENT_REQUIRED');
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
  wrongOwner=true;await expect(backfill(api,'all',true)).rejects.toMatchObject({code:'CAPTURE_OWNER_CHANGED'});wrongOwner=false;
  expect(readdirSync(join(captureDir(),'state'))).toHaveLength(0);
  expect((await backfill(api,'claude-code',true)).processed).toBe(2);
  expect(batches.map(b=>b.harness)).toEqual(['claude-code','claude-code']);
  offline=true;await expect(backfill(api,'codex',true)).rejects.toThrow();offline=false;
  failUpload=true;await expect(backfill(api,'codex',true)).rejects.toThrow();expect(captureStatus().queued).toBe(1);failUpload=false;
  expect((await backfill(api,'codex',true)).processed).toBe(2);
  expect(new Set(batches.map(b=>b.harness+'/'+b.origin))).toEqual(new Set(['claude-code/cli','claude-code/desktop','codex/cli','codex/desktop']));
  expect(JSON.stringify(batches)).not.toContain('EXCLUDED');
  expect(batches.filter(b=>b.harness==='claude-code').every(b=>b.attachments[0].status==='captured')).toBe(true);
  for(const receipt of receipts){expect(await ingest.getBatch(principal,receipt)).not.toBeNull();expect(await ingest.getBatch({...principal,tenantId:'other'},receipt)).toBeNull();}
  expect((await backfill(api,'all',true)).uploaded).toBe(0);
  // Invalid/mismatched commands fail without uploading or changing settings.
  await expect(collectCommand('install',api,{backfill:'invalid'})).rejects.toMatchObject({code:'INVALID_USAGE'});
  await expect(collectCommand('backfill',api,{harness:'invalid',yes:true})).rejects.toMatchObject({code:'INVALID_USAGE'});
  await expect(collectCommand('backfill',api,{'dry-run':true,yes:true})).rejects.toMatchObject({code:'INVALID_USAGE'});
  expect(()=>backfillPreview('https://other.example')).toThrow();
  // A bad transcript cannot hide partial success; successful files are resumable.
  const bad=join(process.env.CODEX_HOME!,'sessions','bad.jsonl');writeFileSync(bad,'invalid\n');
  await expect(backfill(api,'codex',true)).rejects.toMatchObject({code:'BACKFILL_INCOMPLETE'});
  rmSync(bad);expect((await backfill(api,'codex',true)).uploaded).toBe(0);
  if(process.platform!=='win32') {
   const external=join(dir,'outside.jsonl');writeFileSync(external,'{}\n');
   symlinkSync(external,join(process.env.CODEX_HOME!,'sessions','link.jsonl'));
   expect(backfillPreview(api,'codex').sources[0].files).toBe(2);
  }
 } finally {
  await new Promise<void>(r=>server.close(()=>r()));
  for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);
  rmSync(dir,{recursive:true,force:true});
 }
});

test('interactive setup choice defaults to skip and never interprets a generic yes as all sources',async()=>{
 for(const answer of ['','skip','s','no'])expect(await chooseBackfill(async()=>answer)).toBe('skip');
 for(const [answer,expected] of [['c','claude-code'],['codex','codex'],['both','all']] as const)expect(await chooseBackfill(async()=>answer)).toBe(expected);
 await expect(chooseBackfill(async()=>'yes')).rejects.toMatchObject({code:'INVALID_USAGE'});
});
