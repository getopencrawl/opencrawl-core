import {test,expect} from 'bun:test';
import {createServer} from 'node:http';
import {gunzipSync} from 'node:zlib';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {captureDir,flushCaptures,captureStatus} from '../src/capture/runtime.ts';
import {hash,finalizeEventIdentity} from '../src/capture/parse.ts';

async function fixture(run:(f:any)=>Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),'capture-rejection-')),saved={...process.env},owner={tenantId:'team',userId:'owner'};
 const puts:string[]=[],posts:string[]=[];let rejection=413,html=false,badAttachmentReceipt=false;
 const server=createServer(async(req,res)=>{
  if(req.url==='/api/sessions/identity'){res.end(JSON.stringify({data:{principal:owner,capabilities:{batchEncodings:['gzip']}}}));return;}
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks);
  if(req.method==='PUT'){
   const sha=new URL(req.url!,'http://localhost').pathname.split('/').at(-1)!;puts.push(sha);
   res.end(JSON.stringify({data:{sha256:badAttachmentReceipt?'wrong':sha,size:raw.length}}));return;
  }
  const body=(req.headers['content-encoding']==='gzip'?gunzipSync(raw):raw).toString();posts.push(body);
  if(JSON.parse(body).sessionId==='rejected'&&rejection){res.writeHead(rejection);res.end(html?'payload too large':JSON.stringify({error:{code:'CAPTURE_REJECTED'}}));return;}
  res.end(JSON.stringify({data:{stored:true,batchId:hash(body)}}));
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{
  const api='http://127.0.0.1:'+(server.address() as any).port;
  process.env.OPENCRAWL_CONFIG_HOME=join(dir,'config');delete process.env.OPENCRAWL_SESSIONS_TOKEN;
  for(const sub of ['queue','blobs','state','notices','sources'])mkdirSync(join(captureDir(),sub),{recursive:true});
  writeFileSync(join(captureDir(),'config.json'),JSON.stringify({schemaVersion:1,api,owner,installationId:'device',installedAt:new Date().toISOString(),roots:{codex:dir,'claude-code':dir},command:[]}));
  writeFileSync(join(captureDir(),'receiver-token.json'),JSON.stringify({api,token:'fixture'}));
  const bytes=Buffer.from('retained attachment'),sha256=hash(bytes),blob=join(captureDir(),'blobs',sha256);writeFileSync(blob,bytes);
  const queue=(name:string,sessionId:string,attachments=true)=>{
   const batch={schemaVersion:1,owner,installationId:'device',harness:'codex',origin:'cli',sessionId,
    events:[finalizeEventIdentity({id:'native',kind:'message',data:{text:'keep this record'}})],
    attachments:attachments?Array.from({length:2},()=>({status:'captured',sha256,size:bytes.length})):[]};
   const original=JSON.stringify(batch),path=join(captureDir(),'queue',name+'.json');writeFileSync(path,original);return {path,original};
  };
  await run({puts,posts,queue,blob,set rejection(value:number){rejection=value;},set html(value:boolean){html=value;},set badReceipt(value:boolean){badAttachmentReceipt=value;}});
 }finally{await new Promise<void>(r=>server.close(()=>r()));process.env=saved;rmSync(dir,{recursive:true,force:true});}
}

for(const html of [false,true])test('HTTP 413 '+(html?'HTML':'JSON')+' is held across flushes while healthy captures drain',async()=>fixture(async f=>{
 f.html=html;const bad=f.queue('a-bad','rejected');f.queue('z-good','healthy',false);
 await expect(flushCaptures()).rejects.toMatchObject({code:'CAPTURE_BATCH_REJECTED'});
 expect(f.puts).toHaveLength(1);expect(f.posts).toHaveLength(2);
 expect(captureStatus()).toMatchObject({queued:1,rejected:1});
 expect(captureStatus().attention).toContain('--retry-rejected');
 expect(readFileSync(bad.path,'utf8')).toBe(bad.original);expect(existsSync(f.blob)).toBe(true);
 for(let i=0;i<3;i++)await expect(flushCaptures()).rejects.toMatchObject({code:'CAPTURE_BATCH_REJECTED'});
 expect(f.puts).toHaveLength(1);expect(f.posts).toHaveLength(2);
 f.rejection=0;expect(await flushCaptures({retryRejected:true})).toEqual({uploaded:1});
 expect(f.puts).toHaveLength(1);expect(f.posts).toHaveLength(3);
 expect(captureStatus()).toMatchObject({queued:0,rejected:0});expect(existsSync(bad.path)).toBe(false);
}));

test('a temporary batch failure retains attachment acknowledgements for the next flush',async()=>fixture(async f=>{
 f.rejection=503;const bad=f.queue('batch','rejected');
 await expect(flushCaptures()).rejects.toMatchObject({httpStatus:503});
 expect(f.puts).toHaveLength(1);expect(f.posts).toHaveLength(5);
 expect(captureStatus().rejected).toBe(0);expect(readFileSync(bad.path,'utf8')).toBe(bad.original);
 f.rejection=0;
 const child=Bun.spawn([process.execPath,'--eval',`import {flushCaptures} from ${JSON.stringify(resolve(import.meta.dir,'../src/capture/runtime.ts'))};console.log(JSON.stringify(await flushCaptures()));`],{env:process.env,stdout:'pipe',stderr:'pipe'});
 const output=await new Response(child.stdout).text(),errors=await new Response(child.stderr).text();
 expect(await child.exited,errors).toBe(0);expect(JSON.parse(output)).toEqual({uploaded:1});expect(f.puts).toHaveLength(1);
}),15000);

test('an invalid attachment receipt cannot suppress a later upload',async()=>fixture(async f=>{
 f.rejection=0;f.badReceipt=true;f.queue('batch','rejected');
 await expect(flushCaptures()).rejects.toMatchObject({code:'CAPTURE_RECEIPT_INVALID'});
 expect(f.posts).toHaveLength(0);
 f.badReceipt=false;expect(await flushCaptures()).toEqual({uploaded:1});expect(f.puts).toHaveLength(2);
}));

test('a missing attachment after storage restore invalidates its acknowledgement',async()=>fixture(async f=>{
 f.rejection=409;f.queue('batch','rejected');
 await expect(flushCaptures()).rejects.toMatchObject({httpStatus:409});
 expect(f.puts).toHaveLength(1);expect(captureStatus().rejected).toBe(0);
 f.rejection=0;expect(await flushCaptures()).toEqual({uploaded:1});expect(f.puts).toHaveLength(2);
}));

test('a rejection marker applies only to the unchanged queued payload',async()=>fixture(async f=>{
 const bad=f.queue('batch','rejected');await expect(flushCaptures()).rejects.toMatchObject({code:'CAPTURE_BATCH_REJECTED'});
 const changed=JSON.parse(bad.original);changed.sessionId='another-session';writeFileSync(bad.path,JSON.stringify(changed));
 expect(await flushCaptures()).toEqual({uploaded:1});expect(f.puts).toHaveLength(2);expect(f.posts).toHaveLength(2);
}));
