import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {createOnlineMigrationS3Store} from '../dist/src/state/online-s3.mjs';
import {createOnlineJournal} from '../dist/src/state/online-journal.mjs';
import {applicationDatabaseFixture, postgresUrl} from './fixtures/application-database.mjs';

const epoch = '11111111-1111-4111-8111-111111111111';
const key = 'state/tenant/settings.json';
const options = {epoch, sourceId: 'test-source', prefixes: ['state/'], bucket: 'fixture', credentials: {accessKeyId: 'fixture', secretAccessKey: 'fixture'}};
const put = (revision = '1', bytes = Buffer.from('{"value":1}')) => ({operationId: randomUUID(), revision, bytes, contentType: 'application/json'});
const errorResponse = (status, code) => new Response(`<Error><Code>${code}</Code></Error>`, {status});

/** Models conditional S3 writes against the body ETag, including a lost reply
 * after the server applies a write. This intentionally does not version metadata. */
function fixture() {
  const objects = new Map(), calls = [];
  let afterWrite, refusal;
  function seed(k, body, headers = {}) {
    const bytes = Buffer.from(body);
    objects.set(k, {bytes, headers: new Headers({'content-type': 'application/json', ...headers}), version: '"' + createHash('md5').update(bytes).digest('hex') + '"'});
  }
  const fetch = async (url, init) => {
    const k = decodeURIComponent(new URL(url).pathname.slice(1));
    const headers = new Headers(init.headers);
    calls.push({key: k, method: init.method, headers});
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    const old = objects.get(k);
    if (init.method === 'GET') return old ? new Response(old.bytes, {headers: {...Object.fromEntries(old.headers), etag: old.version}}) : errorResponse(404, 'NoSuchKey');
    assert.equal(init.method, 'PUT', 'logical deletion must retain a tombstone');
    if (refusal) return refusal();
    if (headers.get('if-none-match') === '*' ? !!old : headers.get('if-match') !== old?.version) return errorResponse(412, 'PreconditionFailed');
    seed(k, init.body, Object.fromEntries([...headers].filter(([name]) => name === 'content-type' || name.startsWith('x-amz-meta-'))));
    if (afterWrite) {const run = afterWrite; afterWrite = undefined; await run();}
    return new Response('', {status: 200});
  };
  return {objects, calls, seed, fetch, setAfterWrite: value => {afterWrite = value;}, refuse: value => {refusal = value;}, store: createOnlineMigrationS3Store({...options, fetch})};
}

test('online S3 reads legacy bytes without changing them and distinguishes logical absence', async () => {
  const f = fixture();
  f.seed(key, '{"legacy":true}');
  const before = Buffer.from(f.objects.get(key).bytes);
  assert.deepEqual(await f.store.read(key, {maxBytes: 100}), {version: f.objects.get(key).version, operationId: null, revision: null, deleted: false, bytes: before, contentType: 'application/json'});
  assert.deepEqual(await f.store.read('state/missing', {maxBytes: 100}), {version: null, operationId: null, revision: null, deleted: true, bytes: null, contentType: null});
  assert.deepEqual(f.objects.get(key).bytes, before);
  assert.deepEqual(f.calls.map(c => c.method), ['GET', 'GET']);
});

test('online S3 operation body prevents equal-value ETag ABA and retains deletion identity', async () => {
  const f = fixture(), first = put(), second = put('2');
  assert.equal(await f.store.putIfVersion(key, null, first), true);
  const a = await f.store.read(key, {maxBytes: 100});
  assert.equal(a.operationId, first.operationId);
  assert.deepEqual(a.bytes, first.bytes);
  assert.equal(await f.store.putIfVersion(key, a.version, second), true);
  const b = await f.store.read(key, {maxBytes: 100});
  assert.notEqual(a.version, b.version, 'same payload is a distinct physical operation');
  assert.equal(await f.store.putIfVersion(key, a.version, put('3')), false, 'late first-generation request cannot win');
  const deletion = {operationId: randomUUID(), revision: '3'};
  assert.equal(await f.store.deleteIfVersion(key, b.version, deletion), true);
  const tombstone = await f.store.read(key, {maxBytes: 0});
  assert.deepEqual(tombstone, {version: f.objects.get(key).version, ...deletion, deleted: true, bytes: null, contentType: null});
  assert.equal(await f.store.putIfVersion(key, null, put('4')), false, 'a delayed create cannot resurrect deleted state');
  assert.equal(await f.store.putIfVersion(key, b.version, put('4')), false, 'a delayed update cannot overwrite the tombstone');
  assert.equal(await f.store.putIfVersion(key, tombstone.version, put('4')), true, 'a new journaled operation can intentionally recreate state');
  assert.ok(f.calls.every(c => c.method !== 'DELETE'));
});

test('online S3 a lost applied response remains uncertain and exposes exact reconciliation evidence', async () => {
  const f = fixture(), mutation = put();
  f.setAfterWrite(() => {throw new Error('lost response');});
  await assert.rejects(f.store.putIfVersion(key, null, mutation), /lost response/);
  const observed = await f.store.read(key, {maxBytes: 100});
  assert.equal(observed.operationId, mutation.operationId);
  assert.equal(observed.revision, mutation.revision);
  assert.deepEqual(observed.bytes, mutation.bytes);
  assert.equal(await f.store.putIfVersion(key, null, mutation), false);
});

test('online S3 late in-flight requests cannot win after retry recovery and newer equal values', async () => {
  const f = fixture(), initial = put();
  await f.store.putIfVersion(key, null, initial);
  const initialVersion = f.objects.get(key).version;
  let release, entered;
  const gated = new Promise(resolve => {release = resolve;});
  const dispatched = new Promise(resolve => {entered = resolve;});
  let delayed = true;
  const store = createOnlineMigrationS3Store({...options, fetch: async (url, init) => {
    if (init.method === 'PUT' && delayed) {delayed = false; entered(); await gated;}
    return f.fetch(url, init);
  }});
  const interrupted = put('2'), later = put('3');
  const oldRequest = store.putIfVersion(key, initialVersion, interrupted);
  await dispatched;
  assert.equal(await store.putIfVersion(key, initialVersion, interrupted), true);
  const recovered = await store.read(key, {maxBytes: 100});
  assert.equal(await store.putIfVersion(key, recovered.version, later), true);
  release();
  assert.equal(await oldRequest, false);
  assert.equal((await store.read(key, {maxBytes: 100})).operationId, later.operationId);

  let releaseDelete, enteredDelete;
  const deletionGate = new Promise(resolve => {releaseDelete = resolve;});
  const deletionDispatched = new Promise(resolve => {enteredDelete = resolve;});
  let delayedDelete = true;
  const deleting = createOnlineMigrationS3Store({...options, fetch: async (url, init) => {
    if (init.method === 'PUT' && delayedDelete) {delayedDelete = false; enteredDelete(); await deletionGate;}
    return f.fetch(url, init);
  }});
  const previous = await deleting.read(key, {maxBytes: 100});
  const deletion = {operationId: randomUUID(), revision: '4'};
  const oldDelete = deleting.deleteIfVersion(key, previous.version, deletion);
  await deletionDispatched;
  assert.equal(await deleting.deleteIfVersion(key, previous.version, deletion), true);
  const tombstone = await deleting.read(key, {maxBytes: 100});
  const recreated = put('5');
  assert.equal(await deleting.putIfVersion(key, tombstone.version, recreated), true);
  releaseDelete();
  assert.equal(await oldDelete, false);
  assert.equal((await deleting.read(key, {maxBytes: 100})).operationId, recreated.operationId);
});

test('online S3 only explicit conditional refusal becomes false', async () => {
  const f = fixture();
  for (const [status, code] of [[412, 'PreconditionFailed'], [409, 'ConditionalRequestConflict']]) {
    f.refuse(() => errorResponse(status, code));
    assert.equal(await f.store.putIfVersion(key, null, put()), false);
  }
  for (const [status, code] of [[412, 'UnknownFailure'], [409, 'OperationAborted'], [503, 'ServiceUnavailable'], [403, 'AccessDenied']]) {
    f.refuse(() => errorResponse(status, code));
    await assert.rejects(f.store.putIfVersion(key, null, put()), {code});
  }
  f.refuse(() => {throw new Error('network unavailable');});
  await assert.rejects(f.store.deleteIfVersion(key, null, {operationId: randomUUID(), revision: '1'}), /network unavailable/);
});

test('online S3 rejects missing bucket, generic missing response and denied reads', async () => {
  for (const response of [() => errorResponse(404, 'NoSuchBucket'), () => new Response('', {status: 404}), () => errorResponse(403, 'AccessDenied')]) {
    const store = createOnlineMigrationS3Store({...options, fetch: async () => response()});
    await assert.rejects(store.read(key, {maxBytes: 100}));
  }
});

test('online S3 refuses partial successful reads and closes invalid responses', async () => {
  for (const [status, headers] of [[206, {etag: '"v"'}], [200, {}], [200, {etag: '*'}]]) {
    let cancelled = false;
    const stream = new ReadableStream({cancel() {cancelled = true;}});
    const store = createOnlineMigrationS3Store({...options, fetch: async () => new Response(stream, {status, headers})});
    await assert.rejects(store.read(key, {maxBytes: 100}));
    assert.equal(cancelled, true);
  }
});

test('online S3 refuses foreign scope and malformed conditional versions before network I/O', async () => {
  const f = fixture();
  for (const wrong of ['raw/capture.json', 'state/../raw', 'state//key', '/state/key', 'state/key/']) await assert.rejects(f.store.read(wrong, {maxBytes: 100}), /scope/);
  for (const version of ['', '*', 'x\r\nx-amz-meta-evil: true']) await assert.rejects(f.store.putIfVersion(key, version, put()), /ETag/);
  for (const rev of ['0', '-1', '01', '9223372036854775808']) await assert.rejects(f.store.putIfVersion(key, null, put(rev)), /revision/);
  assert.equal(f.calls.length, 0);
});

test('online S3 validates source, epoch, key, metadata and payload binding', async t => {
  const f = fixture();
  await f.store.putIfVersion(key, null, put());
  const saved = f.objects.get(key), original = JSON.parse(saved.bytes);
  for (const [name, change] of Object.entries({
    epoch: e => {e.epoch = randomUUID();}, source: e => {e.sourceId = 'foreign';}, key: e => {e.keyHash = '0'.repeat(64);},
    operation: e => {e.operationId = randomUUID();}, revision: e => {e.revision = '0';}, payload: e => {e.payload = Buffer.from('changed').toString('base64');},
    base64: e => {e.payload += '\n';}, extra: e => {e.extra = true;}, tombstone: e => {e.deleted = true;},
  })) await t.test(name, async () => {
    const modified = structuredClone(original); change(modified);
    f.seed(key, JSON.stringify(modified), Object.fromEntries(saved.headers));
    await assert.rejects(f.store.read(key, {maxBytes: 100}));
  });
  for (const name of ['x-amz-meta-opencrawl-state-bridge', 'x-amz-meta-opencrawl-operation-id']) {
    const headers = new Headers(saved.headers); headers.delete(name);
    f.seed(key, saved.bytes, Object.fromEntries(headers));
    await assert.rejects(f.store.read(key, {maxBytes: 100}), /metadata/);
  }
});

test('online S3 enforces both streaming and decoded body limits', async () => {
  const f = fixture();
  f.seed(key, 'too long');
  await assert.rejects(f.store.read(key, {maxBytes: 2}), /read limit/);
  const version = f.objects.get(key).version;
  await f.store.putIfVersion(key, version, put('1', Buffer.from('three')));
  await assert.rejects(f.store.read(key, {maxBytes: 2}), /bound/);
  const stream = new ReadableStream({start(c) {c.enqueue(Buffer.alloc(8)); c.close();}});
  const store = createOnlineMigrationS3Store({...options, fetch: async () => new Response(stream, {headers: {etag: '"v"'}})});
  await assert.rejects(store.read(key, {maxBytes: 2}), /read limit/);
});

test('PostgreSQL journal recovers a lost S3 reply after reconstruction and replays deletion in order', {skip: !postgresUrl}, async t => {
  const database = await applicationDatabaseFixture(t), f = fixture();
  const config = {database, epoch, sourceId: options.sourceId};
  const first = createOnlineJournal(config);
  await first.ready();
  const value = put();
  f.setAfterWrite(() => {throw new Error('connection closed after server applied object');});
  await assert.rejects(first.mutate({operationId: value.operationId, key, condition: {version: null}, mutation: {kind: 'put', bytes: value.bytes, contentType: value.contentType}}, f.store), {code: 'ONLINE_MIGRATION_EXTERNAL_OUTCOME_UNCERTAIN'});
  assert.equal(await first.closedFrontier(), '0');
  const pending = await database.pool.query('SELECT state,dispatched FROM opencrawl_online_migration_journal WHERE namespace=$1 AND operation_id=$2', [database.namespace, value.operationId]);
  assert.deepEqual(pending.rows, [{state: 'pending', dispatched: true}]);
  const writes = f.calls.filter(call => call.method === 'PUT').length;
  const restarted = createOnlineJournal(config);
  await restarted.ready();
  assert.equal((await restarted.reconcile(key, f.store)).state, 'applied');
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, writes, 'exact applied evidence avoids a second write');
  await restarted.mutate({operationId: randomUUID(), key, mutation: {kind: 'delete'}}, f.store);
  const recreated = put();
  await restarted.mutate({operationId: recreated.operationId, key, condition: {version: null}, mutation: {kind: 'put', bytes: recreated.bytes, contentType: recreated.contentType}}, f.store);
  const replayed = [];
  const result = await restarted.replayPage({consumer: 's3-protocol-test', apply: async (_client, intent) => {replayed.push([intent.sequence, intent.mutation.kind, intent.revision]);}});
  assert.deepEqual(replayed, [['1', 'put', '1'], ['2', 'delete', '2'], ['3', 'put', '3']]);
  assert.equal(result.caughtUp, true);
  assert.equal(result.checkpoint, '3');
  const current = await f.store.read(key, {maxBytes: 100});
  assert.equal(current.operationId, recreated.operationId);
  assert.deepEqual(current.bytes, recreated.bytes);
});
