import {withTestState} from './fixtures/memory-application-state.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createConnectorSearch} from '../dist/src/connectors/search.mjs';
import {documentId} from '../dist/src/connectors/scope.mjs';
import {createConnectorResolver} from '../dist/src/integrations/resolver.mjs';
import {createDriveAccess, DRIVE_API} from '../dist/src/integrations/google-drive-access.mjs';
import {createWorkspaceSearch} from '../dist/src/search/workspace.mjs';
import {realmResponse} from './realm-fixture.mjs';

const tenantId = 'org_efficiency', principal = {tenantId, userId: 'user_reader'};
function bindingFor(provider, marker) {
  const connectionId = 'int_' + marker.repeat(26);
  return {tenantId, connectionId, workspaceId: tenantId, provider, access: provider === 'slack' ? 'team-public' : 'workspace-global',
    rawPrefix: `raw/v1/source=${provider}/workspace=${tenantId}/connection=${connectionId}/`};
}
const hit = (binding, kind, sourceId, metadata = {}) => ({_id: documentId(binding, kind, sourceId), _score: 1,
  _source: {tenantId: binding.tenantId, connectionId: binding.connectionId, workspaceId: binding.workspaceId, provider: binding.provider,
    kind, sourceId, deleted: false, text: 'fixture evidence', ...metadata}});
const idFilter = options => JSON.parse(options.body).query.bool.must[0].bool.filter.find(filter => filter.term?.id)?.term.id;

function metadataFixture() {
  const binding = bindingFor('slack', 'a');
  const candidate = hit(binding, 'file_chunk', 'chunk_1', {channelId: 'channel_1', parentKind: 'file', parentId: 'file_1', resourceVersion: 'current'});
  const channel = {...hit(binding, 'channel', 'channel_1', {publicChannel: true}), found: true};
  const parent = {...hit(binding, 'file', 'file_1', {available: true, resourceVersion: 'current'}), found: true};
  const state = {candidates: [candidate], documents: new Map([[channel._id, channel], [parent._id, parent]]), requests: [], reply: null};
  const search = createConnectorSearch({endpoint: 'https://search.example.test', tenantId, fetch: async (url, options) => {
    if (url.pathname.endsWith('/_search')) {
      const id = idFilter(options);
      return realmResponse('connector', {hits: {hits: state.candidates.filter(candidate => !id || candidate._id === id)}});
    }
    if (!url.pathname.endsWith('/_mget')) throw new Error('Unexpected search request');
    const ids = JSON.parse(options.body).ids.map(id => id.slice('connector:'.length));
    state.requests.push(ids);
    const docs = ids.map(id => state.documents.get(id) ?? {_id: id, found: false});
    return state.reply ? state.reply(docs) : realmResponse('connector', {docs});
  }});
  return {binding, candidate, channel, parent, state, search};
}

function driveFixture(count = 40, {withPolicy = true} = {}) {
  const binding = bindingFor('googledrive', 'b');
  const candidates = Array.from({length: count}, (_, i) => hit(binding, 'file', `file_${i}`, {available: true}));
  const state = {audienceReads: 0, fileReads: 0, permissionReads: 0, members: ['reader@example.test'],
    permissions: [{type: 'user', emailAddress: 'reader@example.test', role: 'reader'}]};
  const access = {audience: async () => {state.audienceReads++; return state.members;}, request: async input => {
    const path = input.endpoint.slice((DRIVE_API + '/files/').length);
    if (path.endsWith('/permissions')) {state.permissionReads++; return {status: 200, data: {permissions: state.permissions}};}
    state.fileReads++;
    return {status: 200, data: {id: path, name: path, mimeType: 'text/plain', version: '1', modifiedTime: '2026-11-15T00:00:00Z', capabilities: {canDownload: true}}};
  }};
  const search = createConnectorSearch({endpoint: 'https://search.example.test', tenantId, fetch: async (url, options) => {
    if (!url.pathname.endsWith('/_search')) throw new Error('Unexpected search request');
    const id = idFilter(options);
    return realmResponse('connector', {hits: {hits: candidates.filter(candidate => !id || candidate._id === id)}});
  }});
  const record = {tenantId, userId: 'user_owner', integrationId: binding.connectionId, provider: 'googledrive', scope: 'team',
    status: 'active', environment: 'selfhost', workspace: tenantId, s3Prefix: binding.rawPrefix.slice(0, -1)};
  const resolver = createConnectorResolver(withTestState({environment: 'selfhost', generation: 'v1',
    registry: {get: async () => record, listTenant: async () => [record]}, storage: async () => ({}), search: () => search,
    ...(withPolicy ? {driveAccess: () => createDriveAccess(access)} : {})}));
  return {binding, candidates, state, access, record, resolver};
}

test('connector search shares one metadata lookup for channel visibility and parent revisions', async t => {
  const f = metadataFixture();
  const result = await f.search.search(principal, [f.binding], {query: 'evidence'});
  assert.deepEqual(result.hits.map(item => item.id), [f.candidate._id]);
  t.diagnostic(JSON.stringify({candidates: 1, metadataRequests: f.state.requests.length, metadataDocuments: f.state.requests.flat().length}));
  assert.equal(f.state.requests.length, 1);
  assert.equal(f.state.requests[0].length, 2);
});

test('Drive search validates the operation audience once initially and once before returning', async t => {
  const f = driveFixture();
  const result = await f.resolver.search(principal, {query: 'evidence', limit: 40});
  assert.equal(result.hits.length, 40);
  assert.equal(f.state.fileReads, 40, 'each distinct file still has a fresh metadata check');
  assert.equal(f.state.permissionReads, 40, 'each distinct file still has a fresh permission check');
  t.diagnostic(JSON.stringify({files: 40, audienceReads: f.state.audienceReads, fileReads: f.state.fileReads, permissionReads: f.state.permissionReads}));
  assert.equal(f.state.audienceReads, 2);
});

test('combined metadata preserves channel and parent visibility for ordinary, raw and ID reads', async t => {
  for (const mode of ['ordinary', 'raw', 'id']) await t.test(mode, async () => {
    for (const denial of ['private-channel', 'deleted-channel', 'missing-channel', 'missing-parent', 'deleted-parent', 'unavailable-parent', 'old-parent']) {
      const f = metadataFixture();
      if (denial === 'private-channel') f.channel._source.publicChannel = false;
      if (denial === 'deleted-channel') f.channel._source.deleted = true;
      if (denial === 'missing-channel') f.state.documents.delete(f.channel._id);
      if (denial === 'missing-parent') f.state.documents.delete(f.parent._id);
      if (denial === 'deleted-parent') f.parent._source.deleted = true;
      if (denial === 'unavailable-parent') f.parent._source.available = false;
      if (denial === 'old-parent') f.parent._source.resourceVersion = 'old';
      const input = mode === 'id' ? {query: '', id: f.candidate._id, limit: 1} : {query: 'evidence', ...(mode === 'raw' ? {raw: true} : {})};
      const result = await f.search.search(principal, [f.binding], input);
      const hits = mode === 'raw' ? result.responses.flatMap(response => response.hits.hits) : result.hits;
      assert.deepEqual(hits, [], denial);
      assert.equal(f.state.requests.length, 1);
    }
  });
});

test('a shared metadata ID must satisfy both channel visibility and parent revision guards', async () => {
  const f = metadataFixture();
  f.candidate._source.parentKind = 'channel';
  f.candidate._source.parentId = 'channel_1';
  f.channel._source.resourceVersion = 'current';
  assert.equal((await f.search.search(principal, [f.binding], {query: 'evidence'})).hits.length, 1);
  assert.deepEqual(f.state.requests[0], [f.channel._id]);
  f.channel._source.resourceVersion = 'old';
  assert.equal((await f.search.search(principal, [f.binding], {query: 'evidence'})).hits.length, 0);
  f.channel._source.resourceVersion = 'current'; f.channel._source.publicChannel = false;
  assert.equal((await f.search.search(principal, [f.binding], {query: 'evidence'})).hits.length, 0);
});

test('combined metadata rejects malformed, incomplete, duplicate, unexpected and mis-scoped documents', async t => {
  const mutations = {
    'missing docs': () => Response.json({}),
    'null docs': () => Response.json({docs: null}),
    'empty docs': () => realmResponse('connector', {docs: []}),
    'missing document': docs => realmResponse('connector', {docs: docs.slice(1)}),
    'duplicate document': docs => realmResponse('connector', {docs: [docs[0], docs[0]]}),
    'unexpected document': docs => realmResponse('connector', {docs: [docs[0], {...docs[1], _id: 'unexpected'}]}),
    'foreign tenant': docs => realmResponse('connector', {docs: docs.map((doc, i) => i ? doc : {...doc, _source: {...doc._source, tenantId: 'org_other'}})}),
    'foreign connection': docs => realmResponse('connector', {docs: docs.map((doc, i) => i ? doc : {...doc, _source: {...doc._source, connectionId: 'int_' + 'c'.repeat(26)}})}),
    'wrong channel kind': docs => realmResponse('connector', {docs: docs.map((doc, i) => i ? doc : {...doc, _source: {...doc._source, kind: 'file'}})}),
    'wrong parent kind': docs => realmResponse('connector', {docs: docs.map((doc, i) => !i ? doc : {...doc, _source: {...doc._source, kind: 'channel'}})}),
    'wrong provider': docs => realmResponse('connector', {docs: docs.map((doc, i) => i ? doc : {...doc, _source: {...doc._source, provider: 'notion'}})}),
  };
  for (const [name, reply] of Object.entries(mutations)) await t.test(name, async () => {
    const f = metadataFixture(); f.state.reply = reply;
    await assert.rejects(f.search.search(principal, [f.binding], {query: 'evidence'}));
  });
});

test('connector pages without metadata dependencies issue no metadata request', async () => {
  const f = metadataFixture(), binding = bindingFor('github', 'c');
  f.state.candidates = [hit(binding, 'issue', 'issue_1')];
  assert.equal((await f.search.search(principal, [binding], {query: 'evidence'})).hits.length, 1);
  assert.deepEqual(f.state.requests, []);
});

test('Drive buffers results until final audience validation and rejects membership changes', async () => {
  const f = driveFixture(), finalStarted = Promise.withResolvers(), finalGate = Promise.withResolvers();
  f.access.audience = async () => {
    f.state.audienceReads++;
    if (f.state.audienceReads === 2) {finalStarted.resolve(); await finalGate.promise;}
    return [...f.state.members];
  };
  let published = false;
  const pending = f.resolver.search(principal, {query: 'evidence', limit: 40}).then(result => {published = true; return result;});
  const rejected = assert.rejects(pending, /membership changed/);
  await finalStarted.promise;
  assert.equal(f.state.fileReads, 40);
  assert.equal(f.state.permissionReads, 40);
  assert.equal(published, false);
  f.state.members.push('new-member@example.test'); finalGate.resolve();
  await rejected;
});

test('Drive raw and ID fetches retain per-file ACL denial and do not reuse prior authorization', async () => {
  const f = driveFixture(1), workspace = createWorkspaceSearch({connectors: f.resolver});
  const id = 'connectors:' + f.candidates[0]._id;
  assert.equal((await workspace.fetch(principal, {id})).text, 'fixture evidence');
  assert.equal(f.state.audienceReads, 2);
  f.state.permissions = [];
  assert.deepEqual((await f.resolver.search(principal, {query: 'evidence', raw: true})).responses.flatMap(response => response.hits.hits), []);
  await assert.rejects(workspace.fetch(principal, {id}), {status: 404});
  assert.equal(f.state.fileReads, 3);
  assert.equal(f.state.permissionReads, 3);
  assert.equal(f.state.audienceReads, 6, 'every operation uses a new initial and final audience');
});

test('Drive denies missing policies, provider failures, audience failures and concurrent disconnects', async t => {
  await t.test('missing policy', async () => {
    const f = driveFixture(1, {withPolicy: false});
    assert.deepEqual((await f.resolver.search(principal, {query: 'evidence'})).hits, []);
    assert.equal(f.state.fileReads, 0);
  });
  await t.test('provider failure', async () => {
    const f = driveFixture(1); f.access.request = async () => {throw new Error('provider unavailable');};
    await assert.rejects(f.resolver.search(principal, {query: 'evidence'}), /provider unavailable/);
  });
  await t.test('final audience failure', async () => {
    const f = driveFixture(1);
    f.access.audience = async () => {if (++f.state.audienceReads === 2) throw new Error('directory unavailable'); return f.state.members;};
    await assert.rejects(f.resolver.search(principal, {query: 'evidence', raw: true}), /directory unavailable/);
  });
  await t.test('disconnect during inspection', async () => {
    const f = driveFixture(1), request = f.access.request;
    f.access.request = async input => {const result = await request(input); if (input.endpoint.endsWith('/permissions')) f.record.status = 'disconnecting'; return result;};
    await assert.rejects(f.resolver.search(principal, {query: 'evidence'}), {status: 403});
  });
  await t.test('foreign tenant', async () => {
    const f = driveFixture(1);
    await assert.rejects(f.resolver.search({...principal, tenantId: 'org_other'}, {query: 'evidence'}), {status: 403});
    assert.equal(f.state.fileReads, 0);
  });
});

test('direct resolved resourceAccess still validates the audience before returning', async () => {
  const f = driveFixture(1);
  f.access.audience = async () => ++f.state.audienceReads === 1 ? ['reader@example.test'] : ['new-member@example.test'];
  const resolved = await f.resolver.resolve({tenantId, userId: 'user_owner', connectionId: f.binding.connectionId});
  await assert.rejects(resolved.resourceAccess('file_0'), /membership changed/);
  assert.equal(f.state.audienceReads, 2);
});
