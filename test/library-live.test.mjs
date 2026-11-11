import {memorySessionStore as deletionTestStore} from './session-store-fixture.mjs';
import {test, before} from 'node:test';
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

test('session hostnames cover the whole authorized session across search and transcript pages', {skip: !endpoint}, async t => {
  const environment = 'hosts-' + randomUUID().slice(0, 8), prefix = 'sessions/hosts', store = deletionTestStore();
  const alice = {tenantId: 'one', userId: 'alice'}, bob = {tenantId: 'one', userId: 'bob'}, outsider = {tenantId: 'two', userId: 'alice'};
  const options = {endpoint, environment, store, prefix};
  const ingest = createSessionIngest({store, prefix}), search = createSessionSearch(options), library = createSessionLibrary(options);
  const pipeline = createSessionPipeline({store, prefix, search, resolvePrincipal: async ({batch}) => batch.owner});
  t.after(async () => {for (const tenant of ['one', 'two']) await fetch(endpoint + '/' + realmIndex(environment, tenant), {method: 'DELETE'});});
  async function capture(owner, sessionId, host, sequence) {
    const before = new Set(store.data.keys());
    await ingest.putBatch(owner, {schemaVersion: 1, owner, installationId: 'device-' + sequence, sessionId, harness: 'codex', host, origin: 'cli', attachments: [],
      events: [{id: 'event-' + sequence, kind: 'message', sequence, timestamp: new Date(1794384000000 + sequence * 1000).toISOString(), data: {role: 'user', content: sequence === 1 ? 'needle' : 'Continue work'}}]});
    for (const key of store.data.keys()) if (!before.has(key) && key.endsWith('.json.gz')) await pipeline.processObject({key});
  }
  await capture(alice, 'shared', 'laptop.local', 1);
  await capture(alice, 'shared', 'runner-42', 2);
  await capture(alice, 'missing', undefined, 3);
  await capture(bob, 'shared', 'other-owner', 4);
  await capture(outsider, 'shared', 'other-tenant', 5);
  for (let index = 0; index < 21; index++) await capture(alice, 'many', 'runner-' + String(index).padStart(2, '0'), index + 10);
  await search.refresh(alice); await search.refresh(outsider);

  const list = await library.list(alice);
  const shared = list.sessions.find(session => session.userId === 'alice' && session.sessionId === 'shared');
  assert.deepEqual(shared.hosts, ['laptop.local', 'runner-42']); assert.equal(shared.hostsTruncated, false);
  assert.deepEqual((await library.list(alice, {query: 'needle'})).sessions.map(session => session.hosts), [['laptop.local', 'runner-42']], 'matching one event still summarizes all capture machines');
  const missing = list.sessions.find(session => session.sessionId === 'missing');
  assert.equal(missing.host, null); assert.deepEqual(missing.hosts, []); assert.equal(missing.hostsTruncated, false);
  const many = list.sessions.find(session => session.sessionId === 'many');
  assert.equal(many.hosts.length, 20); assert.equal(many.hostsTruncated, true);
  assert.ok(list.sessions.every(session => !session.hosts.includes('other-tenant')));
  const reference = {userId: 'alice', harness: 'codex', sessionId: 'shared', limit: 1};
  const first = await library.read(bob, reference), second = await library.read(bob, {...reference, cursor: first.next});
  assert.deepEqual(first.session.hosts, shared.hosts); assert.deepEqual(second.session.hosts, shared.hosts);
  await library.setVisibility(alice, {harness: 'codex', sessionId: 'shared', visibility: 'private'});
  assert.ok((await library.list(bob)).sessions.every(session => session.userId !== 'alice' || session.sessionId !== 'shared'));
  await assert.rejects(library.read(bob, reference), {status: 404});
  assert.deepEqual((await library.read(alice, reference)).session.hosts, shared.hosts);
});

before(async () => {
  if (!endpoint || !s3) return;
  // CI starts OpenSearch alongside the object store. These legacy-mapping
  // fixtures create indexes directly, so they must wait for its HTTP listener.
  for (let attempt = 0; attempt < 60; attempt++) {
    try {if ((await fetch(endpoint)).ok) return;} catch { /* service is starting */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Test OpenSearch did not become ready');
});

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
  const search = createSessionSearch({store,prefix,endpoint, environment}), ingest = createSessionIngest({store, prefix});
  const pipeline = createSessionPipeline({store, prefix, search, resolvePrincipal: async ({batch}) => batch.owner});
  const sessions = createSessionLibrary({...options,scheduleDeletion:async()=>{}}), memories = createMemoryLibrary(options), api = createLibraryApi({sessions, memories});
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
    {id: 'at', kind: 'session_title', timestamp: at(3), sequence: 5, data: {title: 'Lighthouse cutover'}},
  ]);
  await upload(alice, 'beta', 'codex', [
    {id: 'b1', kind: 'message', timestamp: at(4), sequence: 1, data: {type: 'message', role: 'user', content: [{type: 'input_text', text: '# AGENTS.md instructions for repo'}]}},
    {id: 'b2', kind: 'message', timestamp: at(5), sequence: 2, data: {type: 'message', role: 'user', content: [{type: 'input_text', text: 'Rename the harbor module'}], channel: 'user.text', id: 'native-message-id'}},
  ]);
  await upload(bob, 'gamma', 'codex', [{id: 'c1', kind: 'message', timestamp: at(6), sequence: 1, data: {role: 'user', content: 'Bob lighthouse question'}}]);

  const list = await api(bob, 'sessions/list', {});
  assert.deepEqual(list.sessions.map(s => [s.userId, s.sessionId, s.title, s.mine]), [
    ['bob', 'gamma', 'Bob lighthouse question', true], ['alice', 'beta', 'Rename the harbor module', false], ['alice', 'alpha', 'Lighthouse cutover', false]]);
  assert.deepEqual((await api(bob, 'sessions/list', {scope: 'mine'})).sessions.map(s => s.sessionId), ['gamma']);
  assert.deepEqual((await api(bob, 'sessions/list', {query: 'harbor'})).sessions.map(s => s.sessionId), ['beta']);
  assert.deepEqual((await api(bob, 'sessions/list', {query: 'cutover'})).sessions.map(s => s.sessionId), ['alpha']);

  const transcript = await api(bob, 'sessions/read', {userId: 'alice', harness: 'claude-code', sessionId: 'alpha'});
  assert.equal(transcript.session.title, 'Lighthouse cutover');
  assert.deepEqual(transcript.events.flatMap(event => event.entries), [
    {type: 'message', role: 'user', text: 'Plan the lighthouse migration'},
    {type: 'message', role: 'assistant', text: 'Starting with the lighthouse inventory.'},
    {type: 'tool_call', name: 'Bash', input: JSON.stringify({command: 'ls lighthouse'}, null, 2), truncated: false},
    {type: 'tool_result', text: 'beacon.md', truncated: false}]);
  assert.equal(transcript.total, 3, 'bookkeeping events are not part of the transcript');
  const paged = await api(bob, 'sessions/read', {userId: 'alice', harness: 'claude-code', sessionId: 'alpha', limit: 2});
  assert.equal(paged.events.length, 2); assert.ok(paged.next);
  const rest = await api(bob, 'sessions/read', {userId: 'alice', harness: 'claude-code', sessionId: 'alpha', limit: 2, cursor: paged.next});
  assert.equal(rest.session.title, transcript.session.title, 'pagination never changes the title');
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
  const accepted = await api(alice, 'sessions/delete', {harness: 'claude-code', sessionId: 'alpha'});
  assert.equal(accepted.pending,true);
  const deleted = await sessions.delete(alice,{harness:'claude-code',sessionId:'alpha'});
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
  assert.deepEqual(listed.memories.map(m => [m.path, m.title]).sort(), [['memory/project.md', 'Compass rollout'], ['memory/user.md', 'Alice prefers small PRs']]);
  assert.deepEqual(listed.memories.map(m => [m.path, m.description, m.mine]).sort(), [['memory/project.md', 'Compass rollout', false], ['memory/user.md', 'Alice prefers small PRs', false]]);
  const opened = await api(bob, 'memories/read', {userId: 'alice', harness: 'claude-code', path: 'memory/project.md'});
  assert.equal(opened.text, '# Compass rollout\nDetails about compass');
  assert.equal(opened.memory.title, listed.memories.find(m => m.path === 'memory/project.md').title);
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
  const api = createLibraryApi({sessions: createSessionLibrary({...options,scheduleDeletion:async()=>{}}), memories: createMemoryLibrary(options)});
  assert.equal((await api(owner, 'sessions/visibility', {harness: 'codex', sessionId: 'legacy', visibility: 'private'})).visibility, 'private');
  assert.equal((await api(owner, 'memories/visibility', {harness: 'codex', path: 'memories/a.md', visibility: 'private'})).visibility, 'private');
  const stored = await transport('/_doc/session:one', undefined, 'GET');
  assert.equal(stored._source.session.private, true);
});

test('real Grok Bot sessions: hook-derived conversations and tool-only activity logs list, read, search and delete', {skip: !endpoint || !s3}, async t => {
  const run = randomUUID(), environment = 'grok-' + run.slice(0, 8), tenantId = 'grok-' + run;
  const alice = {tenantId, userId: 'alice'}, bob = {tenantId, userId: 'bob'};
  const objects = new Set(), underlying = createObjectStore({endpoint: s3, bucket: 'capture-test', credentials: {accessKeyId: 'capture-test', secretAccessKey: 'capture-test-secret'}});
  const store = {...underlying, put: async (k, b, m) => {objects.add(k); return underlying.put(k, b, m);}, compareAndSet: async (k, v, b) => {objects.add(k); return underlying.compareAndSet(k, v, b);}};
  const prefix = 'sessions/grok-bot-test/' + run, options = {endpoint, environment, store, prefix};
  t.after(async () => {for (const key of objects) await underlying.delete(key); await fetch(endpoint + '/' + realmIndex(environment, tenantId), {method: 'DELETE'});});
  const search = createSessionSearch({store,prefix,endpoint, environment}), ingest = createSessionIngest({store, prefix});
  const pipeline = createSessionPipeline({store, prefix, search, resolvePrincipal: async ({batch}) => batch.owner});
  const api = createLibraryApi({sessions: createSessionLibrary({...options,scheduleDeletion:async()=>{}})}), workspace = createWorkspaceSearch({sessions: search}), recent = createRecentSessions(options);
  const keys = () => [...objects].filter(key => key.endsWith('.json.gz'));
  async function upload(owner, sessionId, harness, events) {
    const before = new Set(keys());
    await ingest.putBatch(owner, {schemaVersion: 1, owner, installationId: 'bot-computer', sessionId, harness, origin: harness === 'grok-bot' ? 'cloud' : 'cli', captureMode: 'live', events, attachments: []});
    for (const key of keys().filter(key => !before.has(key))) await pipeline.processObject({key});
    await search.refresh(owner);
  }
  const at = minute => `2026-11-10T10:${String(minute).padStart(2, '0')}:00.000Z`;
  // The shapes the CLI derives from Cursor-format hook payloads on a Bot's computer.
  await upload(alice, 'bot-conversation', 'grok-bot', [
    {id: 'g0', kind: 'hook', timestamp: at(0), sequence: 1, data: {hook_event_name: 'sessionStart', session_id: 'bot-conversation', note: 'windlass'}},
    {id: 'g1', kind: 'message', timestamp: at(1), sequence: 2, turnId: 'gen-1', data: {role: 'user', content: [{type: 'text', text: 'Expense the harbor conference pass'}]}},
    {id: 'g2', kind: 'reasoning_summary', timestamp: at(2), sequence: 3, data: {type: 'reasoning', summary: [{type: 'summary_text', text: 'Find the receipt first.'}]}},
    {id: 'g3', kind: 'tool_call', timestamp: at(3), sequence: 4, nativeId: 'tool-1', data: {type: 'tool_use', name: 'MCP:gmail_search', input: {query: 'harbor receipt'}, call_id: 'tool-1'}},
    {id: 'g4', kind: 'tool_result', timestamp: at(3), sequence: 5, nativeId: 'tool-1', data: {type: 'tool_result', name: 'MCP:gmail_search', call_id: 'tool-1', output: {redacted: true}, duration_ms: 210}},
    {id: 'g5', kind: 'message', timestamp: at(4), sequence: 6, data: {role: 'assistant', content: [{type: 'text', text: 'Registered and logged the expense.'}], model: 'grok-4.7'}},
  ]);
  // A runtime that reports only tool hooks, with no conversation ID.
  const activity = 'activity-0123456789abcdef-2026-11-10';
  await upload(alice, activity, 'grok-bot', [
    {id: 'title', kind: 'session_title', timestamp: '2026-11-10T00:00:00.000Z', sequence: 0, data: {title: 'Grok Bot activity in expenses on 2026-11-10', titleType: 'auto'}},
    {id: 't1', kind: 'tool_call', timestamp: at(6), sequence: 10, nativeId: 'tool-9', data: {type: 'tool_use', name: 'Shell', input: {command: 'ls quayside'}, call_id: 'tool-9'}},
    {id: 't2', kind: 'tool_result', timestamp: at(6), sequence: 11, nativeId: 'tool-9', data: {type: 'tool_result', name: 'Shell', call_id: 'tool-9', output: {exitCode: 0, stdout: 'ledger.csv'}, duration_ms: 12}},
  ]);
  // Tool-only capture from another harness is still not a listed conversation.
  await upload(alice, 'codex-tools', 'codex', [{id: 'c1', kind: 'tool_call', timestamp: at(7), sequence: 1, data: {type: 'function_call', name: 'shell', arguments: '{"cmd":"ls quayside"}', call_id: 'c'}}]);
  await upload(bob, 'bob-chat', 'codex', [{id: 'b1', kind: 'message', timestamp: at(8), sequence: 1, data: {role: 'user', content: 'Bob harbor question'}}]);

  const list = await api(bob, 'sessions/list', {});
  assert.deepEqual(list.sessions.map(s => [s.userId, s.harness, s.sessionId, s.title, s.origin, s.events]), [
    ['bob', 'codex', 'bob-chat', 'Bob harbor question', 'cli', 1],
    ['alice', 'grok-bot', activity, 'Grok Bot activity in expenses on 2026-11-10', 'cloud', 1],
    ['alice', 'grok-bot', 'bot-conversation', 'Expense the harbor conference pass', 'cloud', 3]]);
  assert.deepEqual((await api(bob, 'sessions/list', {query: 'harbor'})).sessions.map(s => s.sessionId), ['bob-chat', 'bot-conversation']);
  assert.deepEqual((await api(bob, 'sessions/list', {query: 'quayside'})).sessions.map(s => s.sessionId), [activity]);
  assert.deepEqual((await api(bob, 'sessions/list', {query: 'expenses activity'})).sessions.map(s => s.sessionId), [activity]);

  const transcript = await api(bob, 'sessions/read', {userId: 'alice', harness: 'grok-bot', sessionId: 'bot-conversation'});
  assert.equal(transcript.session.title, 'Expense the harbor conference pass'); assert.equal(transcript.session.origin, 'cloud');
  assert.deepEqual(transcript.events.flatMap(event => event.entries), [
    {type: 'message', role: 'user', text: 'Expense the harbor conference pass'},
    {type: 'note', label: 'Reasoning summary', text: 'Find the receipt first.', truncated: false},
    {type: 'tool_call', name: 'MCP:gmail_search', input: JSON.stringify({query: 'harbor receipt'}, null, 2), truncated: false},
    {type: 'tool_result', text: JSON.stringify({redacted: true}, null, 2), truncated: false},
    {type: 'message', role: 'assistant', text: 'Registered and logged the expense.'}]);
  assert.equal(transcript.total, 5, 'lifecycle hook evidence is not part of the transcript');
  const log = await api(bob, 'sessions/read', {userId: 'alice', harness: 'grok-bot', sessionId: activity});
  assert.equal(log.session.title, 'Grok Bot activity in expenses on 2026-11-10');
  assert.deepEqual(log.events.flatMap(event => event.entries).map(entry => entry.type), ['tool_call', 'tool_result']);
  // The same session ID under another harness is a different session.
  await assert.rejects(api(bob, 'sessions/read', {userId: 'alice', harness: 'codex', sessionId: 'bot-conversation'}), {status: 404});

  const found = await workspace.search(bob, {query: 'quayside ledger', source: 'sessions', match: 'any'});
  assert.deepEqual(new Set(found.results.map(r => r.provenance.harness + ':' + r.provenance.sessionId)), new Set(['grok-bot:' + activity, 'codex:codex-tools']));
  assert.equal((await workspace.search(bob, {query: 'windlass', source: 'sessions'})).results.length, 0, 'hook evidence is never indexed');
  const latest = await recent.read(bob);
  assert.deepEqual(latest.filter(s => s.harness === 'grok-bot').map(s => [s.sessionId, s.title, s.titleSource]), [
    [activity, 'Grok Bot activity in expenses on 2026-11-10', 'captured'], ['bot-conversation', 'Expense the harbor conference pass', 'first_user_message']]);
  assert.equal(latest.find(s => s.sessionId === 'bot-conversation').latestAssistantMessage.text, 'Registered and logged the expense.');
  const usage = await search.usage(alice, {team: true, now: Date.parse(at(30))});
  assert.deepEqual(usage.harnesses, [{name: 'grok-bot', count: 8}, {name: 'codex', count: 2}]);
  assert.deepEqual(usage.origins, [{name: 'cloud', count: 8}, {name: 'cli', count: 2}]);
  assert.equal(usage.toolCalls, 3); assert.equal(usage.messages, 3);

  // Owner controls work exactly as for other harnesses.
  await assert.rejects(api(bob, 'sessions/delete', {harness: 'grok-bot', sessionId: 'bot-conversation'}), {status: 404});
  await api(alice, 'sessions/visibility', {harness: 'grok-bot', sessionId: activity, visibility: 'private'});
  assert.deepEqual((await api(bob, 'sessions/list', {})).sessions.map(s => s.sessionId), ['bob-chat', 'bot-conversation']);
  assert.equal((await workspace.search(bob, {query: 'quayside', source: 'sessions'})).results.filter(r => r.provenance.harness === 'grok-bot').length, 0);
  const accepted = await api(alice, 'sessions/delete', {harness: 'grok-bot', sessionId: 'bot-conversation'});
  assert.equal(accepted.pending,true);
  const deleted = await sessions.delete(alice,{harness:'grok-bot',sessionId:'bot-conversation'});
  assert.equal(deleted.objects, 2); // One batch and its event ledger.
  assert.deepEqual((await api(alice, 'sessions/list', {})).sessions.map(s => s.sessionId), ['bob-chat', activity]);
  assert.equal((await workspace.search(alice, {query: 'conference', source: 'sessions'})).results.length, 0);
});
