import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createConnectorSearch} from '../dist/src/connectors/search.mjs';
import {documentId} from '../dist/src/connectors/scope.mjs';
import {createConnectorResolver} from '../dist/src/integrations/resolver.mjs';
import {createDriveAccess, DRIVE_API} from '../dist/src/integrations/google-drive-access.mjs';
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

function metadataFixture() {
  const binding = bindingFor('slack', 'a');
  const candidate = hit(binding, 'file_chunk', 'chunk_1', {channelId: 'channel_1', parentKind: 'file', parentId: 'file_1', resourceVersion: 'current'});
  const channel = {...hit(binding, 'channel', 'channel_1', {publicChannel: true}), found: true};
  const parent = {...hit(binding, 'file', 'file_1', {available: true, resourceVersion: 'current'}), found: true};
  const state = {candidates: [candidate], documents: new Map([[channel._id, channel], [parent._id, parent]]), requests: []};
  const search = createConnectorSearch({endpoint: 'https://search.example.test', tenantId, fetch: async (url, options) => {
    if (url.pathname.endsWith('/_search')) return realmResponse('connector', {hits: {hits: state.candidates}});
    if (!url.pathname.endsWith('/_mget')) throw new Error('Unexpected search request');
    const ids = JSON.parse(options.body).ids.map(id => id.slice('connector:'.length));
    state.requests.push(ids);
    return realmResponse('connector', {docs: ids.map(id => state.documents.get(id) ?? {_id: id, found: false})});
  }});
  return {binding, candidate, channel, parent, state, search};
}

function driveFixture(count = 40) {
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
  const search = createConnectorSearch({endpoint: 'https://search.example.test', tenantId, fetch: async url => {
    if (!url.pathname.endsWith('/_search')) throw new Error('Unexpected search request');
    return realmResponse('connector', {hits: {hits: candidates}});
  }});
  const record = {tenantId, userId: 'user_owner', integrationId: binding.connectionId, provider: 'googledrive', scope: 'team',
    status: 'active', environment: 'selfhost', workspace: tenantId, s3Prefix: binding.rawPrefix.slice(0, -1)};
  const resolver = createConnectorResolver({environment: 'selfhost', generation: 'v1',
    registry: {get: async () => record, listTenant: async () => [record]}, storage: async () => ({}), search: () => search,
    driveAccess: () => createDriveAccess(access)});
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
