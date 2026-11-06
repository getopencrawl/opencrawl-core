import {test} from 'node:test';
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
  return {make, later: () => {time += 16 * 60 * 1000;}, restart: () => {store.close(); store = createLocalBoardStore(join(dir, 'board.sqlite')); return make();}};
}
const post = (id, text = 'Taking auth refresh') => ({id, topic: 'auth', text});

test('durable scope, authenticated authors, retries and presence expiration', async t => {
  const f = await fixture(t), board = f.make();
  await assert.rejects(board.sync({}, {agent: 'codex'}), /scope/);
  await assert.rejects(board.sync(a, {agent: 'codex', tenantId: 'b'}));
  const first = await board.sync(a, {agent: 'codex', topics: ['auth'], posts: [post('1')]});
  assert.deepEqual(first.accepted, [1]);
  assert.deepEqual((await board.sync(a, {agent: 'codex', posts: [post('1')]})).accepted, [1]);
  await assert.rejects(board.sync(a, {agent: 'codex', posts: [post('1', 'Changed')]}), /different content/);
  assert.deepEqual((await board.topics(b)).topics, []);
  assert.deepEqual((await board.sync(b, {agent: 'codex', topics: ['auth'], after: 0})).messages, []);
  const other = await board.sync({...a, userId: 'other'}, {agent: 'codex', topics: ['auth'], after: 0});
  assert.notEqual(other.agent, first.agent);
  assert.equal(other.messages[0].text, 'Taking auth refresh');
  assert.equal((await f.restart().sync(a, {agent: 'reader', topics: ['auth'], after: 0})).messages.length, 1);
  assert.ok((await f.make().topics(a)).topics[0].active.length);
  f.later();
  assert.deepEqual((await f.make().topics(a)).topics[0].active, []);
});

test('concurrent clients do not lose writes; bounded deltas eventually deliver each message once', async t => {
  const f = await fixture(t), boards = Array.from({length: 6}, () => f.make());
  await Promise.all(boards.map((board, i) => board.sync(a, {agent: 'writer-' + i, posts: [post(String(i), 'x'.repeat(512))]})));
  const board = f.make(); let cursor = 0, found = [];
  for (let i = 0; i < 10; i++) {
    const result = await board.sync(a, {agent: 'reader', topics: ['auth'], after: cursor});
    assert.ok(result.messages.length <= 5);
    assert.ok(Buffer.byteLength(JSON.stringify(result.messages)) < 4200);
    found.push(...result.messages.map(m => m.id)); cursor = result.cursor;
    if (!result.more) break;
  }
  assert.deepEqual(found, [1,2,3,4,5,6]);
  assert.deepEqual((await board.sync(a, {agent: 'reader', topics: ['auth'], after: cursor})).messages, []);
  assert.deepEqual((await board.sync(a, {agent: 'fresh-reader', topics: ['auth']})).messages, []);
  await assert.rejects(board.sync(a, {agent: 'reader', after: 100}), /Cursor/);
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
  await call(clients[0], 'board_sync', {agent: 'codex', posts: [post('mcp')]});
  assert.equal((await call(clients[0], 'board_sync', {agent: 'claude', topics: ['auth'], after: 0})).messages.length, 1);
  assert.deepEqual((await call(clients[1], 'board_topics', {})).topics, []);
  revoked = true;
  await assert.rejects(call(clients[0], 'board_topics', {}));
});
