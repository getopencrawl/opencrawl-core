import {test} from 'node:test';
import assert from 'node:assert/strict';
import {usageReport} from '../dist/src/application/usage.mjs';
import {createConsoleApi} from '../dist/src/application/console.mjs';
import {productRouter} from '../dist/src/application/rpc.mjs';

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

test('overlap failure preserves successful activity and records the failed measurement', async () => {
  const logs = [];
  const report = await usageReport({principal, directory, log: (...args) => logs.push(args), search: {
    usage: async () => activity, overlap: async () => {throw new Error('Session overlap scan limit exceeded');},
  }});
  assert.equal(report.agents.sessions, 1);
  assert.equal(report.overlap, null);
  assert.deepEqual(report.failedSources, ['overlap']);
  assert.equal(logs[0][0], 'usage.source.failed');
  assert.equal(logs[0][1].source, 'overlap');
  assert.equal(logs[0][1].message, 'Session overlap scan limit exceeded');
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

test('missing resource controls are an unavailable measurement, never measured zero', async () => {
  const report = await usageReport({principal, directory, search:{usage:async()=>activity,overlap:async()=>{throw Object.assign(new Error('Missing controls'),{status:404});}}});
  assert.equal(report.overlap,null);assert.deepEqual(report.failedSources,['overlap']);
});

test('source access failures still reject the report and cannot retain cached private data', async () => {
  for(const status of [401,402,403])await assert.rejects(usageReport({principal,directory,search:{usage:async()=>activity,overlap:async()=>{throw Object.assign(new Error('Denied'),{status});}}}),error=>error.status===status&&error.expose===true);
});

test('independent source failures are reported, and a display-name failure cannot suppress captured tokens', async () => {
  const failure=async()=>{throw new Error('Unavailable');};
  const report=await usageReport({principal,directory:{...directory,organizations:{getOrganization:failure}},captured:async()=>({tokens:42,since:'2026-11-01'}),
    integrations:{list:failure},search:{usage:failure,overlap:async()=>({timeZone:'UTC',measuredAt:new Date().toISOString(),sessions:1,daily:[]})}});
  assert.equal(report.capture.tokens,42);assert.equal(report.overlap.sessions,1);assert.equal(report.agents,null);
  assert.deepEqual(report.failedSources,['integrations','organization','sessions']);
});

test('console logs the private cause without exposing it, and revalidates partial reports', async () => {
  const logs=[],context={principal,user:{id:principal.userId,email:'a@example.test'},member:{},revalidate:async()=>true};
  const api=createConsoleApi({url:'https://example.test',log:(...args)=>logs.push(args),usage:async()=>{throw new Error('private cause');}});
  const response=await api({url:'/api/console/usage'},'/api/console/usage',context);
  assert.equal(response.status,503);assert.doesNotMatch(JSON.stringify(response.body),/private cause/);
  assert.deepEqual(logs,[['console.request.failed',{path:'/api/console/usage',status:503,message:'private cause'}]]);
  let checks=0;
  const partial=createConsoleApi({url:'https://example.test',usage:()=>usageReport({principal,directory,search:{usage:async()=>activity,overlap:async()=>{throw new Error('Timeout');}}})});
  const denied=await partial({url:'/api/console/usage'},'/api/console/usage',{...context,revalidate:async()=>++checks===1});
  assert.equal(denied.status,403);assert.equal(checks,2);
});

test('older open RPC clients retain their safe cache behavior while new clients receive independent measurements',async()=>{
  const report={agents:activity,overlap:null,failedSources:['overlap']};
  const invoke=async()=>report;
  await assert.rejects(productRouter.createCaller({invoke}).console.usage(),/Reload this page/);
  assert.deepEqual(await productRouter.createCaller({invoke,usageSections:true}).console.usage(),report);
});

test('Usage highlights and details partition the reads for a full report', async () => {
  const calls = [];
  const read = (name, value) => async () => {calls.push(name); return value;};
  const user = {id: principal.userId, email: 'person@example.test'};
  const options = {principal, directory: {
    organizations: {getOrganization: read('organization', {name: 'Example'})},
    userManagement: {listOrganizationMemberships: read('members', {data: [{userId: user.id, organizationId: principal.tenantId, status: 'active', user}]}), getUser: read('user', user)},
  }, captured: read('capture', {tokens: 42, since: '2026-01-01'}),
    integrations: {list: read('integrations', [])}, connectors: {count: read('connectors', {total: 0, kinds: {}, providers: {}, connections: {}})},
    onboarding: {read: read('onboarding', {})}, search: {usage: read('activity', activity), overlap: read('overlap', {sessions: 1, daily: []})}};
  const highlights = await usageReport({...options, part: 'highlights'});
  assert.deepEqual(calls.sort(), ['capture', 'organization']);
  assert.equal(highlights.capture.tokens, 42);
  calls.length = 0;
  const details = await usageReport({...options, part: 'details'});
  assert.deepEqual(calls.sort(), ['activity', 'connectors', 'integrations', 'members', 'onboarding', 'overlap']);
  assert.equal(details.members.length, 1);
  assert.equal(details.agents.sessions, 1);
});

test('the full report starts capture and member setup while independent search is outstanding', async () => {
  const {promise, resolve} = Promise.withResolvers();
  const reads = [];
  const user = {id: principal.userId, email: 'person@example.test'};
  const pending = usageReport({principal, directory: {...directory, userManagement: {
    listOrganizationMemberships: async () => ({data: [{userId: user.id, organizationId: principal.tenantId, status: 'active'}]}),
    getUser: async () => user,
  }}, search: {usage: () => promise, overlap: async () => null},
    captured: async () => {reads.push('capture'); return {tokens: 0, since: '2026-01-01'};},
    onboarding: {read: async () => {reads.push('setup'); return {};}}});
  try {
    await new Promise(next => setImmediate(next));
    assert.deepEqual(reads.sort(), ['capture', 'setup']);
  } finally {resolve(activity); await pending;}
});

test('both Usage reads require fresh final access and accept only trusted scope', async () => {
  for (const part of ['highlights', 'details']) {
    const route = '/api/console/usage/' + part, calls = [];
    const api = createConsoleApi({url:'https://example.test', usageParts: {
      [part]: async scope => {calls.push(scope); return {privateMeasurement: 42};},
    }});
    const context = {principal, user:{id:principal.userId}, member:{}, cacheScope:'session-a', admitted:true};
    const request = (url, body = '') => ({url, async *[Symbol.asyncIterator]() {if (body) yield Buffer.from(body);}});
    const denied = await api(request(route), route, {...context, revalidate: async () => false});
    assert.equal(denied.status, 403);
    assert.doesNotMatch(JSON.stringify(denied.body), /privateMeasurement/);
    const allowed = await api(request(route), route, {...context, revalidate: async () => true});
    assert.deepEqual(allowed.body, {privateMeasurement:42, cacheScope:'session-a'});
    const forged = await api(request(route+'?tenantId=another'), route, {...context, revalidate: async () => true});
    assert.equal(forged.status, 400);
    const badRange = await api(request(route, JSON.stringify({range: '90d'})), route, {...context, revalidate: async () => true});
    assert.equal(badRange.status, 400);
    const extra = await api(request(route, JSON.stringify({range: '7d', tenantId: 'another'})), route, {...context, revalidate: async () => true});
    assert.equal(extra.status, 400);
    assert.deepEqual(calls, [principal, principal]);
  }
});
