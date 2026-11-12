import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createSessionIngest,createCaptureHandler,digest} from '../dist/src/sessions/ingest.mjs';
import {sourceBatchIdentity} from '../dist/src/sessions/event-identity.mjs';
import {createControls} from '../dist/src/sessions/controls.mjs';
import {libraryOperations} from '../dist/src/sessions/library-http.mjs';
import {transcriptEntries} from '../dist/src/sessions/library.mjs';
import {batchDocuments} from '../dist/src/sessions/indexer.mjs';
import {sessionMessage} from '../dist/src/sessions/recent.mjs';
import {SESSION_HARNESSES,isSessionHarness} from '../dist/src/sessions/types.mjs';
import {createOnboardingStatus} from '../dist/src/onboarding-status.mjs';
import {captureSetupPrompt} from '../dist/src/sessions/cloud-setup.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';

const principal={tenantId:'tenant1',userId:'owner1',name:'Owner'};
// The event shapes the CLI derives from what OpenCode's plugin, Cursor's hooks
// and Muse Code's hooks deliver: the same ones transcript capture produces.
const events=[
 {id:'prompt',kind:'message',sequence:1,timestamp:'2026-11-12T12:00:00.000Z',turnId:'turn-1',data:{role:'user',content:[{type:'text',text:'Why is checkout failing?'}]}},
 {id:'thought',kind:'reasoning_summary',sequence:2,timestamp:'2026-11-12T12:00:01.000Z',data:{type:'reasoning',summary:[{type:'summary_text',text:'Look at the failing request first.'}]}},
 {id:'call',kind:'tool_call',sequence:3,timestamp:'2026-11-12T12:00:02.000Z',nativeId:'call-1',data:{type:'tool_use',name:'bash',input:{command:'npm test'},call_id:'call-1'}},
 {id:'result',kind:'tool_result',sequence:4,timestamp:'2026-11-12T12:00:02.000Z',nativeId:'call-1',data:{type:'tool_result',name:'bash',call_id:'call-1',output:'1 failed',title:'npm test',duration_ms:41}},
 {id:'reply',kind:'message',sequence:5,timestamp:'2026-11-12T12:00:03.000Z',data:{role:'assistant',content:[{type:'text',text:'The cart total is rounded twice.'}],model:'lab-model'}},
 {id:'title',kind:'session_title',sequence:6,timestamp:'2026-11-12T12:00:03.000Z',data:{title:'Checkout rounding',titleType:'auto'}},
 {id:'idle',kind:'hook',sequence:7,timestamp:'2026-11-12T12:00:04.000Z',data:{type:'session.idle'}},
];
const batch=harness=>({schemaVersion:1,owner:principal,installationId:'workspace-vm',sessionId:'session-1',harness,origin:'unknown',captureMode:'live',events,attachments:[]});
const added=['opencode','cursor','muse'];

test('OpenCode, Cursor and Muse Code are session harnesses everywhere a session is addressed',async()=>{
 for(const harness of added)assert.equal(isSessionHarness(harness),true,harness);
 for(const value of ['copilot','gemini','OpenCode','muse-code','',null])assert.equal(isSessionHarness(value),false);
 for(const harness of added) {
  const store=memorySessionStore(),ingest=createSessionIngest({store});
  const receipt=await ingest.putBatch(principal,batch(harness));
  assert.equal(receipt.stored,true);
  assert.equal((await ingest.getBatch(principal,{...batch(harness),batchId:receipt.batchId})).events.length,events.length);
  assert.equal(await ingest.getBatch({...principal,tenantId:'tenant2'},{...batch(harness),batchId:receipt.batchId}),null);
  const key=`capture-v1/tenants/${digest(principal.tenantId)}/users/${digest(principal.userId)}/${harness}/${digest('workspace-vm')}/${digest('session-1')}/${receipt.batchId}.json.gz`;
  assert.equal(sourceBatchIdentity('capture-v1',key).harness,harness);
  // Owner controls and the library address the session by the same harness.
  const controls=createControls({store,prefix:'capture-v1'});
  await controls.update(principal,'sessions',harness,'session-1',()=>({visibility:'private',deletedAt:null}));
  assert.equal((await controls.read(principal,'sessions',harness,'session-1')).visibility,'private');
  assert.equal(libraryOperations['sessions/read'].safeParse({userId:'owner1',harness,sessionId:'session-1'}).success,true);
  assert.equal(libraryOperations['sessions/delete'].safeParse({harness,sessionId:'session-1'}).success,true);
  // None of them keeps native memory files.
  assert.equal(libraryOperations['memories/read'].safeParse({userId:'owner1',harness,path:'memory/MEMORY.md'}).success,false);
  // A recorded message completes the recording step of onboarding; hooks alone do not.
  const status=createOnboardingStatus({store:memorySessionStore()});
  await status.session(principal,{...batch(harness),events:[events[6]]});
  assert.equal((await status.read(principal)).session,null);
  await status.session(principal,batch(harness));
  assert.equal((await status.read(principal)).session.harness,harness);
 }
});

test('their events render, index and summarize like native transcript events',()=>{
 assert.deepEqual(events.flatMap(event=>transcriptEntries(event)),[
  {type:'message',role:'user',text:'Why is checkout failing?'},
  {type:'note',label:'Reasoning summary',text:'Look at the failing request first.',truncated:false},
  {type:'tool_call',name:'bash',input:'{\n  "command": "npm test"\n}',truncated:false},
  {type:'tool_result',text:'1 failed',truncated:false},
  {type:'message',role:'assistant',text:'The cart total is rounded twice.'},
 ]);
 assert.deepEqual(sessionMessage(events[0]),{role:'user',text:'Why is checkout failing?'});
 assert.deepEqual(sessionMessage(events[4]),{role:'assistant',text:'The cart total is rounded twice.'});
 for(const harness of added) {
  const key=`capture-v1/tenants/${digest(principal.tenantId)}/users/${digest(principal.userId)}/${harness}/${digest('workspace-vm')}/${digest('session-1')}/${'a'.repeat(64)}.json.gz`;
  const documents=batchDocuments({prefix:'capture-v1',key,batch:{...batch(harness),receivedAt:'2026-11-12T12:01:00.000Z'},principal}).map(item=>item.document);
  // Lifecycle evidence is retained and never indexed.
  assert.deepEqual(documents.map(d=>d.kind),['message','reasoning_summary','tool_call','tool_result','message','session_title']);
  assert.ok(documents.every(d=>d.harness===harness&&d.sessionId==='session-1'));
  assert.deepEqual(documents.map(d=>d.role),['user',null,null,null,'assistant',null]);
  assert.deepEqual(documents[2].toolNames,['bash']);assert.equal(documents[2].toolCallId,'call-1');
  assert.match(documents[3].text,/1 failed/);
 }
});

test('the capture identity response lists the agents this deployment stores',async()=>{
 const ingest=createSessionIngest({store:memorySessionStore()});
 const handler=createCaptureHandler({ingest,authenticate:async request=>request.headers.authorization==='Bearer good'?principal:null});
 const server=createServer((request,response)=>{if(request.url!=='/api/sessions/identity'){response.writeHead(404).end();return;}handler(request,response);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const url=`http://127.0.0.1:${server.address().port}/api/sessions/identity`;
  const answer=await (await fetch(url,{headers:{authorization:'Bearer good'}})).json();
  assert.deepEqual(answer.data.principal,principal);
  // A client enrolls an agent only where its sessions are accepted, and holds
  // batches for one that is not listed instead of sending what would be rejected.
  assert.deepEqual(answer.data.harnesses,[...SESSION_HARNESSES]);
  for(const harness of added)assert.ok(answer.data.harnesses.includes(harness));
  assert.equal((await fetch(url,{headers:{authorization:'Bearer bad'}})).status,401);
 } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('setup guidance covers the agents a plain install finds, naming one, and machines a cloud platform creates',()=>{
 const api='https://capture.example.com',prompt=captureSetupPrompt(api);
 for(const text of ['OpenCode, Cursor and Muse Code wherever it finds them','--harness opencode, cursor or muse','harnesses in its output','skipped says why','not Cursor\'s own cloud agents','These three have no local history to import',
  'such as Replicas or Codespaces','opencrawl collect install --yes --backfill skip --defer-auth --api '+api+' --json','start hook, setup script or postCreateCommand','with the token in that step\'s environment'])assert.ok(prompt.includes(text),text);
 // The cloud credential sentences stay together; "that" token is the one from /capture/cloud.
 assert.ok(prompt.includes(api+'/capture/cloud for Claude cloud setup. For machine images, templates or snapshots, use that upload-only OPENCRAWL_SESSIONS_TOKEN'));
 assert.ok(prompt.indexOf('store that token as my personal secret')>prompt.indexOf('use that upload-only OPENCRAWL_SESSIONS_TOKEN'));
 // Setup stays short: what cannot be proven now is reported as pending, not waited for.
 for(const text of ['Only a brand-new machine proves that step; report it as pending rather than waiting for one','report what agents in that output says each one has delivered','nothing delivered yet is pending until a new session of that agent runs, never a pass'])assert.ok(prompt.includes(text),text);
 assert.ok(prompt.indexOf('report what agents in that output')>prompt.indexOf('Finish with one bounded verification pass'));
});
