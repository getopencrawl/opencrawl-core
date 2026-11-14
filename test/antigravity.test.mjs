import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createSessionIngest,digest} from '../dist/src/sessions/ingest.mjs';
import {sourceBatchIdentity} from '../dist/src/sessions/event-identity.mjs';
import {createControls} from '../dist/src/sessions/controls.mjs';
import {libraryOperations} from '../dist/src/sessions/library-http.mjs';
import {transcriptEntries} from '../dist/src/sessions/library.mjs';
import {batchDocuments} from '../dist/src/sessions/indexer.mjs';
import {capturedEventTokens} from '../dist/src/sessions/token-count.mjs';
import {sessionMessage} from '../dist/src/sessions/recent.mjs';
import {SESSION_HARNESSES,isSessionHarness} from '../dist/src/sessions/types.mjs';
import {createOnboardingStatus} from '../dist/src/onboarding-status.mjs';
import {captureSetupPrompt} from '../dist/src/sessions/cloud-setup.mjs';
import {standaloneCapture} from '../dist/tools/test-fixtures/capture.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';

const principal={tenantId:'tenant1',userId:'owner1',name:'Owner'};
const attachmentBytes=Buffer.from('PNG-attachment-bytes');
const attachmentHash=digest(attachmentBytes);
// Event shapes the CLI derives from Antigravity transcript_full.jsonl steps.
const events=[
 {id:'prompt',kind:'message',sequence:1,nativeId:'0',timestamp:'2026-11-13T23:22:38.000Z',data:{role:'user',content:[
  {type:'text',text:'Add Antigravity session capture'},
  {type:'opencrawl_attachment',status:'captured',sha256:attachmentHash,size:attachmentBytes.length,mimeType:'image/png'},
 ]}},
 {id:'planner',kind:'message',sequence:2,nativeId:'1',timestamp:'2026-11-13T23:22:40.000Z',data:{role:'assistant',content:[
  {type:'thinking',thinking:'Inspect src/sessions/types.mts first.'},
  {type:'text',text:'Checking session harness contracts.'},
  {type:'tool_use',name:'read_file',input:{Path:'/repo/src/sessions/types.mts'}},
 ]}},
 {id:'tool-out',kind:'tool_result',sequence:3,nativeId:'2',timestamp:'2026-11-13T23:22:41.000Z',data:{type:'tool_result',output:'export const SESSION_HARNESSES = ...'}},
 {id:'wakeup',kind:'automation_message',sequence:4,nativeId:'3',timestamp:'2026-11-13T23:22:42.000Z',data:{source:'SYSTEM',content:'Background task completed'}},
 {id:'reply',kind:'message',sequence:5,nativeId:'4',timestamp:'2026-11-13T23:22:43.000Z',data:{role:'assistant',content:[{type:'text',text:'Antigravity support is wired up.'}]}},
 {id:'stop',kind:'hook',sequence:6,timestamp:'2026-11-13T23:22:44.000Z',data:{hook_event_name:'Stop'}},
];
const batch={
 schemaVersion:1,owner:principal,installationId:'workstation-1',sessionId:'a3c19ffd-5921-4b6c-9f76-fbd835a5588d',
 harness:'antigravity',origin:'cli',captureMode:'live',events,
 attachments:[{type:'opencrawl_attachment',status:'captured',sha256:attachmentHash,size:attachmentBytes.length,mimeType:'image/png'}],
};

test('Antigravity is a first-class session harness with fail-closed scope and owner controls',async()=>{
 assert.deepEqual([...SESSION_HARNESSES],['claude-code','codex','cursor','grok-bot','antigravity']);
 assert.equal(isSessionHarness('antigravity'),true);
 // agy is a CLI convenience alias only; wire and storage contracts require canonical antigravity.
 for(const value of ['agy','ANTIGRAVITY','gemini-cli','',null,undefined,['antigravity']])assert.equal(isSessionHarness(value),false);
 const store=memorySessionStore(),ingest=createSessionIngest({store});
 const att=await ingest.putAttachment(principal,attachmentHash,attachmentBytes,{harness:'antigravity',installationId:batch.installationId,sessionId:batch.sessionId});
 assert.equal(att.sha256,attachmentHash);
 await assert.rejects(ingest.putAttachment(principal,attachmentHash,attachmentBytes,{harness:'agy',installationId:batch.installationId,sessionId:batch.sessionId}),/attachments require a session identity/);
 const receipt=await ingest.putBatch(principal,batch);
 assert.equal(receipt.stored,true);
 const stored=await ingest.getBatch(principal,{...batch,batchId:receipt.batchId});
 assert.equal(stored.events.length,events.length);
 // Fail closed across tenants and users.
 assert.equal(await ingest.getBatch({...principal,tenantId:'tenant2'},{...batch,batchId:receipt.batchId}),null);
 assert.equal(await ingest.getBatch({...principal,userId:'other-user'},{...batch,batchId:receipt.batchId}),null);
 await assert.rejects(ingest.putBatch({...principal,tenantId:'tenant2'},batch),/Capture owner does not match signed-in account/);
 await assert.rejects(ingest.putBatch(principal,{...batch,harness:'agy'}),/Invalid capture batch/);
 await assert.rejects(ingest.getBatch(principal,{...batch,harness:'agy',batchId:receipt.batchId}),/Invalid receipt/);
 const key=`capture-v1/tenants/${digest(principal.tenantId)}/users/${digest(principal.userId)}/antigravity/${digest(batch.installationId)}/${digest(batch.sessionId)}/${receipt.batchId}.json.gz`;
 assert.equal(sourceBatchIdentity('capture-v1',key).harness,'antigravity');
 assert.equal(sourceBatchIdentity('capture-v1',key.replace('/antigravity/','/agy/')),null);
 const controls=createControls({store,prefix:'capture-v1'});
 await controls.update(principal,'sessions','antigravity',batch.sessionId,()=>({visibility:'private',deletedAt:null}));
 assert.equal((await controls.read(principal,'sessions','antigravity',batch.sessionId)).visibility,'private');
 assert.equal((await controls.read({...principal,tenantId:'tenant2'},'sessions','antigravity',batch.sessionId)),null);
 await assert.rejects(controls.read(principal,'sessions','agy',batch.sessionId),/Invalid control identity/);
 // Deleted sessions discard both batches and attachments.
 await controls.update(principal,'sessions','antigravity',batch.sessionId,current=>({visibility:current.visibility,deletedAt:new Date().toISOString()}));
 assert.equal((await ingest.putBatch(principal,{...batch,events:[{...events[0],id:'later'}]})).discarded,'session_deleted');
 assert.equal((await ingest.putAttachment(principal,attachmentHash,attachmentBytes,{harness:'antigravity',installationId:batch.installationId,sessionId:batch.sessionId})).discarded,'session_deleted');
});

test('single-tenant HTTP capture accepts Antigravity without hosted credentials and fails closed on scope mismatch',async t=>{
 const store=memorySessionStore(),token='self-hosted-admin-token-01234567890123456789';
 const server=createServer((req,res)=>standaloneCapture({token,principal,store})(req,res));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port;
 const unauth=await fetch(base+'/api/sessions/batches',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(batch)});
 assert.equal(unauth.status,401);
 const forged=await fetch(base+'/api/sessions/batches',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({...batch,owner:{...principal,tenantId:'other'}})});
 assert.equal(forged.status,403);
 // Referencing an unuploaded attachment fails closed with 409 until PUT /api/sessions/attachments/<hash> stores it.
 const missingAtt=await fetch(base+'/api/sessions/batches',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({...batch,origin:'desktop'})});
 assert.equal(missingAtt.status,409);
 const putAtt=await fetch(`${base}/api/sessions/attachments/${attachmentHash}?harness=antigravity&installationId=${batch.installationId}&sessionId=${batch.sessionId}`,{method:'PUT',headers:{authorization:'Bearer '+token},body:attachmentBytes});
 assert.equal(putAtt.status,200);
 const ok=await fetch(base+'/api/sessions/batches',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({...batch,origin:'desktop'})});
 assert.equal(ok.status,200);
 const onboarding=await (await fetch(base+'/api/onboarding',{headers:{authorization:'Bearer '+token}})).json();
 assert.equal(onboarding.data.session.harness,'antigravity');
});

test('library API allows Antigravity sessions while keeping native memory APIs restricted to memory harnesses',()=>{
 assert.equal(libraryOperations['sessions/read'].safeParse({userId:'owner1',harness:'antigravity',sessionId:batch.sessionId}).success,true);
 assert.equal(libraryOperations['sessions/visibility'].safeParse({harness:'antigravity',sessionId:batch.sessionId,visibility:'private'}).success,true);
 assert.equal(libraryOperations['sessions/delete'].safeParse({harness:'antigravity',sessionId:batch.sessionId}).success,true);
 assert.equal(libraryOperations['sessions/read'].safeParse({userId:'owner1',harness:'agy',sessionId:batch.sessionId}).success,false);
 for(const operation of ['memories/read','memories/visibility','memories/delete'])
  assert.equal(libraryOperations[operation].safeParse({userId:'owner1',harness:'antigravity',path:'GEMINI.md',visibility:'team'}).success,false,operation);
});

test('Antigravity transcript events render, index, extract toolNames and count tokens consistently',()=>{
 assert.deepEqual(events.flatMap(event=>transcriptEntries(event)),[
  {type:'message',role:'user',text:'Add Antigravity session capture'},
  {type:'message',role:'assistant',text:'Checking session harness contracts.'},
  {type:'tool_call',name:'read_file',input:'{\n  "Path": "/repo/src/sessions/types.mts"\n}',truncated:false},
  {type:'tool_result',text:'export const SESSION_HARNESSES = ...',truncated:false},
  {type:'note',label:'Automation',text:'Background task completed',truncated:false},
  {type:'message',role:'assistant',text:'Antigravity support is wired up.'},
 ]);
 assert.deepEqual(sessionMessage(events[0]),{role:'user',text:'Add Antigravity session capture'});
 assert.deepEqual(sessionMessage(events[1]),{role:'assistant',text:'Checking session harness contracts.'});
 assert.equal(sessionMessage(events[3]),null);
 // Thinking and attachment descriptors do not inflate capturedEventTokens; text, tool_use and tool_result are counted.
 assert.ok(capturedEventTokens('antigravity',events[0])>0);
 const withoutThinking={...events[1],data:{role:'assistant',content:events[1].data.content.filter(b=>b.type!=='thinking')}};
 assert.equal(capturedEventTokens('antigravity',events[1]),capturedEventTokens('antigravity',withoutThinking));
 assert.ok(capturedEventTokens('antigravity',events[2])>0);
 assert.equal(capturedEventTokens('antigravity',events[3]),0);
 const key=`capture-v1/tenants/${digest(principal.tenantId)}/users/${digest(principal.userId)}/antigravity/${digest(batch.installationId)}/${digest(batch.sessionId)}/${'b'.repeat(64)}.json.gz`;
 const documents=batchDocuments({prefix:'capture-v1',key,batch:{...batch,receivedAt:'2026-11-13T23:23:00.000Z'},principal}).map(item=>item.document);
 assert.deepEqual(documents.map(d=>d.kind),['message','message','tool_result','automation_message','message']);
 assert.ok(documents.every(d=>d.harness==='antigravity'&&d.origin==='cli'&&d.sessionId===batch.sessionId));
 assert.deepEqual(documents.map(d=>d.role),['user','assistant',null,null,'assistant']);
 assert.deepEqual(documents[0].attachments.map(a=>a.sha256),[attachmentHash]);
 assert.deepEqual(documents[1].toolNames,['read_file']);
 assert.match(documents[1].text,/Inspect src\/sessions\/types\.mts first\./);
 assert.match(documents[1].text,/Checking session harness contracts\./);
});

test('Antigravity onboarding requires a live message rather than imported history or tool-only events',async()=>{
 const toolOnly={...batch,events:[events[2],events[5]]};
 for(const [input,expected] of [
  [toolOnly,null],
  [{...batch,captureMode:'history'},null],
  [batch,'antigravity'],
 ]) {
  const status=createOnboardingStatus({store:memorySessionStore()});
  await status.session(principal,input);
  assert.equal((await status.read(principal)).session?.harness??null,expected);
 }
 const history=createOnboardingStatus({store:memorySessionStore()});
 await history.session(principal,{...batch,captureMode:'history'});
 assert.equal((await history.read(principal)).history.harness,'antigravity');
});

test('setup prompt covers Antigravity hooks, skills, mcp_config.json and history backfill',()=>{
 const api='https://capture.example.com',prompt=captureSetupPrompt(api);
 for(const text of [
  'For Antigravity',
  '~/.gemini/config',
  '--harness antigravity',
  '--client antigravity',
  '~/.gemini/config/mcp_config.json',
  '--harness <claude-code|codex|antigravity|all> --yes',
 ])assert.ok(prompt.includes(text),text);
});
