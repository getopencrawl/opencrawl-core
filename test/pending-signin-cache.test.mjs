import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {createIntegrations} from '../dist/src/integrations/service.mjs';

const gate = () => Promise.withResolvers();
const principal = {tenantId: 'org_a', userId: 'user_a'};
const provider = {id: 'slack', name: 'Slack', scope: 'team', auth: 'oauth', toolkit: 'slack', streams: []};
const record = {
  tenantId: 'org_a', userId: 'user_a', integrationId: 'int_' + 'a'.repeat(26),
  provider: 'slack', status: 'connecting', connectedAccountId: 'conn_1',
  environment: 'production', createdAt: '2026-01-01',
};
const active = {id: 'conn_1', toolkit: {slug: 'slack'}, status: 'ACTIVE', user_id: 'production:org_a:user_a'};
const service = account => createIntegrations({
  environment: 'production', appUrl: 'https://app.example', providers: {slack: provider},
  registry: {listTenant: async () => [record]}, oauth: {account}, airbyte: {}, destination: {},
  workspaceId: async () => 'workspace', legacyBucket: 'owned', buckets: {},
});
const poll = integrations => integrations.list(principal).then(cards => cards[0]);

/**
 * Polls of a half-finished OAuth sign-in share a short-lived "account" lookup.
 * The lookup's own failure must only evict the cache entry it belongs to: a late
 * rejection from an old lookup must never delete a newer replacement, or the
 * next poll silently starts duplicate provider work.
 */
test('a late rejection from an expired lookup does not evict its newer replacement', async () => {
  const realNow = performance.now;
  let clock = 0;
  Object.defineProperty(globalThis.performance, 'now', {value: () => clock, configurable: true, writable: true});
  const release = gate();
  let calls = 0;
  const account = async () => {
    calls++;
    return calls === 1 ? release.promise : active;
  };
  try {
    const integrations = service(account);
    const first = poll(integrations);          // lookup A starts and is held open
    await tick();
    assert.equal(calls, 1);
    // advance past the TTL while A is still in flight so B replaces it
    clock = 16_000;
    const second = poll(integrations);         // lookup B starts
    await tick();
    assert.equal(calls, 2);

    release.reject(new Error('provider timed out'));
    await Promise.all([first, second]);
    const third = poll(integrations);          // must reuse B, not start C
    await tick();
    assert.equal(calls, 2, 'the stale rejection must not evict the replacement lookup');
    assert.equal((await third).state, 'connecting');
  } finally {
    Object.defineProperty(globalThis.performance, 'now', {value: realNow, configurable: true, writable: true});
  }
});

test('a failed lookup is evicted so the following poll retries', async () => {
  let calls = 0;
  const account = async () => {
    calls++;
    if (calls === 1) throw new Error('temporarily unavailable');
    return active;
  };
  const integrations = service(account);
  assert.equal((await poll(integrations)).state, 'unavailable');
  assert.equal((await poll(integrations)).state, 'connecting');
  assert.equal(calls, 2, 'a failed lookup must not be cached');
});

test('concurrent polls and a successful result within the TTL share one lookup', async () => {
  const realNow = performance.now;
  let clock = 0;
  Object.defineProperty(globalThis.performance, 'now', {value: () => clock, configurable: true, writable: true});
  const release = gate();
  let calls = 0;
  const account = async () => { calls++; await release.promise; return active; };
  try {
    const integrations = service(account);
    const concurrent = [poll(integrations), poll(integrations), poll(integrations)];
    await tick();
    assert.equal(calls, 1, 'staggered polls must join the in-flight lookup');
    release.resolve();
    assert.deepEqual((await Promise.all(concurrent)).map(card => card.state), ['connecting', 'connecting', 'connecting']);

    clock = 10_000;
    await poll(integrations);
    assert.equal(calls, 1, 'a successful lookup is reused until its TTL expires');
    clock = 16_000;
    await poll(integrations);
    assert.equal(calls, 2, 'the lookup is retried after its TTL');
  } finally {
    Object.defineProperty(globalThis.performance, 'now', {value: realNow, configurable: true, writable: true});
  }
});
