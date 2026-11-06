import {test,expect} from 'bun:test';
import {createServer,type IncomingMessage} from 'node:http';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createSessionIngest,createCaptureHandler} from '../../src/sessions/ingest.mjs';
import {createLocalSessionStore} from '../../src/sessions/local-store.mjs';
import {installCapture} from '../src/capture/install.ts';
import {captureDir,readCaptureConfig,flushCaptures} from '../src/capture/runtime.ts';
import {hash} from '../src/capture/parse.ts';

test('existing capture config and queue follow the authenticated team without reinstall; server owns authorization',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'opencrawl-capture-auth-')),saved={...process.env};
 let principal={tenantId:'personal:alice',userId:'alice',name:'Alice',email:'alice@example.net'},authorized=true,loseResponse=true;
 const token='capture-auth-test-token',store=createLocalSessionStore(join(dir,'objects')),ingest=createSessionIngest({store});
 const payloads:string[]=[];
 const handler=createCaptureHandler({ingest,authenticate:async (req:IncomingMessage)=>{
  if(!authorized||req.headers.authorization!=='Bearer '+token)throw Object.assign(Error('Sign in required'),{status:401});
  return principal;
 }});
 const server=createServer(async(req,res)=>{
  if(req.url==='/api/sessions/batches'&&req.method==='POST'&&authorized){
   const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks).toString();payloads.push(body);
   try{
    const receipt=await ingest.putBatch(principal,JSON.parse(body));
    res.writeHead(loseResponse?502:200,{'content-type':'application/json'});res.end(JSON.stringify(loseResponse?{error:{code:'RETRY'}}:{data:receipt}));loseResponse=false;
   }catch(e:any){res.writeHead(e.status||503,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'CAPTURE_REJECTED'}}));}
   return;
  }
  return handler(req,res);
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const api='http://127.0.0.1:'+(server.address() as any).port;
 try{
  Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(dir,'config'),OPENCRAWL_SESSIONS_TOKEN:token,CLAUDE_CONFIG_DIR:join(dir,'claude'),CODEX_HOME:join(dir,'codex')});
  const options={background:false,home:dir,command:[process.execPath,'-e','']};
  await installCapture(api,options);
  const installed=readCaptureConfig()!;
  const cursor=join(captureDir(),'state','fixture.json');writeFileSync(cursor,'{"offset":42}');
  const blob=Buffer.from('attachment fixture'),sha=hash(blob);writeFileSync(join(captureDir(),'blobs',sha),blob);
  const batch={schemaVersion:1,owner:installed.owner,installationId:installed.installationId,sessionId:'session',harness:'codex',origin:'cli',events:[{id:'event',kind:'message',data:{role:'user',content:'shared knowledge'}}],attachments:[{status:'captured',sha256:sha}]};
  const queue=join(captureDir(),'queue','old.json');writeFileSync(queue,JSON.stringify(batch));
  principal={...principal,tenantId:'org_team'};
  expect(await flushCaptures()).toEqual({uploaded:1});
  expect(payloads).toHaveLength(2);expect(payloads[0]).toBe(payloads[1]);
  const sent=JSON.parse(payloads[0]);expect(sent.owner).toEqual(principal);
  const receipt={...sent,batchId:hash(payloads[0]),userId:principal.userId};
  const stored=await ingest.getBatch({...principal,userId:'teammate'},receipt);
  expect(stored.owner).toEqual(principal);expect(stored.events).toEqual(batch.events);
  expect(await ingest.getBatch({...principal,tenantId:'org_other'},receipt)).toBeNull();
  expect(readCaptureConfig()).toEqual({...installed,owner:principal});
  expect(readFileSync(cursor,'utf8')).toBe('{"offset":42}');
  expect(readFileSync(join(captureDir(),'blobs',sha))).toEqual(blob);
  expect(readdirSync(join(captureDir(),'queue'))).toEqual([]);
  // Another authorized team change also works; there is no personal-scope exception.
  principal={...principal,tenantId:'org_next'};writeFileSync(queue,JSON.stringify(sent));
  expect(await flushCaptures()).toEqual({uploaded:1});
  expect(JSON.parse(payloads.at(-1)!).owner).toEqual(principal);
  // A rejected request retains its queued data. The CLI does not forge the author.
  writeFileSync(queue,JSON.stringify(batch));authorized=false;
  await expect(flushCaptures()).rejects.toMatchObject({code:'CAPTURE_UPLOAD_FAILED'});
  expect(JSON.parse(readFileSync(queue,'utf8'))).toEqual(batch);
  authorized=true;principal={...principal,userId:'bob',name:'Bob'};
  await expect(flushCaptures()).rejects.toMatchObject({code:'CAPTURE_UPLOAD_FAILED'});
  expect(JSON.parse(payloads.at(-1)!).owner.userId).toBe('alice');
  expect(JSON.parse(readFileSync(queue,'utf8'))).toEqual(batch);
  // Reinstall uses current authentication too, retaining installation and cursors.
  expect((await installCapture(api,options)).installationId).toBe(installed.installationId);
  expect(readCaptureConfig()!.owner.userId).toBe('bob');
  expect(readFileSync(cursor,'utf8')).toBe('{"offset":42}');
 }finally{await new Promise<void>(r=>server.close(()=>r()));for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);rmSync(dir,{recursive:true,force:true});}
});
