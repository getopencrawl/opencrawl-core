import {withTestState} from './fixtures/memory-application-state.mjs';
import {memorySessionStore as deletionTestStore} from './session-store-fixture.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {standaloneMcp} from '../dist/tools/test-fixtures/mcp.mjs';
import {createWorkspaceSearch} from '../dist/src/search/workspace.mjs';
import {createOpenCrawlMcp} from '../dist/src/mcp/server.mjs';

const principal = {tenantId: 'team-a', userId: 'alice'};
const hit = (id, extra = {}) => ({id, tenantId: 'team-a', userId: 'bob', sessionId: 'past', text: 'evidence', ...extra});
test('unified ranks, scoped live pages, cursor binding/expiry, validation, and explicit partial coverage', async () => {
  let now = 1000, calls = 0, revoked = false;
  const service = createWorkspaceSearch({now: () => now,
    sessions: {search: async (p, q) => {calls++; assert.deepEqual(p, principal);assert.equal(q.limit, 100);assert.equal(q.match, 'any');return {total: 103, hits: [hit('s1'), hit('s2')]};}},
    connectors: {search: async () => {if (revoked) throw Object.assign(new Error('denied'), {status: 403});return {hits: [hit('c1', {provider: 'notion', sourceId: 'page'})], truncated: false};}},
  });
  const input = {query: 'evidence', limit: 1}, first = await service.search(principal, input);
  assert.deepEqual(first.results.map(r => r.id), ['sessions:s1']);assert.ok(first.next);assert.equal(first.truncated, true);
  assert.equal(first.results[0].provenance.userId, 'bob');assert.equal(first.results[0].tenantId, undefined);
  const second = await service.search(principal, {...input, cursor: first.next});assert.equal(second.results[0].id, 'connectors:c1');assert.equal(calls, 2);
  const third = await service.search(principal, {...input, cursor: second.next});assert.equal(third.next, null);assert.equal(third.windowExhausted, true);
  for (const changed of [{query:'other'}, {source:'sessions'}, {limit:2}]) await assert.rejects(service.search(principal, {...input, ...changed, cursor:first.next}), /cursor/);
  await assert.rejects(service.search({...principal,userId:'eve'}, {...input,cursor:first.next}), /cursor/);
  await assert.rejects(service.search({...principal,tenantId:'team-b'}, {...input,cursor:first.next}), /cursor/);
  await assert.rejects(service.search(principal, {...input,cursor:first.next+'x'}), /cursor/);
  revoked = true;await assert.rejects(service.search(principal,{...input,cursor:first.next}), /denied/);revoked=false;
  now += 300001;await assert.rejects(service.search(principal,{...input,cursor:first.next}), /cursor/);
  await assert.rejects(service.search(null,input), /Authentication/);
  await assert.rejects(service.search({...principal,captureAccess:'write'},input), /credentials/);
  for (const invalid of [{query:''},{query:'x',tenantId:'b'},{query:'x',raw:true},{query:'x',sessionId:'s'},{query:'x',limit:41}]) await assert.rejects(service.search(principal,invalid), /Invalid search/);
  const partial = await createWorkspaceSearch({sessions:{search:async()=>({total:1,hits:[hit('s')]})},connectors:{search:async()=>{throw new Error('PRIVATE_SECRET');}}}).search(principal,input);
  assert.equal(partial.partial,true);assert.equal(partial.coverage[1].state,'unavailable');assert.doesNotMatch(JSON.stringify(partial),/PRIVATE_SECRET/);
  const bad = createWorkspaceSearch({sessions:{search:async()=>({total:1,hits:[hit('leak',{tenantId:'team-b'})]})}});
  await assert.rejects(bad.search(principal,input), /scope/);
});

test('real MCP and HTTP expose the same operation and reject forged scope, origin and capture credentials', async t => {
  const search=createWorkspaceSearch({sessions:{search:async()=>({total:1,hits:[hit('s')]})}});
  // Port 0 is used to reserve the listener, then origin is fixed before requests.
  const {createServer}=await import('node:http');const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const origin=`http://127.0.0.1:${port}`, token='local-search-token-'.repeat(3);
  const server=standaloneMcp({origin,token,principal,search});await new Promise(r=>server.listen(port,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const headers={authorization:'Bearer '+token,'content-type':'application/json'};
  assert.equal((await fetch(origin+'/api/search',{method:'POST',body:'{}'})).status,401);
  assert.equal((await fetch(origin+'/api/search',{method:'POST',headers:{...headers,origin:'https://evil.test'},body:'{}'})).status,403);
  assert.equal((await fetch(origin+'/api/search',{method:'POST',headers,body:JSON.stringify({query:'x',tenantId:'team-b'})})).status,400);
  const http=await (await fetch(origin+'/api/search',{method:'POST',headers,body:JSON.stringify({query:'evidence'})})).json();
  const client=new Client({name:'workspace-search-test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers}}));t.after(()=>client.close());
  const searchTools=(await client.listTools()).tools;
  // Directory scans use display titles as names, so aliases must remain distinct.
  assert.equal(new Set(searchTools.map(tool=>tool.title ?? tool.name)).size,searchTools.length);
  assert.ok(searchTools.some(t=>t.name==='search'));
  const preferred=searchTools.find(t=>t.name==='opencrawl_search_v1');
  assert.ok(preferred);assert.match(preferred.description,/includeToolOutputs=true/);assert.match(preferred.description,/currentSessionStatus=unavailable/);
  assert.ok((await client.listTools()).tools.some(t=>t.name==='fetch'));
  const mcp=await client.callTool({name:'search',arguments:{query:'evidence'}});assert.deepEqual(mcp.structuredContent,http.data);
  assert.deepEqual((await client.callTool({name:'opencrawl_search',arguments:{query:'evidence'}})).structuredContent,http.data);
  assert.deepEqual((await client.callTool({name:'opencrawl_search_v1',arguments:{query:'evidence'}})).structuredContent,http.data);
  assert.equal((await client.callTool({name:'search',arguments:{query:'x',index:'*'}})).isError,true);
  assert.equal(http.data.results[0].provenance.userId,'bob');
  const input={id:http.data.results[0].id,length:3};
  const fetched=await (await fetch(origin+'/api/search/fetch',{method:'POST',headers,body:JSON.stringify(input)})).json();
  assert.equal(fetched.data.text,'evi');assert.equal(fetched.data.nextOffset,3);
  assert.deepEqual((await client.callTool({name:'fetch',arguments:input})).structuredContent,fetched.data);
  assert.equal((await fetch(origin+'/api/search/fetch',{method:'POST',body:JSON.stringify(input)})).status,401);
  assert.equal((await fetch(origin+'/api/search/fetch',{method:'POST',headers:{...headers,origin:'https://evil.test'},body:JSON.stringify(input)})).status,403);
});

test('native search aliases share schemas, context options, authorized cursors and operation accounting', async t => {
  const aliases=['opencrawl_search_v1','opencrawl_search','search'];
  let handler, activePrincipal=principal, adapterCalls=0;
  const accounting=[], observations=[];
  const operation=createWorkspaceSearch({now:()=>1000,sessions:{search:async(who,input)=>{
    adapterCalls++;assert.deepEqual(who,principal);
    assert.deepEqual(input.currentSession,{harness:'codex',sessionId:'current'});
    assert.equal(input.includeCurrentSession,true);assert.equal(input.includeToolOutputs,true);
    return {total:2,hits:[hit('s1',{text:'first evidence',containsToolOutput:false}),hit('s2',{text:'second evidence',containsToolOutput:false})]};
  }}});
  const server=createServer((req,res)=>handler(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  handler=createOpenCrawlMcp({origin,authenticate:req=>req.headers.authorization==='Bearer local-alias-test'?activePrincipal:null,
    search:{...operation,search:async(who,input)=>{
      const result=await operation.search(who,input);
      // Runtime accounting wraps this same operation regardless of MCP alias.
      accounting.push({who,query:input.query,results:result.results.length});return result;
    }},onAuthenticated:(who,_info,exchange)=>{if(exchange.method==='tools/call')observations.push({who,tool:exchange.tool});},
  });
  t.after(async()=>{await handler.close();await new Promise(resolve=>server.close(resolve));});
  const client=new Client({name:'native-alias-test',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{authorization:'Bearer local-alias-test'}}}));
  t.after(()=>client.close());
  const tools=(await client.listTools()).tools, preferred=tools.find(tool=>tool.name===aliases[0]);
  assert.ok(preferred);assert.match(preferred.description,/native client hooks attach currentSession/);
  assert.match(preferred.description,/includeCurrentSession=true/);assert.match(preferred.description,/includeToolOutputs=true/);
  assert.match(preferred.description,/currentSessionStatus=unavailable/);
  for(const name of aliases){
    const tool=tools.find(tool=>tool.name===name);assert.ok(tool);
    assert.deepEqual(tool.inputSchema,preferred.inputSchema);assert.deepEqual(tool.annotations,preferred.annotations);
  }
  // Reserving this raw name prevents AGY's flattened manual/plugin collision.
  assert.equal(tools.some(tool=>tool.name==='search_v1'),false);
  const input={query:'evidence',source:'sessions',limit:1,dedupe:false,groupBy:'none',
    currentSession:{harness:'codex',sessionId:'current'},includeCurrentSession:true,includeToolOutputs:true};
  const first=[];
  for(const name of aliases){const result=await client.callTool({name,arguments:input});assert.equal(result.isError,undefined);first.push(result.structuredContent);}
  assert.ok(first[0].next);assert.deepEqual(first[1],first[0]);assert.deepEqual(first[2],first[0]);
  assert.equal(first[0].searchContext.currentSessionStatus,'included');assert.equal(first[0].searchContext.toolOutputsIncluded,true);
  const second=[];
  for(const name of aliases){const result=await client.callTool({name,arguments:{...input,cursor:first[0].next}});assert.equal(result.isError,undefined);second.push(result.structuredContent);}
  assert.deepEqual(second[1],second[0]);assert.deepEqual(second[2],second[0]);assert.equal(second[0].next,null);
  assert.notEqual(second[0].results[0].id,first[0].results[0].id);
  assert.equal(adapterCalls,6);assert.deepEqual(accounting,Array.from({length:6},()=>({who:principal,query:'evidence',results:1})));
  assert.deepEqual(observations,aliases.concat(aliases).map(tool=>({who:principal,tool})));
  for(const name of aliases)assert.equal((await client.callTool({name,arguments:{...input,tenantId:'team-b'}})).isError,true);
  await assert.rejects(client.callTool({name:'search_v1',arguments:input}),/Tool search_v1 not found/);
  activePrincipal={...principal,userId:'eve'};
  for(const name of aliases)assert.equal((await client.callTool({name,arguments:{...input,cursor:first[0].next}})).isError,true);
  activePrincipal={...principal,captureAccess:'write'};
  for(const name of aliases)assert.equal((await client.callTool({name,arguments:input})).isError,true);
  activePrincipal={userId:'alice'};
  for(const name of aliases)assert.equal((await client.callTool({name,arguments:input})).isError,true);
  const observed=observations.length;
  for(const name of aliases){
    const response=await fetch(origin+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:input}})});
    assert.equal(response.status,401);await response.text();
  }
  assert.equal(adapterCalls,6);assert.equal(accounting.length,6);assert.equal(observations.length,observed);
});

test('partial OpenSearch shard responses cannot masquerade as complete searches', async () => {
  const {createSessionSearch}=await import('../dist/src/sessions/search.mjs');
  const {createConnectorSearch}=await import('../dist/src/connectors/search.mjs');
  const binding={tenantId:'team-a',connectionId:'c',workspaceId:'w',provider:'notion',access:'workspace-global',rawPrefix:'raw/v1/source=notion/workspace=w/connection=c/'};
  for (const flags of [{timed_out:true},{_shards:{failed:1}}]) {
    const fetch=async()=>Response.json({...flags,hits:{total:{value:0},hits:[]}});
    const sessions=createSessionSearch(withTestState({store:deletionTestStore(),prefix:"capture-v1",endpoint:'http://localhost:9200',index:'test',fetch}));
    const connectors=createConnectorSearch({endpoint:'http://localhost:9200',index:'test',tenantId:'team-a',fetch});
    await assert.rejects(sessions.search(principal,{query:'x'}),/incomplete/);
    await assert.rejects(connectors.search(principal,[binding],{query:'x'}),/incomplete/);
    const result=await createWorkspaceSearch({sessions}).search(principal,{query:'x'});
    assert.equal(result.partial,true);assert.equal(result.coverage[0].state,'unavailable');
  }
});
