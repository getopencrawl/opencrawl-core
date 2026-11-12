import {test} from 'node:test';
import assert from 'node:assert/strict';
import {memoryProjectionId, memoryPassageId, activeMemoryProjectionFilter} from '../dist/src/memories/projection.mjs';
import {authorizedMemoryDocuments} from '../dist/src/memories/access.mjs';
import {createControls} from '../dist/src/sessions/controls.mjs';
import {digest, sessionScope} from '../dist/src/sessions/event-identity.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';

const alice = {tenantId: 'memory-team', userId: 'alice'}, bob = {...alice, userId: 'bob'};
const snapshotId = 'a'.repeat(64), path = 'memory/MEMORY.md';
test('memory projection identities retain legacy IDs and separate versions, owners and neighbors', () => {
  const projection = memoryProjectionId(snapshotId);
  assert.equal(memoryPassageId(alice, snapshotId, path, 0), digest(JSON.stringify([sessionScope(alice), snapshotId, path, 0])));
  assert.equal(new Set([
    memoryPassageId(alice, snapshotId, path, 0), memoryPassageId(alice, snapshotId, path, 0, projection),
    memoryPassageId(alice, snapshotId, path, 1, projection), memoryPassageId(bob, snapshotId, path, 0, projection),
    memoryPassageId({...alice, tenantId: 'other-team'}, snapshotId, path, 0, projection),
    memoryPassageId(alice, snapshotId, path, 0, memoryProjectionId(snapshotId, 3)),
  ]).size, 6);
  assert.throws(() => memoryPassageId(alice, snapshotId, path, -1), /identity/);
  assert.throws(() => activeMemoryProjectionFilter([{...alice, snapshotId, projectionId: 'b'.repeat(64), passageVersion: 2}]), /projection/);
  assert.throws(() => activeMemoryProjectionFilter([{...alice, snapshotId: 'invalid'}]), /snapshot/);
  assert.doesNotThrow(() => activeMemoryProjectionFilter([{...alice, snapshotId}, {...alice, snapshotId, projectionId: projection, passageVersion: 2}]));
});

test('stale memory projection cannot override a later private or deleted owner control', async () => {
  const controls = createControls({store: memorySessionStore(), prefix: 'capture'});
  const document = {...alice, harness: 'codex', path, modifiedAt: '2026-11-10T00:00:00Z', private: false, text: 'old projection'};
  assert.equal((await authorizedMemoryDocuments(controls, bob, [document])).length, 1);
  await controls.update(alice, 'memories', 'codex', path, () => ({visibility: 'private', deletedAt: null}));
  assert.deepEqual(await authorizedMemoryDocuments(controls, bob, [document]), []);
  assert.equal((await authorizedMemoryDocuments(controls, alice, [document]))[0].private, true);
  await controls.update(alice, 'memories', 'codex', path, () => ({visibility: 'team', deletedAt: '2026-11-11T00:00:00Z'}));
  assert.deepEqual(await authorizedMemoryDocuments(controls, alice, [document]), []);
  assert.deepEqual(await authorizedMemoryDocuments(controls, bob, [document]), []);
  assert.equal((await authorizedMemoryDocuments(controls, bob, [{...document, modifiedAt: '2026-11-12T00:00:00Z'}])).length, 1);
  await assert.rejects(authorizedMemoryDocuments(controls, {...bob, tenantId: 'other-team'}, [document]), /ownership/);
  await assert.rejects(authorizedMemoryDocuments(controls, {...alice, captureAccess: 'write'}, [document]), {status: 403});
  await assert.rejects(authorizedMemoryDocuments(null, alice, [document]), {status: 503});
  await assert.rejects(authorizedMemoryDocuments(controls, alice, [{...document, path: '../secret.md'}]), /identity/);
});
