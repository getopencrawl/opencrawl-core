import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createObjectStore} from '../dist/src/sessions/s3-store.mjs';
import {createSessionIngest} from '../dist/src/sessions/ingest.mjs';
import {createSessionPipeline} from '../dist/src/sessions/indexer.mjs';
import {createSessionSearch} from '../dist/src/sessions/search.mjs';
import {createRecentSessions} from '../dist/src/sessions/recent.mjs';
import {createSessionLibrary} from '../dist/src/sessions/library.mjs';
import {createMemoryLibrary} from '../dist/src/memories/library.mjs';
import {createLibraryApi} from '../dist/src/sessions/library-http.mjs';
import {createWorkspaceSearch} from '../dist/src/search/workspace.mjs';
import {createIndexTransport, realmIndex, realmMapping} from '../dist/src/search/realm.mjs';
const endpoint = process.env.OPENCRAWL_TEST_OPENSEARCH_URL, s3 = process.env.OPENCRAWL_TEST_S3_ENDPOINT;

test('real session and memory library: viewer, private visibility, owner-only controls, deletion and tombstones', {skip: !endpoint || !s3}, async t => {
  const run = randomUUID(), environment = 'lib-' + run.slice(0, 8), tenantId = 'library-' + run;
  const alice = {tenantId, userId: 'alice'}, bob = {tenantId, userId: 'bob'};
  const objects = new Set(), underlying = createObjectStore({endpoint: s3, bucket: 'capture-test', credentials: {accessKeyId: 'capture-test', secretAccessKey: 'capture-test-secret'}});
  const store = {...underlying, put: async (k, b, m) => {objects.add(k); return underlying.put(k, b, m);}, compareAndSet: async (k, v, b) => {objects.add(k); return underlying.compareAndSet(k, v, b);}};
  const prefix = 'sessions/library-test/' + run;
  t.after(async () => {for (const key of objects) await underlying.delete(key); await fetch(endpoint + '/' + realmIndex(environment, tenantId), {method: 'DELETE'});});
  // Start from an index created before owner visibility existed.
  const old = structuredClone(realmMapping); delete old.properties.session.properties.private; delete old.properties.memory.properties.private;
  await createIndexTransport({endpoint, index: realmIndex(environment, tenantId)})('', {settings: {number_of_shards: 1, number_of_replicas: 0}, mappings: {...old, _meta: {schema: 1, tenantId}}}, 'PUT');

  const options = {endpoint, environment, store, prefix};
  const search = createSessionSearch({endpoint, environment}), ingest = createSessionIngest({store, prefix});
  const pipeline = createSessionPipeline({store, prefix, search, resolvePrincipal: async ({batch}) => batch.owner});
  const sessions = createSessionLibrary(options), memories = createMemoryLibrary(options), api = createLibraryApi({sessions, memories});
  const workspace = createWorkspaceSearch({sessions: search}), recent = createRecentSessions(options);
  const keys = () => [...objects].filter(key => key.endsWith('.json.gz'));
  async function upload(owner, sessionId, harness, events, installationId = 'laptop') {
    const before = new Set(keys());
    const receipt = await ingest.putBatch(owner, {schemaVersion: 1, owner, installationId, sessionId, harness, origin: 'cli', events, attachments: []});
    for (const key of keys().filter(key => !before.has(key))) await pipeline.processObject({key});
    await search.refresh(owner);
    return receipt;
  }
  const at = minute => `2026-11-08T10:${String(minute).padStart(2, '0')}:00.000Z`;
  await upload(alice, 'alpha', 'claude-code', [
    {id: 'a1', kind: 'message', timestamp: at(1), sequence: 1, data: {role: 'user', content: 'Plan the lighthouse migration'}},
    {id: 'a2', kind: 'message', timestamp: at(2), sequence: 2, data: {role: 'assistant', model: 'fixture', content: [{type: 'thinking', thinking: 'hidden'}, {type: 'text', text: 'Starting with the lighthouse inventory.'}, {type: 'tool_use', id: 't1', name: 'Bash', input: {command: 'ls lighthouse'}}]}},
    {id: 'a3', kind: 'message', timestamp: at(3), sequence: 3, data: {role: 'user', content: [{type: 'tool_result', tool_use_id: 't1', content: 'beacon.md'}]}},
    {id: 'a0', kind: 'token_count', timestamp: at(3), sequence: 4, data: {info: {total: 1}}},
  ]);
  await upload(alice, 'beta', 'codex', [
    {id: 'b1', kind: 'message', timestamp: at(4), sequence: 1, data: {type: 'message', role: 'user', content: [{type: 'input_text', text: '# AGENTS.md instructions for repo'}]}},
    {id: 'b2', kind: 'user_message', timestamp: at(5), sequence: 2, data: {type: 'user_message', message: 'Rename the harbor module'}},
  ]);
  await upload(bob, 'gamma', 'codex', [{id: 'c1', kind: 'user_message', timestamp: at(6), sequence: 1, data: {type: 'user_message', message: 'Bob lighthouse question'}}]);

  const list = await api(bob, 'sessions/list', {});
  assert.deepEqual(list.sessions.map(s => [s.userId, s.sessionId, s.title, s.mine]), [
    ['bob', 'gamma', 'Bob lighthouse question', true], ['alice', 'beta', 'Rename the harbor module', false], ['alice', 'alpha', 'Plan the lighthouse migration', false]]);
  assert.deepEqual((await api(bob, 'sessions/list', {scope: 'mine'})).sessions.map(s => s.sessionId), ['gamma']);
  assert.deepEqual((await api(bob, 'sessions/list', {query: 'harbor'})).sessions.map(s => s.sessionId), ['beta']);

  const transcript = await api(bob, 'sessions/read', {userId: 'alice', harness: 'claude-code', sessionId: 'alpha'});
  assert.deepEqual(transcript.events.flatMap(event => event.entries), [
    {type: 'message', role: 'user', text: 'Plan the lighthouse migration'},
    {type: 'message', role: 'assistant', text: 'Starting with the lighthouse inventory.'},
    {type: 'tool_call', name: 'Bash', input: JSON.stringify({command: 'ls lighthouse'}, null, 2), truncated: false},
    {type: 'tool_result', text: 'beacon.md', truncated: false}]);
  assert.equal(transcript.total, 3, 'bookkeeping events are not part of the transcript');
  const paged = await api(bob, 'sessions/read', {userId: 'alice', harness: 'claude-code', sessionId: 'alpha', limit: 2});
  assert.equal(paged.events.length, 2); assert.ok(paged.next);
  const rest = await api(bob, 'sessions/read', {userId: 'alice', harness: 'claude-code', sessionId: 'alpha', limit: 2, cursor: paged.next});
  assert.deepEqual(rest.events.map(e => e.eventId), ['a3']);

  // Only the owner controls a session; another member is told it does not exist.
  await assert.rejects(api(bob, 'sessions/visibility', {harness: 'claude-code', sessionId: 'alpha', visibility: 'private'}), {status: 404});
  await assert.rejects(api(bob, 'sessions/delete', {harness: 'claude-code', sessionId: 'alpha'}), {status: 404});
  await assert.rejects(api(alice, 'sessions/visibility', {harness: 'claude-code', sessionId: 'alpha', visibility: 'private', userId: 'bob'}), {status: 400});
  await assert.rejects(api({...alice, captureAccess: 'write'}, 'sessions/list', {}), {status: 403});

  assert.equal((await api(alice, 'sessions/visibility', {harness: 'claude-code', sessionId: 'alpha', visibility: 'private'})).visibility, 'private');
  // A batch arriving after the change is indexed private too.
  await upload(alice, 'alpha', 'claude-code', [{id: 'a4', kind: 'message', timestamp: at(7), sequence: 4, data: {role: 'user', content: 'lighthouse follow up'}}], 'desktop');
  assert.deepEqual((await api(bob, 'sessions/list', {})).sessions.map(s => s.sessionId), ['gamma', 'beta']);
  await assert.rejects(api(bob, 'sessions/read', {userId: 'alice', harness: 'claude-code', sessionId: 'alpha'}), {status: 404});
  const bobSearch = await workspace.search(bob, {query: 'lighthouse', source: 'sessions'});
  assert.deepEqual(new Set(bobSearch.results.map(r => r.provenance?.sessionId ?? r.sessionId)), new Set(['gamma']));
  assert.ok(!(await recent.read(bob)).some(s => s.sessionId === 'alpha'));
  const mine = (await api(alice, 'sessions/list', {})).sessions.find(s => s.sessionId === 'alpha');
  assert.equal(mine.private, true); assert.equal(mine.lastActivityAt, at(7));
  assert.equal((await workspace.search(alice, {query: 'follow', source: 'sessions'})).results.length, 1);
  await api(alice, 'sessions/visibility', {harness: 'claude-code', sessionId: 'alpha', visibility: 'team'});
  assert.equal((await api(bob, 'sessions/list', {})).sessions.length, 3);

  // Deleting removes raw capture from every installation and the index, and
  // future uploads of the session are accepted but discarded.
  const deleted = await api(alice, 'sessions/delete', {harness: 'claude-code', sessionId: 'alpha'});
  assert.equal(deleted.objects, 4); // Two batches and two event ledgers.
  for (const key of objects) if (key.includes('/claude-code/') && !key.includes('/controls/')) assert.equal(await underlying.get(key), null, key);
  assert.deepEqual((await api(alice, 'sessions/list', {})).sessions.map(s => s.sessionId), ['gamma', 'beta']);
  assert.equal((await workspace.search(alice, {query: 'lighthouse', source: 'sessions'})).results.length, 1);
  const before = keys().length;
  const late = await upload(alice, 'alpha', 'claude-code', [{id: 'a5', kind: 'message', timestamp: at(8), data: {role: 'user', content: 'lighthouse late retry'}}]);
  assert.equal(late.stored, true); assert.equal(late.discarded, 'session_deleted'); assert.equal(keys().length, before);
  assert.equal((await workspace.search(alice, {query: 'late', source: 'sessions'})).results.length, 0);

  // Memories: same visibility and owner rules; deletion holds until the file changes.
  const file = (path, text, modifiedAt = '2026-11-08T09:00:00Z') => ({path, project: 'repo', modifiedAt, text});
  async function snapshot(owner, generation, files) {
    const before = new Set(keys());
    await ingest.putMemorySnapshot(owner, {schemaVersion: 1, owner, installationId: 'laptop', host: 'fixture', harness: 'claude-code', generation, files});
    for (const key of keys().filter(key => !before.has(key))) await pipeline.processObject({key});
  }
  const generation = Date.now() - 60000;
  await snapshot(alice, generation, [file('memory/user.md', '---\nname: user\ndescription: Alice prefers small PRs\n---\nBody about compass'), file('memory/project.md', '# Compass rollout\nDetails about compass')]);
  const listed = await api(bob, 'memories/list', {});
  assert.deepEqual(listed.memories.map(m => [m.path, m.description, m.mine]).sort(), [['memory/project.md', 'Compass rollout', false], ['memory/user.md', 'Alice prefers small PRs', false]]);
  assert.equal((await api(bob, 'memories/read', {userId: 'alice', harness: 'claude-code', path: 'memory/project.md'})).text, '# Compass rollout\nDetails about compass');
  await assert.rejects(api(bob, 'memories/visibility', {harness: 'claude-code', path: 'memory/user.md', visibility: 'private'}), {status: 404});
  await api(alice, 'memories/visibility', {harness: 'claude-code', path: 'memory/user.md', visibility: 'private'});
  assert.deepEqual((await api(bob, 'memories/list', {})).memories.map(m => m.path), ['memory/project.md']);
  await assert.rejects(api(bob, 'memories/read', {userId: 'alice', harness: 'claude-code', path: 'memory/user.md'}), {status: 404});
  const memorySearch = createWorkspaceSearch({sessions: search});
  assert.equal((await memorySearch.search(bob, {query: 'compass', source: 'memories'})).results.length, 1);
  assert.equal((await memorySearch.search(alice, {query: 'compass', source: 'memories'})).results.length, 2);
  assert.equal((await api(alice, 'memories/list', {scope: 'mine'})).memories.find(m => m.path === 'memory/user.md').private, true);

  await api(alice, 'memories/delete', {harness: 'claude-code', path: 'memory/project.md'});
  assert.deepEqual((await api(alice, 'memories/list', {})).memories.map(m => m.path), ['memory/user.md']);
  // The next snapshot still contains the unchanged file: it stays deleted, and privacy persists.
  await snapshot(alice, generation + 1, [file('memory/user.md', '---\ndescription: Alice prefers small PRs\n---\nBody about compass'), file('memory/project.md', '# Compass rollout\nDetails about compass')]);
  assert.deepEqual((await api(alice, 'memories/list', {})).memories.map(m => [m.path, m.private]), [['memory/user.md', true]]);
  assert.equal((await api(bob, 'memories/list', {})).memories.length, 0);
  // A newer version written after deletion is captured again.
  await snapshot(alice, generation + 2, [file('memory/project.md', '# Compass rollout v2', new Date().toISOString())]);
  assert.deepEqual((await api(bob, 'memories/list', {})).memories.map(m => m.path), ['memory/project.md']);
});

test('visibility changes upgrade a realm no indexer has touched since the release', {skip: !endpoint || !s3}, async t => {
  const run = randomUUID(), environment = 'vis-' + run.slice(0, 8), tenantId = 'visibility-' + run, owner = {tenantId, userId: 'alice'};
  const index = realmIndex(environment, tenantId), transport = createIndexTransport({endpoint, index});
  t.after(() => fetch(endpoint + '/' + index, {method: 'DELETE'}));
  const old = structuredClone(realmMapping); delete old.properties.session.properties.private; delete old.properties.memory.properties.private;
  await transport('', {settings: {number_of_shards: 1, number_of_replicas: 0}, mappings: {...old, _meta: {schema: 1, tenantId}}}, 'PUT');
  await transport('/_doc/session:one?refresh=true', {schema: 1, tenantId, corpus: 'session', id: 'one', kind: 'message', text: 'legacy', session: {userId: 'alice', harness: 'codex', sessionId: 'legacy', chunk: 0, kind: 'message'}}, 'PUT');
  await transport('/_doc/memory:one?refresh=true', {schema: 1, tenantId, corpus: 'memory', id: 'one', kind: 'passage', text: 'legacy memory', memory: {userId: 'alice', harness: 'codex', path: 'memories/a.md', kind: 'passage', chunk: 0}}, 'PUT');
  const store = createObjectStore({endpoint: s3, bucket: 'capture-test', credentials: {accessKeyId: 'capture-test', secretAccessKey: 'capture-test-secret'}});
  const prefix = 'sessions/visibility-test/' + run, options = {endpoint, environment, store, prefix};
  t.after(async () => {for (const key of (await store.list(prefix + '/')).keys) await store.delete(key);});
  const api = createLibraryApi({sessions: createSessionLibrary(options), memories: createMemoryLibrary(options)});
  assert.equal((await api(owner, 'sessions/visibility', {harness: 'codex', sessionId: 'legacy', visibility: 'private'})).visibility, 'private');
  assert.equal((await api(owner, 'memories/visibility', {harness: 'codex', path: 'memories/a.md', visibility: 'private'})).visibility, 'private');
  const stored = await transport('/_doc/session:one', undefined, 'GET');
  assert.equal(stored._source.session.private, true);
});
