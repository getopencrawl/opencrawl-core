import {test,expect} from 'bun:test';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {captureDir,flushCaptures} from '../src/capture/runtime.ts';
import {hash,finalizeEventIdentity} from '../src/capture/parse.ts';
import {attachmentReceipts,type AttachmentScope} from '../src/capture/attachment-receipts.ts';

async function fixture(run:(f:any)=>Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),'attachment-reuse-')),saved={...process.env};
 let owner={tenantId:'team',userId:'owner'},putStatus=200,batchStatus=200,discarded:string|undefined,batchDiscarded=false,badSize=false,holdBatch=false;
 const puts:any[]=[],posts:any[]=[];
 const server=createServer(async(req,res)=>{
  if(req.url==='/api/sessions/identity'){res.end(JSON.stringify({data:{principal:owner}}));return;}
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks);
  if(req.method==='PUT'){
   const sha256=new URL(req.url!,'http://localhost').pathname.split('/').at(-1)!;
   puts.push({sha256,path:req.url,owner:{...owner},size:raw.length});
   // Force concurrent flush workers to overlap this request.
   await new Promise(r=>setTimeout(r,10));
   res.writeHead(putStatus);
   res.end(JSON.stringify(putStatus===200?{data:{sha256,size:raw.length+(badSize?1:0),...(discarded?{discarded}:{})}}:{error:{code:'SYNTHETIC_REJECTED'}}));return;
  }
  const body=raw.toString();posts.push(JSON.parse(body));if(holdBatch)return;res.writeHead(batchStatus);
  res.end(JSON.stringify(batchStatus===200?{data:{stored:true,batchId:hash(body),...(batchDiscarded?{discarded:'session_deleted'}:{})}}:{error:{code:'SYNTHETIC_MISSING'}}));
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{
  const api='http://127.0.0.1:'+(server.address() as any).port;
  process.env.OPENCRAWL_CONFIG_HOME=join(dir,'config');delete process.env.OPENCRAWL_SESSIONS_TOKEN;
  delete process.env.OPENCRAWL_AUTH;delete process.env.REPLICAS_WORKSPACE_ID;
  for(const sub of ['queue','blobs','state','notices','sources'])mkdirSync(join(captureDir(),sub),{recursive:true});
  let config:any={schemaVersion:1,api,owner,installationId:'device',installedAt:new Date().toISOString(),roots:{codex:dir,'claude-code':dir},command:[]};
  const configure=(patch:any={})=>{config={...config,...patch};owner=config.owner;writeFileSync(join(captureDir(),'config.json'),JSON.stringify(config));};configure();
  writeFileSync(join(captureDir(),'receiver-token.json'),JSON.stringify({api,token:'synthetic-token'}));
  const bytes=Buffer.from('synthetic reusable image'),sha256=hash(bytes);writeFileSync(join(captureDir(),'blobs',sha256),bytes);
  const queue=(id:string,patch:any={})=>{
   const batch={schemaVersion:1,owner,installationId:config.installationId,harness:'codex',origin:'cli',sessionId:'session',
    events:[finalizeEventIdentity({id,kind:'message',data:{text:id}})],
    attachments:Array.from({length:2},()=>({status:'captured',sha256,size:bytes.length})),...patch};
   writeFileSync(join(captureDir(),'queue',id+'.json'),JSON.stringify(batch));
  };
  const flushInNewProcess=async()=>{
   const runtime=resolve(import.meta.dir,'../src/capture/runtime.ts');
   const child=Bun.spawn([process.execPath,'--eval',`import {flushCaptures} from ${JSON.stringify(runtime)};console.log(JSON.stringify(await flushCaptures()));`],{env:process.env,stdout:'pipe',stderr:'pipe'});
   const [out,err]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);
   expect(await child.exited,err).toBe(0);return JSON.parse(out);
  };
  await run({puts,posts,queue,configure,flushInNewProcess,set putStatus(v:number){putStatus=v;},set batchStatus(v:number){batchStatus=v;},set discarded(v:string|undefined){discarded=v;},set batchDiscarded(v:boolean){batchDiscarded=v;},set badSize(v:boolean){badSize=v;},set holdBatch(v:boolean){holdBatch=v;}});
 }finally{
  server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
  for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);rmSync(dir,{recursive:true,force:true});
 }
}

test('six successful batches and a new CLI process reuse one scoped image upload',async()=>fixture(async f=>{
 for(let i=0;i<6;i++){f.queue('message-'+i);expect(await flushCaptures()).toEqual({uploaded:1});}
 f.queue('new-process');expect(await f.flushInNewProcess()).toEqual({uploaded:1});
 expect(f.puts).toHaveLength(1);expect(f.posts).toHaveLength(7);
 expect(new Set(f.posts.map((b:any)=>b.events[0].id)).size).toBe(7);
}));

test('four concurrent batches coalesce the in-flight attachment PUT',async()=>fixture(async f=>{
 for(let i=0;i<4;i++)f.queue('concurrent-'+i);
 expect(await flushCaptures({concurrency:4})).toEqual({uploaded:4});
 expect(f.puts).toHaveLength(1);expect(f.posts).toHaveLength(4);
}));

test('killing the uploader before a batch receipt preserves its verified attachment acknowledgement',async()=>fixture(async f=>{
 f.queue('interrupted');f.holdBatch=true;
 const runtime=resolve(import.meta.dir,'../src/capture/runtime.ts');
 const child=Bun.spawn([process.execPath,'--eval',`import {flushCaptures} from ${JSON.stringify(runtime)};await flushCaptures();`],{env:process.env,stdout:'ignore',stderr:'ignore'});
 try{
  const deadline=Date.now()+5000;
  while(f.posts.length===0){if(Date.now()>deadline)throw new Error('Batch did not reach receiver');await new Promise(r=>setTimeout(r,10));}
  expect(f.puts).toHaveLength(1);child.kill('SIGKILL');await child.exited;
  f.holdBatch=false;expect(await f.flushInNewProcess()).toEqual({uploaded:1});
  expect(f.puts).toHaveLength(1);expect(f.posts).toHaveLength(2);
 }finally{child.kill();await child.exited;}
}));

test('same content cannot skip uploads for another session, installation, harness or author',async()=>fixture(async f=>{
 f.queue('base');await flushCaptures();
 f.queue('session',{sessionId:'other-session'});await flushCaptures();
 f.queue('installation',{installationId:'other-device'});await flushCaptures();
 f.queue('harness',{harness:'claude-code'});await flushCaptures();
 f.configure({owner:{tenantId:'team',userId:'other-owner'}});f.queue('owner');await flushCaptures();
 f.configure({owner:{tenantId:'other-team',userId:'other-owner'}});f.queue('team');await flushCaptures();
 expect(f.puts).toHaveLength(6);
}));

test('restored storage invalidates the cached blob and repairs on retry',async()=>fixture(async f=>{
 f.queue('first');await flushCaptures();f.queue('after-restore');f.batchStatus=409;
 await expect(flushCaptures()).rejects.toMatchObject({httpStatus:409});expect(f.puts).toHaveLength(1);
 f.batchStatus=200;expect(await f.flushInNewProcess()).toEqual({uploaded:1});expect(f.puts).toHaveLength(2);
 f.queue('after-repair');await flushCaptures();expect(f.puts).toHaveLength(2);
}));

test('failed and incorrectly sized acknowledgements never populate the shared cache',async()=>fixture(async f=>{
 f.queue('retry');f.putStatus=400;await expect(flushCaptures()).rejects.toMatchObject({httpStatus:400});
 f.putStatus=200;f.badSize=true;await expect(flushCaptures()).rejects.toMatchObject({code:'CAPTURE_RECEIPT_INVALID'});
 f.badSize=false;await flushCaptures();expect(f.puts).toHaveLength(3);expect(f.posts).toHaveLength(1);
 f.queue('reuse');await flushCaptures();expect(f.puts).toHaveLength(3);
}));

test('deleted-session acknowledgements do not claim the attachment was stored',async()=>fixture(async f=>{
 f.discarded='session_deleted';f.queue('deleted');await flushCaptures();
 f.discarded=undefined;f.queue('restored');await flushCaptures();expect(f.puts).toHaveLength(2);
 f.discarded='unknown';f.queue('unknown',{sessionId:'another'});
 await expect(flushCaptures()).rejects.toMatchObject({code:'CAPTURE_RECEIPT_INVALID'});
}));

test('a discarded batch also clears earlier stored-attachment receipts for its deleted session',async()=>fixture(async f=>{
 f.queue('stored');await flushCaptures();
 f.batchDiscarded=true;f.queue('deleted');await flushCaptures();expect(f.puts).toHaveLength(1);
 f.batchDiscarded=false;f.queue('restored');await flushCaptures();expect(f.puts).toHaveLength(2);
}));

test('bounded receipt cache preserves destination isolation and safely evicts old acknowledgements',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'attachment-cache-')),path=join(dir,'receipts.json');
 const scope:AttachmentScope={api:'https://one.example',tenantId:'team',userId:'owner',installationId:'device',harness:'codex',sessionId:'session'};
 try{
  let calls=0;const upload=async()=>{calls++;return true;},sha=hash('same');
  const cache=attachmentReceipts(path);await cache.ensure(scope,sha,upload);await cache.ensure(scope,sha,upload);
  await cache.ensure({...scope,api:'https://two.example'},sha,upload);expect(calls).toBe(2);
  for(let i=0;i<1024;i++)await cache.ensure(scope,hash('image-'+i),upload);
  expect(JSON.parse(readFileSync(path,'utf8')).keys).toHaveLength(1024);
  await attachmentReceipts(path).ensure(scope,sha,upload);expect(calls).toBe(1027);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
