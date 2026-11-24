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
import {migrateRealmCorpus} from '../dist/src/search/migration.mjs';
import {createSessionSearch, searchSettings} from '../dist/src/sessions/search.mjs';
import {createSessionIngest} from '../dist/src/sessions/ingest.mjs';
import {createSessionPipeline} from '../dist/src/sessions/indexer.mjs';
import {createSessionLibrary} from '../dist/src/sessions/library.mjs';
import {createRecentSessions} from '../dist/src/sessions/recent.mjs';
import {createConnectorSearch} from '../dist/src/connectors/search.mjs';
import {documentId} from '../dist/src/connectors/scope.mjs';
import {createWorkspaceSearch} from '../dist/src/search/workspace.mjs';
import {createOpenCrawlMcp} from '../dist/src/mcp/server.mjs';
import {createControls} from '../dist/src/sessions/controls.mjs';
import {selfhostSettings} from '../dist/src/selfhost/settings.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';
import {migrateSessionParticipants} from '../dist/src/sessions/participant-migration.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'opencrawl-sqlite-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const path = join(directory, 'search.sqlite'), endpoint = pathToFileURL(path).href.replace('file:', 'sqlite:');
  const principal = {tenantId: 'org_sqlite', userId: 'alice'};
  return {directory, path, endpoint, principal};
}

for (const backend of ['sqlite', 'opensearch']) test(`session participants use human senders, filter whole conversations, and migrate without changing permissions (${backend})`, {skip: backend === 'opensearch' && !process.env.OPENCRAWL_TEST_OPENSEARCH_URL}, async t => {
  const local = await fixture(t), endpoint = backend === 'opensearch' ? process.env.OPENCRAWL_TEST_OPENSEARCH_URL : local.endpoint;
  const principal = {...local.principal, tenantId: 'participants_' + Date.now()}, store = memorySessionStore(), prefix = 'sessions/participants';
  const checkedFetch = async (...args) => {const response = await fetch(...args); if (!response.ok) console.error('Participant fixture engine response:', await response.clone().text()); return response;};
  const realm = createRealm({endpoint, tenantId: principal.tenantId, fetch: checkedFetch}), collection = realm.collection('session');
  const search = createSessionSearch({endpoint, store, prefix, fetch: checkedFetch}), ingest = createSessionIngest({store, prefix});
  const pipeline = createSessionPipeline({store, prefix, search, resolvePrincipal: async ({batch}) => batch.owner});
  const library = createSessionLibrary({endpoint, store, prefix, fetch: checkedFetch});
  const foreign = principal.tenantId + '_foreign';
  if (backend === 'opensearch') t.after(async () => {for (const tenantId of [principal.tenantId, foreign]) await fetch(endpoint + '/' + createRealm({endpoint, tenantId}).index, {method: 'DELETE'});});
  const sender = n => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const actor = n => ({provider: 'replicas', assurance: 'collector-reported', kind: 'human', workspaceId: '10000000-0000-4000-8000-000000000001', nativeId: `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`, messageId: 'user-' + n, userId: sender(n)});
  const owner = {...principal, userId: 'workload_replicas_fixture'};
  const human = (id, n, text) => ({id, kind: 'message', timestamp: '2026-11-13T10:00:00Z', data: {role: 'user', content: text}, actor: actor(n)});
  async function upload(user, sessionId, events, profiles = {}) {
    const before = new Set(store.data.keys());
    await ingest.putBatch(user, {schemaVersion: 1, owner: user, installationId: 'device', sessionId, harness: 'claude-code', origin: 'cli', events, attachments: [], actorProfiles: profiles});
    for (const key of store.data.keys()) if (!before.has(key) && key.endsWith('.json.gz')) await pipeline.processObject({key});
    await search.refresh(user);
  }
  await upload(owner, 'shared', [human('a', 1, 'Alice request'), human('b', 2, 'Bob request'), human('c', 1, 'Another request'), {id: 'answer', kind: 'message', timestamp: '2026-11-13T10:01:00Z', data: {role: 'assistant', content: 'quayside answer'}}], {[sender(1)]: {provider: 'replicas', userId: sender(1), name: 'Alice', email: 'Alice@Example.org'}, [sender(2)]: {provider: 'replicas', userId: sender(2), name: 'Bob'}});
  await upload(owner, 'unknown', [{...human('unknown', 3, 'Anonymous API message'), actor: {...actor(3), kind: 'unknown', userId: undefined}}]);
  await upload(principal, 'local', [{id: 'local', kind: 'message', timestamp: '2026-11-13T10:00:00Z', data: {role: 'user', content: 'Local request'}}]);
  await upload(principal, 'assistant-only', [{id: 'answer-only', kind: 'message', timestamp: '2026-11-13T10:00:00Z', data: {role: 'assistant', content: 'A partial local capture'}}]);
  await upload(principal, 'uploader-only', [human('other-person', 2, 'Only Bob participated')]);
  let list = await library.list(principal);
  assert.deepEqual(list.sessions.find(s => s.sessionId === 'shared').participants, [{id: 'replicas:' + sender(1), name: 'Alice'}, {id: 'replicas:' + sender(2), name: 'Bob'}]);
  assert.deepEqual(list.sessions.find(s => s.sessionId === 'unknown').participants, []);
  assert.deepEqual(list.sessions.find(s => s.sessionId === 'local').participants, [{id: 'user:alice'}]);
  assert.deepEqual(list.sessions.find(s => s.sessionId === 'assistant-only').participants, [{id: 'user:alice'}]);
  assert.deepEqual(list.sessions.find(s => s.sessionId === 'uploader-only').participants.map(p => p.id), ['replicas:' + sender(2)]);
  const member = {id: 'member-alice', email: 'alice@example.org', emailVerified: true};
  const window = {team: true, now: Date.parse('2026-11-14T10:00:00Z')};
  const report = async (members = [member]) => (await search.usage(principal, {...window, members})).people;
  assert.deepEqual(await report(), [{userId: member.id, sessions: 0, subagentSessions: 0, messages: 0, toolCalls: 0,
    events: 0, weekEvents: 2, lastAt: '2026-11-13T10:00:00.000Z'}]);
  assert.deepEqual(await report([{...member, emailVerified: false}]), []);
  assert.deepEqual(await report([member, {...member, id: 'duplicate'}]), []);
  assert.deepEqual(await report([{...member, email: 'bob@example.org'}]), []);
  assert.deepEqual((await search.usage({...principal, tenantId: foreign}, {...window, members: [member]})).people, []);
  await assert.rejects(search.usage(principal, {members: [member]}), {status: 403});
  const filler = Array.from({length: 501}, (_, n) => ({id: 'filler-' + n, document: {...owner, harness: 'claude-code', sessionId: 'aaa' + String(n).padStart(3, '0'), kind: 'message', chunk: 0, participantVersion: 1, participantId: 'replicas:' + sender(2), text: 'Unrelated', timestamp: '2026-11-13T10:00:00Z'}}));
  const excludedOwners = filler.map(item => ({id: 'owner-' + item.id, document: {...item.document, userId: principal.userId}}));
  await collection.bulk(principal, [...filler, ...excludedOwners], {refresh: true});
  // Shared installations can outnumber the roster by orders of magnitude.
  const quiet = {...member, id: 'quiet-member'};
  const workloads = filler.flatMap((item, n) => [0, 1].map(i => ({id: 'workload-' + n + '-' + i,
    document: {...item.document, userId: 'workload_replicas_' + n}})));
  const direct = {id: 'quiet-direct', document: {...filler[0].document, userId: quiet.id, timestamp: '2026-11-12T10:00:00Z'}};
  await collection.bulk(principal, [...workloads, direct], {refresh: true});
  const [active] = await report([quiet]);
  assert.equal(active.sessions, 1);
  assert.equal(active.weekEvents, 3);
  assert.equal(active.lastAt, '2026-11-13T10:00:00.000Z');
  await collection.delete(principal, [...workloads, direct].map(item => item.id));
  await realm.refresh(principal);
  assert.deepEqual((await library.list(principal, {participant: 'replicas:' + sender(2), query: 'quayside'})).sessions.map(s => s.sessionId), ['shared'], 'search reaches matches after the first 500 participant sessions');
  assert.deepEqual((await library.list(principal, {participant: 'user:alice'})).sessions.map(s => s.sessionId), ['assistant-only', 'local'], 'excluded uploader-only pages do not hide later participant matches');
  await collection.delete(principal, [...filler, ...excludedOwners].map(item => item.id)); await realm.refresh(principal);
  assert.deepEqual((await library.list(principal, {participant: 'user:alice'})).sessions.map(s => s.sessionId), ['assistant-only', 'local']);
  assert.deepEqual((await library.list(principal, {participant: 'user:workload_replicas_fixture'})).sessions, []);
  await assert.rejects(library.list(principal, {participant: 'tenant:other'}), {status: 400});
  await library.setVisibility(owner, {harness: 'claude-code', sessionId: 'shared', visibility: 'private'});
  assert.deepEqual((await library.list(principal, {participant: 'replicas:' + sender(1)})).sessions, []);
  assert.deepEqual((await library.list({...principal, tenantId: foreign})).sessions, []);
  await assert.rejects(library.setVisibility(principal, {harness: 'claude-code', sessionId: 'shared', visibility: 'team'}), {status: 404});
  assert.deepEqual(await report(), []);
  const attributed = (await collection.search(principal, {size: 10, query: {term: {'session.participantId': 'replicas:' + sender(1)}}})).hits.hits;
  await collection.bulk(principal, attributed.map(hit => {
    const {participantEmailKey, ...document} = hit._source;
    assert.ok(participantEmailKey);
    return {id: hit._id, document: {...document, participantVersion: 1}};
  }), {refresh: true});
  const backfill = {realm, principal, store, prefix, replicasActivityOnly: true};
  assert.equal((await migrateSessionParticipants(backfill)).events, attributed.length);
  assert.equal((await migrateSessionParticipants({...backfill, dryRun: false})).events, attributed.length);
  await realm.refresh(principal);
  assert.equal((await migrateSessionParticipants(backfill)).events, 0);
  await library.setVisibility(owner, {harness: 'claude-code', sessionId: 'shared', visibility: 'team'});
  assert.equal((await report())[0].weekEvents, 2);
  await library.setVisibility(owner, {harness: 'claude-code', sessionId: 'shared', visibility: 'private'});
  // Emulate older projections while keeping immutable captures intact.
  const existing = await collection.search(principal, {size: 100});
  const legacy = existing.hits.hits.map(hit => {const document = {...hit._source}; for (const field of ['participantVersion','participantId','participantName','participantUnknown','participantEmailKey']) delete document[field]; return {id: hit._id, document};});
  await collection.bulk(principal, legacy, {refresh: true});
  const snapshot = await collection.mget(principal, legacy.map(d => d.id));
  assert.equal((await migrateSessionParticipants({realm, principal, store, prefix})).events, legacy.length);
  assert.deepEqual(await collection.mget(principal, legacy.map(d => d.id)), snapshot);
  const migrated = await migrateSessionParticipants({realm, principal, store, prefix, dryRun: false, pageSize: 2});
  await realm.refresh(principal);
  assert.equal(migrated.complete, true); assert.equal(migrated.events, legacy.length);
  assert.equal((await migrateSessionParticipants({realm, principal, store, prefix, dryRun: false})).events, 0);
  list = await library.list(owner, {participant: 'replicas:' + sender(1)});
  assert.equal(list.sessions[0].private, true);
  const after = await collection.mget(principal, legacy.map(d => d.id));
  for (const hit of after.docs) {const previous = legacy.find(d => d.id === hit._id).document; assert.equal(hit._source.private, previous.private); assert.equal(hit._source.text, previous.text); assert.equal(hit._source.capturedTokens, previous.capturedTokens);}
  await assert.rejects(migrateSessionParticipants({realm, principal: {...principal, tenantId: 'foreign'}, store, prefix}), {status: 403});
  const item = legacy[0]; await collection.delete(principal, [item.id]);
  await collection.bulk(principal, [{...item, document: {...item.document, participantVersion: 1}, policy: 'session-participants'}]);
  assert.equal((await collection.mget(principal, [item.id])).docs[0].found, false);
});

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

test('An unregistered capture client reaches transcripts and MCP search with scoped reads and revocation', async t => {
  const {endpoint, principal} = await fixture(t), peer = {...principal, userId: 'bob'};
  const store = memorySessionStore(), prefix = 'capture-v1', sessions = createSessionSearch({endpoint, store, prefix});
  const ingest = createSessionIngest({store, prefix});
  for (const owner of [peer, {...peer, tenantId: 'outside'}]) await ingest.putBatch(owner, {
    schemaVersion: 1, owner, harness: 'external-recorder', origin: 'cli', installationId: 'fixture', sessionId: 'demo', attachments: [],
    events: [{id: 'event', kind: 'message', timestamp: '2026-11-01T00:00:00Z', data: {role: 'user', content: 'violet lighthouse session evidence'}}],
  });
  const pipeline = createSessionPipeline({store, prefix, search: sessions, resolvePrincipal: async ({batch}) => batch.owner});
  for (const key of (await pipeline.listPage()).keys) await pipeline.processObject({key});
  const library = createSessionLibrary({endpoint, store, prefix});
  const listed = await library.list(principal, {query: 'violet lighthouse'});
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].userId, 'bob');
  assert.equal((await library.read(principal, {userId: 'bob', harness: 'external-recorder', sessionId: 'demo'})).events.length, 1);
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
  const native = {harness: 'external-recorder', sessionId: 'demo'};
  assert.equal((await search({query: 'violet', source: 'sessions', currentSession: native})).results[0].provenance.harness, native.harness);
  const filtered = await search({query: 'violet', source: 'sessions', filters: {roles: ['user'], authors: ['bob']}, select: ['provenance']});
  assert.equal(filtered.results.length, 1); assert.equal(filtered.results[0].text, undefined);
  const first = await search({query: 'violet', limit: 1}); assert.ok(first.next);
  bindings = [];
  const next = await search({query: 'violet', limit: 1, cursor: first.next}); assert.ok(next.results.every(r => r.source !== 'connectors'));
  assert.equal((await client.callTool({name: 'fetch', arguments: {id: all.results.find(r => r.source === 'connectors').id}})).isError, true);
  await createControls({store, prefix}).update(peer, 'sessions', 'external-recorder', 'demo', () => ({visibility: 'private', deletedAt: null}));
  assert.equal((await search({query: 'violet', source: 'sessions'})).results.length, 0);
  assert.equal((await client.callTool({name: 'fetch', arguments: {id: all.results.find(r => r.source === 'sessions').id}})).isError, true);
});

for (const harness of ['codex', 'claude-code']) test(harness + ' client application survives ingestion, scoped search and fetch', async t => {
  const {endpoint, principal} = await fixture(t);
  const store = memorySessionStore(), prefix = 'capture-v1';
  const ingest = createSessionIngest({store, prefix});
  const sessions = createSessionSearch({endpoint, store, prefix});
  const pipeline = createSessionPipeline({store, prefix, search: sessions, resolvePrincipal: async ({batch}) => batch.owner});
  const workspace = createWorkspaceSearch({sessions});
  for (const clientApp of ['t3-code', 'conductor', undefined, 'unrecognized']) {
    const sessionId = clientApp ?? 'legacy';
    await ingest.putBatch(principal, {schemaVersion: 1, owner: principal, harness,
      origin: 'unknown', installationId: 'fixture', sessionId, clientApp, attachments: [],
      events: [{id: 'event', kind: 'message', data: {role: 'user', content: 'attribution fixture'}}]});
  }
  for (const key of (await pipeline.listPage()).keys) await pipeline.processObject({key});
  const input = {query: 'attribution fixture', source: 'sessions'};
  const all = await workspace.search(principal, {...input, facets: ['clientApp']});
  assert.equal(all.results.length, 4);
  assert.deepEqual(all.facets.clientApp.values, [{value: 'conductor', count: 1}, {value: 't3-code', count: 1}]);
  for (const row of all.results) {
    const {sessionId} = row.provenance;
    const expected = ['t3-code', 'conductor'].includes(sessionId) ? sessionId : undefined;
    assert.equal(row.provenance.clientApp, expected);
    assert.deepEqual((await workspace.fetch(principal, {id: row.id})).provenance, row.provenance);
    assert.equal(row.provenance.origin, 'unknown');
  }
  const filtered = await workspace.search(principal, {...input, filters: {clientApps: ['conductor']}});
  assert.deepEqual(filtered.results.map(r => r.provenance.sessionId), ['conductor']);
});

test('SQLite supports library and usage aggregations', async t => {
  const {endpoint, principal} = await fixture(t), realm = createRealm({endpoint, tenantId: principal.tenantId});
  const sessions = createSessionSearch({endpoint, store: memorySessionStore(), prefix: 'capture-v1'});
  await sessions.ensureIndex(principal);
  await sessions.putDocuments([{id: 'event', document: {...principal, text: 'hello', kind: 'message', role: 'user', harness: 'codex', origin: 'cli', sessionId: 'session', installationId: 'machine', chunk: 0, toolNames: ['mcp__opencrawl__search', 'exec'], timestamp: '2026-11-01T12:00:00Z', receivedAt: '2026-11-01T12:00:00Z'}}], principal);
  await sessions.putDocuments([
    {id: 'older', document: {...principal, text: 'earlier', kind: 'message', role: 'user', harness: 'codex', origin: 'cli', sessionId: 'old', installationId: 'machine', chunk: 0, capturedTokens: 40, timestamp: '2026-10-30T12:00:00Z', receivedAt: '2026-11-01T12:00:00Z'}},
    {id: 'recent', document: {...principal, text: 'later', kind: 'message', role: 'user', harness: 'codex', origin: 'cli', sessionId: 'new', installationId: 'machine', chunk: 0, capturedTokens: 7, timestamp: '2026-11-02T08:00:00Z', receivedAt: '2026-11-02T08:00:00Z'}},
  ], principal);
  const now = Date.parse('2026-11-02T12:00:00Z');
  // Tokens are dated by when the event happened; days with nothing captured read zero, and the window bounds the sum.
  assert.deepEqual(await sessions.tokenTotals(principal, {days: 2, now}), {total: 7, first: '2026-11-01T12:00:00.000Z', daily: [{date: '2026-11-01', count: 0}, {date: '2026-11-02', count: 7}]});
  const all = await sessions.tokenTotals(principal, {days: null, now});
  assert.equal(all.total, 47); assert.equal(all.daily[0].date, '2026-10-30'); assert.equal(all.daily.at(-1).date, '2026-11-02'); assert.equal(all.daily.length, 4);
  const page = await sessions.tokenSessions(principal, {days: null, now});
  assert.deepEqual(page.rows.map(row => [row.sessionId, row.tokens]), [['new', 7], ['session', 0], ['old', 40]]);
  assert.equal(page.more, false);
  assert.deepEqual((await sessions.tokenSessions({...principal, tenantId: 'org_other'}, {days: null, now})).rows, []);
  await assert.rejects(sessions.tokenSessions(principal, {offset: 5000}), {status: 400});
  const usage = await sessions.usage(principal, {days: 2, now: Date.parse('2026-11-02T12:00:00Z')});
  assert.equal(usage.events, 2); assert.equal(usage.sessions, 2); assert.equal(usage.toolCalls, 2); assert.equal(usage.opencrawlCalls, 1); assert.equal(usage.daily.length, 2);
  const ever = await sessions.usage(principal, {days: null, now: Date.parse('2026-11-02T12:00:00Z')});
  assert.equal(ever.events, 3); assert.equal(ever.daily[0].date, '2026-10-30'); assert.equal(ever.daily.at(-1).date, '2026-11-02');
  const groups = await realm.collection('session').search(principal, {size: 0, aggs: {sessions: {multi_terms: {terms: [{field: 'session.userId'}, {field: 'session.sessionId'}], order: [{last: 'desc'}, {_key: 'asc'}]}, aggs: {last: {max: {field: 'timestamp'}}, records: {top_hits: {size: 1}}}}}});
  assert.deepEqual(groups.aggregations.sessions.buckets[0].key, ['alice', 'new']);
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

test('SQLite waits for a competing initializer when enabling WAL', async t => {
  const {path, endpoint, principal} = await fixture(t);
  const realm = createRealm({endpoint, tenantId: principal.tenantId});
  await realm.ensureIndex();
  const db = new DatabaseSync(path);
  let release;
  try {
    // The fixture writer must wait for brief competing read locks at COMMIT too.
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE');
    const module = new URL('../dist/src/search/realm.mjs', import.meta.url).href;
    const code = `import {createRealm} from ${JSON.stringify(module)};
      const realm=createRealm({endpoint:process.argv[1],tenantId:'org_sqlite'});
      process.stdout.write('ready'); await realm.ensureIndex();`;
    await new Promise((resolve, reject) => {
      const child = execFile(process.execPath, ['--input-type=module', '-e', code, endpoint], {timeout: 15000}, error => error ? reject(error) : resolve());
      child.stdout.once('data', () => {release = setTimeout(() => {
        try {db.exec('COMMIT');} catch (error) {child.kill(); reject(error);}
      }, 200);});
    });
  } finally {
    clearTimeout(release);
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
  const reopened = new DatabaseSync(path);
  try {assert.equal(reopened.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');}
  finally {reopened.close();}
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


test('SQLite accepts a document larger than 4 MiB and validates the entire bulk scope before writing', async t => {
  const {endpoint, principal} = await fixture(t), collection = createRealm({endpoint, tenantId: principal.tenantId}).collection('connector');
  const document = {...principal, text: 'largeacceptance ' + '界'.repeat(2 * 1024 * 1024)};
  await collection.bulk(principal, [{id: 'large', document}]);
  assert.deepEqual((await collection.mget(principal, ['large'])).docs[0]._source, document);
  assert.equal((await collection.search(principal, {query: {match: {text: 'largeacceptance'}}})).hits.total.value, 1);
  await assert.rejects(collection.bulk(principal, [{id: 'valid', document}, {id: 'foreign', document: {...document, tenantId: 'other'}}]), {status: 403});
  assert.equal((await collection.mget(principal, ['valid'])).docs[0].found, false);
});

test('realm migration copies and verifies large documents without treating the scheduling target as a ceiling', async t => {
  const {endpoint, principal} = await fixture(t), realm = createRealm({endpoint, tenantId: principal.tenantId});
  const documents = ['small-before', 'large', 'small-after'].map(id => ({id, document: {...principal, text: id === 'large' ? '界'.repeat(2 * 1024 * 1024) : id}}));
  const source = {identity: 'frozen-large-source', version: async () => 'v1', read: async after => ({total: documents.length, documents: after ? [] : documents, next: after ? null : ['done']})};
  let checkpoint;
  const result = await migrateRealmCorpus({principal, corpus: 'connector', source, realm, load: async () => null, save: async value => {checkpoint = value;}});
  assert.equal(result.complete, true); assert.equal(checkpoint.copied, 3);
  assert.deepEqual((await realm.collection('connector').mget(principal, documents.map(d => d.id))).docs.map(d => d._source), documents.map(d => d.document));
});

test('Overview assigns multi-day sessions to the first event, including late imports, within the authorized tenant', async t => {
  const {endpoint,principal}=await fixture(t);
  const sessions=createSessionSearch({endpoint});
  const now=Date.parse('2026-11-08T12:00:00Z');
  const put=async (who,id,timestamp,capturedTokens,chunk=0)=>sessions.putDocuments([{id,document:{...who,harness:'codex',sessionId:'same-id',
    chunk,text:'example',kind:'message',timestamp,receivedAt:'2026-11-08T01:00:00Z',capturedTokens}}],who);
  await sessions.ensureIndex(principal);
  await put(principal,'first','2026-11-01T23:00:00Z',3);
  await put(principal,'next','2026-11-07T02:00:00Z',8);
  await put(principal,'extra-chunk','2026-11-07T02:00:00Z',8,1);
  const teammate={...principal,userId:'bob'};
  await put(teammate,'other-owner','2026-11-07T02:00:00Z',19);
  const all=await sessions.tokensBySessionStart(principal,{team:true,days:null,now});
  assert.equal(all.total,30);
  assert.deepEqual(all.daily.filter(day=>day.count),[{date:'2026-11-01',count:11},{date:'2026-11-07',count:19}]);
  assert.equal((await sessions.tokensBySessionStart(principal,{days:7,now})).total,0);
  assert.equal((await sessions.tokensBySessionStart({...principal,tenantId:'org_other'},{team:true,days:null,now})).total,0);
  await assert.rejects(sessions.tokensBySessionStart({...principal,captureAccess:'write'},{team:true,now}),{status:403});
});
