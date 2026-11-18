import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {excerpt, highlightedText, safeSourceUrl, searchGroups, searchHit} from '../src/pages/search-model.ts';
import {SearchReader} from '../src/pages/search-reader.ts';
import {JsonDisclosure, SearchResults} from '../src/pages/search.tsx';
import type {DiagnosticSearch} from '../src/pages/types.ts';

const result = (title: string): DiagnosticSearch => ({sessions: [{scope: 'workspace', response: {hits: {hits: [{_source: {title, text: title}}]}}}]});

test('source-specific result context uses actual fields and safe URLs only', () => {
  const session = searchHit({_source: {harness: 'codex', role: 'assistant', kind: 'message', sessionId: 's1', timestamp: 0, text: 'body'}}, 'sessions');
  assert.equal(session.title, 'Codex session');
  assert.ok(session.context.some(item => item.value === 'Assistant reply'));
  assert.equal(session.timestamp, '1970-01-01T00:00:00.000Z');
  assert.ok(session.context.every(item => item.value !== 's1'));
  assert.equal(searchHit({_source: {harness: 'grok-bot', kind: 'tool_call', sessionId: 's2', timestamp: 0, text: 'body'}}, 'sessions').title, 'Grok Bot session');
  assert.equal(searchHit({_source: {harness: 'antigravity', role: 'assistant', kind: 'message', sessionId: 's3', timestamp: 0, text: 'body'}}, 'sessions').title, 'Antigravity session');
  const source = searchHit({_source: {provider: 'slack', title: 'Deployment', channelId: 'C123', url: 'https://example.com/thread?q=one', timestamp: 'not-a-date'}}, 'connectors');
  assert.equal(source.title, 'Deployment'); assert.equal(source.url, 'https://example.com/thread?q=one');
  assert.equal(source.timestamp, undefined);
  assert.ok(source.context.some(item => item.label === 'Channel' && item.value === 'C123'));
  const memory = searchHit({_source: {path: 'memories/MEMORY.md', harness: 'claude-code', modifiedAt: '2026-11-07T10:00:00Z'}}, 'memories');
  assert.equal(memory.title, 'memories/MEMORY.md'); assert.equal(memory.timestampLabel, 'Modified');
  assert.equal(searchHit({}, 'memories').title, 'Agent memory');
  assert.deepEqual(searchHit({_source: {provider: 'slack', kind: 'message', title: 'Slack message'}}, 'connectors').context, [], 'a case-only title difference does not repeat source/type');
  for (const url of ['javascript:alert(1)', 'data:text/html,x', '//example.com', '/relative', 'https://user:secret@example.com/', 'https://example.com\n.evil', 'file:///secret']) assert.equal(safeSourceUrl(url), undefined, url);
});

test('query highlighting is literal and snippets remain exact source slices', () => {
  const text = 'A [test].* string with <script>markup</script> and a [TEST].* match.';
  const parts = highlightedText(text, '[test].*');
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.deepEqual(parts.filter(part => part.match).map(part => part.text), ['[test].*', '[TEST].*']);
  assert.deepEqual(highlightedText(text, ''), [{text, match: false}]);
  const body = 'before '.repeat(100) + 'needle' + ' after'.repeat(100), snippet = excerpt(body, 'needle', 400);
  assert.ok(snippet.leading && snippet.trailing); assert.ok(snippet.text.includes('needle')); assert.ok(body.includes(snippet.text));
});

test('groups preserve lower-bound totals, source coverage, truncation and failed-shard warnings', () => {
  const groups = searchGroups({sessions: [{scope: 'workspace', response: {hits: {total: {value: 100, relation: 'gte'}, hits: [{_id: 'one'}]}, timed_out: true, _shards: {failed: 1}}}], connectors: {state: 'pending', responses: [], truncated: true}, memories: {state: 'unavailable'}});
  assert.equal(groups[0]?.total, 100); assert.equal(groups[0]?.totalRelation, 'gte');
  assert.equal(groups[0]?.warnings.length, 2);
  assert.equal(groups[1]?.state, 'pending'); assert.equal(groups[1]?.truncated, true);
  assert.equal(groups[2]?.state, 'unavailable');
  assert.equal(searchGroups({sessions: [{scope: 'workspace', response: {hits: {total: {value: NaN}, hits: []}}}]})[0]?.total, undefined);
  assert.equal(searchGroups({memories: {}})[0]?.state, 'unknown');
});

test('a hit whose server excerpt is shorter than its source is marked as an excerpt', () => {
  const hit = {_id: 'connectors:one', _source: {title: 'Page', text: 'Body', url: 'https://example.com/page', excerpt: {start: 0, end: 4, totalChars: 400}}};
  assert.deepEqual(searchHit(hit, 'connectors').serverExcerpt, {leading: false, trailing: true});
});

test('result rendering escapes source text, preserves unlinked full text, and distinguishes partial from empty', () => {
  const full = 'Prefix '.repeat(150) + '<script>needle</script>\n\nFinal paragraph';
  const value: DiagnosticSearch = {memories: {state: 'ready', truncated: true, hits: {total: {value: 12}, hits: [{_source: {title: '<script>Title</script>', text: full, path: 'memory.md', url: 'javascript:alert(1)'}}]}}};
  const html = renderToStaticMarkup(createElement(SearchResults, {result: value, query: 'needle'}));
  assert.doesNotMatch(html, /<script>|href="javascript:/); assert.match(html, /<mark>needle<\/mark>/);
  assert.match(html, /1 of at least 12 results/); assert.match(html, /Final paragraph/);
  assert.match(html, /Read full indexed text/); assert.doesNotMatch(html, /Item metadata and JSON|Raw search response/);
  const partial = renderToStaticMarkup(createElement(SearchResults, {result: {memories: {state: 'pending'}}, query: 'needle'}));
  assert.match(partial, /Indexing is pending/); assert.doesNotMatch(partial, /No matching items/);
  const empty = renderToStaticMarkup(createElement(SearchResults, {result: {memories: {state: 'ready', hits: {hits: []}}}, query: 'needle'}));
  assert.match(empty, /No matching items/);
  const limited = renderToStaticMarkup(createElement(SearchResults, {result: {partial: true, memories: {state: 'ready', hits: {hits: []}}}, query: 'needle'}));
  assert.doesNotMatch(limited, /No matching items/); assert.match(limited, /Some sources did not complete/);
});

test('the latest submitted query wins even when an aborted request resolves late', async () => {
  const pending: Array<{signal: AbortSignal; resolve: (data: DiagnosticSearch) => void}> = [];
  const reader = new SearchReader({search: (_query, signal) => new Promise(resolve => pending.push({signal, resolve}))});
  const first = reader.search('first'), second = reader.search('second');
  assert.equal(pending[0]?.signal.aborted, true);
  pending[1]!.resolve(result('second')); await second;
  pending[0]!.resolve(result('first')); await first;
  assert.equal(reader.snapshot().query, 'second'); assert.deepEqual(reader.snapshot().result, result('second'));
});

test('clearing an in-flight search restores the blank form even if the response arrives later', async () => {
  let finish: (data: DiagnosticSearch) => void = () => {};
  const reader = new SearchReader({search: () => new Promise(resolve => {finish = resolve;})});
  const pending = reader.search('first');
  reader.clear();
  finish(result('late'));
  await pending;
  assert.deepEqual(reader.snapshot(), {state: 'idle', query: '', result: null, error: ''});
});

test('cancel clears pending data and suppresses late completion without changing the submitted query', async () => {
  let finish: (data: DiagnosticSearch) => void = () => {};
  const reader = new SearchReader({search: () => new Promise(resolve => {finish = resolve;})});
  const pending = reader.search('diagnose'); reader.cancel(); finish(result('late')); await pending;
  assert.equal(reader.snapshot().state, 'canceled'); assert.equal(reader.snapshot().query, 'diagnose'); assert.equal(reader.snapshot().result, null);
});

test('every failed query clears earlier results and access failures receive direct safe messages', async () => {
  for (const status of [401, 403, 503]) {
    let fail = false;
    const reader = new SearchReader({search: async () => {if (fail) throw Object.assign(new Error('Provider failure'), {status}); return result('earlier');}});
    await reader.search('earlier'); fail = true;
    const pending = reader.search('next'); assert.equal(reader.snapshot().result, null); await pending;
    assert.equal(reader.snapshot().state, 'failed'); assert.equal(reader.snapshot().result, null);
    if (status === 401) assert.match(reader.snapshot().error, /session expired/);
    if (status === 403) assert.match(reader.snapshot().error, /no longer have access/);
  }
});


test('closed raw disclosures do not serialize response objects or render full-text copies', () => {
  const value = {toJSON() {throw new Error('Closed detail must not serialize');}};
  const html = renderToStaticMarkup(createElement(JsonDisclosure, {label: 'Raw search response', value}));
  assert.match(html, /Raw search response/); assert.doesNotMatch(html, /<pre/);
});

test('session titles identify conversations and user prompts show the actual matching request', () => {
  const source = {harness: 'codex', kind: 'tool_result', sessionId: 's1'};
  const file = searchHit({_source: {...source, text: JSON.stringify({output: 'M docs/onboarding/quickstart.md'})}}, 'sessions', 'onboarding');
  assert.equal(file.title, 'Codex session');
  assert.equal(searchHit({_source: {...source, title: 'Original title', text: 'Review onboarding'}}, 'sessions', 'onboarding').title, 'Original title');
  const prompt = {kind: 'message', role: 'user', text: '# Files mentioned by the user:\n- setup.md\n\n## My request:\nReview the launch checklist'};
  const item = searchHit({_source: prompt}, 'sessions', 'launch');
  assert.equal(item.userPrompt, true); assert.equal(item.body, 'Review the launch checklist');
  assert.equal(searchHit({_source: prompt}, 'sessions', 'setup').userPrompt, false);
  assert.equal(searchHit({_source: {...prompt, containsToolOutput: true}}, 'sessions').userPrompt, false);
  assert.deepEqual(highlightedText('launch the checklist', 'launch checklist').filter(part => part.match).map(part => part.text), ['launch', 'checklist']);
});
