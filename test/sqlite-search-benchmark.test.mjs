import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRealm} from '../dist/src/search/realm.mjs';
import {lexicalQuery} from '../dist/src/search/lexical.mjs';

// Opt-in timing of the ordinary lexical request on a small realm; it is not part
// of the default suite and asserts no duration.
//
//   OPENCRAWL_TEST_SQLITE_BENCHMARK=1 node --test test/sqlite-search-benchmark.test.mjs
//
// OPENCRAWL_TEST_SQLITE_BENCHMARK_RESULTS=<file> records the ranked IDs and
// scores when the file is absent, and otherwise requires this run to return the
// same IDs in the same order with scores equal to 1e-9 relative. Record on one
// commit and rerun on another to compare two implementations on the same corpus.
const enabled = process.env.OPENCRAWL_TEST_SQLITE_BENCHMARK === '1';
const saved = process.env.OPENCRAWL_TEST_SQLITE_BENCHMARK_RESULTS;
const DOCUMENTS = 8000, LIMIT = 40, RUNS = 3;

function random(seed) {
  return () => {
    seed = seed + 0x6d2b79f5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** A fixed 20,000-word vocabulary with a Zipf-like frequency curve: a few words
 * occur in most documents and most words in a handful, as in real transcripts. */
function corpus() {
  const next = random(20261112);
  const common = ('the of and to a in is it that for was on with as be at by this have from or one had not but what all were we when ' +
    'your can said there use an each which she do how their if will up other about out many then them these so some her would make like ' +
    'him into time has look two more write go see number no way could people my than first water been call who its now find long down day').split(' ');
  const syllables = ('ba be bi bo bu ca ce ci co cu da de di do du fa fe fi fo ga ge go ha he hi ho ka ke ki ko la le li lo lu ma me mi mo mu ' +
    'na ne ni no nu pa pe pi po pu ra re ri ro ru sa se si so su ta te ti to tu va ve vi vo wa we wi za ze zo').split(' ');
  const words = new Set(common);
  while (words.size < 20000) {
    let word = '';
    for (let i = 2 + Math.floor(next() * 3); i > 0; i--) word += syllables[Math.floor(next() * syllables.length)];
    words.add(word);
  }
  const vocabulary = [...words], cumulative = [];
  let sum = 0;
  for (let rank = 0; rank < vocabulary.length; rank++) cumulative.push(sum += 1 / (rank + 10));
  const word = () => {
    const target = next() * sum;
    let low = 0, high = cumulative.length - 1;
    while (low < high) {const middle = low + high >> 1; if (cumulative[middle] < target) low = middle + 1; else high = middle;}
    return vocabulary[low];
  };
  const sentence = length => {
    let text = '';
    while (text.length < length) {
      const count = 6 + Math.floor(next() * 14), parts = [];
      for (let i = 0; i < count; i++) parts.push(word());
      text += (text ? ' ' : '') + parts.join(' ').replace(/^./, c => c.toUpperCase()) + '.';
    }
    return text;
  };
  const distinct = count => {const chosen = new Set(); while (chosen.size < count) chosen.add(word()); return [...chosen].join(' ');};
  return {next, sentence, distinct};
}

test('SQLite lexical search timing on 8,000 documents', {skip: !enabled, timeout: 3600000}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'opencrawl-sqlite-benchmark-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const principal = {tenantId: 'org_benchmark', userId: 'alice'};
  const realm = createRealm({endpoint: pathToFileURL(join(directory, 'search.sqlite')).href.replace('file:', 'sqlite:'), environment: 'bench', tenantId: principal.tenantId});
  await realm.ensureIndex();
  const collection = realm.collection('session'), {next, sentence, distinct} = corpus();
  const kinds = ['message', 'message', 'message', 'agent_message', 'tool_result', 'tool_call'];
  let characters = 0;
  for (let start = 0; start < DOCUMENTS; start += 400) {
    const items = [];
    for (let i = start; i < Math.min(DOCUMENTS, start + 400); i++) {
      const text = sentence(1000 + Math.floor(next() * 2000)), session = 'session-' + Math.floor(i / 40);
      characters += text.length;
      items.push({id: 'event-' + String(i).padStart(5, '0'), document: {...principal, harness: 'codex', origin: 'cli', installationId: 'machine',
        sessionId: session, eventId: 'event-' + i, kind: kinds[i % kinds.length], role: i % 2 ? 'assistant' : 'user', sequence: i, chunk: 0,
        timestamp: new Date(1793491200000 + i * 60000).toISOString(), receivedAt: new Date(1793491200000 + i * 60000).toISOString(),
        title: sentence(30).slice(0, -1), text}});
    }
    await collection.bulk(principal, items);
  }
  t.diagnostic(`${DOCUMENTS} documents, ${Math.round(characters / DOCUMENTS)} characters of text on average`);
  const recorded = saved ? await readFile(saved, 'utf8').then(JSON.parse, error => {if (error.code !== 'ENOENT') throw error;}) : undefined;
  const results = {};
  for (const words of [8, 45]) {
    const query = distinct(words);
    // The request sessions/search.mts sends for match "any".
    const body = {size: LIMIT, track_total_hits: true, sort: ['_score', {id: 'asc'}],
      query: {bool: {filter: [{terms: {'session.kind': ['message', 'agent_message', 'tool_result']}}], must: [lexicalQuery(query, 'any')]}}};
    const durations = [];
    let result;
    for (let run = 0; run < RUNS; run++) {
      const started = performance.now();
      result = await collection.search(principal, body);
      durations.push(performance.now() - started);
    }
    assert.equal(result.hits.hits.length, LIMIT);
    const hits = result.hits.hits.map(hit => ({id: hit._id, score: hit._score}));
    results[words] = {query, total: result.hits.total.value, hits};
    durations.sort((a, b) => a - b);
    t.diagnostic(`${words}-word any query: median ${durations[RUNS >> 1].toFixed(1)} ms (${durations.map(d => d.toFixed(1)).join(', ')}); ${result.hits.total.value} of ${DOCUMENTS} documents match`);
    if (recorded) {
      const expected = recorded[words];
      assert.equal(expected.query, query);
      assert.equal(result.hits.total.value, expected.total);
      assert.deepEqual(hits.map(hit => hit.id), expected.hits.map(hit => hit.id));
      for (let i = 0; i < hits.length; i++) assert.ok(Math.abs(hits[i].score - expected.hits[i].score) <= 1e-9 * Math.abs(expected.hits[i].score), `score of ${hits[i].id}`);
      t.diagnostic(`${words}-word any query: same ${LIMIT} IDs, order and scores as ${saved}`);
    }
  }
  if (saved && !recorded) {await writeFile(saved, JSON.stringify(results, null, 1)); t.diagnostic('recorded ' + saved);}
});
