import {test} from 'node:test';
import assert from 'node:assert/strict';
const modulePath = process.env.OPENCRAWL_ONLINE_OBJECT_STORE_SOURCE || '../dist/src/state/online-object-store.mjs';
const {createOnlineMigrationObjectStore} = await import(modulePath);
const {runOnlineMutationProtocol} = await import(new URL('./online-journal.mjs', new URL(modulePath, import.meta.url)));

const absent = () => ({version: null, operationId: null, revision: null, deleted: true, bytes: null, contentType: null});
const legacy = text => ({version: 'legacy-' + text, operationId: null, revision: null, deleted: false, bytes: Buffer.from(text), contentType: 'text/plain'});
const classify = key => key.startsWith('state/') ? {maxBytes: 1024} : null;
function fixture() {
  const objects = new Map(), calls = [], intents = [], pending = new Map();
  let afterWrite;
  const external = {
    async read(key, options) {
      calls.push(['read', key, options]);
      const value = objects.get(key) || absent();
      if (value.bytes?.length > options.maxBytes) throw Error('read bound');
      return {...value, bytes: value.bytes && Buffer.from(value.bytes)};
    },
    async putIfVersion(key, expected, mutation) {
      calls.push(['putIfVersion', key, expected, mutation.operationId]);
      if ((objects.get(key)?.version ?? null) !== expected) return false;
      objects.set(key, {version: 'operation-' + mutation.operationId, operationId: mutation.operationId, revision: mutation.revision, deleted: false, bytes: Buffer.from(mutation.bytes), contentType: mutation.contentType});
      if (afterWrite) {const run = afterWrite; afterWrite = undefined; await run();}
      return true;
    },
    async deleteIfVersion(key, expected, mutation) {
      calls.push(['deleteIfVersion', key, expected, mutation.operationId]);
      if ((objects.get(key)?.version ?? null) !== expected) return false;
      objects.set(key, {version: 'tombstone-' + mutation.operationId, ...mutation, deleted: true, bytes: null, contentType: null});
      return true;
    },
  };
  const process = intent => runOnlineMutationProtocol(intent, external, {
    dispatch: async () => {calls.push(['dispatch', intent.operationId]); intent.dispatched = true;},
    finish: async (state, resultVersion) => {calls.push(['finish', intent.operationId]); Object.assign(intent, {state, resultVersion}); pending.delete(intent.key); return intent;},
  });
  const journal = {
    async reconcile(key, store) {assert.equal(store, external); calls.push(['reconcile', key]); const i = pending.get(key); return i ? process(i) : null;},
    async mutate(request, store) {
      assert.equal(store, external); calls.push(['mutate', request.key]);
      if (pending.has(request.key)) throw Object.assign(Error('pending key'), {code: 'ONLINE_MIGRATION_UNRESOLVED_INTENT'});
      const observed = objects.get(request.key) || absent();
      const permitted = !request.condition || (request.condition.version === null ? observed.deleted : !observed.deleted && request.condition.version === observed.version);
      const intent = {...request, namespace: 'fixture', epoch: '11111111-1111-4111-8111-111111111111', sourceId: 'fixture',
        sequence: String(intents.length + 1), revision: String(intents.length + 1), expectedVersion: observed.version,
        state: permitted ? 'pending' : 'notApplied', dispatched: false, resultVersion: null, requestHash: 'a'.repeat(64)};
      intents.push(intent);
      if (permitted) pending.set(request.key, intent);
      return process(intent);
    },
  };
  const raw = {
    bucket: 'fixture',
    async get(...args) {calls.push(['raw.get', ...args]); return Buffer.from('raw');},
    async has(...args) {calls.push(['raw.has', ...args]); return true;},
    async readVersion(...args) {calls.push(['raw.readVersion', ...args]); return {version: 7, data: Buffer.from('raw')};},
    async put(...args) {calls.push(['raw.put', ...args]);},
    async compareAndSet(...args) {calls.push(['raw.compareAndSet', ...args]); return false;},
    async delete(...args) {calls.push(['raw.delete', ...args]);},
    async listPage(...args) {calls.push(['raw.listPage', ...args]); return {keys: [], nextToken: null};},
  };
  const sourceId = 'fixture', writeAuthority = {run: async (_context, callbacks) => callbacks.journal()};
  return {objects, calls, intents, pending, raw, external, journal, sourceId, writeAuthority, setAfterWrite: run => {afterWrite = run;},
    store: createOnlineMigrationObjectStore({raw, external, journal, classify, sourceId, writeAuthority})};
}

test('raw methods preserve their bytes, versions, options and return values without journal reads', async () => {
  const f = fixture(), key = 'raw/events.json', bytes = Buffer.from('raw'), options = {maxBytes: 512};
  assert.equal(f.store.bucket, f.raw.bucket);
  assert.deepEqual(await f.store.get(key, options), bytes);
  assert.equal(await f.store.has(key, options), true);
  assert.deepEqual(await f.store.readVersion(key, options), {version: 7, data: bytes});
  await f.store.put(key, bytes);
  assert.equal(await f.store.compareAndSet(key, 7, bytes), false);
  await f.store.delete(key);
  assert.deepEqual(f.calls.map(c => c[0]), ['raw.get', 'raw.has', 'raw.readVersion', 'raw.put', 'raw.compareAndSet', 'raw.delete']);
  assert.equal(f.calls[0][2], options);
  assert.equal(f.calls[3][2], bytes);
  assert.equal(f.calls[3][3], undefined, 'raw default content type is not changed');
  assert.equal(f.calls[4][2], 7);
  assert.equal(f.intents.length, 0);
});

test('mutable legacy reads and journaled put expose logical bytes and a new physical version', async () => {
  const f = fixture(), key = 'state/key'; f.objects.set(key, legacy('old'));
  assert.deepEqual(await f.store.readVersion(key), {version: 'legacy-old', data: Buffer.from('old')});
  await f.store.put(key, Buffer.from('new'), 'text/plain');
  assert.equal(f.intents.length, 1);
  assert.match(f.intents[0].operationId, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
  assert.equal(f.intents[0].state, 'applied');
  assert.deepEqual(await f.store.get(key), Buffer.from('new'));
  assert.equal(await f.store.has(key), true);
  assert.equal((await f.store.readVersion(key)).version, f.objects.get(key).version);
  assert.ok(!f.calls.some(c => c[0].startsWith('raw.')));
});

test('CAS preserves definite conflict false and tombstone is logical absence for recreate', async () => {
  const f = fixture(), key = 'state/key'; f.objects.set(key, legacy('old'));
  assert.equal(await f.store.compareAndSet(key, 'wrong', Buffer.from('wrong')), false);
  assert.equal(f.objects.get(key).bytes.toString(), 'old');
  assert.equal(await f.store.compareAndSet(key, 'legacy-old', Buffer.from('new')), true);
  await f.store.delete(key);
  const tombstone = f.objects.get(key);
  assert.equal(tombstone.deleted, true); assert.notEqual(tombstone.version, null);
  assert.equal(await f.store.get(key), null); assert.equal(await f.store.has(key), false);
  assert.deepEqual(await f.store.readVersion(key), {version: null, data: null});
  assert.equal(await f.store.compareAndSet(key, null, Buffer.from('recreated')), true);
  assert.equal(f.intents.at(-1).expectedVersion, tombstone.version, 'logical absence still CASes the physical tombstone');
  assert.equal((await f.store.get(key)).toString(), 'recreated');
  assert.ok(!f.calls.some(c => c[0] === 'raw.delete'));
});

test('uncertain applied write is reconciled before a different operation is issued', async () => {
  const f = fixture(), key = 'state/key'; f.setAfterWrite(() => {throw Error('response lost');});
  await assert.rejects(f.store.put(key, Buffer.from('first')), {code: 'ONLINE_MIGRATION_EXTERNAL_OUTCOME_UNCERTAIN'});
  assert.equal(f.intents[0].state, 'pending'); const firstId = f.intents[0].operationId;
  await f.store.put(key, Buffer.from('second'));
  assert.equal(f.intents[0].state, 'applied'); assert.equal(f.intents[1].state, 'applied');
  assert.notEqual(f.intents[1].operationId, firstId);
  assert.ok(f.calls.findIndex(c => c[0] === 'finish' && c[1] === firstId) < f.calls.findLastIndex(c => c[0] === 'mutate'));
  assert.equal(f.calls.filter(c => c[0] === 'putIfVersion').length, 2, 'recovery reads the applied intent instead of rewriting it');
});

test('unresolved reconciliation, returned pending and conditional uncertainty never report success or conflict', async () => {
  for (const operation of ['put', 'delete', 'compareAndSet']) {
    const f = fixture(); let mutations = 0;
    f.journal.reconcile = async () => ({state: 'pending'});
    f.journal.mutate = async () => {mutations++; return {state: 'applied'};};
    const invoke = () => operation === 'compareAndSet' ? f.store.compareAndSet('state/k', null, Buffer.from('x')) : operation === 'put' ? f.store.put('state/k', Buffer.from('x')) : f.store.delete('state/k');
    await assert.rejects(invoke(), {code: 'ONLINE_OBJECT_STORE_PENDING_RECONCILIATION'}); assert.equal(mutations, 0);
    f.journal.reconcile = async () => null;
    f.journal.mutate = async () => ({state: 'pending'});
    await assert.rejects(invoke(), {code: 'ONLINE_OBJECT_STORE_PENDING_MUTATION'});
    f.journal.mutate = async () => {throw Error('ambiguous transport');};
    await assert.rejects(invoke(), /ambiguous transport/);
  }
});

test('unconditional writes reject a definite non-application rather than silently succeeding', async () => {
  const f = fixture(); f.journal.mutate = async () => ({state: 'notApplied'});
  for (const promise of [f.store.put('state/k', Buffer.from('x')), f.store.delete('state/k')]) await assert.rejects(promise, {code: 'ONLINE_OBJECT_STORE_NOT_APPLIED', writeOutcome: 'not-applied'});
  assert.equal(await f.store.compareAndSet('state/k', null, Buffer.from('x')), false);
});

test('caller payload mutation while reconcile waits cannot change the new operation bytes', async () => {
  const f = fixture(); let release; const wait = new Promise(resolve => {release = resolve;});
  f.journal.reconcile = async () => {await wait; return null;};
  const bytes = Buffer.from('original'); const pending = f.store.put('state/key', bytes, 'text/plain');
  bytes.fill(0); release(); await pending;
  assert.equal(f.intents[0].mutation.bytes.toString(), 'original');
});

test('pending operation arriving between reconcile and mutate fails closed without retrying or overwriting', async () => {
  const f = fixture(); let entered; const ready = new Promise(resolve => {entered = resolve;});
  let release; const wait = new Promise(resolve => {release = resolve;});
  f.setAfterWrite(async () => {entered(); await wait;});
  const first = f.store.put('state/key', Buffer.from('first')); await ready;
  f.journal.reconcile = async () => null; // A competing pending intent may appear after that separate lock releases.
  await assert.rejects(f.store.put('state/key', Buffer.from('second')), {code: 'ONLINE_MIGRATION_UNRESOLVED_INTENT'});
  assert.equal(f.intents.length, 1); release(); await first;
  assert.equal(f.objects.get('state/key').bytes.toString(), 'first');
});

test('list filters tombstones using one bounded page and preserves empty-page continuation and prefixes', async () => {
  const f = fixture(); await f.store.delete('state/deleted'); f.objects.set('state/live', legacy('live'));
  let pages = 0; const options = {maxKeys: 3, continuationToken: 'incoming', delimiter: '/'};
  f.raw.listPage = async (prefix, actual) => {pages++; assert.equal(actual, options); return {keys: ['raw/events', 'state/deleted', 'state/live'], prefixes: ['state/sub/'], nextToken: 'next'};};
  f.calls.length = 0;
  assert.deepEqual(await f.store.listPage('', options), {keys: ['raw/events', 'state/live'], prefixes: ['state/sub/'], nextToken: 'next'});
  assert.equal(pages, 1); assert.deepEqual(f.calls.map(c => c[1]), ['state/deleted', 'state/live']);
  assert.ok(f.calls.every(c => c[2].maxBytes === 1024));
  f.raw.listPage = async () => {pages++; return {keys: ['state/deleted'], nextToken: 'last'};};
  assert.deepEqual(await f.store.listPage('state/', {maxKeys: 1}), {keys: [], nextToken: 'last'});
  assert.equal(pages, 2, 'empty result does not fetch another physical page');
});

test('invalid or oversized pages and mutable bodies reject before unbounded work', async () => {
  const f = fixture(); f.objects.set('state/key', legacy('long'));
  await assert.rejects(f.store.get('state/key', {maxBytes: 2}), /read bound/);
  await assert.rejects(f.store.put('state/key', Buffer.alloc(1025)), {code: 'ONLINE_OBJECT_STORE_PAYLOAD_LIMIT'});
  await assert.rejects(f.store.compareAndSet('state/key', '*', Buffer.from('x')), {code: 'ONLINE_OBJECT_STORE_INVALID_VERSION'});
  assert.equal(f.intents.length, 0);
  await assert.rejects(f.store.listPage('state/', {maxKeys: 1001}), {code: 'ONLINE_OBJECT_STORE_INVALID_PAGE_LIMIT'});
  f.raw.listPage = async () => ({keys: ['state/1', 'state/2'], nextToken: null});
  f.calls.length = 0;
  await assert.rejects(f.store.listPage('state/', {maxKeys: 1}), {code: 'ONLINE_OBJECT_STORE_INVALID_RAW_PAGE'});
  assert.equal(f.calls.length, 0);
  f.raw.listPage = async () => ({keys: ['foreign/key'], nextToken: null});
  await assert.rejects(f.store.listPage('state/'), {code: 'ONLINE_OBJECT_STORE_INVALID_RAW_PAGE'});
});

test('purge passes raw selectors/read hooks but rejects mutable versions and tombstones before physical delete', async () => {
  const f = fixture(), deleted = [], hooks = [];
  const entries = [{key: 'raw/one', marker: false}, {key: 'state/dead', marker: true}];
  f.raw.purgePrefix = async (prefix, options) => {
    for (const row of entries) {
      if (!options.select(row.key)) continue;
      const read = async () => Buffer.from('version bytes');
      if (options.selectVersion && (row.marker || !await options.selectVersion(row.key, read))) continue;
      if (!row.marker) await options.beforeDelete?.(row.key, read);
      deleted.push(row.key);
    }
    return deleted.length;
  };
  const store = createOnlineMigrationObjectStore({...f, classify});
  assert.equal(await store.purgePrefix('', {select: key => key.startsWith('raw/'), selectVersion: async (key, read) => {hooks.push(['version', key, (await read()).toString()]); return true;}, beforeDelete: async (key, read) => {hooks.push(['before', key, (await read()).toString()]);}}), 1);
  assert.deepEqual(deleted, ['raw/one']); assert.equal(hooks.length, 2);
  deleted.length = 0; entries.splice(0, 1);
  await assert.rejects(store.purgePrefix('state/'), {code: 'ONLINE_OBJECT_STORE_MUTABLE_PHYSICAL_PURGE_DENIED'});
  assert.deepEqual(deleted, []);
  entries[0].marker = false;
  await assert.rejects(store.purgePrefix('state/', {selectVersion: async () => true}), {code: 'ONLINE_OBJECT_STORE_MUTABLE_PHYSICAL_PURGE_DENIED'});
  assert.deepEqual(deleted, []);
});

test('invalid classifier or external result cannot grant mutable success', async () => {
  const f = fixture();
  for (const maxBytes of [0, NaN, 64 * 1024 * 1024 + 1]) {
    const store = createOnlineMigrationObjectStore({...f, classify: () => ({maxBytes})});
    await assert.rejects(store.get('state/key'), {code: 'ONLINE_OBJECT_STORE_INVALID_CLASSIFICATION'});
  }
  for (const value of [{...absent(), bytes: Buffer.from('not absent')}, {...legacy('x'), version: null}, {...legacy('x'), bytes: Buffer.alloc(1025)}]) {
    f.external.read = async () => value;
    await assert.rejects(f.store.readVersion('state/key'), {code: 'ONLINE_OBJECT_STORE_INVALID_EXTERNAL_READ'});
  }
});

test('known streaming/access/location capabilities are explicit and raw stream cancellation propagates', async () => {
  const f = fixture(), chunks = [Buffer.from('one'), Buffer.from('two')], options = {maxBytes: 20};
  let closed = false, access = 0;
  f.raw.location = 'fixture-location';
  f.raw.checkAccess = async function() {assert.equal(this, f.raw); access++;};
  f.raw.read = async function*(key, actual) {
    assert.equal(this, f.raw); assert.equal(key, 'raw/key'); assert.equal(actual, options);
    try {yield* chunks;} finally {closed = true;}
  };
  f.raw.unsafePhysicalDelete = async () => {throw Error('must not be exposed');};
  const store = createOnlineMigrationObjectStore({...f, classify});
  assert.equal(store.location, 'fixture-location'); await store.checkAccess(); assert.equal(access, 1);
  assert.equal(store.unsafePhysicalDelete, undefined);
  for await (const bytes of store.read('raw/key', options)) {assert.equal(bytes, chunks[0]); break;}
  assert.equal(closed, true); assert.equal(f.calls.length, 0, 'raw streaming never unwraps or uses journal');
  await store.put('state/key', Buffer.from('logical'), 'text/plain');
  assert.deepEqual(await Array.fromAsync(store.read('state/key')), [Buffer.from('logical')]);
  await store.delete('state/key');
  await assert.rejects(Array.fromAsync(store.read('state/key')), {code: 'ONLINE_OBJECT_STORE_SOURCE_NOT_AVAILABLE'});
  await assert.rejects(Array.fromAsync(store.read('state/missing')), {code: 'ONLINE_OBJECT_STORE_SOURCE_NOT_AVAILABLE'});
});

test('listing caps requests at one page and concurrency eight while preserving byte order', async () => {
  const f = fixture(); const keys = Array.from({length: 1000}, (_v, n) => 'state/' + String(n).padStart(4, '0'));
  let pages = 0, reads = 0, active = 0, peak = 0;
  f.raw.listPage = async () => {pages++; return {keys, nextToken: 'unfollowed'};};
  f.external.read = async (key, {maxBytes}) => {
    assert.equal(maxBytes, 1024); reads++; active++; peak = Math.max(peak, active);
    const n = Number(key.slice(6)); await new Promise(resolve => setTimeout(resolve, n % 3)); active--;
    return n % 7 === 0 ? absent() : legacy(String(n));
  };
  const page = await f.store.listPage('state/');
  assert.equal(pages, 1); assert.equal(reads, 1000); assert.equal(peak, 8); assert.equal(active, 0);
  assert.equal(page.nextToken, 'unfollowed'); assert.deepEqual(page.keys, keys.filter((_k, n) => n % 7 !== 0));
  f.raw.listPage = async () => ({keys: ['raw/one', 'raw/two'], nextToken: null});
  reads = 0; assert.deepEqual((await f.store.listPage('raw/')).keys, ['raw/one', 'raw/two']); assert.equal(reads, 0);
});

test('listing failure drains in-flight reads, issues no extra work and never returns a partial page', async () => {
  const f = fixture(); let released, entered; const gate = new Promise(resolve => {released = resolve;});
  const started = new Promise(resolve => {entered = resolve;}); let reads = 0, active = 0;
  f.raw.listPage = async () => ({keys: Array.from({length: 100}, (_v, n) => 'state/' + n), nextToken: 'next'});
  f.external.read = async key => {
    reads++; active++; if (reads === 8) entered();
    if (key === 'state/0') {active--; throw Error('failed bounded source read');}
    await gate; active--; return legacy(key);
  };
  let settled = false; const pending = f.store.listPage('state/').finally(() => {settled = true;});
  await started; await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(reads, 8); assert.equal(active, 7);
  released(); await assert.rejects(pending, /failed bounded source read/);
  assert.equal(reads, 8); assert.equal(active, 0);
});

test('compatible readers work before activation and without write authority while mutable writes fail closed', async () => {
  const f = fixture(), reader = createOnlineMigrationObjectStore({...f, journal: undefined, writeAuthority: undefined, classify});
  await f.store.put('state/active', Buffer.from('wrapped'));
  await f.store.put('state/deleted', Buffer.from('gone')); await f.store.delete('state/deleted');
  assert.equal((await reader.get('state/active')).toString(), 'wrapped'); assert.equal(await reader.get('state/deleted'), null);
  const prior = f.calls.length;
  await assert.rejects(reader.put('state/new', Buffer.from('x')), {code: 'ONLINE_OBJECT_STORE_WRITE_AUTHORITY_NOT_CONFIGURED'});
  await assert.rejects(reader.compareAndSet('state/new', null, Buffer.from('x')), {code: 'ONLINE_OBJECT_STORE_WRITE_AUTHORITY_NOT_CONFIGURED'});
  await assert.rejects(reader.delete('state/active'), {code: 'ONLINE_OBJECT_STORE_WRITE_AUTHORITY_NOT_CONFIGURED'});
  assert.equal(f.calls.length, prior);
  await reader.put('raw/batch', Buffer.from('raw')); assert.equal(f.calls.at(-1)[0], 'raw.put');
});

test('authority selects the entire legacy mutation before activation and payload freezes before its wait', async () => {
  const f = fixture(), contexts = []; let selected;
  const writeAuthority = {run: async (context, callbacks) => {contexts.push(context); await new Promise(resolve => {selected = resolve;}); return callbacks.legacy();}};
  const store = createOnlineMigrationObjectStore({...f, journal: undefined, writeAuthority, classify});
  const bytes = Buffer.from('original'), put = store.put('state/key', bytes, 'text/plain'); bytes.fill(120); selected(); await put;
  assert.deepEqual(contexts, [{sourceId: 'fixture', key: 'state/key'}]);
  assert.equal(f.calls.at(-1)[0], 'raw.put'); assert.equal(f.calls.at(-1)[2].toString(), 'original'); assert.equal(f.intents.length, 0);
  const cas = store.compareAndSet('state/key', 'before', Buffer.from('next')); selected(); assert.equal(await cas, false);
  const deletion = store.delete('state/key'); selected(); await deletion; assert.equal(f.calls.at(-1)[0], 'raw.delete');
});

test('write routing rejects missing journal and duplicate or skipped authority callbacks', async () => {
  const f = fixture();
  const missing = createOnlineMigrationObjectStore({...f, journal: undefined, classify});
  await assert.rejects(missing.put('state/key', Buffer.from('x')), {code: 'ONLINE_OBJECT_STORE_JOURNAL_NOT_CONFIGURED'});
  const twice = createOnlineMigrationObjectStore({...f, classify, writeAuthority: {run: async (_context, callbacks) => {await callbacks.journal(); return callbacks.legacy();}}});
  await assert.rejects(twice.put('state/key', Buffer.from('x')), {code: 'ONLINE_OBJECT_STORE_AUTHORITY_CALLBACK_REUSED'});
  assert.ok(!f.calls.some(call => call[0] === 'raw.put'));
  const skipped = createOnlineMigrationObjectStore({...f, classify, writeAuthority: {run: async () => undefined}});
  await assert.rejects(skipped.put('state/key', Buffer.from('x')), {code: 'ONLINE_OBJECT_STORE_AUTHORITY_CALLBACK_NOT_RUN'});
});

test('object routing refuses early return, late dispatch and swallowed mutation errors', async () => {
  const f = fixture(); let selected, finish;
  const late = createOnlineMigrationObjectStore({...f, classify, writeAuthority: {run: async (_context, callbacks) => {selected = callbacks.legacy;}}});
  await assert.rejects(late.put('state/key', Buffer.from('x')), {code: 'ONLINE_OBJECT_STORE_AUTHORITY_CALLBACK_NOT_RUN'});
  assert.throws(() => selected(), {code: 'ONLINE_OBJECT_STORE_AUTHORITY_CALLBACK_REUSED'});
  f.raw.put = async () => {await new Promise(resolve => {finish = resolve;});};
  const early = createOnlineMigrationObjectStore({...f, classify, writeAuthority: {run: async (_context, callbacks) => {callbacks.legacy();}}});
  await assert.rejects(early.put('state/key', Buffer.from('x')), {code: 'ONLINE_OBJECT_STORE_AUTHORITY_CALLBACK_NOT_AWAITED'}); finish();
  f.raw.put = async () => {throw Error('external outcome unknown');};
  const swallowed = createOnlineMigrationObjectStore({...f, classify, writeAuthority: {run: async (_context, callbacks) => {try {await callbacks.legacy();} catch {} return true;}}});
  await assert.rejects(swallowed.put('state/key', Buffer.from('x')), /external outcome unknown/);
});
