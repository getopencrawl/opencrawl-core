import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createOpenCrawlMcp} from '../dist/src/mcp/server.mjs';
import {standaloneMcp} from '../dist/src/mcp/standalone.mjs';
import {z} from 'zod';

test('runtime tools use the authenticated principal across concurrent requests', async t => {
  let handler, principalOutsideRequest;
  const server = createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  handler = createOpenCrawlMcp({origin, authenticate: req => {
    const userId = /^Bearer ([ab])$/.exec(req.headers.authorization || '')?.[1];
    return userId ? {userId, tenantId: 'tenant_' + userId} : null;
  }, registerTools(server, principal) {
    principalOutsideRequest = principal;
    server.registerTool('local_report', {inputSchema: z.strictObject({text: z.string()})}, async () => {
      const before = principal();
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.deepEqual(principal(), before);
      return {content: [{type: 'text', text: JSON.stringify(before)}]};
    });
  }});
  t.after(async () => {await handler.close(); await new Promise(resolve => server.close(resolve));});
  const clients = await Promise.all(['a', 'b'].map(async user => {
    const client = new Client({name: 'local', version: '1'});
    await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {requestInit: {headers: {authorization: 'Bearer ' + user}}}));
    t.after(() => client.close());
    return client;
  }));
  const reports = await Promise.all(clients.map(client => client.callTool({name: 'local_report', arguments: {text: 'example'}})));
  assert.deepEqual(reports.map(result => JSON.parse(result.content[0].text)), [{userId: 'a', tenantId: 'tenant_a'}, {userId: 'b', tenantId: 'tenant_b'}]);
  assert.throws(principalOutsideRequest, /Missing authenticated principal/);
  assert.equal((await clients[0].callTool({name: 'local_report', arguments: {text: 'example', tenantId: 'tenant_b'}})).isError, true);
  assert.equal((await fetch(origin + '/mcp')).status, 401);
});

test('MCP serves exactly two tools without skills or resources through real SDK clients', async t => {
  let handler;
  const server = createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  handler = createOpenCrawlMcp({origin, revision: 'test-revision', authenticate: async req => req.headers.authorization === 'Bearer local-secret' ? {userId: 'local'} : null});
  t.after(async () => {await handler.close(); await new Promise(resolve => server.close(resolve));});
  for (const mode of ['legacy', 'auto']) {
    const client = new Client({name: 'core-test', version: '1'}, {versionNegotiation: {mode}});
    await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {requestInit: {headers: {authorization: 'Bearer local-secret'}}}));
    try {
      assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['opencrawl', 'test_connection']);
      const result = await client.callTool({name: 'test_connection', arguments: {}});
      assert.equal(result.structuredContent.connected, true);
      assert.equal(result.structuredContent.revision, 'test-revision');
      assert.ok(Date.now() - Date.parse(result.structuredContent.serverTime) < 5000);
      const overview = await client.callTool({name: 'opencrawl', arguments: {}});
      assert.equal(overview.isError, undefined);
      assert.match(overview.content[0].text, /# OpenCrawl/);
      assert.match(overview.content[0].text, /expose captured sessions/);
      assert.equal((await client.callTool({name: 'opencrawl', arguments: {query: 'private data'}})).isError, true);
      const capabilities = client.getServerCapabilities();
      assert.equal(capabilities.resources, undefined);
      assert.equal(capabilities.extensions?.['io.modelcontextprotocol/skills'], undefined);
      await assert.rejects(client.readResource({uri: 'skill://opencrawl/SKILL.md'}));
      assert.equal((await client.callTool({name: 'test_connection', arguments: {url: 'https://untrusted.test'}})).isError, true);
    } finally {await client.close();}
  }
  assert.equal((await fetch(origin + '/mcp')).status, 401);
  assert.equal((await fetch(origin + '/mcp', {headers: {origin: 'https://evil.test', authorization: 'Bearer local-secret'}})).status, 403);
  const post = body => fetch(origin + '/mcp', {method: 'POST', headers: {authorization: 'Bearer local-secret', 'content-type': 'application/json', accept: 'application/json, text/event-stream'}, body});
  assert.equal((await post('x'.repeat(65537))).status, 413);
  assert.equal((await post('{')).status, 400);
});

test('standalone adapter requires a secret and rejects anonymous and forged hosts', async t => {
  assert.throws(() => standaloneMcp({origin: 'http://127.0.0.1'}), /MCP_TOKEN/);
  const server = standaloneMcp({token: 'a'.repeat(32), origin: 'http://127.0.0.1:8093'});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  assert.equal((await fetch(url)).status, 403);
  const status = headers => new Promise((resolve, reject) => {
    const req = request(url, {headers}, res => {res.resume();resolve(res.statusCode);});req.on('error', reject);req.end();
  });
  assert.equal(await status({host: '127.0.0.1:8093'}), 401);
  assert.equal(await status({host: '127.0.0.1:8093', authorization: 'Bearer ' + 'a'.repeat(32)}), 405);
});

test('receipt failures preserve committed tool results and resource denials', async t => {
  let handler, applied = 0, denied = false, sinkMode = 'throw'; const observations = [], errors = [];
  const principal = {tenantId:'tenant',userId:'user'};
  const server = createServer((req,res)=>handler(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  handler=createOpenCrawlMcp({origin,authenticate:async req=>req.headers.authorization==='Bearer test'?principal:null,
    board:{topics:async()=>({workspace:'tenant'}),sync:async who=>{
      assert.deepEqual(who,principal);
      if(denied)throw Object.assign(new Error('Resource access denied'),{status:403});
      return {applied:++applied};
    }},onAuthenticated:async(who,_info,exchange)=>{
      assert.deepEqual(who,principal);observations.push(exchange);
      if(exchange.method==='tools/call')throw new Error('sensitive storage detail');
    },onObservationError:event=>{errors.push(event);if(sinkMode==='throw')throw new Error('sink failed');return Promise.reject(new Error('sink rejected'));},
  });
  t.after(async()=>{await handler.close();await new Promise(resolve=>server.close(resolve));});
  const client=new Client({name:'test',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{authorization:'Bearer test'}}}));
  t.after(()=>client.close());
  for(const mode of ['throw','reject']){
    sinkMode=mode;
    const result=await client.callTool({name:'board_sync',arguments:{workspace:'tenant',agent:'agent'}});
    assert.equal(result.isError,undefined);
    assert.deepEqual(JSON.parse(result.content[0].text),{applied:mode==='throw'?1:2});
  }
  assert.equal(applied,2);
  denied=true;
  const rejection=await client.callTool({name:'board_sync',arguments:{workspace:'tenant',agent:'agent'}});
  assert.equal(rejection.isError,true);assert.match(rejection.content[0].text,/Resource access denied/);
  const observed=observations.length;
  assert.equal((await fetch(origin+'/mcp')).status,401);
  assert.equal(observations.length,observed);assert.equal(applied,2);
  assert.deepEqual(errors,Array.from({length:3},()=>({event:'mcp.observation_failed',method:'tools/call',tool:'board_sync',reason:'error'})));
});

test('a hung receipt is bounded and its late rejection cannot change the tool result', async t => {
  let handler, applied=0, rejectReceipt; const errors=[];
  const server=createServer((req,res)=>handler(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  handler=createOpenCrawlMcp({origin,observationTimeoutMs:15,authenticate:async()=>({tenantId:'tenant',userId:'user'}),
    board:{topics:async()=>({workspace:'tenant'}),sync:async()=>({applied:++applied})},
    onAuthenticated:async(_who,_info,exchange)=>{if(exchange.method==='tools/call')await new Promise((_,reject)=>{rejectReceipt=reject;});},
    onObservationError:event=>{errors.push(event);return new Promise(()=>{});},
  });
  t.after(async()=>{await handler.close();await new Promise(resolve=>server.close(resolve));});
  const client=new Client({name:'test',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp')));t.after(()=>client.close());
  let deadline;
  try {
    const result=await Promise.race([
      client.callTool({name:'board_sync',arguments:{workspace:'tenant',agent:'agent'}}),
      new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('MCP result blocked by observer')),1000);}),
    ]);
    assert.deepEqual(JSON.parse(result.content[0].text),{applied:1});assert.equal(applied,1);
    assert.deepEqual(errors,[{event:'mcp.observation_failed',method:'tools/call',tool:'board_sync',reason:'timeout'}]);
    rejectReceipt(new Error('late storage failure'));
    await new Promise(resolve=>setImmediate(resolve));
  } finally {clearTimeout(deadline);}
});
