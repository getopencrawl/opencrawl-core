import test from 'node:test';
import assert from 'node:assert/strict';
import {applicationDatabaseFixture, postgresUrl} from './fixtures/application-database.mjs';
import {postgresSharedFiles} from '../dist/src/files/store.mjs';

test('shared file history and its pusher commit atomically across concurrent application replicas', {skip: !postgresUrl}, async t => {
  const db = await applicationDatabaseFixture(t);
  const first = postgresSharedFiles(db);
  const second = postgresSharedFiles(db);
  await Promise.all([first.ready(), second.ready()]);
  const history = digit => ({head: digit.repeat(40), bundle: Buffer.from('bundle-' + digit)});
  assert.equal(await first.read('network-a'), null);
  const writers = [first, second];
  const attempts = await Promise.all(writers.map((store, i) =>
    store.publish('network-a', null, history(String(i)), 'member-' + i)));
  assert.equal(attempts.filter(Boolean).length, 1);
  const winner = attempts.indexOf(true);
  assert.deepEqual(await second.read('network-a'), history(String(winner)));
  assert.equal(await first.read('network-b'), null);
  assert.equal(await first.publish('network-b', null, history('2'), 'member-2'), true);

  const original = history(String(winner)).head;
  const advances = await Promise.all(writers.map((store, i) =>
    store.publish('network-a', original, history(String(i + 3)), 'member-' + (i + 3))));
  assert.equal(advances.filter(Boolean).length, 1);
  const advanced = advances.indexOf(true) + 3;
  assert.deepEqual(await postgresSharedFiles(db).read('network-a'), history(String(advanced)));
  assert.deepEqual(await second.read('network-b'), history('2'));
  const audit = await db.pool.query('SELECT head, previous_head, user_id FROM opencrawl_shared_file_pushes WHERE namespace=$1 AND tenant_id=$2 ORDER BY previous_head NULLS FIRST',
    [db.namespace,'network-a']);
  assert.deepEqual(audit.rows, [
    {head: original, previous_head: null, user_id: 'member-' + winner},
    {head: history(String(advanced)).head, previous_head: original, user_id: 'member-' + advanced},
  ]);
});
