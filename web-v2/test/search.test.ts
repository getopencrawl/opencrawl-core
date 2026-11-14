import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {excerpt, highlightedText, safeSourceUrl, searchGroups, searchHit} from '../src/pages/search-model.ts';
import {SearchReader} from '../src/pages/search-reader.ts';
import {JsonDisclosure, SearchResults} from '../src/pages/search.tsx';
import {workspaceSearchDiagnostics} from '../src/reference/search.ts';
import type {DiagnosticSearch} from '../src/pages/types.ts';

const result = (title: string): DiagnosticSearch => ({sessions: [{scope: 'workspace', response: {hits: {hits: [{_source: {title, text: title}}]}}}]});

test('source-specific result context uses actual fields and safe URLs only', () => {
  const session = searchHit({_source: {harness: 'codex', role: 'assistant', kind: 'message', sessionId: 's1', timestamp: 0, text: 'body'}}, 'sessions');
  assert.equal(session.title, 'Codex Assistant Message');
  assert.ok(session.context.some(item => item.label === 'Session' && item.value === 's1'));
  assert.equal(session.timestamp, '1970-01-01T00:00:00.000Z');
  assert.ok(session.context.every(item => !['Harness', 'Type'].includes(item.label)), 'fallback title already includes those details');
  assert.equal(searchHit({_source: {harness: 'grok-bot', kind: 'tool_call', sessionId: 's2', timestamp: 0, text: 'body'}}, 'sessions').title, 'Grok Bot Tool call');
  assert.equal(searchHit({_source: {harness: 'antigravity', role: 'assistant', kind: 'message', sessionId: 's3', timestamp: 0, text: 'body'}}, 'sessions').title, 'Antigravity Assistant Message');
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

test('the self-host returned window never fabricates a total and preserves an existing source URL', () => {
  const data = workspaceSearchDiagnostics({results: [{id: 'connectors:one', source: 'connectors', title: 'Page', text: 'Body', url: 'https://example.com/page', excerpt: {start: 0, end: 4, totalChars: 400}}], partial: true, truncated: true, coverage: [{source: 'connectors', state: 'ready', truncated: true}]});
  assert.equal(data.connectors?.responses?.[0]?.hits?.total, undefined);
  assert.equal(data.connectors?.responses?.[0]?.hits?.hits?.[0]?._source?.url, 'https://example.com/page');
  assert.equal(data.connectors?.truncated, true);
  assert.equal(data.partial, true); assert.equal(data.truncated, true);
  const hit = data.connectors?.responses?.[0]?.hits?.hits?.[0]; assert.ok(hit);
  assert.equal(searchHit(hit, 'connectors').serverExcerpt, true);
});

test('result rendering escapes source text, keeps full text/raw detail, and distinguishes partial from empty', () => {
  const full = 'Prefix '.repeat(150) + '<script>needle</script>\n\nFinal paragraph';
  const value: DiagnosticSearch = {memories: {state: 'ready', truncated: true, hits: {total: {value: 12}, hits: [{_source: {title: '<script>Title</script>', text: full, path: 'memory.md', url: 'javascript:alert(1)'}}]}}};
  const html = renderToStaticMarkup(createElement(SearchResults, {result: value, query: 'needle'}));
  assert.doesNotMatch(html, /<script>|href="javascript:/); assert.match(html, /<mark>needle<\/mark>/);
  assert.match(html, /Showing 1 of 12 reported matches/); assert.match(html, /Final paragraph/);
  assert.match(html, /Read full indexed text/); assert.match(html, /Item metadata and JSON/); assert.match(html, /Raw search response/);
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
