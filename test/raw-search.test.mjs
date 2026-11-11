import {memorySessionStore as deletionTestStore} from './session-store-fixture.mjs';
import {realmResponse} from './realm-fixture.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSessionSearch} from '../dist/src/sessions/search.mjs';
import {createConnectorSearch} from '../dist/src/connectors/search.mjs';
import {documentId} from '../dist/src/connectors/scope.mjs';

test('raw session responses retain OpenSearch fields after ownership checks', async () => {
  const owner = {tenantId: 'tenant', userId: 'user'};
  const response = {took: 2, timed_out: false, _shards: {successful: 1,failed:0}, hits: {total: {value: 1, relation: 'eq'}, hits: [{_id: 'id', _index: 'sessions', _score: 2, _source: {...owner, harness: 'codex', sessionId: 's', text: 'hello'}}]}};
  const search = createSessionSearch({store:deletionTestStore(),prefix:"capture-v1",endpoint: 'http://localhost:9200', index: 'sessions', fetch: async (_, options) => {
    assert.deepEqual(JSON.parse(options.body).query.bool.filter, [{term: {tenantId: owner.tenantId}},{term:{corpus:'session'}}]);
    return realmResponse('session',response);
  }});
  assert.deepEqual(await search.search(owner, {query: 'hello', raw: true}), response);
  await assert.rejects(search.search(null, {query: 'hello', raw: true}), /Authentication/);
  response.hits.hits[0]._source.userId = 'other';
  assert.deepEqual(await search.search(owner, {query: 'hello', raw: true}), response);
  response.hits.hits[0]._source.tenantId = 'other';
  await assert.rejects(search.search(owner, {query: 'hello', raw: true}), /ownership/);
});

test('raw connector hits retain search fields but never expose private or unknown channels', async () => {
  const binding = {tenantId: 'tenant', connectionId: 'conn', workspaceId: 'workspace', provider: 'slack', access: 'team-public', rawPrefix: 'raw/v1/source=slack/workspace=workspace/connection=conn/'};
  let forged = false;
  const hits = ['public', 'private', 'unknown'].map(channelId => ({_id: documentId(binding, 'message', channelId + ':1'), _index: 'connectors', _score: 3, sort: [3, 'conn', channelId + ':1'], _source: {...binding, kind: 'message', sourceId: channelId + ':1', channelId, text: channelId, deleted: false}}));
  const search = createConnectorSearch({endpoint: 'http://localhost:9200', index: 'connectors', tenantId: binding.tenantId, fetch: async url => {
    if (url.pathname.endsWith('_search')) return realmResponse('connector',{took: 1, timed_out: false, _shards: {successful: 1,failed:0}, hits: {total: {value: 3}, max_score: 3, hits: hits.map(hit => forged ? {...hit, _source: {...hit._source, tenantId: 'other'}} : hit)}});
    return realmResponse('connector',{docs: ['public', 'private','unknown'].map(channel => ({_id: documentId(binding, 'channel', channel), found: channel!=='unknown', _source: {...binding, kind: 'channel', sourceId: channel, publicChannel: channel === 'public', deleted: false}}))});
  }});
  const result = await search.search({tenantId: 'tenant'}, [binding], {query: 'hello', raw: true, limit: 1});
  assert.deepEqual(result.responses[0].hits, {hits: [hits[0]]});
  assert.equal(result.responses[0].took, 1);
  assert.doesNotMatch(JSON.stringify(result), /private|unknown/);
  await assert.rejects(search.search({tenantId: 'other'}, [binding], {query: 'hello', raw: true}), /scope/);
  forged = true;
  await assert.rejects(search.search({tenantId: 'tenant'}, [binding], {query: 'hello', raw: true}), /scope/);
});
