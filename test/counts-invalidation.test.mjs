import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {gzipSync} from 'node:zlib';
import {createRecordCounts} from '../dist/src/integrations/counts.mjs';

const gate = () => Promise.withResolvers();
const record = {
  tenantId: 'org_a', userId: 'user_a', integrationId: 'int_' + 'a'.repeat(26),
  environment: 'production', s3Bucket: 'owned', s3Prefix: 'raw/connection',
};
const provider = {id: 'slack', keys: {messages: ['id']}, streams: [{name: 'messages', syncMode: 'incremental'}]};
const succeeded = new Set([1]);
const saved = gzipSync(JSON.stringify({version: 1, read: [], ids: {messages: ['old']}, full: {}}));
const noState = () => Object.assign(Error('missing'), {status: 404});

/**
 * A disconnect calls `forget()` while the durable recount is often still
 * streaming a large backfill. Invalidating the cache must also invalidate any
 * in-flight refresh: a late completion must never republish old measurements
 * as fresh, and later callers must not join a refresh that is being discarded.
 */
test('forget prevents an in-flight recount from republishing invalidated counts as fresh', async () => {
  const scan = gate();
  let reads = 0;
  let lists = 0;
  const buckets = {
    read: async () => { reads++; return saved; },
    list: async () => { lists++; return scan.promise; },
    write: async () => {},
    stream: async () => assert.fail('No objects'),
  };
  let time = 0;
  const counts = createRecordCounts({buckets, legacyBucket: 'owned', now: () => time});
  assert.deepEqual(await counts.get(record, provider, succeeded, {wait: 10}), {messages: 1});
  await tick();
  assert.equal(lists, 1, 'the initial scan started');

  counts.forget(record.integrationId);
  scan.resolve([]);
  await tick();

  assert.deepEqual(await counts.get(record, provider, succeeded, {wait: 10}), {messages: 1});
  assert.equal(lists, 2, 'the invalidated connection must be recounted');
  assert.equal(reads, 2, 'durable state must be reloaded after invalidation');
});

test('a caller after forget starts its own scan instead of joining an invalidated one', async () => {
  const firstScan = gate();
  const secondScan = gate();
  let reads = 0;
  const scans = [];
  const buckets = {
    read: async () => { reads++; return reads === 1 ? saved : Promise.reject(noState()); },
    list: async () => {
      const current = scans.length === 0 ? firstScan : secondScan;
      scans.push(current);
      return current.promise;
    },
    write: async () => {},
    stream: async () => assert.fail('No objects'),
  };
  const counts = createRecordCounts({buckets, legacyBucket: 'owned'});
  assert.deepEqual(await counts.get(record, provider, succeeded, {wait: 1000}), {messages: 1});
  await tick();
  assert.equal(scans.length, 1);

  counts.forget(record.integrationId);
  const second = counts.get(record, provider, succeeded, {wait: 1000});
  await tick();
  assert.equal(scans.length, 2, 'forget must not leave later callers waiting on the discarded scan');

  firstScan.resolve([]);
  secondScan.resolve([]);
  assert.deepEqual(await second, {}, 'the fresh scan has no saved state to inherit');
});

test('forgetting a different connection leaves its in-flight counts untouched', async () => {
  const scan = gate();
  let lists = 0;
  const buckets = {
    read: async () => saved,
    list: async () => { lists++; return scan.promise; },
    write: async () => {},
    stream: async () => assert.fail('No objects'),
  };
  const counts = createRecordCounts({buckets, legacyBucket: 'owned'});
  assert.deepEqual(await counts.get(record, provider, succeeded, {wait: 10}), {messages: 1});
  await tick();
  counts.forget('int_' + 'b'.repeat(26));
  scan.resolve([]);
  await tick();
  assert.deepEqual(await counts.get(record, provider, succeeded, {wait: 10}), {messages: 1});
  assert.equal(lists, 1, 'an unrelated forget must not invalidate this connection');
});

test('forget during an initial count discards the late completion instead of caching it', async () => {
  const firstScan = gate();
  const secondScan = gate();
  const scans = [];
  const buckets = {
    read: async () => Promise.reject(noState()),
    list: async () => {
      const current = scans.length === 0 ? firstScan : secondScan;
      scans.push(current);
      return current.promise;
    },
    write: async () => {},
    stream: async () => assert.fail('No objects'),
  };
  const counts = createRecordCounts({buckets, legacyBucket: 'owned'});
  const first = counts.get(record, provider, succeeded, {wait: 1000});
  await tick();
  counts.forget(record.integrationId);
  firstScan.resolve([]);
  assert.equal(await first, null, 'the invalidated scan must not publish a measurement');

  const second = counts.get(record, provider, succeeded, {wait: 1000});
  await tick();
  assert.equal(scans.length, 2, 'a new refresh must be started after invalidation');
  secondScan.resolve([]);
  assert.deepEqual(await second, {});
});
