import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Pool} from 'pg';
import {createOnlineWriteAuthority, rejectOnlineLegacyMutation} from '../dist/src/state/online-authority.mjs';
import {createOnlineJournal} from '../dist/src/state/online-journal.mjs';
const url = process.env.OPENCRAWL_TEST_POSTGRES_URL;
const live = (name, run) => test(name, {skip: !url, timeout: 15_000}, run);
const preparation = 'a'.repeat(64), enrollment = 'b'.repeat(64), context = {sourceId: 'bucket', key: 'state/key'};
function signal() {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};}
async function fixture(t, max = 4) {
  const admin = new Pool({connectionString: url, max: 2}), schema = 'authority_' + randomUUID().replaceAll('-', '');
  await admin.query('CREATE SCHEMA ' + schema);
  const pool = new Pool({connectionString: url, max, options: '-c search_path=' + schema, application_name: schema});
  const database = {pool, namespace: 'test-' + randomUUID()}, epoch = randomUUID(), protocol = 'compat-v1';
  const authority = createOnlineWriteAuthority({database, epoch, protocol});
  t.after(async () => {await pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end();});
  await authority.prepare({receiptHash: preparation});
  const activate = () => authority.activate({receiptHash: enrollment, verify: async binding => ({...binding, receiptHash: enrollment})});
  return {admin, schema, pool, database, epoch, protocol, authority, activate};
}

test('authority validates bindings and destroys a connection after ambiguous lock acquisition', async () => {
  const client = Object.assign(new EventEmitter(), {query: async () => {throw Error('query timeout');}, release: value => {assert.equal(value, true);}});
  const database = {pool: {connect: async () => client}, namespace: 'ns'};
  assert.throws(() => createOnlineWriteAuthority({database, epoch: 'bad', protocol: 'compat'}), {code: 'ONLINE_AUTHORITY_INVALID_EPOCH'});
  const authority = createOnlineWriteAuthority({database, epoch: randomUUID(), protocol: 'compat'});
  assert.ok(Object.isFrozen(authority.binding));
  await assert.rejects(authority.run(context, {legacy: () => assert.fail('No dispatch'), journal: () => assert.fail('No dispatch')}), /query timeout/);
  await assert.rejects(authority.pending({limit: 65}), {code: 'ONLINE_AUTHORITY_INVALID_PAGE_LIMIT'});
});

live('activation drains a late legacy operation; subsequent writes use the journal without a reader outage', async t => {
  const f = await fixture(t), started = signal(), finish = signal(), events = [];
  t.after(() => finish.resolve());
  const pending = f.authority.run(context, {legacy: async () => {events.push('legacy-start'); started.resolve(); await finish.promise; events.push('legacy-finished'); return 17;}, journal: () => assert.fail('Not active')});
  await started.promise;
  const active = f.authority.activate({receiptHash: enrollment, verify: async binding => {events.push('enrollment-verified'); return {...binding, receiptHash: enrollment};}});
  const peer = await f.pool.connect();
  try {
    const acquired = (await peer.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [JSON.stringify(['online-write-authority', f.database.namespace])])).rows[0].acquired;
    if (acquired) await peer.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [JSON.stringify(['online-write-authority', f.database.namespace])]);
    assert.equal(acquired, false);
  } finally {peer.release();}
  finish.resolve(); assert.equal(await pending, 17); assert.equal((await active).mode, 'journal');
  const value = await f.authority.run(context, {legacy: () => assert.fail('No later raw write'), journal: async () => {events.push('journal'); return false;}});
  assert.equal(value, false); assert.deepEqual(events, ['legacy-start', 'legacy-finished', 'enrollment-verified', 'journal']);
  assert.deepEqual(await f.authority.pending(), {entries: [], more: false});
});

live('uncertain legacy outcomes survive restart, block that key and prevent activation', async t => {
  const f = await fixture(t);
  await assert.rejects(f.authority.run(context, {legacy: async () => {throw Error('lost external response');}, journal: () => assert.fail('Wrong branch')}), /lost external response/);
  const restarted = createOnlineWriteAuthority({database: f.database, epoch: f.epoch, protocol: f.protocol});
  await restarted.prepare({receiptHash: preparation});
  const pending = await restarted.pending(); assert.equal(pending.entries.length, 1); assert.equal(pending.entries[0].key, context.key);
  await assert.rejects(restarted.run(context, {legacy: () => assert.fail('Unresolved key cannot be overwritten'), journal: () => assert.fail('Wrong branch')}), {code: 'ONLINE_AUTHORITY_LEGACY_OUTCOME_UNRESOLVED'});
  assert.equal(await restarted.run({...context, key: 'independent'}, {legacy: async () => 'still-serving', journal: () => assert.fail('Wrong branch')}), 'still-serving');
  await assert.rejects(restarted.activate({receiptHash: enrollment, verify: () => assert.fail('Pending IO cannot be bypassed by a receipt')}), {code: 'ONLINE_AUTHORITY_LEGACY_OUTCOME_UNRESOLVED'});
  assert.equal((await restarted.status()).mode, 'legacy');
});

live('adapter-proven no-effect exceptions preserve the business error without stranding activation', async t => {
  const f = await fixture(t), conflict = Object.assign(Error('conditional conflict'), {code: 'ConditionalCheckFailedException'});
  await assert.rejects(f.authority.run(context, {legacy: async () => rejectOnlineLegacyMutation(conflict), journal: () => assert.fail('Wrong branch')}), error => error === conflict);
  assert.deepEqual(await f.authority.pending(), {entries: [], more: false});
  // The same public error code without the adapter proof is still uncertain.
  await assert.rejects(f.authority.run(context, {legacy: async () => {throw conflict;}, journal: () => assert.fail('Wrong branch')}), error => error === conflict);
  await assert.rejects(f.activate(), {code: 'ONLINE_AUTHORITY_LEGACY_OUTCOME_UNRESOLVED'});
});

live('loss of the gate connection cannot erase the legacy in-flight blocker or report success', async t => {
  const f = await fixture(t), started = signal(), finish = signal(); t.after(() => finish.resolve());
  const result = f.authority.run(context, {legacy: async () => {started.resolve(); await finish.promise; return 'external request may have committed';}, journal: () => assert.fail('Wrong branch')});
  // Attach the assertion before terminating the held session.
  const rejected = assert.rejects(result, error => error.code === '57P01' || /LOCK_CONNECTION_LOST|terminated|closed|not queryable/i.test(error.message));
  await started.promise;
  const processes = (await f.admin.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1', [f.schema])).rows;
  assert.equal(processes.length, 1);
  await f.admin.query('SELECT pg_terminate_backend($1)', [processes[0].pid]);
  await new Promise(resolve => setImmediate(resolve)); finish.resolve(); await rejected;
  assert.equal((await f.authority.pending()).entries.length, 1);
  await assert.rejects(f.activate(), {code: 'ONLINE_AUTHORITY_LEGACY_OUTCOME_UNRESOLVED'});
});

live('namespace authority binds one epoch and protocol and never resets an activated mode', async t => {
  const f = await fixture(t);
  for (const changes of [{epoch: randomUUID()}, {protocol: 'other-protocol'}]) {
    const other = createOnlineWriteAuthority({database: f.database, epoch: f.epoch, protocol: f.protocol, ...changes});
    await assert.rejects(other.prepare({receiptHash: preparation}), {code: 'ONLINE_AUTHORITY_BINDING_MISMATCH'});
  }
  await assert.rejects(f.authority.prepare({receiptHash: 'c'.repeat(64)}), {code: 'ONLINE_AUTHORITY_PREPARATION_RECEIPT_CHANGED'});
  await assert.rejects(f.authority.activate({receiptHash: enrollment, verify: async binding => ({...binding, namespace: 'forged', receiptHash: enrollment})}), {code: 'ONLINE_AUTHORITY_ENROLLMENT_EVIDENCE_MISMATCH'});
  assert.equal((await f.authority.status()).mode, 'legacy');
  await f.activate(); assert.equal((await f.authority.prepare({receiptHash: preparation})).mode, 'journal');
  assert.equal((await f.activate()).mode, 'journal');
  await assert.rejects(f.authority.activate({receiptHash: 'c'.repeat(64), verify: () => assert.fail('Different receipt')}), {code: 'ONLINE_AUTHORITY_ENROLLMENT_RECEIPT_CHANGED'});
});

live('caller context freezes before waiting and equal keys in another source remain independent', async t => {
  const f = await fixture(t), started = signal(), finish = signal(); t.after(() => finish.resolve());
  const first = f.authority.run(context, {legacy: async () => {started.resolve(); await finish.promise;}, journal: () => assert.fail('Wrong branch')});
  await started.promise;
  const mutable = {...context};
  const second = f.authority.run(mutable, {legacy: async () => 'second', journal: () => assert.fail('Wrong branch')});
  mutable.sourceId = 'forged'; mutable.key = 'changed';
  assert.equal(await f.authority.run({...context, sourceId: 'other'}, {legacy: async () => 'independent', journal: () => assert.fail('Wrong branch')}), 'independent');
  finish.resolve(); await first; assert.equal(await second, 'second'); assert.equal((await f.authority.pending()).entries.length, 0);
});

live('a reserved one-connection authority pool composes with the real journal without nested pool starvation', async t => {
  const f = await fixture(t, 1);
  const workPool = new Pool({connectionString: url, max: 2, options: '-c search_path=' + f.schema}); t.after(() => workPool.end());
  const journal = createOnlineJournal({database: {...f.database, pool: workPool}, epoch: f.epoch, sourceId: context.sourceId}); await journal.ready();
  let stored = {version: null, operationId: null, revision: null, deleted: true, bytes: null, contentType: null};
  const external = {
    read: async () => stored,
    putIfVersion: async (_key, expected, mutation) => {assert.equal(expected, stored.version); stored = {...mutation, version: mutation.operationId, deleted: false}; return true;},
    deleteIfVersion: () => assert.fail('No delete'),
  };
  await f.activate();
  const result = await f.authority.run(context, {legacy: () => assert.fail('No legacy'), journal: () => journal.mutate({operationId: randomUUID(), key: context.key, mutation: {kind: 'put', bytes: Buffer.from('new'), contentType: 'text/plain'}}, external)});
  assert.equal(result.state, 'applied'); assert.equal(await journal.closedFrontier(), '1');
  await assert.rejects(f.authority.run(context, {legacy: () => assert.fail('No legacy'), journal: async () => {throw Error('journal retains its own uncertainty');}}), /retains its own uncertainty/);
  assert.equal((await f.authority.pending()).entries.length, 0);
});
