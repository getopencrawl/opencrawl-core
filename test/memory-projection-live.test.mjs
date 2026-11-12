import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {gunzipSync,gzipSync} from 'node:zlib';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createSessionIngest} from '../dist/src/sessions/ingest.mjs';
import {createSessionSearch} from '../dist/src/sessions/search.mjs';
import {createMemoryLibrary} from '../dist/src/memories/library.mjs';
import {createWorkspaceSearch} from '../dist/src/search/workspace.mjs';
import {createRealm, createIndexTransport, realmMapping, realmIndex} from '../dist/src/search/realm.mjs';
import {createControls} from '../dist/src/sessions/controls.mjs';
import {digest, sessionScope} from '../dist/src/sessions/event-identity.mjs';
import {memoryPassageId} from '../dist/src/memories/projection.mjs';
import {migrateMemoryProjection, rollbackMemoryProjection} from '../dist/src/memories/projection-migration.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';

const openSearchEndpoint = process.env.OPENCRAWL_TEST_OPENSEARCH_URL;
for(const backend of ['sqlite','opensearch'])test(`${backend}: memory projection switch keeps complete old/new files, controls, rollback and newer captures`, {skip: backend==='opensearch'&&!openSearchEndpoint}, async t => {
  const directory=await mkdtemp(join(tmpdir(),'opencrawl-memory-projection-'));
  const endpoint=backend==='sqlite'?pathToFileURL(join(directory,'search.sqlite')).href.replace('file:','sqlite:'):openSearchEndpoint;
  const environment = 'mproj-' + randomUUID().slice(0, 8), owner = {tenantId: 'one', userId: 'alice'}, viewer = {...owner, userId: 'bob'};
  const outsider = {...owner, tenantId: 'two'}, store = memorySessionStore(), prefix = 'capture', path = 'memories/long.md';
  const options = {endpoint, environment, store, prefix}, realm = createRealm({...options, tenantId: owner.tenantId});
  const collection = realm.collection('memory');
  t.after(async () => {try{if(backend==='opensearch')for (const principal of [owner, outsider]) await fetch(endpoint + '/' + realmIndex(environment, principal.tenantId), {method: 'DELETE'});}finally{await rm(directory,{recursive:true,force:true});}});
  if(backend==='opensearch'){
    const transport=createIndexTransport({endpoint,index:realmIndex(environment,owner.tenantId)});
    const oldMapping = structuredClone(realmMapping); delete oldMapping.properties.memory.properties.projectionId;
    await transport('', {settings: {number_of_shards: 1, number_of_replicas: 0}, mappings: {...oldMapping, _meta: {schema: 1, tenantId: owner.tenantId}}}, 'PUT');
  }else await realm.ensureIndex();
  const ingest = createSessionIngest({store, prefix}), generation = Date.now() - 10000;
  const text = ('Lighthouse source with coherent paragraph boundaries.\n\n').repeat(13000) + 'finaltailwitness';
  async function capture(gen, body) {
    const input = {schemaVersion: 1, owner, installationId: 'machine', host: 'fixture', harness: 'codex', generation: gen,
      files: [{path, project: 'fixture', modifiedAt: '2026-11-10T00:00:00Z', text: body}]};
    const receipt = await ingest.putMemorySnapshot(owner, input), key = [...store.data.keys()].find(key => key.endsWith(receipt.snapshotId + '.json.gz'));
    return {snapshot: JSON.parse(gunzipSync(store.data.get(key))), key};
  }
  const original = await capture(generation, text), snapshot = original.snapshot;
  const common = {...owner, installationId: snapshot.installationId, host: snapshot.host, harness: snapshot.harness,
    generation, snapshotId: snapshot.snapshotId, receivedAt: snapshot.receivedAt, sourceKey: original.key};
  const headId = digest(JSON.stringify([sessionScope(owner), snapshot.harness, snapshot.installationId, 'head']));
  const oldId = memoryPassageId(owner, snapshot.snapshotId, path, 0);
  await collection.bulk(owner, [{id: oldId, document: {...common, ...snapshot.files[0], kind: 'passage', chunk: 0}}, {id: headId, document: {...common, kind: 'snapshot'}}], {refresh: true});
  const search = createSessionSearch(options), workspace = createWorkspaceSearch({sessions: search}), library = createMemoryLibrary(options);
  const fileKey = {userId: owner.userId, harness: 'codex', path};
  const binding = {realm, principal: {tenantId: owner.tenantId}, store, prefix, headId};
  let backup;
  const save = async step => {if (backup) assert.deepEqual(step, backup); else backup = structuredClone(step);};
  const sourceHash = createHash('sha256').update(store.data.get(original.key)).digest('hex');
  const preview = await migrateMemoryProjection({...binding, search: search.memories, backup: async () => assert.fail('Dry run wrote a backup')});
  assert.equal(preview.status, 'dry-run'); assert.equal(preview.previousPassages, 1);
  assert.equal((await library.read(viewer, fileKey)).text, text);

  if(backend==='opensearch'){
  let interrupted = false;
  const partial = createSessionSearch({...options, fetch: async (url, request) => {
    if (!interrupted && String(url).endsWith('/_bulk')) {
      interrupted = true;
      const compressed = request.headers?.['content-encoding']==='gzip';
      const body = compressed ? gunzipSync(request.body).toString() : request.body;
      const partial = body.trimEnd().split('\n').slice(0, 4).join('\n') + '\n';
      return fetch(url, {...request, body: compressed ? gzipSync(partial) : partial});
    }
    return fetch(url, request);
  }});
  await assert.rejects(migrateMemoryProjection({...binding, search: partial.memories, backup: save, dryRun: false}), /missing items/);
  assert.equal((await workspace.search(viewer, {query: 'Lighthouse', source: 'memories'})).results[0].id, 'memories:' + oldId);
  assert.equal((await library.read(viewer, fileKey)).text, text);
  const brokenRefresh = createSessionSearch({...options, fetch: (url, request) => String(url).endsWith('/_refresh') ?
    Promise.resolve(Response.json({_shards: {total: 1, successful: 0, failed: 1}})) : fetch(url, request)});
  await assert.rejects(migrateMemoryProjection({...binding, search: brokenRefresh.memories, backup: save, dryRun: false}), /refresh incomplete/);
  assert.equal((await library.read(viewer, fileKey)).text, text);

  }
  const applied = await migrateMemoryProjection({...binding, search: search.memories, backup: save, dryRun: false});
  assert.equal(applied.status, 'activated'); assert.ok(applied.passages > 200);
  assert.equal(createHash('sha256').update(store.data.get(original.key)).digest('hex'), sourceHash);
  assert.equal((await library.read(viewer, fileKey)).text, text, 'complete file beyond the previous200-chunk read limit');
  await assert.rejects(workspace.fetch(viewer, {id: 'memories:' + oldId}), {status: 404});
  const hit = (await workspace.search(viewer, {query: 'Lighthouse', source: 'memories'})).results[0];
  const fetched = await workspace.fetch(viewer, {id: hit.id}); assert.ok(fetched.nextId);
  assert.equal((await workspace.fetch(viewer, {id: fetched.nextId})).previousId, hit.id);
  await assert.rejects(workspace.fetch(outsider, {id: hit.id}), {status: 404});
  assert.equal((await migrateMemoryProjection({...binding, search: search.memories, backup: save, dryRun: false})).status, 'already-current');

  const controls = createControls({store, prefix});
  await controls.update(owner, 'memories', 'codex', path, () => ({visibility: 'private', deletedAt: null}));
  assert.equal((await workspace.search(viewer, {query: 'Lighthouse', source: 'memories'})).results.length, 0, 'current controls override deliberately stale public projection');
  assert.equal((await library.list(viewer)).memories.length, 0);
  await assert.rejects(library.read(viewer, fileKey), {status: 404});
  assert.equal((await library.read(owner, fileKey)).text, text);
  assert.equal((await rollbackMemoryProjection({...binding, backup, dryRun: false})).status, 'restored');
  assert.equal((await library.read(owner, fileKey)).text, text);
  await assert.rejects(workspace.fetch(viewer, {id: 'memories:' + oldId}), {status: 404});
  await migrateMemoryProjection({...binding, search: search.memories, backup: save, dryRun: false});
  await controls.update(owner, 'memories', 'codex', path, () => ({visibility: 'team', deletedAt: new Date().toISOString()}));
  assert.equal((await workspace.search(owner, {query: 'Lighthouse', source: 'memories'})).results.length, 0);
  await assert.rejects(library.read(owner, fileKey), {status: 404});

  await assert.rejects(rollbackMemoryProjection({...binding, backup: {...backup, sourceSha256: '0'.repeat(64)}, dryRun: false}), /evidence mismatch/);
  const next = await capture(generation + 1, 'A newer captured snapshot.');
  let raced = false;
  const rollbackRace = {...realm, collection: corpus => {
    const selected = realm.collection(corpus);
    return {...selected, bulk: async (...args) => {
      assert.equal(raced, false); raced = true;
      await search.memories.putSnapshot(next.snapshot, owner, next.key);
      return selected.bulk(...args);
    }};
  }};
  await assert.rejects(rollbackMemoryProjection({...binding, realm: rollbackRace, backup, dryRun: false}), /changed during rollback/);
  assert.equal(raced, true);
  await assert.rejects(rollbackMemoryProjection({...binding, backup, dryRun: false}), /newer memory capture/);
  await assert.rejects(migrateMemoryProjection({...binding, principal: {tenantId: outsider.tenantId}, search: search.memories, backup: save, dryRun: false}), {status: 403});
  assert.equal((await collection.mget(owner, [headId])).docs[0]._source.snapshotId, next.snapshot.snapshotId);

  // A capture that publishes after migration's head read must win activation.
  await controls.update(owner, 'memories', 'codex', path, () => ({visibility: 'team', deletedAt: null}));
  const pending = await capture(generation + 2, 'Older pending projection.'), winner = await capture(generation + 3, 'Newest winning projection.');
  const pendingHead = {...common, generation: pending.snapshot.generation, snapshotId: pending.snapshot.snapshotId,
    receivedAt: pending.snapshot.receivedAt, sourceKey: pending.key, kind: 'snapshot'};
  await collection.bulk(owner, [
    {id: memoryPassageId(owner, pending.snapshot.snapshotId, path, 0), document: {...pendingHead, ...pending.snapshot.files[0], kind: 'passage', chunk: 0}},
    {id: headId, document: pendingHead},
  ], {refresh: true});
  const migrationRace = {putSnapshot: async (...args) => {
    await search.memories.putSnapshot(winner.snapshot, owner, winner.key);
    return search.memories.putSnapshot(...args);
  }};
  const superseded = await migrateMemoryProjection({...binding, search: migrationRace, backup: async () => {}, dryRun: false});
  assert.equal(superseded.status, 'superseded');
  assert.equal((await collection.mget(owner, [headId])).docs[0]._source.snapshotId, winner.snapshot.snapshotId);
  assert.equal((await library.read(viewer, fileKey)).text, winner.snapshot.files[0].text);

  // Scope and source identities are checked before any migration mutation.
  for (const patch of [{userId: 'mallory'}, {installationId: 'forged'}, {harness: 'claude-code'},
    {sourceKey: original.key}, {receivedAt: '2000-01-01T00:00:00Z'}]) {
    const forged = {...realm, collection: corpus => {
      const selected = realm.collection(corpus);
      return {...selected, mget: async (...args) => {
        const result = await selected.mget(...args);
        return {...result, docs: result.docs.map(hit => ({...hit, _source: {...hit._source, ...patch}}))};
      }};
    }};
    await assert.rejects(migrateMemoryProjection({...binding, realm: forged, search: {putSnapshot: async () => assert.fail('Forged source indexed')},
      backup: async () => assert.fail('Forged source backed up'), dryRun: false}), /source scope mismatch|chronology differs/);
  }
  await assert.rejects(migrateMemoryProjection({...binding, principal: {...owner, captureAccess: {}}, search: search.memories, backup: save}), {status: 403});
});
