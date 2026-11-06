import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createObjectStore} from '../src/sessions/s3-store.mjs';
import {createConnectorSearch} from '../src/connectors/search.mjs';
import {documentId, digest} from '../src/connectors/scope.mjs';
import {createConnectorWriteBarrier, guardConnectorWrites} from '../src/connectors/write-barrier.mjs';

const defer = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
function fixture() {
  const objects = new Map(); let revision = 0;
  const store = {
    async readVersion(key) {const item = objects.get(key); return item ? {version: item.version, data: Buffer.from(item.data)} : {version: null, data: null};},
    async compareAndSet(key, expected, data) {
      if ((objects.get(key)?.version ?? null) !== expected) return false;
      objects.set(key, {version: String(++revision), data: Buffer.from(data)}); return true;
    },
    async put(key, data) {objects.set(key, {version: String(++revision), data: Buffer.from(data)});},
  };
  const scope = {tenantId: 'tenant_a', connectionId: 'connection_a'};
  return {objects, store, scope, barrier: options => createConnectorWriteBarrier({...scope, store, ...options})};
}

test('close serializes with registration and blocks stale late writers without reopening after restart', async () => {
  const h = fixture(), entered = defer(), continueAcquire = defer();
  let paused = false;
  const writer = h.barrier({store: {...h.store, async compareAndSet(key, version, data) {
    if (!paused && JSON.parse(data).writers.length) {paused = true; entered.resolve(); await continueAcquire.promise;}
    return h.store.compareAndSet(key, version, data);
  }}});
  let writes = 0;
  const writing = writer.run('object-put', async () => {writes++;});
  await entered.promise;
  assert.deepEqual(await h.barrier().close(), {closed: true, closedAt: (await h.barrier().inspect()).closedAt, pending: 0, writers: []});
  continueAcquire.resolve();
  await assert.rejects(writing, /closed/); assert.equal(writes, 0);
  for (const barrier of [writer, h.barrier()]) await assert.rejects(barrier.run('object-put', async () => {writes++;}), /closed/);
  assert.equal(writes, 0);
});

test('held native writes keep deletion pending until positive completion; later writes cannot recreate data', async () => {
  const h = fixture(), entered = defer(), finish = defer();
  const writing = h.barrier().run('object-put', async () => {
    entered.resolve(); await finish.promise; await h.store.put('raw/document', 'private'); return 'written';
  });
  await entered.promise;
  assert.equal((await h.barrier().close()).pending, 1);
  assert.equal((await h.barrier({now: () => 9999999999999}).close()).pending, 1, 'time is not evidence of drain');
  await assert.rejects(h.barrier().run('search-write', async () => assert.fail('late write')), /closed/);
  finish.resolve(); assert.equal(await writing, 'written');
  assert.equal((await h.barrier().close()).pending, 0);
  h.objects.delete('raw/document');
  await assert.rejects(h.barrier().run('object-put', () => h.store.put('raw/document', 'resurrected')), /closed/);
  assert.equal(h.objects.has('raw/document'), false);
});

test('transport ambiguity remains durable across worker restart and cancellation', async () => {
  const h = fixture();
  await assert.rejects(h.barrier().run('object-put', async () => {throw new DOMException('cancelled', 'AbortError');}), error => error.code === 'CONNECTOR_WRITE_PENDING' && typeof error.writeId === 'string');
  const state = await h.barrier().close();
  assert.equal(state.pending, 1); assert.equal(state.writers[0].operation, 'object-put');
  assert.equal(state.writers[0].phase, 'writing'); assert.ok(Number.isSafeInteger(state.writers[0].startedAt));
  assert.equal((await h.barrier({now: () => 9999999999999}).close()).pending, 1);
});

test('lost acquire and settlement responses recover without running the write twice', async () => {
  const h = fixture(); let lost = 0, writes = 0;
  const store = {...h.store, async compareAndSet(key, version, bytes) {
    const state = JSON.parse(bytes), accepted = await h.store.compareAndSet(key, version, bytes);
    if (accepted && lost < 2 && state.writers.length) {lost++; throw new Error('lost successful response');}
    return accepted;
  }};
  assert.equal(await h.barrier({store}).run('object-put', async () => {writes++; return 'ok';}), 'ok');
  assert.equal(writes, 1); assert.equal((await h.barrier().close()).pending, 0);
});

test('durable settled records are reclaimed by a restarted closer after release failure', async () => {
  const h = fixture(); let shouldFail = false;
  const store = {...h.store, async compareAndSet(key, version, bytes) {
    const state = JSON.parse(bytes);
    if (shouldFail && !state.writers.length) throw new Error('release unavailable');
    const accepted = await h.store.compareAndSet(key, version, bytes);
    if (accepted && state.writers.some(writer => writer.phase === 'settled')) shouldFail = true;
    return accepted;
  }};
  await assert.rejects(h.barrier({store}).run('search-write', async () => 'completed'), /acknowledgment needs retry/);
  const state = await h.barrier().inspect();
  assert.equal(state.writers[0].phase, 'settled');
  assert.deepEqual((await h.barrier().close()).writers, []);
});

test('bounded writer records fail closed; failed acquisition never starts a data write', async () => {
  const h = fixture();
  for (let i = 0; i < 128; i++) await assert.rejects(h.barrier().run('object-put', async () => {throw new Error('unknown outcome');}));
  await assert.rejects(h.barrier().run('object-put', () => assert.fail('capacity overflow')), /too many unresolved/);
  assert.equal((await h.barrier().close()).pending, 128);
});

test('colliding connection IDs remain tenant scoped and forged persisted scope fails closed', async () => {
  const h = fixture(), a = h.barrier(), b = h.barrier({tenantId: 'tenant_b'});
  await a.close(); assert.notEqual(a.key, b.key);
  const otherDeployment = h.barrier({namespace: 'other'});
  assert.notEqual(a.key, otherDeployment.key); await otherDeployment.run('object-put', async () => {});
  await b.run('search-write', async () => {});
  assert.throws(() => h.barrier({tenantId: '../other'}), /scope/);
  const raw = await h.store.readVersion(b.key); const state = JSON.parse(raw.data); state.tenantId = 'tenant_a';
  await h.store.compareAndSet(b.key, raw.version, Buffer.from(JSON.stringify(state)));
  await assert.rejects(b.run('object-put', () => assert.fail('forged state')), /scope/);
});

test('guard covers raw, receipts, conditional writes and search; foreign scope never acquires', async () => {
  const h = fixture();
  const binding = {...h.scope, workspaceId: 'T123', provider: 'slack', access: 'team-public', rawPrefix: 'raw/v1/source=slack/workspace=T123/connection=connection_a/'};
  const search = {identity: 'search-a', putDocuments: async () => {}, suppress: async () => {}};
  const guarded = guardConnectorWrites({binding, store: h.store, search});
  assert.throws(() => guarded.store.put('raw/other/document', 'x'), /scope/);
  assert.throws(() => guarded.store.put(binding.rawPrefix + '../escape', 'x'), /scope/);
  assert.throws(() => guarded.search.putDocuments({tenantId: binding.tenantId, captureAccess: 'write'}, binding, []), /capability/);
  assert.throws(() => guarded.store.compareAndSet(guarded.writeBarrier.key, null, 'x'), /scope/);
  assert.throws(() => guarded.search.putDocuments({tenantId: 'other'}, binding, []), /scope/);
  const other = {...binding, connectionId: 'connection_b', rawPrefix: binding.rawPrefix.replace('connection_a/', 'connection_b/')};
  assert.throws(() => guarded.search.putDocuments({tenantId: binding.tenantId}, other, []), /scope/);
  assert.equal(h.objects.size, 0);
  await guarded.store.put(binding.rawPrefix + 'record', 'x');
  await guarded.search.suppress({tenantId: binding.tenantId}, binding, {kind: 'message', sourceId: '1'});
  await guarded.writeBarrier.close();
  await assert.rejects(guarded.store.put(binding.rawPrefix + 'late', 'x'), /closed/);
  await assert.rejects(guarded.store.compareAndSet(binding.rawPrefix + 'late', null, 'x'), /closed/);
  await assert.rejects(guarded.search.putDocuments({tenantId: binding.tenantId}, binding, []), /closed/);
});

function connectorBinding(h) {
  return {...h.scope, workspaceId: 'T123', provider: 'slack', access: 'team-public', rawPrefix: 'raw/v1/source=slack/workspace=T123/connection=connection_a/'};
}
function connectorDocuments(binding, count = 1) {
  return Array.from({length: count}, (_, i) => ({id: documentId(binding, 'message', String(i)), document: {
    tenantId: binding.tenantId, connectionId: binding.connectionId, workspaceId: binding.workspaceId,
    provider: binding.provider, kind: 'message', sourceId: String(i), deleted: false, extractedAt: 1,
    contentHash: 'a'.repeat(64), text: 'Synthetic document ' + i,
  }}));
}

test('maximum valid connector bulk retains bounded durable metadata and completes all documents', async () => {
  const h = fixture(), binding = connectorBinding(h), documents = connectorDocuments(binding, 100);
  let requests = 0, target;
  const search = createConnectorSearch({endpoint: 'http://search.test', tenantId: binding.tenantId, fetch: async (url, options) => {
    requests++;
    const state = await h.barrier().inspect();
    target = JSON.parse(state.writers[0].target);
    assert.ok(Buffer.byteLength(state.writers[0].target) < 200);
    const lines = options.body.trim().split('\n');
    assert.equal(lines.length, 200);
    assert.equal(new Set(lines.filter((_, i) => i % 2 === 0).map(line => JSON.parse(line).update._id)).size, 100);
    return Response.json({errors: false, items: documents.map(() => ({update: {status: 200}}))});
  }});
  const guarded = guardConnectorWrites({binding, store: h.store, search});
  await guarded.search.putDocuments({tenantId: binding.tenantId}, binding, documents);
  assert.equal(requests, 1);
  assert.deepEqual(target, {operation: 'putDocuments', count: 100, idsSha256: digest(documents.map(item => item.id))});
  assert.equal((await guarded.writeBarrier.close()).pending, 0);
});

test('trusted no-mutation refusal settles; status codes and permanent flags alone do not', async () => {
  for (const positive of [true, false]) {
    const h = fixture();
    const error = Object.assign(new Error('denied'), {status: 403, permanent: true, ...(positive ? {writeOutcome: 'not-applied'} : {})});
    await assert.rejects(h.barrier().run('object-put', async () => {throw error;}), result => positive ? result === error : result.code === 'CONNECTOR_WRITE_PENDING');
    assert.equal((await h.barrier().close()).pending, positive ? 0 : 1);
  }
});

test('reference S3 rejects authorization and validation without stranding a writer, but retains ambiguous errors', async () => {
  for (const scenario of [
    {status: 403, code: 'AccessDenied', pending: 0},
    {status: 400, code: 'BadDigest', pending: 0},
    {status: 400, code: 'UnrecognizedFailure', pending: 1},
    {status: 403, code: 'UnknownRefusal', pending: 1},
    {status: 408, code: 'RequestTimeout', pending: 1},
    {status: 500, code: 'InternalError', pending: 1},
    {credentialsError: true, pending: 0},
    {abort: true, pending: 1},
  ]) {
    const h = fixture(), binding = connectorBinding(h);
    let sent = 0;
    const remote = createObjectStore({endpoint: 'http://s3.test', bucket: 'synthetic', credentials: async () => {
      if (scenario.credentialsError) throw new Error('credential lookup failed before PUT');
      return {accessKeyId: 'test', secretAccessKey: 'test'};
    }, fetch: async () => {
      sent++;
      if (scenario.abort) throw new DOMException('cancelled', 'AbortError');
      return new Response('<Error><Code>' + scenario.code + '</Code></Error>', {status: scenario.status});
    }});
    const guarded = guardConnectorWrites({binding, store: {...h.store, put: remote.put}});
    await assert.rejects(guarded.store.put(binding.rawPrefix + 'document', Buffer.from('synthetic')));
    assert.equal(sent, scenario.credentialsError ? 0 : 1);
    assert.equal((await guarded.writeBarrier.close()).pending, scenario.pending, JSON.stringify(scenario));
  }
});

test('reference search settles preflight and definite auth rejection but not partial bulk or uncertain responses', async () => {
  for (const scenario of ['invalid-document', 'oversized-body', 'auth-denied', 'unknown-forbidden', 'partial-bulk', 'bad-response']) {
    const h = fixture(), binding = connectorBinding(h), documents = connectorDocuments(binding, scenario === 'oversized-body' ? 100 : 1);
    let sent = 0;
    if (scenario === 'invalid-document') documents[0].document.connectionId = 'other';
    if (scenario === 'oversized-body') for (const item of documents) item.document.text = 'x'.repeat(50000);
    const search = createConnectorSearch({endpoint: 'http://search.test', tenantId: binding.tenantId, fetch: async () => {
      sent++;
      if (scenario === 'auth-denied') return Response.json({error: {type: 'security_exception'}}, {status: 403});
      if (scenario === 'unknown-forbidden') return Response.json({error: {type: 'unknown'}}, {status: 403});
      if (scenario === 'partial-bulk') return Response.json({errors: true, items: [{update: {status: 400}}]});
      return new Response('invalid JSON');
    }});
    const guarded = guardConnectorWrites({binding, store: h.store, search});
    await assert.rejects(guarded.search.putDocuments({tenantId: binding.tenantId}, binding, documents));
    assert.equal(sent, ['invalid-document', 'oversized-body'].includes(scenario) ? 0 : 1);
    assert.equal((await guarded.writeBarrier.close()).pending, ['invalid-document', 'oversized-body', 'auth-denied'].includes(scenario) ? 0 : 1, scenario);
  }
});
