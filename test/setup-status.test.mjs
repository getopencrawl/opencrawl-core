import {memorySetupState} from './fixtures/memory-setup-state.mjs';
import {registerSetupTools} from '../dist/src/setup/mcp.mjs';
const states=new WeakMap();
function stateFor(store){if(!states.has(store))states.set(store,{setup:memorySetupState()});return states.get(store);}
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createSetupStatus} from '../dist/src/setup/status.mjs';
import {createSetupHandler} from '../dist/src/setup/http.mjs';
import {createSessionIngest} from '../dist/src/sessions/ingest.mjs';
import {createSessionSearch} from '../dist/src/sessions/search.mjs';
import {createSessionPipeline} from '../dist/src/sessions/indexer.mjs';
import {createWorkspaceSearch} from '../dist/src/search/workspace.mjs';
import {createOpenCrawlMcp} from '../dist/src/mcp/server.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';

const owner={tenantId:'org_setup',userId:'alice'};
const selection={installationId:'machine-installation',client:'codex'};
const observation=(client='codex',extra={})=>({client,installed:true,forward:true,history:'skip',historyProgress:{state:'not_started',completed:0},hookTrust:'pending',...extra});
const registration=(clients=[observation()])=>({installationId:selection.installationId,machine:{id:'machine',label:'My machine'},clients});
async function fixture() {
  const store=memorySessionStore();let time=Date.parse('2026-11-14T12:00:00Z'),hits=[],fetched,searches=0;
  const search={search:async()=>{searches++;return {results:hits};},fetch:async()=>fetched??hits[0]};
  const setup=createSetupStatus({state:stateFor(store),search,now:()=>new Date(time)});
  await setup.installation(owner,registration([observation(),observation('claude-code')]));
  const proof=(await setup.verify(owner,selection)).proof;time+=1000;
  const batch=(extra={})=>({schemaVersion:1,installationId:selection.installationId,sessionId:'native-session',harness:'codex',origin:'cli',captureMode:'live',owner,events:[{id:'native-message',nativeId:'native-message',kind:'message',timestamp:new Date(time).toISOString(),data:{role:'assistant',content:proof.marker}}],attachments:[],...extra});
  const hit=(extra={})=>({source:'sessions',id:'sessions:passage',text:proof.marker,provenance:{userId:owner.userId,installationId:selection.installationId,harness:'codex',sessionId:'native-session',eventId:'native-message'},...extra});
  return {setup,store,proof,batch,hit,get searches(){return searches;},setHits:v=>{hits=v;},setFetched:v=>{fetched=v;},advance:ms=>{time+=ms;}};
}

test('setup records independent choices and fails closed on scope, capture-only tokens and client-supplied evidence',async()=>{
  const f=await fixture();
  const state=await f.setup.read(owner);assert.equal(state.firstWin,null);assert.equal(state.installations[0].clients[1].proof.state,'pending');
  assert.deepEqual((await f.setup.read({...owner,tenantId:'other'})).installations,[]);
  assert.deepEqual((await f.setup.read({...owner,userId:'bob'})).installations,[]);
  await assert.rejects(f.setup.read({userId:'alice'}),/Authentication/);
  await assert.rejects(f.setup.read({...owner,captureAccess:'write'}),{status:403});
  await assert.rejects(f.setup.installation(owner,{...registration(),tenantId:'foreign'}),{status:400});
  await assert.rejects(f.setup.installation(owner,registration([{...observation(),mcp:{state:'authenticated'}}])),{status:400});
  await assert.rejects(f.setup.installation(owner,registration([observation('codex',{lastSeenAt:new Date().toISOString()})])),{status:400});
  await assert.rejects(f.setup.installation(owner,{...registration(),machine:{id:'different',label:'Changed'}}),{status:409});
  await assert.rejects(f.setup.verify({...owner,userId:'bob'},selection),{status:404});
  const restarted=createSetupStatus({state:stateFor(f.store),search:{search:async()=>({results:[]}),fetch:async()=>null}});
  assert.equal((await restarted.read(owner)).installations[0].installationId,selection.installationId);
});

test('computer contact follows scoped setup reports and live uploads independently of verification', async () => {
  const f = await fixture();
  const other = {...registration(), installationId:'other', machine:{id:'other', label:'My machine'}};
  await f.setup.installation(owner, other);
  const contacts = async () => (await f.setup.read(owner)).installations.map(i => i.updatedAt);
  const initial = await contacts();
  f.advance(2 * 60_000);
  const batch = f.batch({harness:'claude-code', events:[{id:'queued', kind:'hook', timestamp:'2020-01-01T00:00:00Z'}]});
  for (const change of [{captureMode:'history'}, {installationId:'unknown'}, {harness:'devin'}]) {
    await f.setup.session(owner, {...batch, ...change});
  }
  for (const principal of [{...owner, userId:'bob'}, {...owner, tenantId:'other'}]) {
    await f.setup.session(principal, {...batch, owner:principal});
  }
  await f.setup.verify(owner, selection);
  assert.deepEqual(await contacts(), initial);
  await f.setup.session({...owner, captureAccess:'write'}, batch);
  const expected = f.batch().events[0].timestamp;
  assert.deepEqual(await contacts(), [expected, initial[1]]);
  const client = (await f.setup.read(owner)).installations[0].clients.find(c => c.client === 'claude-code');
  assert.equal(client.proof.state, 'pending');
  assert.equal(client.mcp.state, 'pending');
  assert.equal(client.captureObservedAt, undefined);
  assert.equal(client.lastSeenAt, expected);

  const storage = stateFor(f.store).setup;
  const revision = (await storage.read(owner)).version;
  f.advance(30_000);
  await f.setup.session(owner, batch);
  assert.equal((await storage.read(owner)).version, revision);
  f.advance(30_000);
  await f.setup.session(owner, batch);
  assert.deepEqual(await contacts(), [f.batch().events[0].timestamp, initial[1]]);

  await f.setup.installation(owner, registration([observation('claude-code', {forward:false})]));
  const unselected = await contacts();
  f.advance(300_000);
  await f.setup.session(owner, batch);
  assert.deepEqual(await contacts(), unselected);
});

test('live receipts advance only the reporting agent on the reporting computer', async () => {
  const f = await fixture();
  const read = async () => (await f.setup.read(owner)).installations.map(i => i.clients.map(c => c.lastSeenAt));
  await f.setup.installation(owner, {...registration(), installationId:'office', machine:{id:'office', label:'Office'}});
  await f.setup.session(owner, f.batch({captureMode:'history'}));
  assert.deepEqual(await read(), [[undefined, undefined], [undefined]]);
  const codexTime = f.batch().events[0].timestamp;
  await f.setup.session(owner, f.batch({events:[{id:'event',kind:'hook'}]}));
  f.advance(1_000);
  const claudeTime = f.batch().events[0].timestamp;
  await f.setup.session(owner, f.batch({harness:'claude-code'}));
  assert.deepEqual(await read(), [[codexTime, claudeTime], [undefined]]);
  f.advance(60_000);
  await f.setup.installation(owner, registration());
  assert.deepEqual(await read(), [[codexTime, claudeTime], [undefined]], 'host reports do not refresh agents');
  const nextTime = f.batch().events[0].timestamp;
  await Promise.all([
    f.setup.session(owner, f.batch({harness:'claude-code'})),
    f.setup.session(owner, f.batch({installationId:'office'})),
  ]);
  assert.deepEqual(await read(), [[codexTime, nextTime], [nextTime]]);
});

test('older capture receipts supply agent contact before and after a setup change', async () => {
  const f = await fixture();
  await f.setup.session(owner, f.batch());
  const storage = stateFor(f.store).setup;
  const {record,version} = await storage.read(owner);
  const old = record.installations[0].clients[0];
  const seen = old.evidence.capture.observedAt;
  delete old.lastSeenAt;
  assert.equal(await storage.save(owner, version, record), true);
  assert.equal((await f.setup.read(owner)).installations[0].clients[0].lastSeenAt, seen);
  f.advance(3_600_000);
  const updated = await f.setup.installation(owner, registration([observation('codex',{forward:false})]));
  assert.equal(updated.installations[0].clients[0].lastSeenAt, seen);
});

test('Devin setup uses scoped core proof and workload guidance without inventing native MCP evidence',async()=>{
  const f=await fixture(),selected={...selection,client:'devin'};
  await f.setup.installation(owner,registration([observation('devin',{hookTrust:'not_required'})]));
  const proof=(await f.setup.verify(owner,selected)).proof;
  const row=(await f.setup.read(owner)).installations[0].clients.find(client=>client.client==='devin');
  assert.match(row.humanTasks.find(task=>task.kind==='mcp_auth').instruction,/renewable workload identity/);
  await assert.rejects(f.setup.verify({...owner,tenantId:'other'},selected),{status:404});
  await assert.rejects(f.setup.installation({...owner,captureAccess:'write'},registration([observation('devin')])),{status:403});
  const receipt=await f.setup.mcp(owner,{...selected,proofId:proof.id});
  const batch=f.batch({harness:'devin',sessionId:'devin-native-session'});
  batch.events[0].data.content=proof.marker;
  await f.setup.session(owner,batch);
  const hit=f.hit({text:proof.marker,provenance:{userId:owner.userId,installationId:selection.installationId,harness:'devin',sessionId:batch.sessionId,eventId:'native-message'}});
  f.setHits([hit]);f.setFetched(hit);
  assert.equal((await f.setup.verify(owner,selected)).proof.state,'verified');
  assert.equal((await f.setup.verify(owner,selected)).mcp.state,'observed','searchable marker alone is not native MCP correlation');
  await f.setup.session(owner,{...batch,events:[{id:'terminal-result',kind:'tool_result',timestamp:batch.events[0].timestamp,data:{call_id:'terminal',output:JSON.stringify(receipt)}}]});
  assert.equal((await f.setup.verify(owner,selected)).mcp.state,'observed','an unpaired receipt in tool output does not prove a native invocation');
  await f.setup.installation(owner,registration([observation('devin',{forward:false,hookTrust:'not_required'})]));
  assert.equal((await f.setup.verify(owner,selected)).proof.state,'not_selected');
});

test('history, old events, unrelated clients, other installations, hooks and forged ownership never prove capture',async()=>{
  const f=await fixture();
  for(const changed of [
    {captureMode:'history'},{captureMode:undefined},{installationId:'other-installation'},{harness:'claude-code'},{origin:'subagent'},
    {events:[{...f.batch().events[0],timestamp:'2026-11-14T11:59:00Z'}]},
    {events:[{...f.batch().events[0],timestamp:null}]},
    {events:[{...f.batch().events[0],kind:'hook'}]},
    {events:[{...f.batch().events[0],data:{role:'system',content:f.proof.marker}}]},
    {events:[{...f.batch().events[0],data:{role:'assistant',content:[{type:'thinking',thinking:f.proof.marker}]}}]},
    {events:[{...f.batch().events[0],data:{role:'user',content:[{type:'tool_result',tool_use_id:'terminal',content:f.proof.marker}]}}]},
  ])await f.setup.session(owner,f.batch(changed));
  await assert.rejects(f.setup.session({...owner,userId:'bob'},f.batch()),{status:403});
  assert.equal((await f.setup.verify(owner,selection)).proof.state,'waiting_capture');assert.equal(f.searches,0);
});

test('plugin preparation is an optional local observation, separate from activation and server proof',async()=>{
  const f=await fixture();
  assert.equal((await f.setup.read(owner)).pluginStateSupported,true);
  assert.equal((await f.setup.read(owner)).installations[0].clients[0].pluginState,undefined,'old observations remain unclassified');
  await f.setup.installation(owner,registration([observation('codex',{installed:false,pluginState:'prepared'})]));
  let checked=await f.setup.verify(owner,selection);
  assert.equal(checked.installed,false);assert.equal(checked.pluginState,'prepared');assert.equal(checked.proof.state,'waiting_capture');
  assert.equal(checked.mcp.state,'pending');
  await f.setup.session(owner,f.batch());f.setHits([f.hit()]);f.setFetched(f.hit());
  checked=await f.setup.verify(owner,selection);
  assert.equal(checked.proof.state,'verified');assert.equal(checked.installed,false);assert.equal(checked.pluginState,'prepared','server proof never promotes native activation');
  await assert.rejects(f.setup.installation(owner,registration([observation('codex',{pluginState:'verified'})])),{status:400});
  await f.setup.installation(owner,registration([observation()]));
  assert.equal((await f.setup.read(owner)).installations[0].clients[0].pluginState,undefined,'a legacy update does not retain a stale prepared report');
});

test('a new captured event waits for exact authorized search AND fetch; first win verifies only that client',async()=>{
  const f=await fixture();await f.setup.session(owner,f.batch());
  assert.equal((await f.setup.read(owner)).installations[0].updatedAt, f.batch().events[0].timestamp, 'a recorded proof receipt can be newer than the setup report');
  let checked=await f.setup.verify(owner,selection);assert.equal(checked.proof.state,'waiting_index');
  assert.ok(checked.captureObservedAt);assert.equal(checked.hookTrust,'pending');assert.equal(checked.humanTasks.some(t=>t.kind==='hook_trust'),false);
  for(const [key,value] of [['userId','bob'],['installationId','another'],['harness','claude-code'],['sessionId','another'],['eventId','other']]) {
    f.setHits([f.hit({provenance:{...f.hit().provenance,[key]:value}})]);
    assert.equal((await f.setup.verify(owner,selection)).proof.state,'waiting_index',key);
  }
  f.setHits([f.hit()]);f.setFetched(f.hit({text:'unrelated fetched text'}));
  assert.equal((await f.setup.verify(owner,selection)).proof.state,'waiting_index');
  f.setFetched(f.hit());checked=await f.setup.verify(owner,selection);
  assert.equal(checked.proof.state,'verified');assert.equal(checked.mcp.state,'pending');
  const state=await f.setup.read(owner);assert.equal(state.firstWin,null,'searchable capture without native MCP correlation cannot complete setup');assert.equal(state.installations[0].clients[1].proof.state,'pending');
  f.setHits([]);assert.equal((await f.setup.verify(owner,selection)).proof.state,'waiting_index','fresh verification cannot reuse a disappeared passage');
});

test('MCP needs its authenticated proof-specific call plus the selected native client tool result',async()=>{
  const f=await fixture();await f.setup.session(owner,f.batch());
  await assert.rejects(f.setup.mcp({...owner,userId:'bob'},{...selection,proofId:f.proof.id}),{status:404});
  await assert.rejects(f.setup.mcp(owner,{...selection,client:'claude-code',proofId:f.proof.id}),{status:409});
  const result=await f.setup.mcp(owner,{...selection,proofId:f.proof.id});
  let client=(await f.setup.read(owner)).installations[0].clients[0];assert.equal(client.mcp.state,'observed');
  assert.equal(JSON.stringify(await f.setup.read(owner)).includes(result.receipt),false,'MCP receipt is not available to CLI status');
  const event={id:'mcp-result',kind:'tool_result',timestamp:f.batch().events[0].timestamp,data:{call_id:'mcp-call',output:JSON.stringify(result)}};
  await f.setup.session(owner,f.batch({sessionId:'other-session',events:[event]}));
  assert.equal((await f.setup.read(owner)).installations[0].clients[0].mcp.state,'observed');
  await f.setup.session(owner,f.batch({captureMode:'history',events:[event]}));
  assert.equal((await f.setup.read(owner)).installations[0].clients[0].mcp.state,'observed');
  await f.setup.session(owner,f.batch({events:[event]}));
  assert.equal((await f.setup.read(owner)).installations[0].clients[0].mcp.state,'observed','a receipt in terminal output alone does not prove native MCP use');
  await f.setup.session(owner,f.batch({events:[{id:'terminal-call',kind:'tool_call',timestamp:f.batch().events[0].timestamp,data:{name:'exec_command',call_id:'mcp-call',arguments:JSON.stringify({...selection,proofId:f.proof.id})}}]}));
  assert.equal((await f.setup.read(owner)).installations[0].clients[0].mcp.state,'observed');
  await f.setup.session(owner,f.batch({events:[{id:'native-call',kind:'tool_call',timestamp:f.batch().events[0].timestamp,data:{name:'mcp__opencrawl__verify_installation',call_id:'mcp-call',arguments:JSON.stringify({...selection,proofId:f.proof.id})}}]}));
  client=(await f.setup.read(owner)).installations[0].clients[0];assert.equal(client.mcp.state,'authenticated');
  assert.equal(client.proof.state,'waiting_index','MCP auth never stands in for searchable capture');
});

function codexCompletion(f,result) {
  const timestamp=f.batch().events[0].timestamp;
  return {id:'native-completion',kind:'mcp_tool_call_end',timestamp,data:{type:'item_completed',thread_id:'native-session',
    started_at_ms:Date.parse(timestamp)-100,completed_at_ms:Date.parse(timestamp),item:{type:'McpToolCall',id:'exec-native-mcp',
      server:'opencrawl-0123456789ab',tool:'verify_installation',status:'completed',pluginId:'opencrawl-0123456789ab@opencrawl-cli-0123456789ab',
      arguments:{...selection,proofId:f.proof.id},result:{content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result}}}};
}

test('Codex completed native MCP metadata binds its own invocation and result in the selected session',async()=>{
  for(const server of ['opencrawl','opencrawl-0123456789ab']) {
    const f=await fixture(),result=await f.setup.mcp(owner,{...selection,proofId:f.proof.id}),event=codexCompletion(f,result);
    event.data.item.server=server;if(server==='opencrawl')delete event.data.item.pluginId;
    // Native metadata may arrive before the marker; it cannot prove a different session.
    await f.setup.session(owner,f.batch({events:[event]}));
    assert.equal((await f.setup.read(owner)).installations[0].clients[0].mcp.state,'observed');
    await f.setup.session(owner,f.batch());
    const client=(await f.setup.read(owner)).installations[0].clients[0];
    assert.equal(client.mcp.state,'authenticated');assert.equal(client.proof.state,'waiting_index');
  }
});

test('Codex native completion rejects wrong binding, errors, incomplete records and stale or future evidence',async()=>{
  const changes=[
    ['wrong server',e=>e.data.item.server='other-opencrawl'],['wrong tool',e=>e.data.item.tool='search'],
    ['wrong thread',e=>e.data.thread_id='other-session'],['missing thread',e=>delete e.data.thread_id],
    ['wrong proof',e=>e.data.item.arguments.proofId='0'.repeat(32)],['wrong client',e=>e.data.item.arguments.client='claude-code'],
    ['wrong installation',e=>e.data.item.arguments.installationId='other-installation'],
    ['string arguments',e=>e.data.item.arguments=JSON.stringify(e.data.item.arguments)],
    ['incomplete',e=>e.data.item.status='in_progress'],['failed',e=>e.data.item.status='failed'],
    ['native error',e=>e.data.item.error={message:'failed'}],['native isError',e=>e.data.item.isError=true],
    ['MCP error',e=>e.data.item.result.isError=true],['error result',e=>e.data.item.result.error={message:'failed'}],
    ['missing result',e=>delete e.data.item.result],['string result',e=>e.data.item.result=JSON.stringify(e.data.item.result)],
    ['missing id',e=>delete e.data.item.id],['empty id',e=>e.data.item.id=''],['blank id',e=>e.data.item.id=' '],['long id',e=>e.data.item.id='x'.repeat(201)],
    ['wrong native type',e=>e.data.item.type='CommandExecution'],['wrong event type',e=>e.data.type='item_started'],
    ['wrong event kind',e=>e.kind='hook'],['missing timestamp',e=>e.timestamp=null],
    ['stale',e=>e.timestamp='2026-11-14T11:59:00Z'],['before MCP receipt',e=>e.timestamp='2026-11-14T12:00:00.500Z'],['future',e=>e.timestamp='2026-11-14T12:02:00Z'],
    ['wrong nonce',e=>e.data.item.result={content:[{type:'text',text:'not the server receipt'}]}],
  ];
  for(const [label,change] of changes) {
    const f=await fixture();await f.setup.session(owner,f.batch());
    const result=await f.setup.mcp(owner,{...selection,proofId:f.proof.id}),event=codexCompletion(f,result);change(event);
    await f.setup.session(owner,f.batch({events:[event]}));
    assert.equal((await f.setup.read(owner)).installations[0].clients[0].mcp.state,'observed',label);
  }
  for(const changed of [{sessionId:'other-session'},{harness:'claude-code'},{installationId:'another'},{captureMode:'history'}]) {
    const f=await fixture();await f.setup.session(owner,f.batch());
    const result=await f.setup.mcp(owner,{...selection,proofId:f.proof.id}),event=codexCompletion(f,result);
    if(changed.sessionId)event.data.thread_id=changed.sessionId;
    await f.setup.session(owner,f.batch({...changed,events:[event]}));
    assert.equal((await f.setup.read(owner)).installations[0].clients[0].mcp.state,'observed',JSON.stringify(changed));
  }
});

test('rejected Codex completion cannot donate its nonce to a later matching call ID',async()=>{
  const f=await fixture();await f.setup.session(owner,f.batch());
  const result=await f.setup.mcp(owner,{...selection,proofId:f.proof.id}),event=codexCompletion(f,result);
  event.data.item.arguments.client='claude-code';await f.setup.session(owner,f.batch({events:[event]}));
  await f.setup.session(owner,f.batch({events:[{id:'later-call',kind:'tool_call',timestamp:event.timestamp,data:{
    id:event.data.item.id,name:'mcp__opencrawl__verify_installation',input:{...selection,proofId:f.proof.id}}}]}));
  assert.equal((await f.setup.read(owner)).installations[0].clients[0].mcp.state,'observed');
});

test('Claude tool_use-only marker cannot prove capture even when its input is searchable',async()=>{
  const f=await fixture(),selected={...selection,client:'claude-code'},proof=(await f.setup.verify(owner,selected)).proof;
  f.advance(1000);const timestamp=f.batch().events[0].timestamp,eventId='claude-search-call';
  f.setHits([f.hit({text:proof.marker,provenance:{userId:owner.userId,installationId:selection.installationId,harness:'claude-code',sessionId:'native-session',eventId}})]);
  await f.setup.session(owner,f.batch({harness:'claude-code',events:[{id:eventId,kind:'message',timestamp,data:{role:'assistant',content:[
    {type:'tool_use',id:'native-search',name:'mcp__opencrawl__search',input:{query:proof.marker}},
  ]}}]}));
  const checked=await f.setup.verify(owner,selected);
  assert.equal(checked.proof.state,'waiting_capture');assert.equal(checked.captureObservedAt,undefined);
  assert.equal(f.searches,0,'indexed tool input cannot bypass the conversational capture requirement');
  assert.equal((await f.setup.read(owner)).firstWin,null);
});

test('Claude native tool_use and tool_result blocks bind MCP without treating terminal output as authentication',async()=>{
  const f=await fixture(),selected={...selection,client:'claude-code'},proof=(await f.setup.verify(owner,selected)).proof;
  f.advance(1000);const timestamp=f.batch().events[0].timestamp;
  await f.setup.session(owner,f.batch({harness:'claude-code',events:[{id:'claude-message',kind:'message',timestamp,data:{role:'assistant',content:[{type:'text',text:proof.marker}]}}]}));
  const result=await f.setup.mcp(owner,{...selected,proofId:proof.id});
  await f.setup.session(owner,f.batch({harness:'claude-code',events:[
    {id:'claude-call',kind:'message',timestamp,data:{role:'assistant',content:[{type:'tool_use',id:'claude-tool',name:'mcp__opencrawl__verify_installation',input:{...selected,proofId:proof.id}}]}},
    {id:'claude-result',kind:'message',timestamp,data:{role:'user',content:[{type:'tool_result',tool_use_id:'claude-tool',content:JSON.stringify(result)}]}},
  ]}));
  assert.equal((await f.setup.read(owner)).installations[0].clients[1].mcp.state,'authenticated');
});

async function devinFixture() {
  const f=await fixture(),selected={...selection,client:'devin'};
  await f.setup.installation(owner,registration([observation('devin')]));
  const proof=(await f.setup.verify(owner,selected)).proof;f.advance(100);
  const result=await f.setup.mcp(owner,{...selected,proofId:proof.id});f.advance(100);
  const timestamp=f.batch().events[0].timestamp,callId='devin-hook:completed-proof';
  // Cloud records mcp_call_tool; the provider's tool_args is JSON inside the wrapper.
  const call={id:'devin-call',kind:'tool_call',nativeId:null,sequence:100,timestamp,
    data:{type:'tool_use',name:'mcp_call_tool',call_id:callId,input:{server:'opencrawl-012345abcdef',tool_name:'verify_installation',tool_args:JSON.stringify({...selected,proofId:proof.id})}}};
  const output={id:'devin-result',kind:'tool_result',nativeId:null,sequence:101,timestamp,
    data:{type:'tool_result',name:call.data.name,call_id:callId,is_error:false,output:JSON.stringify(result)}};
  const ingest=(events,extra={})=>f.setup.session(owner,f.batch({harness:'devin',events,...extra}));
  const read=async()=>(await f.setup.read(owner)).installations[0].clients.find(c=>c.client==='devin');
  await ingest([{id:'devin-message',kind:'message',timestamp,data:{role:'assistant',content:proof.marker}}]);
  return {...f,selected,proof,call,output,ingest,read};
}

test('Devin completed MCP wrapper binds its JSON arguments and native receipt without inventing search proof',async()=>{
  for(const nativeId of [null,'provider-native-id'])for(const encoded of [true,false]) {
    const f=await devinFixture();f.call.nativeId=f.output.nativeId=nativeId;
    if(!encoded)f.output.data.output=JSON.parse(f.output.data.output);
    await f.ingest([f.call,f.output]);assert.equal((await f.read()).mcp.state,'authenticated');
    assert.equal((await f.read()).proof.state,'waiting_index');
    await f.ingest([f.call,f.output]);assert.equal((await f.read()).mcp.state,'authenticated');
  }
});

test('Devin rejects failed, unrelated or incomplete MCP wrapper pairs without donating a receipt',async()=>{
  const changes=[
    ['wrong server',f=>{f.call.data.input.server='other-opencrawl';}],
    ['wrong tool',f=>{f.call.data.input.tool_name='installation_status';}],
    ['malformed arguments',f=>{f.call.data.input.tool_args='{';}],
    ['oversized arguments',f=>{f.call.data.input.tool_args=' '.repeat(8193)+f.call.data.input.tool_args;}],
    ...['proofId','installationId','client'].map(key=>['wrong '+key,f=>{const input=JSON.parse(f.call.data.input.tool_args);input[key]='other';f.call.data.input.tool_args=JSON.stringify(input);}]),
    ['native failure',f=>{f.output.data.is_error=true;}],
    ['MCP error',f=>{f.output.data.output=JSON.stringify({...JSON.parse(f.output.data.output),isError:true});}],
    ['transport error',f=>{f.output.data.output={error:f.output.data.output};}],
    ['mismatched call',f=>{f.output.data.call_id='other';}],
    ['mismatched native ID',f=>{f.output.nativeId='other';}],
    ['non-adjacent sequence',f=>{f.output.sequence++;}],
    ['different timestamp',f=>{f.output.timestamp='2026-11-14T12:00:00Z';}],
    ['different result name',f=>{f.output.data.name='exec';}],
    ['missing call',f=>{f.call.kind='hook';}],
    ['wrong receipt',f=>{f.output.data.output='{}';}],
  ];
  for(const [name,change] of changes){
    const f=await devinFixture(),validCall=structuredClone(f.call),validOutput=structuredClone(f.output);change(f);
    await f.ingest([f.call,f.output]);assert.equal((await f.read()).mcp.state,'observed',name);
    await f.ingest([validCall]);await f.ingest([validOutput]);
    assert.equal((await f.read()).mcp.state,'observed',name+' cannot donate either half');
  }
  for(const extra of [{captureMode:'history'},{sessionId:'other-session'},{installationId:'other-installation'}]){
    const f=await devinFixture();await f.ingest([f.call,f.output],extra);assert.equal((await f.read()).mcp.state,'observed');
  }
  const f=await devinFixture();await f.ingest([f.call,structuredClone(f.call),f.output]);assert.equal((await f.read()).mcp.state,'observed');
});

async function cursorFixture() {
  const f=await fixture(),selected={...selection,client:'cursor'};
  await f.setup.installation(owner,registration([observation('cursor')]));
  const proof=(await f.setup.verify(owner,selected)).proof;f.advance(100);
  const result=await f.setup.mcp(owner,{...selected,proofId:proof.id});f.advance(100);
  const timestamp=f.batch().events[0].timestamp,callId='native-cursor-mcp';
  // Actual Cursor postToolUse creates both events in one batch. Its MCP name
  // omits the server namespace, but native IDs, arguments and result survive.
  const call={id:'cursor-call',kind:'tool_call',nativeId:callId,sequence:100,timestamp,
    data:{type:'tool_use',name:'MCP:verify_installation',call_id:callId,input:{...selected,proofId:proof.id}}};
  const output={id:'cursor-result',kind:'tool_result',nativeId:callId,sequence:101,timestamp,
    data:{type:'tool_result',name:call.data.name,call_id:callId,output:{content:[{type:'text',text:JSON.stringify(result)}],isError:false}}};
  const ingest=(events,extra={})=>f.setup.session(owner,f.batch({harness:'cursor',events,...extra}));
  const read=async()=>(await f.setup.read(owner)).installations[0].clients.find(c=>c.client==='cursor');
  await ingest([{id:'cursor-message',kind:'message',timestamp,data:{role:'assistant',content:proof.marker}}]);
  return {...f,selected,proof,call,output,ingest,read};
}

test('Cursor completed MCP hook pair binds exact native call, success envelope and proof without a server name',async()=>{
  const f=await cursorFixture();await f.ingest([f.call,f.output]);
  assert.equal((await f.read()).mcp.state,'authenticated');
  assert.equal((await f.read()).proof.state,'waiting_index','MCP correlation does not substitute for search');
  await f.ingest([f.call,f.output]);assert.equal((await f.read()).mcp.state,'authenticated','replay remains idempotent');
  const domain=await cursorFixture();
  domain.output.data.output.content.push({type:'text',text:JSON.stringify({error:'returned domain data',isError:true})});
  await domain.ingest([domain.call,domain.output]);
  assert.equal((await domain.read()).mcp.state,'authenticated','returned domain text is not native failure metadata');
});

test('Cursor rejects failed, incomplete, mismatched and non-native completion pairs without donating either half',async()=>{
  const changes=[
    ['ordinary tool',f=>{f.call.data.name=f.output.data.name='verify_installation';}],
    ['shell wrapper',f=>{f.call.data.name=f.output.data.name='Shell';}],
    ['another MCP tool',f=>{f.call.data.name=f.output.data.name='MCP:installation_status';}],
    ['different result name',f=>{f.output.data.name='MCP:other';}],
    ['wrong proof',f=>{f.call.data.input.proofId='0'.repeat(32);}],
    ['wrong client',f=>{f.call.data.input.client='codex';}],
    ['wrong installation',f=>{f.call.data.input.installationId='other';}],
    ['wrong call id',f=>{f.output.data.call_id='other';}],
    ['missing call id',f=>{delete f.call.data.call_id;}],
    ['blank native id',f=>{f.call.data.call_id=f.output.data.call_id=f.call.nativeId=f.output.nativeId=' ';}],
    ['missing native id',f=>{delete f.call.nativeId;}],
    ['mismatched native id',f=>{f.output.nativeId='other';}],
    ['non-adjacent sequence',f=>{f.output.sequence++;}],
    ['missing sequence',f=>{delete f.call.sequence;}],
    ['negative sequence',f=>{f.call.sequence=-2;f.output.sequence=-1;}],
    ['different timestamp',f=>{f.call.timestamp='2026-11-14T12:00:00Z';}],
    ['wrong event kind',f=>{f.call.kind='message';}],
    ['native failure',f=>{f.output.data.is_error=true;}],
    ['native camel-case failure',f=>{f.output.data.isError=true;}],
    ['failed call',f=>{f.call.data.is_error=true;}],
    ['MCP failure with echoed receipt',f=>{f.output.data.output.isError=true;}],
    ['failed transport with echoed receipt',f=>{f.output.data.output={error:f.output.data.output.content[0].text};}],
    ['no MCP envelope',f=>{f.output.data.output=f.output.data.output.content[0].text;}],
    ['wrong receipt',f=>{f.output.data.output.content[0].text='not the native receipt';}],
    ['stale pair',f=>{f.call.timestamp=f.output.timestamp='2026-11-14T11:59:00Z';}],
    ['future pair',f=>{f.call.timestamp=f.output.timestamp='2026-11-14T12:02:00Z';}],
  ];
  for(const [name,change] of changes){
    const f=await cursorFixture(),validCall=structuredClone(f.call),validOutput=structuredClone(f.output);change(f);
    await f.ingest([f.call,f.output]);assert.equal((await f.read()).mcp.state,'observed',name);
    await f.ingest([validCall]);await f.ingest([validOutput]);
    assert.equal((await f.read()).mcp.state,'observed',name+' cannot donate a half to a separate incomplete event');
  }
  for(const extra of [{captureMode:'history'},{sessionId:'other-session'},{installationId:'other-installation'},{harness:'codex'},{harness:'claude-code'},{harness:'grok-bot'}]){
    const f=await cursorFixture();await f.ingest([f.call,f.output],extra);assert.equal((await f.read()).mcp.state,'observed',JSON.stringify(extra));
  }
  const f=await cursorFixture();await f.ingest([f.call,structuredClone(f.call),f.output]);
  assert.equal((await f.read()).mcp.state,'observed','ambiguous native call pair');
});

test('generic native results with explicit failure flags cannot authenticate an echoed receipt',async()=>{
  for(const flags of [{is_error:true},{isError:true},{mcpEnvelopeError:true}]) {
    const f=await fixture();await f.setup.session(owner,f.batch());
    const result=await f.setup.mcp(owner,{...selection,proofId:f.proof.id}),timestamp=f.batch().events[0].timestamp;
    await f.setup.session(owner,f.batch({events:[
      {id:'native-call',kind:'tool_call',timestamp,data:{name:'mcp__opencrawl__verify_installation',call_id:'native-call',input:{...selection,proofId:f.proof.id}}},
      {id:'failed-result',kind:'tool_result',timestamp,data:{type:'tool_result',call_id:'native-call',
        ...(flags.mcpEnvelopeError?{output:{content:[{type:'text',text:JSON.stringify(result)}],isError:true}}:{output:JSON.stringify(result),...flags})}},
    ]}));
    assert.equal((await f.setup.read(owner)).installations[0].clients[0].mcp.state,'observed');
  }
});

async function agyFixture({compact=false,server='opencrawl_opencrawl'}={}) {
  const f=await fixture(),selected={...selection,client:'antigravity'};
  await f.setup.installation(owner,registration([observation('antigravity')]));
  const proof=(await f.setup.verify(owner,selected)).proof,input={...selected,proofId:proof.id};
  const started=f.batch().events[0].timestamp;f.advance(100);
  const result=await f.setup.mcp(owner,input);f.advance(100);
  const completed=f.batch().events[0].timestamp;
  const wrapper={ServerName:server,ToolName:'verify_installation',Arguments:input};
  const hook={id:'agy-completed-step',kind:'hook',timestamp:completed,data:{hookEventName:'PostToolUse',conversationId:'native-session',stepIdx:4,toolCall:{name:'call_mcp_tool',args:compact?Object.fromEntries(Object.entries(wrapper).map(([k,v])=>[k,JSON.stringify(v)])):wrapper}}};
  const output={id:'agy-native-result',kind:'tool_result',sequence:4,nativeId:'4',timestamp:started,data:{type:'tool_result',output:JSON.stringify(result)}};
  const ingest=(events,extra={})=>f.setup.session(owner,f.batch({harness:'antigravity',events,...extra}));
  const read=async()=>(await f.setup.read(owner)).installations[0].clients.find(c=>c.client==='antigravity');
  await ingest([{id:'agy-message',kind:'message',timestamp:completed,data:{role:'assistant',content:proof.marker}}]);
  return {...f,selected,proof,hook,output,ingest,read};
}

test('Antigravity binds its completed MCP wrapper to the exact native result step across batches',async()=>{
  for(const compact of [false,true])for(const order of ['result-first','hook-first']){
    const f=await agyFixture({compact,server:compact?'opencrawl-012345abcdef_opencrawl':'opencrawl_opencrawl'});
    const pair=order==='result-first'?[f.output,f.hook]:[f.hook,f.output];
    await f.ingest([pair[0]]);assert.equal((await f.read()).mcp.state,'observed');
    await f.ingest([pair[1]]);assert.equal((await f.read()).mcp.state,'authenticated');
    assert.equal((await f.read()).proof.state,'waiting_index','native MCP binding does not invent search proof');
    await f.ingest(pair);assert.equal((await f.read()).mcp.state,'authenticated','replay stays idempotent');
    assert.equal(JSON.stringify(await f.read()).includes('opencrawlmcp'),false);
  }
});

test('Antigravity rejects unrelated steps, wrappers, sessions, stale timestamps and non-native evidence',async()=>{
  const cases=[
    ['adjacent result',(f)=>{f.output.sequence=5;f.output.nativeId='5';}],
    ['missing native ID',(f)=>{delete f.output.nativeId;}],
    ['different native ID',(f)=>{f.output.nativeId='04';}],
    ['negative step',(f)=>{f.hook.data.stepIdx=-1;}],
    ['fractional step',(f)=>{f.hook.data.stepIdx=4.5;}],
    ['wrong native conversation',(f)=>{f.hook.data.conversationId='other-native';}],
    ['before tool execution',(f)=>{f.hook.data.hookEventName='PreToolUse';}],
    ['terminal call',(f)=>{f.hook.data.toolCall.name='run_command';}],
    ['unrelated MCP server',(f)=>{f.hook.data.toolCall.args.ServerName='unrelated';}],
    ['different MCP tool',(f)=>{f.hook.data.toolCall.args.ToolName='installation_status';}],
    ['other proof',(f)=>{f.hook.data.toolCall.args.Arguments.proofId='0'.repeat(32);}],
    ['wrong result nonce',(f)=>{f.output.data.output='opencrawlmcp'+'0'.repeat(32);}],
    ['hook before receipt',(f)=>{f.hook.timestamp=f.output.timestamp;}],
    ['result before challenge',(f)=>{f.output.timestamp='2026-11-14T11:59:59Z';}],
    ['hook error',(f)=>{f.hook.data.error='Native tool failed';}],
    ['result error',(f)=>{f.output.data.is_error=true;}],
    ['oversized encoded arguments',(f)=>{f.hook.data.toolCall.args.Arguments=' '.repeat(8193)+JSON.stringify(f.hook.data.toolCall.args.Arguments);}],
  ];
  for(const [name,change] of cases){
    const f=await agyFixture();change(f);await f.ingest([f.output,f.hook]);
    assert.equal((await f.read()).mcp.state,'observed',name);
  }
  for(const extra of [{captureMode:'history'},{captureMode:undefined},{sessionId:'other-native'},{installationId:'other-installation'},{harness:'codex'}]){
    const f=await agyFixture();await f.ingest([f.output,f.hook],extra);
    assert.equal((await f.read()).mcp.state,'observed',JSON.stringify(extra));
  }
});

test('Antigravity cannot join the same step across sessions or use another session for this marker',async()=>{
  for(const wholePair of [false,true]){
    const f=await agyFixture();
    const otherHook={...f.hook,data:{...f.hook.data,conversationId:'other-native'}};
    if(wholePair)await f.ingest([otherHook,f.output],{sessionId:'other-native'});
    else {
      await f.ingest([f.hook]);
      await f.ingest([f.output],{sessionId:'other-native'});
    }
    assert.equal((await f.read()).mcp.state,'observed',wholePair?'other session pair cannot verify marker session':'step IDs remain session-scoped');
    await f.ingest([f.hook,f.output]);
    assert.equal((await f.read()).mcp.state,'authenticated');
  }
});

test('search-only and history-only clients can observe MCP without enabling capture or claiming native proof',async()=>{
  const f=await fixture();
  for(const history of ['skip','import']) {
    await f.setup.installation(owner,registration([observation('codex',{forward:false,history})]));
    const checked=await f.setup.verify(owner,selection);assert.equal(checked.proof.state,'not_selected');assert.ok(checked.proof.id);assert.equal(checked.proof.marker,undefined);
    await f.setup.mcp(owner,{...selection,proofId:checked.proof.id});
    const client=(await f.setup.read(owner)).installations[0].clients[0];assert.equal(client.forward,false);assert.equal(client.history,history);assert.equal(client.mcp.state,'observed');
    assert.equal(client.lastSeenAt, undefined, 'an uncorroborated MCP receipt cannot identify the active agent');
    assert.deepEqual(client.humanTasks,[]);assert.equal((await f.setup.read(owner)).firstWin,null);
  }
});

test('disabling and re-enabling forward capture resets its server boundary; expired proofs cannot be reused',async()=>{
  const f=await fixture();f.advance(61*60_000);
  await assert.rejects(f.setup.mcp(owner,{...selection,proofId:f.proof.id}),{status:409});
  const newProof=(await f.setup.verify(owner,selection)).proof;assert.notEqual(newProof.id,f.proof.id);
  await f.setup.installation(owner,registration([observation('codex',{forward:false})]));
  await f.setup.installation(owner,registration([observation()]));
  const current=await f.setup.verify(owner,selection);assert.notEqual(current.proof.id,newProof.id);
  await f.setup.session(owner,f.batch());assert.equal((await f.setup.verify(owner,selection)).proof.state,'waiting_capture');
});

test('concurrent local progress updates preserve independent server capture evidence',async()=>{
  const f=await fixture();
  await Promise.all([f.setup.session(owner,f.batch()),f.setup.installation(owner,registration([observation('codex',{history:'import',historyProgress:{state:'running',completed:7}})]))]);
  const client=(await f.setup.read(owner)).installations[0].clients[0];assert.equal(client.proof.state,'waiting_index');assert.equal(client.historyProgress.completed,7);
});

test('plugin choice is independent: unknown-origin native evidence still needs live mode, exact owner and fresh proof',async()=>{
  const f=await fixture();await f.setup.installation(owner,registration([observation('codex',{installed:false})]));
  await assert.rejects(f.setup.session({...owner,userId:'bob'},f.batch({origin:'unknown'})),{status:403});
  await f.setup.session(owner,f.batch({origin:'unknown',captureMode:'history'}));
  await f.setup.session(owner,f.batch({origin:'unknown',installationId:'another-installation'}));
  await f.setup.session(owner,f.batch({origin:'unknown',events:[{...f.batch().events[0],timestamp:'2026-11-14T11:00:00Z'}]}));
  assert.equal((await f.setup.verify(owner,selection)).proof.state,'waiting_capture');
  await f.setup.session(owner,f.batch({origin:'unknown'}));f.setHits([f.hit()]);
  const result=await f.setup.verify(owner,selection);assert.equal(result.installed,false);assert.equal(result.proof.state,'verified');assert.equal(result.mcp.state,'pending');
  await assert.rejects(f.setup.mcp({...owner,userId:'bob'},{...selection,proofId:result.proof.id}),{status:404});
  await f.setup.mcp(owner,{...selection,proofId:result.proof.id});
  assert.equal((await f.setup.read(owner)).installations[0].clients[0].mcp.state,'observed','the call still needs its native call/result correlation');
});

test('portable setup HTTP authenticates scope, rejects browser writes and does not echo credentials',async t=>{
  const f=await fixture();
  let calls=0,changeAt=Infinity;
  const handler=createSetupHandler({setup:f.setup,authenticate:async req=>{calls++;return calls>=changeAt?{...owner,tenantId:'foreign'}:req.headers.authorization==='Bearer test-secret'?owner:null;}});
  const server=createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const url='http://127.0.0.1:'+server.address().port,headers={authorization:'Bearer test-secret','content-type':'application/json'};
  assert.equal((await fetch(url+'/api/setup')).status,401);
  assert.equal((await fetch(url+'/api/setup?tenantId=other',{headers})).status,400);
  assert.equal((await fetch(url+'/api/setup/verify',{method:'POST',headers:{...headers,origin:url},body:JSON.stringify(selection)})).status,403);
  const read=await(await fetch(url+'/api/setup',{headers})).json();assert.equal(read.data.scope.userId,'alice');assert.equal(JSON.stringify(read).includes('test-secret'),false);
  const verified=await(await fetch(url+'/api/setup/verify',{method:'POST',headers,body:JSON.stringify(selection)})).json();assert.equal(verified.data.proof.state,'waiting_capture');
  changeAt=calls+2;
  assert.equal((await fetch(url+'/api/setup',{headers})).status,403,'a scope change during the read withholds private setup status');
});

for(const harness of ['codex','devin'])test(`self-contained ${harness} ingestion → SQLite search/fetch → authenticated MCP result capture proves one client`,async t=>{
  const sessionId='real-native-session',selection={installationId:'machine-installation',client:harness};
  const owner={tenantId:'org_setup',userId:harness==='devin'?'workload_devin_test':'alice',...(harness==='devin'?{owner:{kind:'shared',provider:'devin',organizationId:'org-11111111111141118111111111111111',sessionId}}:{})};
  const directory=await mkdtemp(join(tmpdir(),'opencrawl-setup-proof-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const endpoint=pathToFileURL(join(directory,'search.sqlite')).href.replace('file:','sqlite:'),store=memorySessionStore(),prefix='sessions/setup';
  const sessions=createSessionSearch({state:stateFor(store),eventIdentities:stateFor(store).eventIdentities,endpoint,store,prefix}),search=createWorkspaceSearch({sessions});
  const setup=createSetupStatus({state:stateFor(store),search}),pipeline=createSessionPipeline({state:stateFor(store),eventIdentities:stateFor(store).eventIdentities,store,prefix,search:sessions,resolvePrincipal:async({batch})=>batch.owner});
  const ingest=createSessionIngest({state:stateFor(store),eventIdentities:stateFor(store).eventIdentities,store,prefix,onStored:setup.session,scheduleIndexing:async key=>{await pipeline.processObject({key});await sessions.refresh(owner);}});
  await setup.installation(owner,registration([observation(harness)]));const proof=(await setup.verify(owner,selection)).proof;
  const native={schemaVersion:1,installationId:selection.installationId,sessionId,harness,origin:'cli',captureMode:'live',owner,events:[{id:'native-answer',kind:'message',timestamp:new Date().toISOString(),data:{role:'assistant',content:`The requested result is ready. ${proof.marker}`}}],attachments:[]};
  await ingest.putBatch(owner,native);
  const markerSearch={query:proof.marker,source:'sessions',match:'all',currentSession:{harness,sessionId}};
  assert.equal((await search.search(owner,markerSearch)).results.length,0,'ordinary search excludes its known current chat');
  assert.ok((await search.search(owner,{...markerSearch,includeCurrentSession:true})).results.length);
  assert.equal((await setup.verify(owner,selection)).proof.state,'verified','internal exact provenance verification is not an ordinary current-chat search');
  let mcp;const server=createServer((req,res)=>mcp(req,res));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  mcp=createOpenCrawlMcp({origin,registerTools:(server,principal)=>registerSetupTools(server,principal,setup),search,authenticate:async req=>req.headers.authorization==='Bearer local-test'?owner:null});
  const client=new Client({name:harness,version:'test'});
  t.after(async()=>{await client.close();await mcp.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{authorization:'Bearer local-test'}}}));
  await client.callTool({name:'test_connection',arguments:{}});assert.equal((await setup.read(owner)).installations[0].clients[0].mcp.state,'pending');
  const result=await client.callTool({name:'verify_installation',arguments:{...selection,proofId:proof.id}});assert.ok(result.structuredContent.receipt);
  const completedAt=new Date().toISOString(),input={...selection,proofId:proof.id},name=harness==='devin'?'mcp_call_tool':'mcp__opencrawl__verify_installation';
  await ingest.putBatch(owner,{...native,events:[
    {id:'native-mcp-call',kind:'tool_call',sequence:100,nativeId:null,timestamp:completedAt,data:{type:'tool_use',name,call_id:'native-call',input:harness==='devin'?{server:'opencrawl-012345abcdef',tool_name:'verify_installation',tool_args:JSON.stringify(input)}:input}},
    {id:'native-mcp-result',kind:'tool_result',sequence:101,nativeId:null,timestamp:completedAt,data:{type:'tool_result',name,call_id:'native-call',output:JSON.stringify(result.structuredContent)}},
  ]});
  const receiptSearch={query:result.structuredContent.receipt,source:'sessions',match:'all'};
  assert.equal((await search.search(owner,receiptSearch)).results.length,0,'ordinary search still excludes tool-result receipts');
  assert.ok((await search.search(owner,{...receiptSearch,includeToolOutputs:true,includeCurrentSession:true})).results.length);
  const checked=await setup.verify(owner,selection);assert.equal(checked.proof.state,'verified');assert.equal(checked.mcp.state,'authenticated','native receipt attribution uses the scoped captured batch, not broader search defaults');
  assert.equal((await setup.read({...owner,tenantId:'foreign'})).firstWin,null);
});
