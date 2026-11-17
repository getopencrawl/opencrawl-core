import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSessionIngest,digest} from '../dist/src/sessions/ingest.mjs';
import {createLocalSessionStore} from '../dist/src/sessions/local-store.mjs';
test('portable capture durably stores attachments and idempotent account-scoped batches',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'capture-core-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const principal={tenantId:'tenant1',userId:'owner1',name:'Owner'};
 const ingest=createSessionIngest({store:createLocalSessionStore(dir)});
 const attachment=Buffer.from('image fixture'),sha=digest(attachment);
 const batch={schemaVersion:1,owner:principal,installationId:'device',sessionId:'session',harness:'claude-code',origin:'desktop',
   events:[{id:'event',kind:'message',data:{role:'user',content:'fixture'}}],attachments:[{status:'captured',sha256:sha}]};
 await assert.rejects(ingest.putBatch(principal,batch),/not uploaded/);
 await assert.rejects(ingest.putAttachment(principal,'0'.repeat(64),attachment),/digest mismatch/);
 await ingest.putAttachment(principal,sha,attachment,batch);
 const receipt=await ingest.putBatch(principal,batch);
 assert.deepEqual(await ingest.putBatch(principal,batch),receipt);
 const ids={...batch,batchId:receipt.batchId};
 const restarted=createSessionIngest({store:createLocalSessionStore(dir)});
 assert.equal((await restarted.getBatch(principal,ids)).events[0].data.content,'fixture');
 assert.equal(await restarted.getBatch({...principal,tenantId:'tenant2'},ids),null);
 assert.equal(await restarted.getBatch({...principal,userId:'owner2'},ids),null);
 await assert.rejects(ingest.putBatch({...principal,userId:'owner2'},batch),/owner/);
 await assert.rejects(ingest.putBatch(null,batch),/Authentication/);
 const odd={...batch,installationId:'..',sessionId:'..'};
 await ingest.putAttachment(principal,sha,attachment,odd);
 const oddReceipt=await ingest.putBatch(principal,odd);
 assert.ok(await ingest.getBatch(principal,{...odd,batchId:oddReceipt.batchId}));
 assert.equal(await ingest.getBatch({...principal,userId:'owner2'},{...odd,batchId:oddReceipt.batchId}),null);
});


test('teammates read an attributed batch; other teams and forged authors fail closed',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'capture-team-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const ingest=createSessionIngest({store:createLocalSessionStore(dir)});
 const author={tenantId:'team-a',userId:'alice',name:'Alice',email:'alice@example.net'};
 const reader={tenantId:'team-a',userId:'bob'};
 const batch={schemaVersion:1,owner:{...author,name:'Spoofed'},installationId:'device',sessionId:'session',harness:'codex',origin:'cli',
   events:[{id:'event',kind:'message',data:{role:'user',content:'team knowledge'}}],attachments:[]};
 const {batchId}=await ingest.putBatch(author,batch);
 const receipt={harness:batch.harness,installationId:batch.installationId,sessionId:batch.sessionId,batchId,userId:author.userId};
 assert.deepEqual((await ingest.getBatch(reader,receipt)).owner,author);
 assert.equal(await ingest.getBatch({...reader,tenantId:'team-b'},{...receipt,tenantId:'team-a'}),null);
 await assert.rejects(ingest.getBatch(null,receipt),/Authentication/);
 await assert.rejects(ingest.getBatch(reader,{...receipt,userId:'../alice'}),/Invalid author/);
 await assert.rejects(ingest.putBatch(reader,batch),/owner/);
});
