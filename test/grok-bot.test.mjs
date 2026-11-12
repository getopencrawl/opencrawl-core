import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSessionIngest,digest} from '../dist/src/sessions/ingest.mjs';
import {sourceBatchIdentity} from '../dist/src/sessions/event-identity.mjs';
import {createControls} from '../dist/src/sessions/controls.mjs';
import {libraryOperations} from '../dist/src/sessions/library-http.mjs';
import {transcriptEntries} from '../dist/src/sessions/library.mjs';
import {batchDocuments} from '../dist/src/sessions/indexer.mjs';
import {sessionMessage} from '../dist/src/sessions/recent.mjs';
import {SESSION_HARNESSES,isSessionHarness} from '../dist/src/sessions/types.mjs';
import {createOnboardingStatus} from '../dist/src/onboarding-status.mjs';
import {captureSetupPrompt,cloudCapturePage,cloudSetupScript} from '../dist/src/sessions/cloud-setup.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';

const principal={tenantId:'tenant1',userId:'owner1',name:'Owner'};
// The event shapes the CLI derives from Grok Bot hook payloads.
const events=[
 {id:'prompt',kind:'message',sequence:1,timestamp:'2026-11-10T12:00:00.000Z',turnId:'gen-1',data:{role:'user',content:[{type:'text',text:'Expense the conference pass'}]}},
 {id:'thought',kind:'reasoning_summary',sequence:2,timestamp:'2026-11-10T12:00:01.000Z',data:{type:'reasoning',summary:[{type:'summary_text',text:'Find last year first.'}]}},
 {id:'call',kind:'tool_call',sequence:3,timestamp:'2026-11-10T12:00:02.000Z',nativeId:'tool-1',data:{type:'tool_use',name:'Shell',input:{command:'npm test'},call_id:'tool-1'}},
 {id:'result',kind:'tool_result',sequence:4,timestamp:'2026-11-10T12:00:02.000Z',nativeId:'tool-1',data:{type:'tool_result',name:'Shell',call_id:'tool-1',output:{exitCode:0,stdout:'All tests passed'},duration_ms:5432}},
 {id:'reply',kind:'message',sequence:5,timestamp:'2026-11-10T12:00:03.000Z',data:{role:'assistant',content:[{type:'text',text:'Booked and logged.'}],model:'grok-4.7'}},
 {id:'stop',kind:'hook',sequence:6,timestamp:'2026-11-10T12:00:04.000Z',data:{hook_event_name:'stop',status:'completed'}},
];
const batch={schemaVersion:1,owner:principal,installationId:'bot-computer',sessionId:'conversation-1',harness:'grok-bot',origin:'cloud',captureMode:'live',events,attachments:[]};

test('Grok Bot is a session harness everywhere a session is addressed, and unknown harnesses stay rejected',async()=>{
 assert.deepEqual([...SESSION_HARNESSES],['claude-code','codex','grok-bot','opencode','cursor','muse']);
 assert.equal(isSessionHarness('grok-bot'),true);
 for(const value of ['copilot','grok','GROK-BOT','',null,undefined,['grok-bot']])assert.equal(isSessionHarness(value),false);
 const store=memorySessionStore(),ingest=createSessionIngest({store});
 const receipt=await ingest.putBatch(principal,batch);
 assert.equal(receipt.stored,true);
 const stored=await ingest.getBatch(principal,{...batch,batchId:receipt.batchId});
 assert.equal(stored.events.length,events.length);
 assert.equal(await ingest.getBatch({...principal,tenantId:'tenant2'},{...batch,batchId:receipt.batchId}),null);
 await assert.rejects(ingest.putBatch(principal,{...batch,harness:'copilot'}),/Invalid capture batch/);
 await assert.rejects(ingest.getBatch(principal,{...batch,harness:'copilot',batchId:receipt.batchId}),/Invalid receipt/);
 const key=`capture-v1/tenants/${digest(principal.tenantId)}/users/${digest(principal.userId)}/grok-bot/${digest(batch.installationId)}/${digest(batch.sessionId)}/${receipt.batchId}.json.gz`;
 assert.equal(sourceBatchIdentity('capture-v1',key).harness,'grok-bot');
 assert.equal(sourceBatchIdentity('capture-v1',key.replace('/grok-bot/','/copilot/')),null);
 // Owner controls address the session by the same harness.
 const controls=createControls({store,prefix:'capture-v1'});
 await controls.update(principal,'sessions','grok-bot',batch.sessionId,()=>({visibility:'private',deletedAt:null}));
 assert.equal((await controls.read(principal,'sessions','grok-bot',batch.sessionId)).visibility,'private');
 await assert.rejects(controls.read(principal,'sessions','copilot',batch.sessionId),/Invalid control identity/);
 // A deleted session swallows later uploads from the Bot's computer.
 await controls.update(principal,'sessions','grok-bot',batch.sessionId,current=>({visibility:current.visibility,deletedAt:new Date().toISOString()}));
 assert.equal((await ingest.putBatch(principal,{...batch,events:[{...events[0],id:'later'}]})).discarded,'session_deleted');
});

test('the library API reads Grok Bot sessions; memories remain limited to harnesses with memory files',()=>{
 assert.equal(libraryOperations['sessions/read'].safeParse({userId:'owner1',harness:'grok-bot',sessionId:'conversation-1'}).success,true);
 assert.equal(libraryOperations['sessions/visibility'].safeParse({harness:'grok-bot',sessionId:'conversation-1',visibility:'private'}).success,true);
 assert.equal(libraryOperations['sessions/delete'].safeParse({harness:'grok-bot',sessionId:'conversation-1'}).success,true);
 assert.equal(libraryOperations['sessions/read'].safeParse({userId:'owner1',harness:'copilot',sessionId:'conversation-1'}).success,false);
 for(const operation of ['memories/read','memories/visibility','memories/delete'])
  assert.equal(libraryOperations[operation].safeParse({userId:'owner1',harness:'grok-bot',path:'projects/x/memory/MEMORY.md',visibility:'team'}).success,false,operation);
 assert.equal(libraryOperations['memories/read'].safeParse({userId:'owner1',harness:'codex',path:'memories/MEMORY.md'}).success,true);
});

test('hook-derived Grok Bot events render, index and summarize like native transcript events',()=>{
 assert.deepEqual(events.flatMap(event=>transcriptEntries(event)),[
  {type:'message',role:'user',text:'Expense the conference pass'},
  {type:'note',label:'Reasoning summary',text:'Find last year first.',truncated:false},
  {type:'tool_call',name:'Shell',input:'{\n  "command": "npm test"\n}',truncated:false},
  {type:'tool_result',text:'{\n  "exitCode": 0,\n  "stdout": "All tests passed"\n}',truncated:false},
  {type:'message',role:'assistant',text:'Booked and logged.'},
 ]);
 assert.deepEqual(sessionMessage(events[0]),{role:'user',text:'Expense the conference pass'});
 assert.deepEqual(sessionMessage(events[4]),{role:'assistant',text:'Booked and logged.'});
 assert.equal(sessionMessage(events[2]),null);
 const key=`capture-v1/tenants/${digest(principal.tenantId)}/users/${digest(principal.userId)}/grok-bot/${digest(batch.installationId)}/${digest(batch.sessionId)}/${'a'.repeat(64)}.json.gz`;
 const documents=batchDocuments({prefix:'capture-v1',key,batch:{...batch,receivedAt:'2026-11-10T12:01:00.000Z'},principal}).map(item=>item.document);
 // Lifecycle hooks are retained as capture evidence and never indexed.
 assert.deepEqual(documents.map(d=>d.kind),['message','reasoning_summary','tool_call','tool_result','message']);
 assert.ok(documents.every(d=>d.harness==='grok-bot'&&d.origin==='cloud'&&d.sessionId==='conversation-1'));
 assert.deepEqual(documents.map(d=>d.role),['user',null,null,null,'assistant']);
 assert.deepEqual(documents[2].toolNames,['Shell']);assert.equal(documents[2].toolCallId,'tool-1');assert.equal(documents[2].text,'npm test\nShell');
 assert.equal(documents[3].toolCallId,'tool-1');assert.match(documents[3].text,/All tests passed/);
 assert.equal(documents[0].turnId,'gen-1');
});

test('a recorded Grok Bot tool call completes the recording step; other harnesses still need a message',async()=>{
 const toolOnly={...batch,events:events.filter(event=>event.kind.startsWith('tool_'))};
 for(const [input,expected] of [
  [{...batch,events:[events[5]]},null],
  [{...toolOnly,harness:'codex'},null],
  [{...toolOnly,harness:'claude-code'},null],
  [{...toolOnly,captureMode:'history'},null],
  [toolOnly,'grok-bot'],
  [batch,'grok-bot'],
 ]) {
  const status=createOnboardingStatus({store:memorySessionStore()});
  await status.session(principal,input);
  assert.equal((await status.read(principal)).session?.harness??null,expected);
 }
 const history=createOnboardingStatus({store:memorySessionStore()});
 await history.session(principal,{...toolOnly,captureMode:'history'});
 assert.equal((await history.read(principal)).history.harness,'grok-bot');
 await assert.rejects(async()=>createOnboardingStatus({store:memorySessionStore()}).session(principal,{...batch,harness:'copilot'}),/Unknown session harness/);
});

test('setup guidance sends Grok Bot to its own cloud computer with the explicit harness',()=>{
 const api='https://capture.example.com',prompt=captureSetupPrompt(api);
 for(const text of ['For Grok Bot','opencrawl collect install --yes --harness grok-bot --api '+api+' --json',api+'/mcp as a custom connector','newly created Bot',"skip a shared Bot's computer",'no local history to import'])assert.ok(prompt.includes(text),text);
 // The cloud credential sentences stay together; "that" token is the one from /capture/cloud.
 assert.ok(prompt.includes(api+'/capture/cloud for Claude cloud setup. For machine images, templates or snapshots, use that upload-only OPENCRAWL_SESSIONS_TOKEN'));
 // The capture page is inert data rendered by the React console, which builds the Grok Bot
 // commands from this API origin (web-v2/test/documents.test.ts covers the rendered steps).
 assert.deepEqual(cloudCapturePage({api}),{kind:'capture',api,credential:undefined,revoked:false,script:cloudSetupScript(api)});
});
