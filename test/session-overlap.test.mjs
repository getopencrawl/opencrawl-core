import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {dailyOverlap, sessionOverlap} from '../dist/src/sessions/overlap.mjs';
import {createSessionSearch} from '../dist/src/sessions/search.mjs';
import {createRealm} from '../dist/src/search/realm.mjs';
import {createControls} from '../dist/src/sessions/controls.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';

const DAY = 86_400_000, now = Date.parse('2026-11-13T12:00:00Z');
const midnight = Date.parse('2026-11-13T00:00:00Z');
test('overlap integrates exact spans, clips the window, groups coincident endpoints and uses elapsed today', () => {
  const spans = [{first: midnight - DAY * 4, last: midnight + DAY / 4},
    {first: midnight, last: midnight + DAY / 8}, {first: midnight + DAY / 8, last: midnight + DAY / 4},
    {first: midnight, last: midnight}, {first: now + 1, last: now + 10}];
  assert.deepEqual(dailyOverlap(spans, 2, now), [
    {date: '2026-11-12', average: 1, peak: 1, partial: false},
    {date: '2026-11-13', average: 1, peak: 2, partial: true},
  ]);
  assert.deepEqual(dailyOverlap([], 1, midnight), [{date: '2026-11-13', average: 0, peak: 0, partial: true}]);
  // A session ending exactly at midnight never leaks into the next day.
  assert.equal(dailyOverlap([{first: midnight - DAY, last: midnight}], 2, now)[1].peak, 0);
  assert.throws(() => dailyOverlap([], 0, now), /window/);
  assert.throws(() => dailyOverlap([{first: 2, last: 1}], 1, now), /interval/);
});

test('daily integral and peaks match an independent interval-clipping oracle', () => {
  let state = 17;
  const random = () => ((state = (state * 16807) % 2147483647) / 2147483647);
  const spans = Array.from({length: 300}, () => {const first = midnight - random() * 8 * DAY; return {first, last: first + random() * 5 * DAY};});
  for (const day of dailyOverlap(spans, 7, now)) {
    const start = Date.parse(day.date), end = Math.min(start + DAY, now);
    const clipped = spans.map(s => ({first: Math.max(start, s.first), last: Math.min(end, s.last)})).filter(s => s.last > s.first);
    const area = clipped.reduce((sum, s) => sum + s.last - s.first, 0);
    const peak = Math.max(0, ...clipped.map(s => clipped.filter(other => other.first <= s.first && other.last > s.first).length));
    assert.ok(Math.abs(day.average - area / (end - start)) < 1e-9);
    assert.equal(day.peak, peak);
  }
});

for (const backend of ['sqlite', 'opensearch']) test(`${backend}: captured spans preserve tenant/privacy boundaries and session identity`, {skip: backend === 'opensearch' && !process.env.OPENCRAWL_TEST_OPENSEARCH_URL}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'opencrawl-overlap-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const endpoint = backend === 'sqlite' ? pathToFileURL(join(directory, 'search.sqlite')).href.replace('file:', 'sqlite:') : process.env.OPENCRAWL_TEST_OPENSEARCH_URL;
  const principal = {tenantId: `org_overlap_${Date.now()}_${backend}`, userId: 'alice'};
  const realm = createRealm({endpoint, tenantId: principal.tenantId}), store = memorySessionStore();
  if (backend === 'opensearch') t.after(() => fetch(endpoint + '/' + realm.index, {method: 'DELETE'}));
  await realm.ensureIndex();
  const controls = createControls({store, prefix: 'test'}), search = createSessionSearch({endpoint, store, prefix: 'test'});
  const docs = [];
  const span = (userId, harness, sessionId, first, last, extra = {}) => {
    for (const [i, timestamp] of [first, last].entries()) docs.push({id: `${userId}:${harness}:${sessionId}:${i}`, document: {...principal, userId, harness, sessionId, chunk: 0, receivedAt: new Date(now - 1).toISOString(), timestamp: new Date(timestamp).toISOString(), kind: 'message', origin: 'desktop', ...extra}});
  };
  span('alice', 'codex', 'same', midnight - DAY * 60, now);
  span('bob', 'codex', 'same', midnight, now); // same native ID, different owner
  span('alice', 'claude-code', 'same', midnight, now); // same ID, different harness
  span('bob', 'codex', 'private-index', midnight, now, {private: true});
  span('bob', 'codex', 'private-stale-index', midnight, now);
  span('alice', 'codex', 'deleted-stale-index', midnight, now);
  span('alice', 'codex', 'my-private', midnight, now, {private: true});
  span('alice', 'codex', 'child', midnight, now, {origin: 'subagent'});
  span('alice', 'codex', 'mixed-child', midnight - DAY * 60, now);
  docs.push({id: 'child-marker', document: {...docs.at(-1).document, timestamp: new Date(midnight - DAY * 45).toISOString(), origin: 'subagent'}});
  span('alice', 'codex', 'zero', midnight, midnight);
  span('alice', 'codex', 'duplicate-chunk', midnight, now, {chunk: 1});
  span('alice', 'codex', 'future-upload', midnight, now, {receivedAt: new Date(now + 1).toISOString()});
  span('alice', 'codex', 'missing-time', midnight, now, {timestamp: null});
  await realm.collection('session').bulk(principal, docs);
  await realm.refresh(principal);
  await controls.update({...principal, userId: 'bob'}, 'sessions', 'codex', 'private-stale-index', () => ({visibility: 'private', deletedAt: null}));
  await controls.update(principal, 'sessions', 'codex', 'deleted-stale-index', () => ({visibility: 'team', deletedAt: new Date(now).toISOString()}));
  const result = await search.overlap(principal, {days: 2, now});
  assert.deepEqual(result.daily, [{date: '2026-11-12', average: 1, peak: 1, partial: false}, {date: '2026-11-13', average: 4, peak: 4, partial: true}]);
  const foreign = {...principal, tenantId: principal.tenantId + '_other'};
  const other = createRealm({endpoint, tenantId: foreign.tenantId});
  if (backend === 'opensearch') t.after(() => fetch(endpoint + '/' + other.index, {method: 'DELETE'}));
  await other.ensureIndex();
  await other.collection('session').bulk(foreign, [{...docs[0], document: {...docs[0].document, tenantId: foreign.tenantId}}, {...docs[1], document: {...docs[1].document, tenantId: foreign.tenantId}}]);
  await other.refresh(foreign);
  assert.equal((await createSessionSearch({endpoint, store, prefix: 'test'}).overlap(foreign, {days: 1, now})).daily[0].average, 1);
  await assert.rejects(sessionOverlap(realm.collection('session'), controls, foreign, {days: 1, now}), /scope/);
  await assert.rejects(search.overlap({...principal, captureAccess: 'write'}, {days: 1, now}), /read access/);
  await assert.rejects(createSessionSearch({endpoint}).overlap(principal), /authoritative/);
  await assert.rejects(search.overlap(null), /Authentication|scope/);
});

test('key pagination keeps complete intervals and rejects truncated, repeated or malformed pages', async () => {
  const bucket = (user, session) => ({key: [user, 'codex', session], doc_count: 2, first: {value: midnight}, last: {value: now}, subagents: {doc_count: 0}});
  const principal = {tenantId: 'org_a', userId: 'a'}, controls = createControls({store: memorySessionStore(), prefix: 'test'});
  let mode = 'ok', reads = 0, bodies = [];
  const collection = {field: f => 'session.' + f, search: async (_, body) => {
    bodies.push(body); const second = reads++ % 2 === 1;
    return {timed_out: mode === 'timeout', _shards: {failed: mode === 'shard' ? 1 : 0}, hits: {total: {relation: 'eq', value: second ? 2 : 4}}, aggregations: {sessions: {
      buckets: [bucket(second && mode !== 'repeat' ? 'b' : 'a', 's')], sum_other_doc_count: second ? 0 : 2, doc_count_error_upper_bound: mode === 'inexact' ? 1 : 0,
    }}};
  }};
  assert.equal((await sessionOverlap(collection, controls, principal, {days: 1, now})).daily[0].peak, 2);
  assert.match(JSON.stringify(bodies[1]), /"gt":"a"/);
  assert.match(JSON.stringify(bodies[1]), /"gt":"codex"/);
  assert.match(JSON.stringify(bodies[1]), /"gt":"s"/);
  for (mode of ['timeout', 'shard', 'inexact', 'repeat']) {reads = 0; await assert.rejects(sessionOverlap(collection, controls, principal, {days: 1, now}));}
});
