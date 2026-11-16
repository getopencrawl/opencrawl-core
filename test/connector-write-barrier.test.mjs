import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
import {createPostgresWriteBarrier,ensureWriteBarrierSchema} from '../dist/src/state/write-barriers.mjs';
import {gunzipSync} from 'node:zlib';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createObjectStore} from '../dist/src/sessions/s3-store.mjs';
import {createConnectorSearch} from '../dist/src/connectors/search.mjs';
import {documentId, digest} from '../dist/src/connectors/scope.mjs';
import {createConnectorWriteBarrier, guardConnectorWrites} from '../dist/src/connectors/write-barrier.mjs';

const live=(name,run)=>test(name,{skip:!postgresUrl},run);
const defer = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
async function fixture(t) {
  const database=await applicationDatabaseFixture(t);await ensureWriteBarrierSchema(database);
  const state={namespace:database.namespace,writeBarrier:scope=>createPostgresWriteBarrier({...scope,database})};
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
  return {objects,store,scope,state,database,barrier:options=>createPostgresWriteBarrier({...scope,database,...options})};
}

live('close serializes with registration and blocks stale late writers without reopening after restart',async t=>{
  const h=await fixture(t),entered=defer(),continueAcquire=defer();let once=true,writes=0;
  const delayed={...h.database,transaction:async run=>{if(once){once=false;entered.resolve();await continueAcquire.promise;}return h.database.transaction(run);}};
  const writer=h.barrier({database:delayed}),writing=writer.run('object-put',async()=>{writes++;});await entered.promise;
  assert.equal((await h.barrier().close()).pending,0);continueAcquire.resolve();await assert.rejects(writing,/closed/);
  for(const barrier of [writer,h.barrier()])await assert.rejects(barrier.run('object-put',async()=>{writes++;}),/closed/);assert.equal(writes,0);
});

live('held native writes keep deletion pending until positive completion; later writes cannot recreate data', async t => {
  const h = await fixture(t), entered = defer(), finish = defer();
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

live('transport ambiguity remains durable across worker restart and cancellation', async t => {
  const h = await fixture(t);
  await assert.rejects(h.barrier().run('object-put', async () => {throw new DOMException('cancelled', 'AbortError');}), error => error.code === 'CONNECTOR_WRITE_PENDING' && typeof error.writeId === 'string');
  const state = await h.barrier().close();
  assert.equal(state.pending, 1); assert.equal(state.writers[0].operation, 'object-put');
  assert.equal(state.writers[0].phase, 'writing'); assert.ok(Number.isSafeInteger(state.writers[0].startedAt));
  assert.equal((await h.barrier({now: () => 9999999999999}).close()).pending, 1);
});

live('lost acquire and settlement responses recover without running the write twice',async t=>{
  const h=await fixture(t),lost=new Set();let writes=0;
  const uncertain={...h.database,transaction:async run=>{const result=await h.database.transaction(run);const row=(await h.database.pool.query('SELECT phase FROM opencrawl_resource_writers WHERE namespace=$1 LIMIT 1',[h.database.namespace])).rows[0];if(row&&!lost.has(row.phase)){lost.add(row.phase);throw new Error('lost successful response');}return result;}};
  assert.equal(await h.barrier({database:uncertain}).run('object-put',async()=>{writes++;return 'ok';}),'ok');assert.equal(writes,1);assert.deepEqual([...lost].sort(),['settled','writing']);assert.equal((await h.barrier().close()).pending,0);
});

live('durable settled records are reclaimed by a restarted closer after release failure',async t=>{
  const h=await fixture(t);let settled=false;
  const failing={...h.database,transaction:async run=>{
    const value=await h.database.transaction(client=>run({...client,query:(...args)=>{if(settled&&String(args[0]).startsWith('DELETE FROM opencrawl_resource_writers'))throw new Error('release unavailable');return client.query(...args);}}));
    settled=Boolean((await h.database.pool.query("SELECT 1 FROM opencrawl_resource_writers WHERE namespace=$1 AND phase='settled'",[h.database.namespace])).rowCount);return value;
  }};
  await assert.rejects(h.barrier({database:failing}).run('search-write',async()=>'completed'),/acknowledgment needs reconciliation/);
  assert.equal((await h.barrier().inspect()).writers[0].phase,'settled');assert.deepEqual((await h.barrier().close()).writers,[]);
});

live('normalized writer rows retain every unresolved receipt beyond the old object limit',async t=>{
  const h=await fixture(t);for(let i=0;i<129;i++)await assert.rejects(h.barrier().run('object-put',async()=>{throw new Error('unknown outcome');}),{code:'CONNECTOR_WRITE_PENDING'});
  assert.equal((await h.barrier().close()).pending,129);assert.equal(h.objects.size,0);
});

live('colliding connection IDs remain tenant scoped and forged persisted scope fails closed', async t => {
  const h = await fixture(t), a = h.barrier(), b = h.barrier({tenantId: 'tenant_b'});
  await a.close(); assert.notEqual(a.key, b.key);
  const otherDeployment = h.barrier({namespace: 'other'});
  assert.notEqual(a.key, otherDeployment.key); await otherDeployment.run('object-put', async () => {});
  await b.run('search-write', async () => {});
  assert.throws(() => h.barrier({tenantId: '../other'}), /scope/);
  await h.database.pool.query('UPDATE opencrawl_write_fences SET tenant_id=$3 WHERE namespace=$1 AND fence_key=$2',[h.database.namespace,b.key,'tenant_a']);
  await assert.rejects(b.run('object-put', () => assert.fail('forged state')), /scope/);
});

live('guard covers raw bytes, conditional writes and search; app metadata and foreign scope never acquire', async t => {
  const h = await fixture(t);
  const binding = {...h.scope, workspaceId: 'T123', provider: 'slack', access: 'team-public', rawPrefix: 'raw/v1/source=slack/workspace=T123/connection=connection_a/'};
  const search = {identity: 'search-a', putDocuments: async () => {}, suppress: async () => {}};
  const guarded = guardConnectorWrites({binding,state:h.state, store: h.store, search});
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

live('maximum valid connector bulk retains bounded durable metadata and completes all documents', async t => {
  const h = await fixture(t), binding = connectorBinding(h), documents = connectorDocuments(binding, 100);
  let requests = 0, target;
  const search = createConnectorSearch({endpoint: 'http://search.test', tenantId: binding.tenantId, fetch: async (url, options) => {
    requests++;
    const state = await h.barrier().inspect();
    target = JSON.parse(state.writers[0].target);
    assert.ok(Buffer.byteLength(state.writers[0].target) < 200);
    const body = options.headers['content-encoding']==='gzip' ? gunzipSync(options.body).toString() : options.body;
    const lines = body.trim().split('\n');
    assert.equal(lines.length, 200);
    assert.equal(new Set(lines.filter((_, i) => i % 2 === 0).map(line => JSON.parse(line).update._id)).size, 100);
    return Response.json({errors: false, items: documents.map(() => ({update: {status: 200}}))});
  }});
  const guarded = guardConnectorWrites({binding,state:h.state, store: h.store, search});
  await guarded.search.putDocuments({tenantId: binding.tenantId}, binding, documents);
  assert.equal(requests, 1);
  assert.deepEqual(target, {operation: 'putDocuments', count: 100, idsSha256: digest(documents.map(item => item.id))});
  assert.equal((await guarded.writeBarrier.close()).pending, 0);
});

live('trusted no-mutation refusal settles; status codes and permanent flags alone do not', async t => {
  for (const positive of [true, false]) {
    const h = await fixture(t);
    const error = Object.assign(new Error('denied'), {status: 403, permanent: true, ...(positive ? {writeOutcome: 'not-applied'} : {})});
    await assert.rejects(h.barrier().run('object-put', async () => {throw error;}), result => positive ? result === error : result.code === 'CONNECTOR_WRITE_PENDING');
    assert.equal((await h.barrier().close()).pending, positive ? 0 : 1);
  }
});

live('reference S3 rejects authorization and validation without stranding a writer, but retains ambiguous errors', async t => {
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
    const h = await fixture(t), binding = connectorBinding(h);
    let sent = 0;
    const remote = createObjectStore({endpoint: 'http://s3.test', bucket: 'synthetic', credentials: async () => {
      if (scenario.credentialsError) throw new Error('credential lookup failed before PUT');
      return {accessKeyId: 'test', secretAccessKey: 'test'};
    }, fetch: async () => {
      sent++;
      if (scenario.abort) throw new DOMException('cancelled', 'AbortError');
      return new Response('<Error><Code>' + scenario.code + '</Code></Error>', {status: scenario.status});
    }});
    const guarded = guardConnectorWrites({binding,state:h.state, store: {...h.store, put: remote.put}});
    await assert.rejects(guarded.store.put(binding.rawPrefix + 'document', Buffer.from('synthetic')));
    assert.equal(sent, scenario.credentialsError ? 0 : 1);
    assert.equal((await guarded.writeBarrier.close()).pending, scenario.pending, JSON.stringify(scenario));
  }
});

live('reference search settles preflight and definite auth rejection but not partial bulk or uncertain responses', async t => {
  for (const scenario of ['invalid-document', 'oversized-item', 'auth-denied', 'unknown-forbidden', 'partial-bulk', 'bad-response']) {
    const h = await fixture(t), binding = connectorBinding(h), documents = connectorDocuments(binding, 1);
    let sent = 0;
    if (scenario === 'invalid-document') documents[0].document.connectionId = 'other';
    if (scenario === 'oversized-item') documents[0].document.text = 'x'.repeat(5*1024*1024);
    const search = createConnectorSearch({endpoint: 'http://search.test', tenantId: binding.tenantId, fetch: async () => {
      sent++;
      if (scenario === 'auth-denied') return Response.json({error: {type: 'security_exception'}}, {status: 403});
      if (scenario === 'oversized-item') return new Response('Provider request limit', {status:413});
      if (scenario === 'unknown-forbidden') return Response.json({error: {type: 'unknown'}}, {status: 403});
      if (scenario === 'partial-bulk') return Response.json({errors: true, items: [{update: {status: 400}}]});
      return new Response('invalid JSON');
    }});
    const guarded = guardConnectorWrites({binding,state:h.state, store: h.store, search});
    await assert.rejects(guarded.search.putDocuments({tenantId: binding.tenantId}, binding, documents));
    assert.equal(sent, scenario === 'invalid-document' ? 0 : 1);
    assert.equal((await guarded.writeBarrier.close()).pending, ['invalid-document', 'oversized-item', 'auth-denied'].includes(scenario) ? 0 : 1, scenario);
  }
});
