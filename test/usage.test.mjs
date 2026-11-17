import {memorySessionStore as deletionTestStore} from './session-store-fixture.mjs';
import {realmResponse} from './realm-fixture.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSessionSearch} from '../dist/src/sessions/search.mjs';
import {createConnectorSearch} from '../dist/src/connectors/search.mjs';

const owner = {tenantId: 'org_a', userId: 'user_a'};
const bucket = (key, extra = {}) => ({key, doc_count: 4, sessions: {count: {value: 2}}, subagentSessions: {count: {value: 6}}, messages: {doc_count: 3}, toolCalls: {value: 5}, last: {value_as_string: '2026-11-05T10:00:00.000Z'}, week: {doc_count: 4}, ...extra});
const aggregations = people => ({activity: {doc_count: 8, sessions: {count: {value: 3}}, subagentSessions: {count: {value: 7}}, messages: {doc_count: 6}, toolCalls: {value: 9}, machines: {value: 2}, opencrawl: {doc_count: 1},
  tools: {buckets: [{key: 'Bash', doc_count: 7}]}, harnesses: {buckets: [{key: 'codex', doc_count: 8}]}, origins: {buckets: [{key: 'cli', doc_count: 8}]},
  first: {value_as_string: '2026-11-01T00:00:00.000Z'}, last: {value_as_string: '2026-11-05T10:00:00.000Z'},
  daily: {buckets: [{key_as_string: '2026-11-05', doc_count: 8, sessions: {count: {value: 3}}}]}, people: {buckets: people}}});

test('session usage counts only the principal, or the whole tenant when asked, and never returns text', async () => {
  const bodies = [];
  let people = [bucket('user_a')];
  const search = createSessionSearch({store:deletionTestStore(),prefix:"capture-v1",endpoint: 'http://localhost:9200', index: 'sessions', fetch: async (_, options) => {
    bodies.push(JSON.parse(options.body));
    return realmResponse('session',{hits: {total: {value: 80, relation: 'eq'}}, aggregations: aggregations(people)});
  }});
  const mine = await search.usage(owner, {now: Date.parse('2026-11-05T12:00:00Z')});
  assert.deepEqual(bodies[0].query.bool.must[0].bool.filter, [{term: {tenantId: 'org_a'}}, {term: {'session.userId': 'user_a'}}, {term: {'session.chunk': 0}}]);
  assert.equal(bodies[0].size, 0);
  assert.deepEqual(bodies[0].aggs.activity.filter, {range: {'session.timestamp': {gte: '2026-10-07T00:00:00.000Z', lte: '2026-11-05T12:00:00.000Z'}}});
  assert.equal(mine.events, 8); assert.equal(mine.lifetimeEvents, 80);
  assert.equal(mine.sessions, 3); assert.equal(mine.subagentSessions, 7); assert.equal(mine.people[0].toolCalls, 5);
  assert.equal(mine.people[0].sessions, 2); assert.equal(mine.people[0].subagentSessions, 6);
  // Spawned subagents are counted apart from the sessions a person started.
  const subagent = {term: {'session.origin': 'subagent'}}, count = {cardinality: {field: 'session.sessionId', precision_threshold: 40000}};
  for (const aggs of [bodies[0].aggs.activity.aggs, bodies[0].aggs.activity.aggs.people.aggs]) {
    assert.deepEqual(aggs.sessions, {filter: {bool: {must_not: [subagent]}}, aggs: {count}});
    assert.deepEqual(aggs.subagentSessions, {filter: subagent, aggs: {count}});
  } assert.equal(mine.daily[0].date, '2026-11-05');
  assert.doesNotMatch(JSON.stringify(mine), /text/);
  people = [bucket('user_a'), bucket('user_b')];
  await assert.rejects(search.usage(owner), /ownership/);
  const team = await search.usage(owner, {team: true});
  assert.deepEqual(bodies.at(-1).query.bool.must[0].bool.filter, [{term: {tenantId: 'org_a'}}, {term: {'session.chunk': 0}}]);
  assert.equal(team.people.length, 2);
  await assert.rejects(search.usage(null), /Authentication/);
  await assert.rejects(search.usage(owner, {days: 0}), /window/);
  await assert.rejects(search.usage(owner, {now: NaN}), /window/);
});

test('connector counts stay inside authorized connections', async () => {
  const binding = {tenantId: 'org_a', connectionId: 'conn', workspaceId: 'w', provider: 'slack', access: 'team-public', rawPrefix: 'raw/v1/source=slack/workspace=w/connection=conn/'};
  let body;
  const search = createConnectorSearch({endpoint: 'http://localhost:9200', index: 'connectors', tenantId: 'org_a', fetch: async (_, options) => {
    body = JSON.parse(options.body);
    return realmResponse('session',{hits: {total: {value: 12}}, aggregations: {kinds: {buckets: [{key: 'message', doc_count: 10}, {key: 'channel', doc_count: 2}]}}});
  }});
  assert.deepEqual(await search.count({tenantId: 'org_a'}, [binding]), {total: 12, kinds: {message: 10, channel: 2}});
  assert.deepEqual(body.query.bool.must[0].bool.filter, [{term: {tenantId: 'org_a'}}, {terms: {'connector.connectionId': ['conn']}}, {term: {'connector.deleted': false}}]);
  await assert.rejects(search.count({tenantId: 'org_b'}, [binding]), /scope/);
  await assert.rejects(search.count({tenantId: 'org_a'}, []), /Authorized/);
});
