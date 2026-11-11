import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createRealm} from '../dist/src/search/realm.mjs';
import {createSessionSearch, searchSettings} from '../dist/src/sessions/search.mjs';
import {createSessionIngest} from '../dist/src/sessions/ingest.mjs';
import {createSessionPipeline} from '../dist/src/sessions/indexer.mjs';
import {createSessionLibrary} from '../dist/src/sessions/library.mjs';
import {createRecentSessions} from '../dist/src/sessions/recent.mjs';
import {createConnectorSearch} from '../dist/src/connectors/search.mjs';
import {documentId} from '../dist/src/connectors/scope.mjs';
import {createBoardSearch} from '../dist/src/board/search.mjs';
import {createWorkspaceSearch} from '../dist/src/search/workspace.mjs';
import {createOpenCrawlMcp} from '../dist/src/mcp/server.mjs';
import {createControls} from '../dist/src/sessions/controls.mjs';
import {selfhostSettings} from '../dist/src/selfhost/settings.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'opencrawl-sqlite-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const path = join(directory, 'search.sqlite'), endpoint = pathToFileURL(path).href.replace('file:', 'sqlite:');
  const principal = {tenantId: 'org_sqlite', userId: 'alice'};
  return {directory, path, endpoint, principal};
}

test('SQLite persists across factories, isolates colliding tenants and rejects unknown operations/files', async t => {
  const {path, endpoint, principal} = await fixture(t);
  const realm = createRealm({endpoint, tenantId: principal.tenantId});
  await realm.ensureIndex();
  const documents = realm.collection('session');
  await documents.bulk(principal, [{id: 'same', document: {...principal, text: 'retained evidence', sequence: 1}}]);
  const reopened = createRealm({endpoint: '  ' + endpoint.replace('sqlite:', 'SQLITE:') + '  ', tenantId: principal.tenantId});
  assert.equal((await reopened.collection('session').mget(principal, ['same'])).docs[0]._source.text, 'retained evidence');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const foreign = {...principal, tenantId: 'other'};
  await createRealm({endpoint, tenantId: foreign.tenantId}).collection('session').bulk(foreign, [{id: 'same', document: {...foreign, text: 'foreign secret'}}]);
  assert.equal((await documents.search(principal, {})).hits.total.value, 1);
  await assert.rejects(createRealm({endpoint, tenantId: foreign.tenantId, index: realm.index}).ensureIndex(), /tenant mismatch/);
  for (const query of [{query_string: {query: '*'}}, {bool: {filter: [{term: {'session.userId': 'alice'}}], surprise: true}}, {term: {"session.userId') OR 1=1 --": 'alice'}}]) {
    await assert.rejects(documents.search(principal, {query}), /Unsupported/);
  }
  await assert.rejects(documents.search(principal, {timeout: '0ms'}), /exceeded timeout/);
  await assert.rejects(documents.search(principal, {timeout: 'invalid'}), /Unsupported/);
  await assert.rejects(documents.bulk(principal, [{id: 'new', document: {...principal, text: 'must roll back'}}, {id: 'same', document: {...principal, userId: 'bob'}, policy: 'session'}]));
  assert.equal((await documents.mget(principal, ['new'])).docs[0].found, false);
  const unrelated = path + '.unrelated';
  const db = new DatabaseSync(unrelated); db.exec('CREATE TABLE private_data(value TEXT)'); db.close();
  await assert.rejects(createRealm({endpoint: pathToFileURL(unrelated).href.replace('file:', 'sqlite:'), tenantId: principal.tenantId}).ensureIndex(), /Not an OpenCrawl/);
});

test('SQLite keeps the actual MCP search/fetch interface, controls and connector revocation', async t => {
  const {endpoint, principal} = await fixture(t), peer = {...principal, userId: 'bob'};
  const store = memorySessionStore(), prefix = 'capture-v1', sessions = createSessionSearch({endpoint, store, prefix});
  const ingest = createSessionIngest({store, prefix});
  for (const owner of [peer, {...peer, tenantId: 'outside'}]) await ingest.putBatch(owner, {
    schemaVersion: 1, owner, harness: 'codex', origin: 'cli', installationId: 'fixture', sessionId: 'demo', attachments: [],
    events: [{id: 'event', kind: 'message', timestamp: '2026-11-01T00:00:00Z', data: {role: 'user', content: 'violet lighthouse session evidence'}}],
  });
  const pipeline = createSessionPipeline({store, prefix, search: sessions, resolvePrincipal: async ({batch}) => batch.owner});
  for (const key of (await pipeline.listPage()).keys) await pipeline.processObject({key});
  const library = createSessionLibrary({endpoint, store, prefix});
  const listed = await library.list(principal, {query: 'violet lighthouse'});
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].userId, 'bob');
  assert.equal((await library.read(principal, {userId: 'bob', harness: 'codex', sessionId: 'demo'})).events.length, 1);
  const recent = await createRecentSessions({endpoint, store, prefix}).list(principal);
  assert.equal(recent.length, 1);
  const binding = {tenantId: principal.tenantId, connectionId: 'github', workspaceId: 'w', provider: 'github', access: 'workspace-global', rawPrefix: 'raw/v1/source=github/workspace=w/connection=github/'};
  const connectors = createConnectorSearch({endpoint, tenantId: principal.tenantId});
  await connectors.ensureIndex();
  await connectors.putDocuments(principal, binding, [{id: documentId(binding, 'issue', 'one'), document: {...binding, access: undefined, rawPrefix: undefined, kind: 'issue', sourceId: 'one', text: 'violet lighthouse connector evidence', extractedAt: 1, deleted: false, contentHash: 'a'.repeat(64)}}]);
  let bindings = [binding];
  const workspace = createWorkspaceSearch({sessions, connectors: {search: (p, q) => bindings.length ? connectors.search(p, bindings, q) : Promise.resolve({hits: [], truncated: false})}});
  let handler;
  const server = createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  handler = createOpenCrawlMcp({origin, search: workspace, authenticate: async req => req.headers.authorization === 'Bearer local-test' ? principal : null});
  const client = new Client({name: 'sqlite-conformance', version: '1'});
  t.after(async () => {await client.close(); await handler.close(); await new Promise(resolve => server.close(resolve));});
  await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {requestInit: {headers: {authorization: 'Bearer local-test'}}}));
  const search = async input => {const result = await client.callTool({name: 'search', arguments: input}); assert.ok(!result.isError, JSON.stringify(result)); return result.structuredContent;};
  const all = await search({query: 'violet lighthouse', match: 'phrase', facets: ['source', 'author']});
  assert.equal(all.partial, false); assert.equal(all.results.length, 2);
  assert.deepEqual(new Set(all.results.map(r => r.source)), new Set(['sessions', 'connectors']));
  for (const hit of all.results) {const fetched = await client.callTool({name: 'fetch', arguments: {id: hit.id}}); assert.equal(fetched.isError, undefined); assert.match(fetched.structuredContent.text, /violet lighthouse/);}
  const filtered = await search({query: 'violet', source: 'sessions', filters: {roles: ['user'], authors: ['bob']}, select: ['provenance']});
  assert.equal(filtered.results.length, 1); assert.equal(filtered.results[0].text, undefined);
  const first = await search({query: 'violet', limit: 1}); assert.ok(first.next);
  bindings = [];
  const next = await search({query: 'violet', limit: 1, cursor: first.next}); assert.ok(next.results.every(r => r.source !== 'connectors'));
  assert.equal((await client.callTool({name: 'fetch', arguments: {id: all.results.find(r => r.source === 'connectors').id}})).isError, true);
  await createControls({store, prefix}).update(peer, 'sessions', 'codex', 'demo', () => ({visibility: 'private', deletedAt: null}));
  assert.equal((await search({query: 'violet', source: 'sessions'})).results.length, 0);
  assert.equal((await client.callTool({name: 'fetch', arguments: {id: all.results.find(r => r.source === 'sessions').id}})).isError, true);
});

test('SQLite supports board ranking/facets and library/usage aggregations', async t => {
  const {endpoint, principal} = await fixture(t), realm = createRealm({endpoint, tenantId: principal.tenantId});
  const board = createBoardSearch({endpoint});
  const messages = ['release evidence', 'other message'].map((text, i) => ({id: i + 1, timestamp: 1793491200000 + i, topic: 'orion', agent: 'agent', author: 'alice', name: 'agent', text}));
  const result = await board.search(principal, messages, 'key', {workspace: principal.tenantId, query: 'orion release'});
  assert.equal(result.total, 1); assert.equal(result.facets.topic.values[0].value, 'orion');
  const sessions = createSessionSearch({endpoint, store: memorySessionStore(), prefix: 'capture-v1'});
  await sessions.ensureIndex(principal);
  await sessions.putDocuments([{id: 'event', document: {...principal, text: 'hello', kind: 'message', role: 'user', harness: 'codex', origin: 'cli', sessionId: 'session', installationId: 'machine', chunk: 0, toolNames: ['mcp__opencrawl__search', 'exec'], timestamp: '2026-11-01T12:00:00Z', receivedAt: '2026-11-01T12:00:00Z'}}], principal);
  const usage = await sessions.usage(principal, {days: 2, now: Date.parse('2026-11-02T12:00:00Z')});
  assert.equal(usage.events, 1); assert.equal(usage.sessions, 1); assert.equal(usage.toolCalls, 2); assert.equal(usage.opencrawlCalls, 1); assert.equal(usage.daily.length, 2);
  const groups = await realm.collection('session').search(principal, {size: 0, aggs: {sessions: {multi_terms: {terms: [{field: 'session.userId'}, {field: 'session.sessionId'}], order: [{last: 'desc'}, {_key: 'asc'}]}, aggs: {last: {max: {field: 'timestamp'}}, records: {top_hits: {size: 1}}}}}});
  assert.deepEqual(groups.aggregations.sessions.buckets[0].key, ['alice', 'session']);
  assert.equal(groups.aggregations.sessions.buckets[0].records.hits.hits[0]._source.corpus, 'session');
});

test('SQLite memory snapshots activate, replace removed files and reject stale replay', async t => {
  const {endpoint, principal} = await fixture(t), store = memorySessionStore(), prefix = 'capture-v1';
  const search = createSessionSearch({endpoint, store, prefix}), workspace = createWorkspaceSearch({sessions: search});
  const ingest = createSessionIngest({store, prefix}), pipeline = createSessionPipeline({store, prefix, search, resolvePrincipal: async ({batch}) => batch.owner});
  async function send(generation, files) {
    const snapshot = {schemaVersion: 1, owner: principal, installationId: 'machine', host: 'fixture', harness: 'codex', generation, files};
    const receipt = await ingest.putMemorySnapshot(principal, snapshot);
    const key = [...store.data.keys()].find(k => k.endsWith(receipt.snapshotId + '.json.gz'));
    await pipeline.processObject({key}); return {snapshot, key, receipt};
  }
  const file = text => ({path: 'memories/MEMORY.md', project: 'fixture', modifiedAt: '2026-11-07T00:00:00Z', text});
  const first = await send(10, [file('oldmemory evidence')]);
  const before = await workspace.search(principal, {query: 'oldmemory', source: 'memories'});
  assert.equal(before.partial, false); assert.equal(before.results.length, 1);
  await send(11, [file('newmemory evidence')]);
  assert.equal((await workspace.search(principal, {query: 'oldmemory', source: 'memories'})).results.length, 0);
  await assert.rejects(workspace.fetch(principal, {id: before.results[0].id}), {status: 404});
  await search.memories.putSnapshot({...first.snapshot, snapshotId: first.receipt.snapshotId, receivedAt: new Date().toISOString()}, principal, first.key);
  assert.equal((await workspace.search(principal, {query: 'newmemory', source: 'memories'})).results.length, 1);
  await send(12, []);
  assert.equal((await workspace.search(principal, {query: 'newmemory', source: 'memories'})).results.length, 0);
});

test('SQLite coordinates independent indexer processes and preserves the newest replay', async t => {
  const {endpoint, principal} = await fixture(t);
  const module = new URL('../dist/src/search/realm.mjs', import.meta.url).href;
  const code = `import {createRealm} from ${JSON.stringify(module)};
    const [endpoint,offset]=process.argv.slice(1),p={tenantId:'org_sqlite',userId:'alice'};
    const realm=createRealm({endpoint,tenantId:p.tenantId});await realm.ensureIndex();
    for(let i=0;i<15;i++)await realm.collection('session').bulk(p,[{id:'contended',policy:'session',document:{...p,text:'writer '+offset,receivedAt:new Date(1700000000000+Number(offset)+i).toISOString()}}]);`;
  await Promise.all([0, 100, 200].map(offset => promisify(execFile)(process.execPath, ['--input-type=module', '-e', code, endpoint, String(offset)])));
  const realm = createRealm({endpoint, tenantId: principal.tenantId});
  const document = (await realm.collection('session').mget(principal, ['contended'])).docs[0]._source;
  assert.equal(document.receivedAt, new Date(1700000000214).toISOString());
  assert.equal(document.text, 'writer 200');
});

test('self-host SQLite configuration is explicit and keeps OpenSearch defaults', () => {
  const env = {OPENCRAWL_URL: 'http://localhost', OPENCRAWL_ORGANIZATION_ID: 'org_local', OPENCRAWL_AUTH_SECRET: 'a'.repeat(32), OPENCRAWL_SETUP_TOKEN: 'b'.repeat(32), OPENCRAWL_SEARCH_URL: 'sqlite:///data/search.sqlite'};
  assert.equal(selfhostSettings(env).search.endpoint, env.OPENCRAWL_SEARCH_URL);
  assert.equal(searchSettings(env).endpoint, env.OPENCRAWL_SEARCH_URL);
  assert.equal(searchSettings({OPENCRAWL_OPENSEARCH_URL: 'http://localhost:9200'}).endpoint, 'http://localhost:9200');
  assert.throws(() => selfhostSettings({...env, OPENCRAWL_SEARCH_URL: 'sqlite://remote/data/search.sqlite'}), /Invalid SQLite/);
  assert.throws(() => selfhostSettings({...env, OPENCRAWL_OPENSEARCH_USERNAME: 'u', OPENCRAWL_OPENSEARCH_PASSWORD: 'p'}), /credentials/);
});
