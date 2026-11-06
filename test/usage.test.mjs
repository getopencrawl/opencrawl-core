import {realmResponse} from './realm-fixture.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSessionSearch} from '../src/sessions/search.mjs';
import {createConnectorSearch} from '../src/connectors/search.mjs';
import {renderUsage} from '../src/usage.mjs';

const owner = {tenantId: 'org_a', userId: 'user_a'};
const bucket = (key, extra = {}) => ({key, doc_count: 4, sessions: {value: 2}, messages: {doc_count: 3}, toolCalls: {value: 5}, last: {value_as_string: '2026-11-05T10:00:00.000Z'}, week: {doc_count: 4}, ...extra});
const aggregations = people => ({activity: {doc_count: 8, sessions: {value: 3}, messages: {doc_count: 6}, toolCalls: {value: 9}, machines: {value: 2}, opencrawl: {doc_count: 1},
  tools: {buckets: [{key: 'Bash', doc_count: 7}]}, harnesses: {buckets: [{key: 'codex', doc_count: 8}]}, origins: {buckets: [{key: 'cli', doc_count: 8}]},
  first: {value_as_string: '2026-11-01T00:00:00.000Z'}, last: {value_as_string: '2026-11-05T10:00:00.000Z'},
  daily: {buckets: [{key_as_string: '2026-11-05', doc_count: 8, sessions: {value: 3}}]}, people: {buckets: people}}});

test('session usage counts only the principal, or the whole tenant when asked, and never returns text', async () => {
  const bodies = [];
  let people = [bucket('user_a')];
  const search = createSessionSearch({endpoint: 'http://localhost:9200', index: 'sessions', fetch: async (_, options) => {
    bodies.push(JSON.parse(options.body));
    return realmResponse('session',{hits: {total: {value: 80, relation: 'eq'}}, aggregations: aggregations(people)});
  }});
  const mine = await search.usage(owner, {now: Date.parse('2026-11-05T12:00:00Z')});
  assert.deepEqual(bodies[0].query.bool.must[0].bool.filter, [{term: {tenantId: 'org_a'}}, {term: {'session.userId': 'user_a'}}, {term: {'session.chunk': 0}}]);
  assert.equal(bodies[0].size, 0);
  assert.deepEqual(bodies[0].aggs.activity.filter, {range: {'session.timestamp': {gte: '2026-10-07T00:00:00.000Z', lte: '2026-11-05T12:00:00.000Z'}}});
  assert.equal(mine.events, 8); assert.equal(mine.lifetimeEvents, 80);
  assert.equal(mine.sessions, 3); assert.equal(mine.people[0].toolCalls, 5); assert.equal(mine.daily[0].date, '2026-11-05');
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

test('usage report renders each tab, escapes names and uses no inline styles', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  const agents = {events: 8, sessions: 3, messages: 6, toolCalls: 9, machines: 2, opencrawlCalls: 1, tools: [{name: 'mcp__opencrawl__test_connection', count: 1}],
    harnesses: [{name: 'claude-code', count: 8}], origins: [{name: 'cli', count: 8}], firstAt: '2026-11-01T00:00:00Z', lastAt: '2026-11-05T11:00:00Z',
    daily: [{date: '2026-11-04', events: 0, sessions: 0}, {date: '2026-11-05', events: 8, sessions: 3}], people: []};
  const report = {workspace: 'Acme', team: true, days: 30, generatedAt: '2026-11-05T12:00:00Z', agents,
    ingestion: {sources: [{name: 'Slack', icon: '/s.svg', account: 'Acme', state: 'synced', records: 1200, units: ['message', 'messages'], rows: [{label: 'Messages', count: 1200}], lastSyncedAt: '2026-11-05T11:00:00Z', connectedBy: 'Ada', searchable: true, indexed: 1100}],
      index: {sessionEvents: 8, connectorDocuments: 1100, searchMs: 12, probes: [11, 12, 30]}},
    members: [{name: '<Ada>', email: 'ada@acme.dev', you: true, sources: 1, sessions: 3, toolCalls: 9, weekEvents: 8, lastAt: '2026-11-05T11:00:00Z', setup: {cli: {}, mcp: {}, session: {}, client: 'Claude'}},
      {name: null, email: 'bob@acme.dev', sources: 0, sessions: 0, toolCalls: 0, weekEvents: 0, lastAt: null, setup: {}}]};
  const ingestion = renderUsage({...report, tab: 'ingestion'}, {now});
  assert.match(ingestion, /1,200 records/); assert.match(ingestion, /1,108 documents/); assert.match(ingestion, /12<small>ms/);
  assert.match(ingestion, /aria-current="page">Ingestion/);
  const agentTab = renderUsage({...report, tab: 'agents'}, {now});
  assert.match(agentTab, /3 sessions/); assert.match(agentTab, /opencrawl · test_connection/);
  const teamTab = renderUsage({...report, tab: 'team'}, {now});
  assert.match(teamTab, /1 of 2 members/); assert.match(teamTab, /&lt;Ada&gt;/); assert.doesNotMatch(teamTab, /<Ada>/);
  for (const html of [ingestion, agentTab, teamTab]) assert.doesNotMatch(html, /style=/);
  assert.match(renderUsage({tab: 'nope', agents: null, ingestion: null, members: []}, {now}), /aria-current="page">Ingestion/);
  assert.match(renderUsage({tab: 'agents', agents: {...agents, events: 0}}, {now}), /No agent sessions captured yet/);
  const untrusted = renderUsage({...report, tab: 'ingestion', ingestion: {...report.ingestion, sources: [{...report.ingestion.sources[0], state: '<img src=x onerror=alert(1)>'}]}}, {now});
  assert.match(untrusted, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.doesNotMatch(untrusted, /<img src=x/);
});
