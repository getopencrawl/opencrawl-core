import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createObjectStore} from '../src/sessions/s3-store.mjs';
import {createConnectorWriteBarrier} from '../src/connectors/write-barrier.mjs';

test('real S3 conditional writes fence independent connector writers and retain the tombstone', {
  skip: !process.env.OPENCRAWL_TEST_S3_ENDPOINT,
}, async t => {
  const scope = {tenantId: 'fixture-' + randomUUID(), connectionId: 'same-connection'};
  const options = {endpoint: process.env.OPENCRAWL_TEST_S3_ENDPOINT, bucket: 'capture-test', credentials: {accessKeyId: 'capture-test', secretAccessKey: 'capture-test-secret'}};
  const store = createObjectStore(options), key = 'test-write-barrier/' + scope.tenantId;
  const writer = createConnectorWriteBarrier({...scope, store});
  const closer = createConnectorWriteBarrier({...scope, store: createObjectStore(options)});
  let entered, finish;
  const enteredPromise = new Promise(r => {entered = r;}), finishPromise = new Promise(r => {finish = r;});
  const pending = writer.run('object-put', async () => {entered(); await finishPromise; await store.put(key, Buffer.from('synthetic'));});
  t.after(async () => {finish(); await pending.catch(() => {}); await store.delete(key); await store.delete(writer.key);});
  await Promise.race([enteredPromise, pending]);
  assert.equal((await closer.close()).pending, 1);
  await assert.rejects(closer.run('object-put', async () => assert.fail('late data write')), /closed/);
  finish(); await pending;
  assert.equal((await closer.close()).pending, 0);
  await store.delete(key);
  const restarted = createConnectorWriteBarrier({...scope, store: createObjectStore(options)});
  await assert.rejects(restarted.run('object-put', () => store.put(key, Buffer.from('resurrected'))), /closed/);
  assert.equal(await store.get(key), null);
});
