import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseValueReport, valueReportKey, valueReports} from '../dist/src/application/value-report.mjs';
import {usageReport} from '../dist/src/application/usage.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';

const prefix = 'sessions/staging/v1';
const report = {
  schema: 4, measuredAt: '2026-11-10', window: {from: '2026-11-05', to: '2026-11-10', days: 6},
  model: {model: 'GPT-6 Astra', input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50, asOf: '2026-11-09', share: 63},
  work: {sessions: 386, tasks: 368}, spend: {input: 1, cacheRead: 2, cacheWrite: 0, output: 3},
  drift: {conflictsAvoided: 35, duplicatesAvoided: 7}, usage: {searches: 340, boardMessages: 3690},
  value: {searchesUsed: 221, fixesReused: 69, found: {teammateWork: 116, whereThingsLive: 65, pastDecisions: 34, pastFixes: 2, other: 4}},
};

test('value reports accept schema 4 exactly and ignore anything else', () => {
  assert.deepEqual(parseValueReport(JSON.stringify(report)), report);
  for (const bad of [
    'not json', JSON.stringify({...report, schema: 3}), JSON.stringify({...report, savings: {tokens: {input: 1, cacheRead: 2, cacheWrite: 0, output: 3}}}), JSON.stringify({...report, extra: true}),
    JSON.stringify({...report, usage: {...report.usage, searches: 1.5}}), JSON.stringify({...report, cost: {usd: 1}}),
    JSON.stringify({...report, drift: {...report.drift, conflictsAvoided: -1}}),
    JSON.stringify({...report, model: {...report.model, share: undefined}}), JSON.stringify({...report, measuredAt: 'yesterday'}),
  ]) assert.equal(parseValueReport(bad), null);
});

test('the usage report shows only the signed-in workspace’s own measured value', async () => {
  const store = memorySessionStore();
  await store.put(valueReportKey(prefix, 'org_a'), JSON.stringify(report));
  await store.put(valueReportKey(prefix, 'org_b'), JSON.stringify({...report, work: {...report.work, tasks: 1}}));
  assert.notEqual(valueReportKey(prefix, 'org_a'), valueReportKey(prefix, 'org_b'));
  assert.match(valueReportKey(prefix, 'org_a'), /^sessions\/staging\/v1\/value\/tenants\/[a-f0-9]{64}\.json$/);
  const values = valueReports({store, prefix});
  const directory = {
    organizations: {getOrganization: async id => ({id, name: 'Acme'})},
    userManagement: {listOrganizationMemberships: async () => ({data: []}), getUser: async () => null},
  };
  const read = tenantId => usageReport({principal: {tenantId, userId: 'user_a'}, directory, values});
  assert.equal((await read('org_a')).value?.work.tasks, 368);
  assert.equal((await read('org_b')).value?.work.tasks, 1);
  assert.equal((await read('org_c')).value, null);
  await store.put(valueReportKey(prefix, 'org_c'), '{"schema":4}');
  assert.equal((await read('org_c')).value, null);
  assert.equal((await usageReport({principal: {tenantId: 'org_a', userId: 'user_a'}, directory})).value, null);
});

test('tokens captured uses only the verified organization adapter', async () => {
  const directory = {
    organizations: {getOrganization: async id => ({id, name: 'Acme'})},
    userManagement: {listOrganizationMemberships: async () => ({data: []}), getUser: async () => ({id: 'user_a', email: 'a@example.com'})},
  };
  const asked = [];
  const captured = async principal => {asked.push(principal.tenantId); return {tokens: 142_500_000, since: '2026-11-01T00:00:00.000Z'};};
  assert.deepEqual((await usageReport({principal: {tenantId: 'org_a', userId: 'user_a'}, directory, captured})).capture, {tokens: 142_500_000, since: '2026-11-01T00:00:00.000Z'});
  assert.deepEqual(asked, ['org_a']);
  assert.equal((await usageReport({principal: {tenantId: 'user_a', userId: 'user_a'}, directory, captured})).capture, null);
  assert.equal((await usageReport({principal: {tenantId: 'org_a', userId: 'user_a'}, directory})).capture, null);
});
