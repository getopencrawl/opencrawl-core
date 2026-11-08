import {test,expect} from 'bun:test';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {request} from '../src/capture/runtime.ts';
import {finalizeEventIdentity,hash} from '../src/capture/parse.ts';
import {createSessionIngest} from '../../dist/src/sessions/ingest.mjs';
import {createLocalSessionStore} from '../../dist/src/sessions/local-store.mjs';

test('capture retries a lost response after durable storage with the identical payload, but does not retry rejection',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'opencrawl-capture-retry-')),saved=process.env.OPENCRAWL_CONFIG_HOME;
 process.env.OPENCRAWL_CONFIG_HOME=join(dir,'config');
 const owner={tenantId:'test',userId:'test'},ingest=createSessionIngest({store:createLocalSessionStore(join(dir,'objects'))});
 const batch={schemaVersion:1,owner,installationId:'test',sessionId:'session',harness:'codex',origin:'desktop',events:[finalizeEventIdentity({id:'event',kind:'message',data:{role:'user',content:'preserve me'}})],attachments:[]};
 const body=JSON.stringify(batch),payloads:string[]=[];let reject=false;
 const server=createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks).toString();payloads.push(raw);
  if(reject){res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'DENIED'}}));return;}
  const receipt=await ingest.putBatch(owner,JSON.parse(raw));
  if(payloads.length===1){res.writeHead(502,{'content-type':'text/html'});res.end('temporary upstream failure');return;}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:receipt}));
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const api='http://127.0.0.1:'+(server.address() as any).port;
 try {
  const receipt=await request(api,'/api/sessions/batches',{method:'POST',headers:{'content-type':'application/json'},body},'test-token');
  expect(payloads).toEqual([body,body]);expect(receipt).toEqual({stored:true,batchId:hash(body),eventCount:1});
  expect((await ingest.getBatch(owner,{harness:'codex',installationId:'test',sessionId:'session',batchId:receipt.batchId})).events).toEqual(batch.events);
  reject=true;const before=payloads.length;
  await expect(request(api,'/api/sessions/batches',{method:'POST',body},'test-token')).rejects.toMatchObject({code:'CAPTURE_UPLOAD_FAILED'});
  expect(payloads.length-before).toBe(1);
 }finally{await new Promise<void>(r=>server.close(()=>r()));if(saved===undefined)delete process.env.OPENCRAWL_CONFIG_HOME;else process.env.OPENCRAWL_CONFIG_HOME=saved;rmSync(dir,{recursive:true,force:true});}
});
