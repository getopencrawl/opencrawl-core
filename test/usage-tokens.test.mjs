import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tokenUsage, tokenSessionPage, usageServices} from '../dist/src/application/usage.mjs';
import {createConsoleApi} from '../dist/src/application/console.mjs';

const principal = {tenantId: 'org_a', userId: 'alice'};
const session = (userId, sessionId, tokens) => ({userId, harness: sessionId ? 'codex' : null, sessionId, tokens, lastAt: '2026-11-20T00:00:00.000Z'});

test('Usage tokens come from the deployment meter when it has one, else from the index, with the requested window', async () => {
  const seen = [];
  const ledger = {usage: async (p, range, now) => {seen.push(['meter', p, range]); return {total: 9, daily: [{date: '2026-11-20', count: 9}]};}, sessions: async () => ({rows: [], more: false})};
  const search = {tokenTotals: async (p, options) => {seen.push(['index', p, options.team, options.days]); return {total: 3, first: null, daily: []};}};
  assert.deepEqual(await tokenUsage({principal, tokens: ledger, search}, '7d', 0), {source: 'meter', range: '7d', total: 9, daily: [{date: '2026-11-20', count: 9}]});
  assert.deepEqual(await tokenUsage({principal, search}, 'all', 0), {source: 'index', range: 'all', total: 3, daily: []});
  await tokenUsage({principal: {tenantId: 'user_personal', userId: 'alice'}, search}, '30d', 0);
  assert.deepEqual(seen, [['meter', principal, '7d'], ['index', principal, true, null], ['index', {tenantId: 'user_personal', userId: 'alice'}, false, 30]]);
  await assert.rejects(tokenUsage({principal}, '30d', 0), {status: 503});
});

test('the session list leaves out sessions the viewer cannot read; unrecorded sessions show only to their owner', async () => {
  const rows = [session('alice', 's1', 5), session('bob', 'private', 7), session('bob', 'shared', 2), session('bob', null, 4), session('alice', null, 1)];
  const ledger = {usage: async () => ({total: 0, daily: []}), sessions: async (p, range, offset) => ({rows, more: offset === 0})};
  // The same visibility rule as search history: teammates' sessions need a readable capture.
  const visible = async (p, candidates) => candidates.filter(row => row.sessionId ? row.userId === p.userId || row.sessionId === 'shared' : row.userId === p.userId);
  const page = await tokenSessionPage({principal, tokens: ledger, visible}, {range: '30d'});
  assert.deepEqual(page.rows.map(row => [row.userId, row.sessionId, row.tokens]), [['alice', 's1', 5], ['bob', 'shared', 2], ['alice', null, 1]]);
  assert.equal(page.next, 25);
  assert.equal((await tokenSessionPage({principal, tokens: ledger, visible}, {range: '30d', offset: 25})).next, null);
  await assert.rejects(tokenSessionPage({principal, tokens: ledger}, {range: '30d'}), {status: 503});
  await assert.rejects(tokenSessionPage({principal, tokens: ledger, visible}, {range: '30d', tenantId: 'org_b'}));
  const oversized = {...ledger, sessions: async () => ({rows: Array.from({length: 26}, (_, i) => session('alice', 's' + i, 1)), more: false})};
  await assert.rejects(tokenSessionPage({principal, tokens: oversized, visible}, {range: '30d'}), /Oversized/);
});

test('token endpoints require fresh access, a valid range and only trusted scope', async () => {
  const calls = [];
  const services = usageServices(p => ({principal: p, tokens: {usage: async (_, range) => {calls.push(range); return {total: 1, daily: []};}, sessions: async () => ({rows: [], more: false})}, visible: async (_, rows) => rows}));
  const api = createConsoleApi({url: 'https://example.test', usageTokens: services.usageTokens});
  const request = (url, body = '') => ({url, async *[Symbol.asyncIterator]() {if (body) yield Buffer.from(body);}});
  const context = {principal, user: {id: principal.userId}, member: {}, cacheScope: 'scope-a', admitted: true, revalidate: async () => true};
  const route = '/api/console/usage/tokens', sessions = '/api/console/usage/token-sessions';
  // Access is checked again after the read; a denied response carries none of it.
  const denied = await api(request(route, '{"range":"7d"}'), route, {...context, revalidate: async () => false});
  assert.equal(denied.status, 403); assert.doesNotMatch(JSON.stringify(denied.body), /total/);
  assert.deepEqual((await api(request(route, '{"range":"7d"}'), route, context)).body, {source: 'meter', range: '7d', total: 1, daily: [], cacheScope: 'scope-a'});
  for (const body of ['{}', '{"range":"90d"}', '{"range":"7d","tenantId":"org_b"}']) assert.equal((await api(request(route, body), route, context)).status, 400, body);
  assert.deepEqual((await api(request(sessions, '{"range":"all","offset":25}'), sessions, context)).body, {rows: [], next: null, cacheScope: 'scope-a'});
  for (const body of ['{"range":"all","offset":-1}', '{"range":"all","offset":5000}', '{"range":"all","userId":"bob"}']) assert.equal((await api(request(sessions, body), sessions, context)).status, 400, body);
  assert.deepEqual(calls, ['7d', '7d']);
});
