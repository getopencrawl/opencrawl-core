import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {gzipSync} from 'node:zlib';
import {createCaptureHandler,createSessionIngest,digest,MAX_BATCH_BYTES} from '../dist/src/sessions/ingest.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';

test('compressed capture preserves receipts and scope with bounded expansion',async t=>{
 const owner={tenantId:'compression-team',userId:'author'},store=memorySessionStore(),ingest=createSessionIngest({store});
 let rejectAfterBody=false,authCalls=0;
 const handler=createCaptureHandler({ingest,authenticate:async req=>{
  authCalls++;return req.headers.authorization==='Bearer fixture'&&!(rejectAfterBody&&authCalls%2===0)?owner:null;
 }});
 const server=createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>server.close(r)));
 const api='http://127.0.0.1:'+server.address().port;
 const value={schemaVersion:1,owner,installationId:'device',sessionId:'session',harness:'codex',origin:'cli',events:[{id:'event',kind:'message',data:'realistic repeated tool output 中文 '.repeat(2000)}],attachments:[]};
 const serialized=JSON.stringify(value),compressed=gzipSync(serialized,{level:1});
 const send=(body,encoding='gzip',authorization='Bearer fixture')=>fetch(api+'/api/sessions/batches',{method:'POST',headers:{authorization,'content-type':'application/json','content-encoding':encoding},body});
 const identity=await (await fetch(api+'/api/sessions/identity',{headers:{authorization:'Bearer fixture'}})).json();
 assert.deepEqual(identity.data.capabilities.batchEncodings,['gzip']);
 assert.ok(compressed.length<Buffer.byteLength(serialized)/10);
 const first=await send(compressed);assert.equal(first.status,200);const receipt=(await first.json()).data;
 assert.equal(receipt.batchId,digest(serialized));assert.equal(receipt.stored,true);
 const retry=await send(serialized,'identity');assert.equal(retry.status,200);assert.deepEqual((await retry.json()).data,receipt);
 assert.equal((await ingest.getBatch(owner,{...value,batchId:receipt.batchId})).events[0].data,value.events[0].data);
 assert.equal((await send(gzipSync(JSON.stringify({...value,owner:{...owner,tenantId:'other'}})))).status,403);
 assert.equal((await send(compressed,'br')).status,415);
 assert.equal((await send(compressed.subarray(0,compressed.length-6))).status,400);
 assert.equal((await send(gzipSync('x'.repeat(MAX_BATCH_BYTES+1)))).status,413);
 assert.equal((await send(Buffer.alloc(MAX_BATCH_BYTES+1))).status,413);
 assert.equal((await send(compressed,'gzip','Bearer revoked')).status,401);
 authCalls=0;rejectAfterBody=true;assert.equal((await send(compressed)).status,403);
});
