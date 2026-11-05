import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {createConnectorPipeline} from '../src/connectors/pipeline.mjs';
import {normalizeSlack} from '../src/connectors/slack.mjs';
import {documentId, receiptKey, validateBinding} from '../src/connectors/scope.mjs';
import {connectorIndex, createConnectorSearch} from '../src/connectors/search.mjs';
import {runConnectorSegment} from '../src/connectors/workflow.mjs';
import {createObjectStore} from '../src/sessions/s3-store.mjs';

const binding = {tenantId: 'tenant-a', connectionId: 'conn', workspaceId: 'T123', provider: 'slack', access: 'team-public', rawPrefix: 'raw/v1/source=slack/workspace=T123/connection=conn/'};
const key = (stream = 'channel_messages', file = '1') => `${binding.rawPrefix}stream=${stream}/date=2026-11-04/sync=1/${file}.jsonl.gz`;
const envelope = (data = {}, at = 1000) => ({_airbyte_raw_id: 'random-copy-id', _airbyte_extracted_at: at, _airbyte_data: {channel_id: 'C123', ts: '1234567890.000001', text: 'searchable pineapple', ...data}});
function harness({records = [envelope()], failBulk = false} = {}) {
  const objects = new Map([[key(), gzipSync(records.map(r => JSON.stringify(r)).join('\n'))]]), written = new Map();
  let active = true, attempts = 0;
  const search = {identity: 'index-a', async putDocuments(principal, b, docs) {
    attempts++;
    // Simulate a bulk where some writes committed before the transport failed.
    for (const d of docs) written.set(d.id, d.document);
    if (failBulk && attempts === 1) throw new Error('Connection lost after commit');
  }};
  const store = {get: async k => objects.get(k) || null, put: async (k, v) => objects.set(k, v), listPage: async () => ({keys: [key()], nextToken: null})};
  const pipeline = createConnectorPipeline({binding, store, search, checkActive: async () => {if (!active) throw new Error('Connection revoked');}});
  return {objects, written, search, pipeline, revoke: () => {active = false;}};
}

test('stock messages and thread parents share stable identity; raw delivery IDs do not matter', () => {
  const a = normalizeSlack(binding, 'channel_messages', envelope(), key());
  const b = normalizeSlack(binding, 'threads', {...envelope(), _airbyte_raw_id: 'different'}, key('threads'));
  assert.equal(a.id, b.id); assert.equal(a.document.contentHash, b.document.contentHash);
  const reply = normalizeSlack(binding, 'threads', envelope({ts: '1234567891.000001', thread_ts: '1234567890.000001'}), key('threads'));
  assert.notEqual(reply.id, a.id); assert.equal(reply.document.threadTs, a.document.timestamp);
});
test('tenant and connection identity cannot collide; malformed scope fails closed', () => {
  const other = {...binding, tenantId: 'tenant-b'};
  assert.notEqual(documentId(binding, 'message', 'C1:1'), documentId(other, 'message', 'C1:1'));
  assert.notEqual(connectorIndex('staging', binding.tenantId), connectorIndex('staging', other.tenantId));
  assert.notEqual(receiptKey(binding, 'index-a', key()), receiptKey(other, 'index-a', key()));
  assert.throws(() => validateBinding({...binding, rawPrefix: 'raw/'}));
  assert.throws(() => validateBinding({...binding, tenantId: ''}));
});
test('partial bulk failure does not acknowledge; replay converges and reindex uses separate receipts', async () => {
  const h = harness({failBulk: true});
  await assert.rejects(h.pipeline.processObject({key: key()}));
  assert.equal(h.objects.size, 1);
  assert.equal((await h.pipeline.processObject({key: key()})).records, 1);
  assert.equal(h.written.size, 1);
  assert.equal((await h.pipeline.processObject({key: key()})).status, 'already-indexed');
  assert.notEqual(receiptKey(binding, 'new-index', key()), receiptKey(binding, 'index-a', key()));
});
test('forged paths, revoked connections, corrupt data and lossy Airbyte records do not acknowledge', async () => {
  const h = harness();
  await assert.rejects(h.pipeline.processObject({key: key().replace('connection=conn/', 'connection=other/')}), /scope/);
  h.revoke(); await assert.rejects(h.pipeline.processObject({key: key()}), /revoked/);
  const corrupt = harness(); corrupt.objects.set(key(), Buffer.from('not gzip'));
  await assert.rejects(corrupt.pipeline.processObject({key: key()}), /gzip/);
  const lossy = harness({records: [{...envelope(), _airbyte_meta: {changes: [{field: 'text'}]}}]});
  await assert.rejects(lossy.pipeline.processObject({key: key()}), /lossy/);
  assert.equal(lossy.objects.size, 1);
});
test('bounded segments retain cursors and continue other objects after one fails', async () => {
  let calls = 0, processed = 0;
  const result = await runConnectorSegment({}, {listPage: async () => ({keys: ['bad', 'good'], cursor: String(++calls)}), processObject: async ({key}) => {
    if (key === 'bad') throw new Error('poison'); processed++; return {records: 1};
  }});
  assert.deepEqual(result, {cursor: '5', indexed: 5, failed: 5}); assert.equal(processed, 5);
});
test('extra source streams do not starve supported data; selection never bypasses scope or path checks', async () => {
  let keys = [key('emoji'), key(), key('replies')];
  const pipeline = createConnectorPipeline({binding, search: {}, store: {listPage: async () => ({keys, nextToken: 'next-page'})}});
  assert.deepEqual(await pipeline.listPage(), {keys: [key()], cursor: 'next-page', ignored: 2});
  keys = [key('emoji')];
  assert.deepEqual(await pipeline.listPage(), {keys: [], cursor: 'next-page', ignored: 1});
  keys = [key('emoji').replace('connection=conn/', 'connection=other/')];
  await assert.rejects(pipeline.listPage(), /scope/);
  keys = [key().replace('/date=2026-11-04/', '/bad-date/')];
  await assert.rejects(pipeline.listPage(), /path/);
});
test('search adapter refuses cross-tenant writes before issuing requests and checks every bulk item', async () => {
  let calls = 0;
  const search = createConnectorSearch({endpoint: 'http://localhost:9200', index: 'test', tenantId: binding.tenantId, fetch: async () => {calls++; return Response.json({items: [{update: {status: 429}}]});}});
  const item = normalizeSlack(binding, 'channel_messages', envelope(), key());
  await assert.rejects(search.putDocuments({tenantId: 'tenant-b'}, binding, [item]), /scope/);
  await assert.rejects(search.putDocuments({tenantId: 'tenant-a'}, binding, [{...item, document: {...item.document, tenantId: 'tenant-b'}}]), /scope/);
  assert.equal(calls, 0);
  await assert.rejects(search.putDocuments({tenantId: 'tenant-a'}, binding, [item]), /bulk/);
});
test('query filters tenant/connections, checks returned ownership and hides unknown/private channels', async () => {
  const item = normalizeSlack(binding, 'channel_messages', envelope(), key());
  let publicChannel = false, forged = false;
  const search = createConnectorSearch({endpoint: 'http://localhost:9200', index: 'test', tenantId: binding.tenantId, fetch: async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.pathname.endsWith('/_search')) {
      assert.deepEqual(body.query.bool.filter[0], {term: {tenantId: binding.tenantId}});
      return Response.json({hits: {hits: [{_id: item.id, _score: 1, _source: {...item.document, tenantId: forged ? 'other' : binding.tenantId}}]}});
    }
    const d = normalizeSlack(binding, 'channels', envelope({id: 'C123', is_private: !publicChannel}), key('channels'));
    return Response.json({docs: [{_id: d.id, found: true, _source: d.document}]});
  }});
  assert.equal((await search.search({tenantId: binding.tenantId}, [binding], {query: 'pineapple'})).hits.length, 0);
  publicChannel = true;
  assert.equal((await search.search({tenantId: binding.tenantId}, [binding], {query: 'pineapple'})).hits.length, 1);
  forged = true;
  await assert.rejects(search.search({tenantId: binding.tenantId}, [binding], {query: 'pineapple'}), /scope/);
});
test('S3 bounded reads enforce declared and streamed sizes', async () => {
  const credentials = {accessKeyId: 'test', secretAccessKey: 'test'};
  for (const headers of [{}, {'content-length': '20'}]) {
    const store = createObjectStore({bucket: 'test', credentials, fetch: async () => new Response('123456789', {headers})});
    await assert.rejects(store.get('key', {maxBytes: 5}), /limit/);
    assert.equal((await store.get('key', {maxBytes: 30})).toString(), '123456789');
  }
});
