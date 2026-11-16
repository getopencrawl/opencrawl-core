import {withTestState} from './fixtures/memory-application-state.mjs';
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
import {memorySessionStore} from './session-store-fixture.mjs';

const principal={tenantId:'tenant1',userId:'owner1',name:'Owner'};
// The event shapes the CLI derives from a Reason session log (cli/test/capture-reason.test.ts).
const events=[
 {id:'header',kind:'session_metadata',sequence:0,timestamp:'2026-11-16T21:21:13.120Z',data:{id:'session-1',version:3,cwd:'/work/project'}},
 {id:'prompt',kind:'message',sequence:155,timestamp:'2026-11-16T21:21:13.344Z',nativeId:'c0362b2c',parentId:'27b24c80',data:{role:'user',content:[{type:'text',text:'Print the probe marker with echo.'}]}},
 {id:'call',kind:'message',sequence:400,timestamp:'2026-11-16T21:21:13.396Z',nativeId:'26699b3b',parentId:'c0362b2c',data:{role:'assistant',model:'stub-model',provider:'stub',stop_reason:'toolUse',content:[
  {type:'thinking',thinking:'The user wants the marker printed.'},{type:'text',text:'Running the command now.'},{type:'tool_use',id:'call_probe_1',name:'bash',input:{command:'echo REASON_PROBE_MARKER'}}]}},
 {id:'result',kind:'tool_result',sequence:900,timestamp:'2026-11-16T21:21:13.405Z',nativeId:'10be76f7',parentId:'26699b3b',data:{type:'tool_result',tool_use_id:'call_probe_1',name:'bash',output:'REASON_PROBE_MARKER\n'}},
 {id:'answer',kind:'message',sequence:1200,timestamp:'2026-11-16T21:21:13.412Z',nativeId:'a81328bc',parentId:'10be76f7',data:{role:'assistant',content:[{type:'text',text:'Done: the command printed the marker.'}]}},
 {id:'compaction',kind:'compaction',sequence:1500,timestamp:'2026-11-16T21:30:00.000Z',data:{type:'compaction',summary:'Earlier work summarized.',tokensBefore:50000}},
];
const batch={schemaVersion:1,owner:principal,installationId:'laptop-1',sessionId:'session-1',harness:'reason',origin:'unknown',captureMode:'live',cwd:'/work/project',events,attachments:[]};

test('Reason is a session harness everywhere a session is addressed, with fail-closed scope and owner controls',async()=>{
 assert.equal(SESSION_HARNESSES.includes('reason'),true);
 assert.equal(isSessionHarness('reason'),true);
 for(const value of ['Reason','reasons','pi',''])assert.equal(isSessionHarness(value),false);
 const store=memorySessionStore(),ingest=createSessionIngest(withTestState({store}));
 const receipt=await ingest.putBatch(principal,batch);
 assert.equal(receipt.stored,true);
 const stored=await ingest.getBatch(principal,{...batch,batchId:receipt.batchId});
 assert.equal(stored.events.length,events.length);
 assert.equal(await ingest.getBatch({...principal,tenantId:'tenant2'},{...batch,batchId:receipt.batchId}),null);
 const key=`capture-v1/tenants/${digest(principal.tenantId)}/users/${digest(principal.userId)}/reason/${digest(batch.installationId)}/${digest(batch.sessionId)}/${receipt.batchId}.json.gz`;
 assert.equal(sourceBatchIdentity('capture-v1',key).harness,'reason');
 const controls=createControls(withTestState({store,prefix:'capture-v1'}));
 await controls.update(principal,'sessions','reason',batch.sessionId,()=>({visibility:'private',deletedAt:null}));
 assert.equal((await controls.read(principal,'sessions','reason',batch.sessionId)).visibility,'private');
 await controls.update(principal,'sessions','reason',batch.sessionId,current=>({visibility:current.visibility,deletedAt:new Date().toISOString()}));
 assert.equal((await ingest.putBatch(principal,{...batch,events:[{...events[1],id:'later'}]})).discarded,'session_deleted');
});

test('the library API reads Reason sessions; memories remain limited to harnesses with memory files',()=>{
 assert.equal(libraryOperations['sessions/read'].safeParse({userId:'owner1',harness:'reason',sessionId:'session-1'}).success,true);
 assert.equal(libraryOperations['sessions/visibility'].safeParse({harness:'reason',sessionId:'session-1',visibility:'private'}).success,true);
 assert.equal(libraryOperations['sessions/delete'].safeParse({harness:'reason',sessionId:'session-1'}).success,true);
 for(const operation of ['memories/read','memories/visibility','memories/delete'])
  assert.equal(libraryOperations[operation].safeParse({userId:'owner1',harness:'reason',path:'memory/MEMORY.md',visibility:'team'}).success,false,operation);
});

test('Reason events render, index and summarize through the shared projections',()=>{
 assert.deepEqual(events.flatMap(event=>transcriptEntries(event)),[
  {type:'message',role:'user',text:'Print the probe marker with echo.'},
  {type:'message',role:'assistant',text:'Running the command now.'},
  {type:'tool_call',name:'bash',input:'{\n  "command": "echo REASON_PROBE_MARKER"\n}',truncated:false},
  {type:'tool_result',text:'REASON_PROBE_MARKER\n',truncated:false},
  {type:'message',role:'assistant',text:'Done: the command printed the marker.'},
  {type:'note',label:'Context compacted',text:'Earlier work summarized.',truncated:false},
 ]);
 assert.deepEqual(sessionMessage(events[1]),{role:'user',text:'Print the probe marker with echo.'});
 assert.deepEqual(sessionMessage(events[4]),{role:'assistant',text:'Done: the command printed the marker.'});
 const key=`capture-v1/tenants/${digest(principal.tenantId)}/users/${digest(principal.userId)}/reason/${digest(batch.installationId)}/${digest(batch.sessionId)}/${'a'.repeat(64)}.json.gz`;
 const documents=batchDocuments({prefix:'capture-v1',key,batch:{...batch,receivedAt:'2026-11-16T21:31:00.000Z'},principal}).map(item=>item.document);
 const text=documents.map(document=>document.text??'').join('\n');
 for(const expected of ['Print the probe marker with echo.','The user wants the marker printed.','echo REASON_PROBE_MARKER','REASON_PROBE_MARKER','Done: the command printed the marker.'])assert.ok(text.includes(expected),expected);
 assert.ok(documents.length>0&&documents.every(document=>document.harness==='reason'&&document.sessionId==='session-1'));
 const result=documents.find(document=>document.kind==='tool_result');
 assert.equal(result.toolCallId,'call_probe_1');
 assert.equal(result.nativeId,'10be76f7');
 assert.equal(result.parentId,'26699b3b');
 assert.equal(result.timestamp,'2026-11-16T21:21:13.405Z');
});
