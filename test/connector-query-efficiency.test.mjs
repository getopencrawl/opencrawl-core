import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createConnectorSearch} from '../dist/src/connectors/search.mjs';
import {documentId} from '../dist/src/connectors/scope.mjs';
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

test('connector search shares one metadata lookup for channel visibility and parent revisions', async t => {
  const f = metadataFixture();
  const result = await f.search.search(principal, [f.binding], {query: 'evidence'});
  assert.deepEqual(result.hits.map(item => item.id), [f.candidate._id]);
  t.diagnostic(JSON.stringify({candidates: 1, metadataRequests: f.state.requests.length, metadataDocuments: f.state.requests.flat().length}));
  assert.equal(f.state.requests.length, 1);
  assert.equal(f.state.requests[0].length, 2);
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
