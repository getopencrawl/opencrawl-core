import {memorySessionStore as deletionTestStore} from './session-store-fixture.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {standaloneMcp} from '../dist/tools/test-fixtures/mcp.mjs';
import {createWorkspaceSearch} from '../dist/src/search/workspace.mjs';

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
  assert.ok((await client.listTools()).tools.some(t=>t.name==='search'));
  assert.ok((await client.listTools()).tools.some(t=>t.name==='fetch'));
  const mcp=await client.callTool({name:'search',arguments:{query:'evidence'}});assert.deepEqual(mcp.structuredContent,http.data);
  assert.equal((await client.callTool({name:'search',arguments:{query:'x',index:'*'}})).isError,true);
  assert.equal(http.data.results[0].provenance.userId,'bob');
  const input={id:http.data.results[0].id,length:3};
  const fetched=await (await fetch(origin+'/api/search/fetch',{method:'POST',headers,body:JSON.stringify(input)})).json();
  assert.equal(fetched.data.text,'evi');assert.equal(fetched.data.nextOffset,3);
  assert.deepEqual((await client.callTool({name:'fetch',arguments:input})).structuredContent,fetched.data);
  assert.equal((await fetch(origin+'/api/search/fetch',{method:'POST',body:JSON.stringify(input)})).status,401);
  assert.equal((await fetch(origin+'/api/search/fetch',{method:'POST',headers:{...headers,origin:'https://evil.test'},body:JSON.stringify(input)})).status,403);
});

test('partial OpenSearch shard responses cannot masquerade as complete searches', async () => {
  const {createSessionSearch}=await import('../dist/src/sessions/search.mjs');
  const {createConnectorSearch}=await import('../dist/src/connectors/search.mjs');
  const binding={tenantId:'team-a',connectionId:'c',workspaceId:'w',provider:'notion',access:'workspace-global',rawPrefix:'raw/v1/source=notion/workspace=w/connection=c/'};
  for (const flags of [{timed_out:true},{_shards:{failed:1}}]) {
    const fetch=async()=>Response.json({...flags,hits:{total:{value:0},hits:[]}});
    const sessions=createSessionSearch({store:deletionTestStore(),prefix:"capture-v1",endpoint:'http://localhost:9200',index:'test',fetch});
    const connectors=createConnectorSearch({endpoint:'http://localhost:9200',index:'test',tenantId:'team-a',fetch});
    await assert.rejects(sessions.search(principal,{query:'x'}),/incomplete/);
    await assert.rejects(connectors.search(principal,[binding],{query:'x'}),/incomplete/);
    const result=await createWorkspaceSearch({sessions}).search(principal,{query:'x'});
    assert.equal(result.partial,true);assert.equal(result.coverage[0].state,'unavailable');
  }
});
