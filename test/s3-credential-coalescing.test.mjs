import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {awsCredentials} from '../dist/src/sessions/s3-store.mjs';

const env = {AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/x'};
const role = {AccessKeyId: 'ASIA', SecretAccessKey: 'secret', Token: 'session'};
const gate = () => Promise.withResolvers();

/**
 * A single S3 client shares one credential provider across many concurrent
 * uploads. A stale or expired role must trigger exactly one container/STS/IMDS
 * request, and a slow failure must not leave the cache stuck on a rejected
 * promise. These tests use the ECS container path so the refresh can be gated.
 */
test('concurrent cold refreshes share one container credential request', async () => {
  const release = gate();
  let requests = 0;
  const fetch = async () => {
    requests++;
    await release.promise;
    return Response.json(role);
  };
  const credentials = awsCredentials({env, fetch});
  const first = credentials();
  const second = credentials();
  const third = credentials();
  await tick();
  assert.equal(requests, 1, 'three callers must coalesce onto a single refresh');
  release.resolve();
  const [a, b, c] = await Promise.all([first, second, third]);
  assert.equal(requests, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
  assert.deepEqual([a.accessKeyId, a.secretAccessKey, a.sessionToken], ['ASIA', 'secret', 'session']);
});

test('a slow failed refresh is shared, cleared, and retried by the next caller', async () => {
  const release = gate();
  let requests = 0;
  const fetch = async () => {
    requests++;
    if (requests === 1) {
      await release.promise;
      throw new Error('container endpoint timed out');
    }
    return Response.json(role);
  };
  const credentials = awsCredentials({env, fetch});
  const first = credentials();
  await tick();
  assert.equal(requests, 1);
  // This caller arrives after the first is already in flight and must join it,
  // not start a second request.
  const joined = credentials();
  await tick();
  assert.equal(requests, 1, 'a staggered caller must not start a duplicate refresh');

  release.resolve();
  await assert.rejects(first, /container endpoint timed out/);
  await assert.rejects(joined, /container endpoint timed out/);
  assert.equal(requests, 1, 'both coalesced callers observe the same failure');

  // A later retry must succeed instead of being stuck on the rejected promise.
  assert.equal((await credentials()).accessKeyId, 'ASIA');
  assert.equal(requests, 2);
});

test('fresh credentials are reused and a near-expiry refresh is coalesced once', async () => {
  const realNow = Date.now;
  let now = Date.parse('2026-01-01T00:00:00Z');
  let requests = 0;
  const fetch = async () => {
    requests++;
    return Response.json({...role, Expiration: new Date(Date.now() + 10 * 60_000).toISOString()});
  };
  Date.now = () => now;
  try {
    const credentials = awsCredentials({env, fetch});
    assert.equal((await credentials()).accessKeyId, 'ASIA');
    assert.equal(requests, 1);

    // Well before the refresh window, the cached value answers without I/O.
    now += 4 * 60_000;
    assert.equal((await Promise.all([credentials(), credentials()])).length, 2);
    assert.equal(requests, 1);

    // Inside the five-minute window every concurrent caller refreshes, but only
    // one container request is made and the new expiry is reused afterwards.
    now += 2 * 60_000;
    const [a, b] = await Promise.all([credentials(), credentials()]);
    assert.equal(requests, 2);
    assert.equal(a.accessKeyId, 'ASIA');
    assert.deepEqual(a, b);
    assert.equal((await credentials()).accessKeyId, 'ASIA');
    assert.equal(requests, 2);
  } finally {
    Date.now = realNow;
  }
});
