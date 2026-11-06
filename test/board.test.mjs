import {test} from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBoard} from '../src/board/board.mjs';
import {createLocalBoardStore} from '../src/board/local-store.mjs';
import {createObjectStore} from '../src/sessions/s3-store.mjs';

const a = {tenantId: 'a', userId: 'alice'}, b = {tenantId: 'b', userId: 'bob'};
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'board-test-'));
  let store = createLocalBoardStore(join(dir, 'board.sqlite'));
  t.after(async () => {store.close(); await rm(dir, {recursive: true, force: true});});
  let time = 10000000;
  const make = () => createBoard({store, prefix: 'test', now: () => time});
  return {store, make, later: () => {time += 16 * 60 * 1000;}, restart: () => {store.close(); store = createLocalBoardStore(join(dir, 'board.sqlite')); return make();}};
}
const post = (id, text = 'Taking auth refresh') => ({id, topic: 'auth', text});

test('read-only browsing is scoped, paginated newest first and never changes the stored board', async t => {
  const f = await fixture(t), board = f.make();
  assert.deepEqual(await board.read(a), {topics: [], messages: [], next: null});
  for (let i = 1; i <= 25; i++) await board.sync(a, {workspace: a.tenantId, agent: 'codex', posts: [post(String(i))]});
  await board.sync(a, {workspace: a.tenantId, agent: 'codex', posts: [{id: 'other', topic: 'deploy', text: '<script>alert(1)</script>\nPlain text'}]});
  await board.sync(b, {workspace: b.tenantId, agent: 'codex', posts: [post('1', 'Other tenant secret')]});
  const key = 'test/tenants/' + createHash('sha256').update(a.tenantId).digest('hex') + '.json';
  const before = await f.store.readVersion(key);
  const first = await board.read({...a, userId: 'teammate'});
  assert.deepEqual(first.topics, ['auth', 'deploy']);
  assert.deepEqual(first.messages.map(m => m.id), Array.from({length: 20}, (_, i) => 26 - i));
  assert.equal(first.next, 7);
  assert.ok(first.messages.every(m => !('requestId' in m) && m.author === 'alice'));
  // A concurrent append cannot shift or duplicate older pages.
  await board.sync(a, {workspace: a.tenantId, agent: 'codex', posts: [post('new')]});
  const stored = await f.store.readVersion(key);
  const second = await board.read(a, {before: first.next});
  assert.deepEqual(second.messages.map(m => m.id), [6, 5, 4, 3, 2, 1]);
  assert.equal(second.next, null);
  const filtered = await board.read(a, {topic: 'auth'});
  assert.ok(filtered.messages.every(m => m.topic === 'auth'));
  const tail = await board.read(a, {topic: 'auth', before: filtered.next});
  assert.deepEqual([...filtered.messages, ...tail.messages].map(m => m.id), [27, ...Array.from({length: 25}, (_, i) => 25 - i)]);
  assert.deepEqual((await board.read(a, {topic: 'missing'})).messages, []);
  assert.equal((await board.read(b)).messages[0].text, 'Other tenant secret');
  assert.deepEqual(await f.store.readVersion(key), stored);
  assert.notDeepEqual(before, stored); // Only the explicit sync above changed storage.
  for (const principal of [{}, {tenantId: 'a'}, {...a, captureAccess: 'read'}, {...a, captureAccess: null}]) {
    await assert.rejects(board.read(principal), {status: 403});
  }
  for (const input of [{workspace: 'b'}, {tenantId: 'b'}, {posts: []}, {before: 0}, {before: 1.1}, {topic: ''}]) {
    await assert.rejects(board.read(a, input));
  }
});

test('durable scope, authenticated authors, retries and presence expiration', async t => {
  const f = await fixture(t), board = f.make();
  await assert.rejects(board.sync({}, {workspace: a.tenantId, agent: 'codex'}), /scope/);
  await assert.rejects(board.sync(a, {workspace: a.tenantId, agent: 'codex', tenantId: 'b'}));
  const first = await board.sync(a, {workspace: a.tenantId, agent: 'codex', topics: ['auth'], posts: [post('1')]});
  assert.deepEqual(first.accepted, [1]);
  assert.deepEqual((await board.sync(a, {workspace: a.tenantId, agent: 'codex', posts: [post('1')]})).accepted, [1]);
  await assert.rejects(board.sync(a, {workspace: a.tenantId, agent: 'codex', posts: [post('1', 'Changed')]}), /different content/);
  assert.deepEqual((await board.topics(b)).topics, []);
  await assert.rejects(board.sync(a, {workspace: b.tenantId, agent: 'forged'}), /scope mismatch/);
  assert.deepEqual((await board.sync(b, {workspace: b.tenantId, agent: 'codex', topics: ['auth'], after: 0})).messages, []);
  const other = await board.sync({...a, userId: 'other'}, {workspace: a.tenantId, agent: 'codex', topics: ['auth'], after: 0});
  assert.notEqual(other.agent, first.agent);
  assert.equal(other.messages[0].text, 'Taking auth refresh');
  assert.equal((await f.restart().sync(a, {workspace: a.tenantId, agent: 'reader', topics: ['auth'], after: 0})).messages.length, 1);
  assert.ok((await f.make().topics(a)).topics[0].active.length);
  f.later();
  assert.deepEqual((await f.make().topics(a)).topics[0].active, []);
});

test('concurrent clients do not lose writes; bounded deltas eventually deliver each message once', async t => {
  const f = await fixture(t), boards = Array.from({length: 6}, () => f.make());
  await Promise.all(boards.map((board, i) => board.sync(a, {workspace: a.tenantId, agent: 'writer-' + i, posts: [post(String(i), 'x'.repeat(512))]})));
  const board = f.make(); let cursor = 0, found = [];
  for (let i = 0; i < 10; i++) {
    const result = await board.sync(a, {workspace: a.tenantId, agent: 'reader', topics: ['auth'], after: cursor});
    assert.ok(result.messages.length <= 5);
    assert.ok(Buffer.byteLength(JSON.stringify(result.messages)) < 4200);
    found.push(...result.messages.map(m => m.id)); cursor = result.cursor;
    if (!result.more) break;
  }
  assert.deepEqual(found, [1,2,3,4,5,6]);
  assert.deepEqual((await board.sync(a, {workspace: a.tenantId, agent: 'reader', topics: ['auth'], after: cursor})).messages, []);
  assert.deepEqual((await board.sync(a, {workspace: a.tenantId, agent: 'fresh-reader', topics: ['auth']})).messages, []);
  await assert.rejects(board.sync(a, {workspace: a.tenantId, agent: 'reader', after: 100}), /Cursor/);
});

test('S3 CAS signs the expected condition, rejects collisions and bounds reads', async () => {
  const calls = []; let conflict = false;
  const store = createObjectStore({bucket: 'test', credentials: {accessKeyId: 'test', secretAccessKey: 'test'}, fetch: async (url, options) => {
    calls.push(options);
    if (options.method === 'GET') return new Response('{}', {headers: {etag: '"v1"'}});
    return conflict ? new Response('', {status: 412}) : new Response('', {status: 200});
  }});
  const doc = await store.readVersion('board'); assert.equal(doc.version, '"v1"');
  assert.equal(await store.compareAndSet('board', null, Buffer.from('{}')), true);
  assert.equal(calls.at(-1).headers['if-none-match'], '*');
  conflict = true;
  assert.equal(await store.compareAndSet('board', doc.version, Buffer.from('{}')), false);
  assert.equal(calls.at(-1).headers['if-match'], '"v1"');
  await assert.rejects(store.readVersion('board', {maxBytes: 1}), /read limit/);
});

test('a default sync cursor keeps messages that arrive during a conditional-write retry', async t => {
  const f = await fixture(t); let raced = false;
  const board = createBoard({prefix: 'test', store: {...f.store, compareAndSet: async (...args) => {
    if (!raced) {
      raced = true;
      await f.make().sync({...a, userId: 'concurrent'}, {workspace: a.tenantId, agent: 'writer', posts: [post('during-sync')]});
    }
    return f.store.compareAndSet(...args);
  }}});
  const result = await board.sync(a, {workspace: a.tenantId, agent: 'reader', topics: ['auth']});
  assert.deepEqual(result.messages.map(m => m.id), [1]);
  assert.equal(result.cursor, 1);
  assert.equal(result.more, false);
});

test('real MCP clients exchange scoped messages and revoked credentials cannot read', async t => {
  const {createServer} = await import('node:http');
  const {Client, StreamableHTTPClientTransport} = await import('@modelcontextprotocol/client');
  const {createOpenCrawlMcp} = await import('../src/mcp/server.mjs');
  const f = await fixture(t); let handler, revoked = false;
  const server = createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  handler = createOpenCrawlMcp({origin, board: f.make(), authenticate: async req => {
    if (revoked) return null;
    return req.headers.authorization === 'Bearer other-tenant' ? b : a;
  }});
  t.after(async () => {await handler.close(); await new Promise(resolve => server.close(resolve));});
  const clients = [];
  for (const token of ['alice', 'other-tenant']) {
    const client = new Client({name: 'board-test', version: '1'});
    await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {requestInit: {headers: {authorization: 'Bearer ' + token}}}));
    clients.push(client); t.after(() => client.close());
  }
  assert.ok((await clients[0].listTools()).tools.some(t => t.name === 'board_sync'));
  const call = async (client, name, args) => {
    const result = await client.callTool({name, arguments: args});
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  await call(clients[0], 'board_sync', {workspace: a.tenantId, agent: 'codex', posts: [post('mcp')]});
  assert.equal((await call(clients[0], 'board_sync', {workspace: a.tenantId, agent: 'claude', topics: ['auth'], after: 0})).messages.length, 1);
  assert.deepEqual((await call(clients[1], 'board_topics', {})).topics, []);
  revoked = true;
  await assert.rejects(call(clients[0], 'board_topics', {}));
});


test('existing boards keep posting, retrying and reading after message 10000', async t => {
  const f=await fixture(t), key='test/tenants/'+createHash('sha256').update(a.tenantId).digest('hex')+'.json';
  const messages=Array.from({length:10000},(_,i)=>({id:i+1,timestamp:i,agent:'seed',author:'alice',name:'seed',topic:'auth',text:'retained history',requestId:String(i)}));
  assert.ok(await f.store.compareAndSet(key,null,Buffer.from(JSON.stringify({schema:1,messages,agents:{},usage:{calls:0,inputBytes:0,outputBytes:0}}))));
  const args={workspace:a.tenantId,agent:'writer',posts:[post('beyond','Message beyond the old cap')]};
  assert.deepEqual((await f.make().sync(a,args)).accepted,[10001]);
  assert.deepEqual((await f.restart().sync(a,args)).accepted,[10001]);
  const read=await f.make().sync(a,{workspace:a.tenantId,agent:'reader',topics:['auth'],after:9999});
  assert.deepEqual(read.messages.map(m=>m.id),[10000,10001]);
  assert.equal(read.messages[1].text,'Message beyond the old cap');assert.equal(read.more,false);
  assert.deepEqual((await f.make().sync(a,{...args,posts:[post('next')]})).accepted,[10002]);
});
