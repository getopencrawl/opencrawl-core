import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {gunzipSync} from 'node:zlib';
import {createSessionLibrary} from '../dist/src/sessions/library.mjs';
import {createSessionIngest} from '../dist/src/sessions/ingest.mjs';
import {batchDocuments} from '../dist/src/sessions/indexer.mjs';
import {realmDocument} from '../dist/src/search/realm.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';

test('session list bounds title reads and does independent work while a count or title read is pending', async t => {
  const principal = {tenantId: 'team', userId: 'alice'}, prefix = 'sessions/budget';
  const store = memorySessionStore(), ingest = createSessionIngest({store, prefix});
  const fixtures = [];
  for (let n = 0; n < 18; n++) {
    const sessionId = 'session-' + n;
    await ingest.putBatch(principal, {schemaVersion: 1, owner: principal, installationId: 'device', harness: 'codex', origin: 'desktop', sessionId, attachments: [],
      events: [{id: 'title', kind: 'session_title', data: {title: 'Title ' + n, context: 'x'.repeat(4000)}}]});
  }
  for (const [key, bytes] of store.data) {
    if (!key.endsWith('.json.gz')) continue;
    const batch = JSON.parse(gunzipSync(bytes));
    const [{id, document}] = batchDocuments({prefix, key, batch, principal});
    fixtures.push({key: ['alice', 'codex', batch.sessionId], sourceKey: key, hit: {_id: 'session:' + id, _source: realmDocument('session', id, document)}});
  }
  const rawRead = store.get, gate = Promise.withResolvers(), countGate = Promise.withResolvers();
  let titleReads = 0, active = 0, peak = 0, startsWithFirstBlocked = 0, titleFields;
  store.get = async (key, options) => {
    titleReads++;
    peak = Math.max(peak, ++active);
    if (key === fixtures[0].sourceKey) await gate.promise;
    else await setImmediate();
    active--;
    return rawRead(key, options);
  };
  const library = createSessionLibrary({store, prefix, endpoint: 'http://localhost:9200', fetch: async (_url, request) => {
    const {aggs} = JSON.parse(request.body);
    let aggregations;
    if (aggs.tokenCounts) {
      await countGate.promise;
      aggregations = {tokenCounts: {buckets: fixtures.map(({key}) => ({key, doc_count: 1, tokens: {value: 42}, counted: {value: 1}}))}};
    } else if (aggs.titles) {
      const {metadata, prompts} = aggs.titles.aggs;
      titleFields = [metadata, prompts].map(branch => branch.aggs.records.top_hits._source);
      aggregations = {titles: {buckets: fixtures.map(({key, hit}) => ({key, metadata: {records: {hits: {hits: [hit]}}}, prompts: {records: {hits: {hits: []}}}}))}};
    } else {
      aggregations = {sessions: {buckets: fixtures.map(({key}) => ({key, doc_count: 1, lastActivity: {value: 0}, firstActivity: {value: 0}, private: {doc_count: 0}, origin: {buckets: []}, host: {buckets: []}}))}};
    }
    return Response.json({aggregations, hits: {hits: [], total: {value: 0, relation: 'eq'}}, _shards: {failed: 0}, timed_out: false});
  }});
  const pending = library.list(principal);
  // These local transports yield once per read. Drain all runnable work, then
  // release both gates even on the slower implementation.
  for (let i = 0; i <= fixtures.length; i++) await setImmediate();
  const beforeCounts = titleReads;
  countGate.resolve();
  for (let i = 0; i <= fixtures.length; i++) await setImmediate();
  startsWithFirstBlocked = titleReads;
  gate.resolve();
  const {sessions} = await pending;
  t.diagnostic(JSON.stringify({beforeCounts, startsWithFirstBlocked, peak, titleReads}));
  assert.deepEqual(sessions.map(s => s.title), fixtures.map((_, n) => 'Title ' + n));
  assert.ok(sessions.every(s => s.capturedTokens === 42));
  assert.equal(beforeCounts, fixtures.length, 'titles can finish independently of token counts');
  assert.equal(startsWithFirstBlocked, fixtures.length, 'one slow session must not stall later titles');
  assert.equal(titleReads, fixtures.length);
  assert.ok(peak > 1 && peak <= 12, 'bound simultaneous source reads');
  for (const fields of titleFields) {
    assert.deepEqual([...fields].sort(), ['schema', 'tenantId', 'id', 'corpus', 'sourceKey', 'session.userId', 'session.harness', 'session.sessionId', 'session.private', 'session.eventId', 'session.installationId', 'session.kind'].sort());
  }
});
