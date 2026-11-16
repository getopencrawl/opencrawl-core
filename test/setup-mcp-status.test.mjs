import {stateFor} from './fixtures/memory-application-state.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createSetupStatus} from '../dist/src/setup/status.mjs';
import {createOpenCrawlMcp} from '../dist/src/mcp/server.mjs';
import {createSessionIngest} from '../dist/src/sessions/ingest.mjs';
import {createSessionSearch} from '../dist/src/sessions/search.mjs';
import {createSessionPipeline} from '../dist/src/sessions/indexer.mjs';
import {createWorkspaceSearch} from '../dist/src/search/workspace.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';

const owner={tenantId:'setup-native',userId:'alice'};
const selection={installationId:'native-machine',client:'codex'};
const observation=(client='codex',extra={})=>({client,installed:false,forward:true,history:'skip',historyProgress:{state:'not_started',completed:0},hookTrust:'pending',...extra});
const registration=clients=>({installationId:selection.installationId,machine:{id:'local-machine',label:'Local machine'},clients});

async function fixture(t,{clients=[observation(),observation('claude-code')],realSearch=false}={}) {
  const store=memorySessionStore(),prefix='native-setup-test';let clock=Date.now(),hits=[],fetches=0,searches=0;
  let search={search:async()=>{searches++;return {results:hits};},fetch:async()=>{fetches++;return hits[0];}};
  let sessions;
  if(realSearch){
    const directory=await mkdtemp(join(tmpdir(),'opencrawl-mcp-setup-'));t.after(()=>rm(directory,{recursive:true,force:true}));
    const endpoint=pathToFileURL(join(directory,'search.sqlite')).href.replace('file:','sqlite:');
    sessions=createSessionSearch({state:stateFor(store),eventIdentities:stateFor(store).eventIdentities,endpoint,store,prefix});search=createWorkspaceSearch({sessions});
  }
  const setup=createSetupStatus({state:stateFor(store),search,now:()=>new Date(clock)});
  await setup.installation(owner,registration(clients));
  const pipeline=sessions?createSessionPipeline({state:stateFor(store),eventIdentities:stateFor(store).eventIdentities,store,prefix,search:sessions,resolvePrincipal:async({batch})=>batch.owner}):null;
  const ingest=pipeline?createSessionIngest({state:stateFor(store),eventIdentities:stateFor(store).eventIdentities,store,prefix,onStored:setup.session,scheduleIndexing:async key=>{await pipeline.processObject({key});await sessions.refresh(owner);}}):null;
  const principals={owner,otherUser:{...owner,userId:'bob'},otherTenant:{...owner,tenantId:'other'},capture:{...owner,captureAccess:'write'}};
  let mcp;const server=createServer((req,res)=>mcp(req,res));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  mcp=createOpenCrawlMcp({origin,setup,authenticate:async req=>principals[req.headers.authorization?.replace('Bearer ','')]??null});
  const connections=[];
  t.after(async()=>{for(const connection of connections)await connection.close();await mcp.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  async function connect(identity='owner'){
    const client=new Client({name:'codex',version:'fixture'});connections.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+identity}}}));
    return client;
  }
  const client=await connect();
  const call=(name,input=selection,connection=client)=>connection.callTool({name,arguments:input});
  const status=async(input=selection)=>{const result=await call('installation_status',input);assert.notEqual(result.isError,true);return result.structuredContent;};
  const batch=(events,extra={})=>({schemaVersion:1,installationId:selection.installationId,sessionId:'native-session',harness:'codex',origin:'cli',captureMode:'live',owner,events,attachments:[],...extra});
  const event=(id,kind,data)=>({id,kind,timestamp:new Date(clock).toISOString(),data});
  return {setup,client,call,status,batch,event,connect,origin,ingest,advance:ms=>{clock+=ms;},get searches(){return searches;},get fetches(){return fetches;},setHits:rows=>{hits=rows;}};
}

test('native MCP begins and checks one client through real ingestion/search/fetch without a networked CLI',async t=>{
  const f=await fixture(t,{realSearch:true});
  const tools=await f.client.listTools();
  assert.deepEqual(tools.tools.find(tool=>tool.name==='installation_status').annotations,{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false});
  const first=await f.status();
  assert.equal(first.installationId,selection.installationId);assert.equal(first.proof.state,'waiting_capture');assert.equal(first.mcp.state,'pending');
  assert.equal(first.installed,false,'server plugin report is not promoted by native MCP');
  assert.equal((await f.status()).proof.id,first.proof.id,'checking reuses the active challenge');
  const proofInput={...selection,proofId:first.proof.id};
  const exchange=await f.call('verify_installation',proofInput);
  assert.ok(exchange.structuredContent.receipt);
  f.advance(1000);
  await f.ingest.putBatch(owner,f.batch([
    f.event('normal-answer','message',{role:'assistant',content:'The result is ready. '+first.proof.marker}),
    f.event('native-call','tool_call',{name:'mcp__opencrawl__verify_installation',call_id:'native-call-id',arguments:JSON.stringify(proofInput)}),
    f.event('native-result','tool_result',{call_id:'native-call-id',output:JSON.stringify(exchange.structuredContent)}),
  ]));
  const checked=await f.status();
  assert.equal(checked.proof.state,'verified');assert.equal(checked.mcp.state,'authenticated');assert.ok(checked.proof.passageId);
  assert.equal(checked.installed,false);assert.equal(checked.forward,true);assert.equal(checked.history,'skip');
  assert.equal(JSON.stringify(checked).includes(exchange.structuredContent.receipt),false,'secret MCP receipt remains absent from status');
  const saved=await f.setup.read(owner);
  assert.equal(saved.firstWin.client,'codex');assert.equal(saved.installations[0].clients[1].proof.state,'pending');
  assert.equal(saved.installations[0].clients[1].mcp.state,'pending');
});

test('native status is owner scoped, rejects capture tokens and never accepts forged scope or evidence',async t=>{
  const f=await fixture(t);
  assert.equal((await fetch(f.origin+'/mcp')).status,401);
  for(const identity of ['otherUser','otherTenant','capture']){
    const client=await f.connect(identity),result=await f.call('installation_status',selection,client);
    assert.equal(result.isError,true,identity);
    assert.equal(JSON.stringify(result).includes('opencrawlverify'),false);
  }
  for(const extra of [{tenantId:'other'},{installed:true},{proofId:'a'.repeat(32)},{forward:true}]){
    assert.equal((await f.call('installation_status',{...selection,...extra})).isError,true);
  }
  assert.equal((await f.call('installation_status',{...selection,installationId:'another-machine'})).isError,true);
  const foreign={...owner,tenantId:'other'};
  await f.setup.installation(foreign,registration([observation()]));
  const foreignClient=await f.connect('otherTenant');
  const foreignProof=(await f.call('installation_status',selection,foreignClient)).structuredContent.proof;
  const own=await f.status();assert.notEqual(own.proof.id,foreignProof.id);
  assert.equal((await f.call('verify_installation',{...selection,proofId:foreignProof.id})).isError,true);
});

test('begin/check and terminal output cannot replace the proof-bearing native MCP call/result',async t=>{
  const f=await fixture(t),first=await f.status();
  assert.equal(first.mcp.state,'pending');assert.equal(f.searches,0);
  assert.equal((await f.call('verify_installation',selection)).isError,true,'proofId stays mandatory');
  assert.equal((await f.call('verify_installation',{...selection,client:'claude-code',proofId:first.proof.id})).isError,true);
  const input={...selection,proofId:first.proof.id},exchange=(await f.call('verify_installation',input)).structuredContent;
  f.advance(1000);
  await f.setup.session(owner,f.batch([
    f.event('normal-answer','message',{role:'assistant',content:first.proof.marker}),
    f.event('terminal','tool_call',{name:'exec_command',call_id:'call-id',arguments:JSON.stringify(input)}),
    f.event('terminal-output','tool_result',{call_id:'call-id',output:JSON.stringify(exchange)}),
    f.event('begin-status','tool_call',{name:'mcp__opencrawl__installation_status',call_id:'call-id',arguments:JSON.stringify(input)}),
  ]));
  let checked=await f.status();assert.equal(checked.mcp.state,'observed');assert.equal(checked.proof.state,'waiting_index');
  assert.equal(JSON.stringify(checked).includes(exchange.receipt),false);
  // Another client/installation/history batch cannot supply the native proof.
  for(const extra of [{harness:'claude-code'},{installationId:'another-machine'},{captureMode:'history'}]){
    await f.setup.session(owner,f.batch([
      f.event('wrong-native-call','tool_call',{name:'mcp__opencrawl__verify_installation',call_id:'call-id',arguments:JSON.stringify(input)}),
      f.event('wrong-native-result','tool_result',{call_id:'call-id',output:JSON.stringify(exchange)}),
    ],extra));
    assert.equal((await f.status()).mcp.state,'observed');
  }
  const wrongEvent={source:'sessions',id:'passage',text:first.proof.marker,provenance:{userId:owner.userId,installationId:selection.installationId,harness:'codex',sessionId:'native-session',eventId:'wrong-event'}};
  f.setHits([wrongEvent]);assert.equal((await f.status()).proof.state,'waiting_index');assert.equal(f.fetches,0);
  f.setHits([{...wrongEvent,provenance:{...wrongEvent.provenance,eventId:'normal-answer'}}]);
  checked=await f.status();assert.equal(checked.proof.state,'verified');assert.equal(checked.mcp.state,'observed','search proof does not promote native MCP evidence');assert.equal(f.fetches,1);
});

test('native status renews expired challenges and preserves search-only choices without capture',async t=>{
  const f=await fixture(t,{clients:[observation('codex',{forward:false,history:'import',historyProgress:{state:'running',completed:3,total:5}})]});
  const before=(await f.setup.read(owner)).installations[0].clients[0],first=await f.status();
  assert.equal(first.proof.state,'not_selected');assert.equal(first.proof.marker,undefined);
  await f.call('verify_installation',{...selection,proofId:first.proof.id});
  let checked=await f.status();assert.equal(checked.mcp.state,'observed');assert.equal(checked.proof.state,'not_selected');assert.equal(f.searches,0);
  for(const field of ['installed','forward','history','historyProgress','hookTrust'])assert.deepEqual(checked[field],before[field]);
  f.advance(60*60_000+1);
  const renewed=await f.status();assert.notEqual(renewed.proof.id,first.proof.id);assert.equal(renewed.mcp.state,'pending');
  assert.equal((await f.call('verify_installation',{...selection,proofId:first.proof.id})).isError,true);
  assert.equal((await f.call('verify_installation',{...selection,proofId:renewed.proof.id})).isError,undefined);
  assert.equal((await f.setup.read(owner)).firstWin,null);
});
