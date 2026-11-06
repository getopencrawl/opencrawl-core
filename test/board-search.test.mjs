import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createBoardSearch, boardIndexMapping} from '../src/board/search.mjs';

const principal = {tenantId: 'team-a', userId: 'alice'}, key = 'board/tenants/team-a.json';
const boardId = createHash('sha256').update(key).digest('hex');
const messages = Array.from({length: 8}, (_, i) => ({id: i + 1, timestamp: 1700000000000 + i, topic: i < 6 ? 'auth' : 'other', agent: 'agent-a', author: 'alice', name: 'codex', text: 'Refresh ' + i, requestId: String(i)}));
const query = {workspace: 'team-a', query: 'refresh', limit: 2};
function mock({partial = false, forged = false, bulkFailure = false, gap = false} = {}) {
  const requests = []; let time = 1, written = false;
  const send = async (url, options) => {
    const body = options.body && JSON.parse(options.body.startsWith('{"index":') ? '{}' : options.body);
    requests.push({url: String(url), ...options, parsed: body});
    if (String(url).endsWith('/_mapping')) return Response.json({'board-test': {mappings: boardIndexMapping}});
    if (String(url).includes('/_bulk')) {written = true; return Response.json({errors: bulkFailure, items: messages.slice(gap ? 0 : 6).map(() => ({index: {status: bulkFailure ? 500 : 201}}))});}
    if (body?.size === 0) return Response.json({timed_out: false, _shards: {failed: 0}, hits: {total: {value: written ? 8 : gap ? 5 : 6, relation: 'eq'}}, aggregations: {last: {value: written ? 8 : 6}}});
    if (body?.size === 10000) return Response.json({timed_out: partial, _shards: {failed: 0}, hits: {total: {value: 8, relation: 'eq'}, hits: [...messages].reverse().map(m => ({_id: boardId + ':' + m.id, _source: {id: m.id, tenantId: forged ? 'team-b' : principal.tenantId, boardId}}))}, aggregations: {topic: {doc_count_error_upper_bound: 0, sum_other_doc_count: 0, buckets: [{key: 'auth', doc_count: 6}, {key: 'other', doc_count: 2}]}, agent: {doc_count_error_upper_bound: 0, sum_other_doc_count: 0, buckets: [{key: 'agent-a', doc_count: 8}]}}});
    return Response.json({acknowledged: true});
  };
  return {requests, advance: () => {time += 300001;}, search: createBoardSearch({endpoint: 'http://search.test', index: 'board-test', fetch: send, now: () => time})};
}

test('catches up projection and returns full ranked messages, exact facets and stable compact pages', async () => {
  const f = mock();
  const first = await f.search.search(principal, messages, key, query);
  assert.equal(first.total, 8); assert.equal(first.through, 8);
  assert.deepEqual(first.messages.map(m => m.id), [8, 7]);
  assert.equal(first.messages[0].text, 'Refresh 7'); assert.ok(!('requestId' in first.messages[0]));
  assert.deepEqual(first.facets.topic.values, [{value: 'auth', count: 6}, {value: 'other', count: 2}]);
  assert.equal(first.facets.agent.values[0].name, 'codex');
  const bulk = f.requests.find(r => r.url.includes('_bulk'));
  assert.match(bulk.body, /"id":7/); assert.doesNotMatch(bulk.body, /"id":6/);
  const ranking = f.requests.find(r => r.parsed?.size === 10000).parsed;
  assert.ok(ranking.query.bool.filter.some(f => f.term?.tenantId === principal.tenantId));
  assert.equal(ranking.sort[0]._score, 'desc');
  let cursor = first.next, all = first.messages.map(m => m.id), count = f.requests.length;
  const grown = [...messages, {...messages[0], id: 9, text: 'New concurrent post'}];
  while (cursor) {
    const page = await f.search.search(principal, grown, key, {...query, cursor});
    assert.equal(page.facets, undefined); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8192);
    all.push(...page.messages.map(m => m.id)); cursor = page.next;
  }
  assert.deepEqual(all, [8,7,6,5,4,3,2,1]); assert.equal(f.requests.length, count);
  await assert.rejects(f.search.search({...principal, userId: 'bob'}, messages, key, {...query, cursor: first.next}), /cursor/);
  await assert.rejects(f.search.search(principal, messages, key, {...query, query: 'changed', cursor: first.next}), /cursor/);
  f.advance(); await assert.rejects(f.search.search(principal, messages, key, {...query, cursor: first.next}), /expired/);
});

test('rejects missing scope, partial results, failed indexing and cross-tenant engine responses', async () => {
  await assert.rejects(mock().search.search({userId:'alice'}, messages, key, query), /scope/);
  for (const options of [{partial:true}, {forged:true}, {bulkFailure:true}]) await assert.rejects(mock(options).search.search(principal, messages, key, query));
  const f = mock({gap:true}); await f.search.search(principal, messages, key, query);
  assert.match(f.requests.find(r => r.url.includes('_bulk')).body, /"id":1/);
});

test('filters are exact and message bodies are never sliced to fit the response budget', async () => {
  const f = mock();
  const big = messages.map(m => ({...m, text: 'é'.repeat(512), name: '名'.repeat(80), topic: '題'.repeat(80)}));
  const output = await f.search.search(principal, big, key, {...query, limit:10, topics:['auth'], agents:['agent-a'], authors:['alice'], since:'2023-11-01T00:00:00Z', until:'2024-01-01T00:00:00Z', sort:'newest'});
  assert.ok(output.messages.length < 8); assert.ok(output.next); assert.ok(Buffer.byteLength(JSON.stringify(output)) <= 8192);
  assert.ok(output.messages.every(m => m.text === big[0].text));
  const body = f.requests.find(r => r.parsed?.size === 10000).parsed;
  assert.deepEqual(body.sort, [{timestamp:'desc'},{id:'desc'}]);
  assert.ok(body.query.bool.filter.some(f => f.terms?.author?.[0] === 'alice'));
  assert.ok(body.query.bool.filter.some(f => f.range?.timestamp?.gte === '2023-11-01T00:00:00Z'));
});
