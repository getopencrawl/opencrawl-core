import {test} from 'node:test';
import assert from 'node:assert/strict';
import {usageReport} from '../dist/src/application/usage.mjs';

const principal = {tenantId: 'org_usage', userId: 'user_a'};
const directory = {organizations: {getOrganization: async () => ({name: 'Example'})}, userManagement: {listOrganizationMemberships: async () => ({data: []})}};
const activity = {events: 1, lifetimeEvents: 1, sessions: 1, subagentSessions: 0, messages: 1, toolCalls: 0, machines: 1, opencrawlCalls: 0, tools: [], harnesses: [], origins: [], firstAt: null, lastAt: null, daily: [], people: []};

test('session activity and overlap use one scope and window in a complete response', async () => {
  const calls = [];
  const report = await usageReport({principal, directory, days: 2, search: {
    usage: async (scope, window) => {calls.push({scope, window}); return activity;},
    overlap: async (scope, window) => {calls.push({scope, window}); return {timeZone: 'UTC', measuredAt: new Date(window.now).toISOString(), sessions: 1, daily: []};},
  }});
  assert.equal(report.agents.sessions, 1);
  assert.equal(report.overlap.sessions, 1);
  assert.ok(calls.every(call => call.scope === principal && call.window.days === 2));
  assert.equal(calls[0].window.now, calls[1].window.now);
});

test('overlap failure rejects the usage refresh instead of publishing successful activity with null overlap', async () => {
  for (const error of [new Error('Session overlap scan limit exceeded'), Object.assign(new Error('Denied'), {status: 403}), Object.assign(new Error('Missing controls'), {status: 404})]) {
    await assert.rejects(usageReport({principal, directory, search: {usage: async () => activity, overlap: async () => {throw error;}}}), caught => caught === error);
  }
});

test('an uncreated index returns measured empty overlap; an unconfigured session service omits both measurements', async () => {
  const missing = async () => {throw Object.assign(new Error('No index yet'), {status: 404, type: 'index_not_found_exception'});};
  const empty = await usageReport({principal, directory, days: 2, search: {usage: missing, overlap: missing}});
  assert.equal(empty.agents.sessions, 0);
  assert.equal(empty.overlap.sessions, 0);
  assert.equal(empty.overlap.daily.length, 2);
  assert.ok(empty.overlap.daily.every(day => day.average === 0 && day.peak === 0));
  const unconfigured = await usageReport({principal, directory});
  assert.equal(unconfigured.agents, null);
  assert.equal(unconfigured.overlap, null);
});
