import {withTestState} from '../../test/fixtures/memory-application-state.mjs';
import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {atomicJson} from '../src/session.ts';
import {backfill,type BackfillProgress} from '../src/capture/backfill.ts';
import {captureDir,type CaptureConfig} from '../src/capture/runtime.ts';
import {hash} from '../src/capture/parse.ts';
import {createSessionIngest} from '../../dist/src/sessions/ingest.mjs';
import {createLocalSessionStore} from '../../dist/src/sessions/local-store.mjs';

test('a compressed history with an unfinished JSONL record fails progress and remains recoverable',async()=>{
 const saved={...process.env},dir=mkdtempSync(join(tmpdir(),'opencrawl-archive-completion-'));
 const owner={tenantId:'test',userId:'importer'},ingest=createSessionIngest(withTestState({store:createLocalSessionStore(join(dir,'objects'))}));
 const batches:any[]=[],progress:BackfillProgress[]=[];
 const server=createServer(async(req,res)=>{
  const send=(status:number,body:unknown)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
  if(req.url==='/api/sessions/identity')return send(200,{data:{principal:owner}});
  if(req.url==='/api/sessions/batches'){
   try{
    const parts=[];for await(const part of req)parts.push(part);
    const batch=JSON.parse(Buffer.concat(parts).toString());batches.push(batch);
    return send(200,{data:await ingest.putBatch(owner,batch)});
   }catch{return send(500,{error:{code:'TEST_INGEST_ERROR'}});}
  }
  send(404,{});
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const api='http://127.0.0.1:'+(server.address() as any).port;
 try{
  Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(dir,'config'),OPENCRAWL_API_URL:api,OPENCRAWL_SESSIONS_TOKEN:'archive-completion-fixture-token'});
  const config:CaptureConfig={schemaVersion:1,api,installationId:'fixture',owner,installedAt:new Date().toISOString(),roots:{codex:join(dir,'codex'),'claude-code':join(dir,'claude')},command:[]};
  atomicJson(join(captureDir(),'config.json'),config);
  const path=join(config.roots.codex,'archived_sessions','unfinished.jsonl.zst');mkdirSync(join(path,'..'),{recursive:true});
  const header=JSON.stringify({type:'session_meta',payload:{id:'unfinished-archive',source:'cli'}})+'\n';
  const tail=JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:'recovered final message'}});
  const incomplete=Buffer.from(Bun.zstdCompressSync(header+tail.slice(0,-2)));writeFileSync(path,incomplete);
  await expect(backfill(api,'codex',true,{retryDelays:[],onProgress:value=>progress.push(value)})).rejects.toMatchObject({code:'BACKFILL_INCOMPLETE'});
  expect(progress.at(-1)).toMatchObject({status:'failed',processed:0,totalFiles:1,processedBytes:0});
  expect(progress.some(value=>value.status==='complete')).toBe(false);
  expect(JSON.parse(readFileSync(join(captureDir(),'backfill-progress.json'),'utf8')).status).toBe('failed');
  const state=join(captureDir(),'state',hash('codex'+realpathSync(path))+'.json');
  expect(JSON.parse(readFileSync(state,'utf8')).archiveSize).toBeUndefined();
  expect(readFileSync(path)).toEqual(incomplete);
  // A repaired archive replays complete records idempotently and reaches its tail.
  writeFileSync(path,Bun.zstdCompressSync(header+tail+'\n'));
  expect(await backfill(api,'codex',true,{retryDelays:[]})).toMatchObject({status:'complete',processed:1});
  expect(batches.flatMap(batch=>batch.events).some(event=>event.data.content==='recovered final message')).toBe(true);
  expect(JSON.parse(readFileSync(state,'utf8')).archiveSize).toBeGreaterThan(0);
  expect((await backfill(api,'codex',true,{retryDelays:[]})).uploaded).toBe(0);
 }finally{
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);
  rmSync(dir,{recursive:true,force:true});
 }
});
