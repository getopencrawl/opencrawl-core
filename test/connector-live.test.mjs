import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {createObjectStore} from '../src/sessions/s3-store.mjs';
import {createConnectorSearch, connectorIndex} from '../src/connectors/search.mjs';
import {createConnectorPipeline} from '../src/connectors/pipeline.mjs';

test('real S3/OpenSearch: stock Slack, replay ordering, durable suppression and two tenants', {
  skip: !process.env.OPENCRAWL_TEST_S3_ENDPOINT || !process.env.OPENCRAWL_TEST_OPENSEARCH_URL,
}, async t => {
  const run = randomUUID(), objects = [], indexes = [];
  const store = createObjectStore({endpoint: process.env.OPENCRAWL_TEST_S3_ENDPOINT, bucket: 'capture-test', credentials: {accessKeyId: 'capture-test', secretAccessKey: 'capture-test-secret'}});
  t.after(async () => {
    for (const key of objects) await store.delete(key);
    // Only disposable indexes created by this test are removed.
    for (const index of indexes) await fetch(process.env.OPENCRAWL_TEST_OPENSEARCH_URL + '/' + index, {method: 'DELETE'});
  });
  const handles = [];
  for (const tenant of ['a', 'b']) {
    const tenantId = `fixture-${run}-${tenant}`, connectionId = `fixture-${run}-${tenant}`;
    const binding = {tenantId, connectionId, workspaceId: 'T123', provider: 'slack', access: 'team-public', rawPrefix: `raw/v1/source=slack/workspace=T123/connection=${connectionId}/`};
    const index = connectorIndex('test', tenantId); indexes.push(index);
    const search = createConnectorSearch({endpoint: process.env.OPENCRAWL_TEST_OPENSEARCH_URL, index, tenantId});
    for (let attempt = 0; ; attempt++) {
      try { await store.checkAccess(); await search.ensureIndex(); break; }
      catch (error) { if (attempt === 60) throw error; await new Promise(r => setTimeout(r, 1000)); }
    }
    const tracked = {...store, put: async (key, bytes, type) => {objects.push(key); await store.put(key, bytes, type);}};
    const pipeline = createConnectorPipeline({binding, store: tracked, search});
    async function ingest(stream, data, extractedAt, suffix) {
      const key = `${binding.rawPrefix}stream=${stream}/date=2026-11-04/sync=1/${suffix}.jsonl.gz`;
      await tracked.put(key, gzipSync(JSON.stringify({_airbyte_extracted_at: extractedAt, _airbyte_data: data}) + '\n'));
      return pipeline.processObject({key});
    }
    const principal = {tenantId};
    await ingest('channels', {id: 'C123', name: 'general', is_private: false}, 1000, 'channel');
    const message = {channel_id: 'C123', ts: '1234567890.000001', text: `pineapple current ${tenant}`};
    await ingest('channel_messages', message, 2000, 'current');
    await ingest('threads', {...message, text: 'obsolete grapefruit'}, 1000, 'older');
    await ingest('threads', {...message, ts: '1234567891.000001', thread_ts: message.ts, text: 'pineapple thread reply'}, 2000, 'reply');
    await ingest('channel_messages', message, 2000, 'duplicate');
    await search.refresh();
    assert.equal((await search.search(principal, [binding], {query: 'pineapple'})).hits.length, 2);
    assert.equal((await search.search(principal, [binding], {query: 'grapefruit'})).hits.length, 0);
    await search.suppress(principal, binding, {kind: 'message', sourceId: 'C123:' + message.ts});
    await ingest('channel_messages', message, 3000, 'after-suppression');
    await search.refresh();
    assert.equal((await search.search(principal, [binding], {query: 'pineapple'})).hits.length, 1);
    await ingest('channels', {id: 'C123', name: 'general', is_private: true}, 4000, 'private');
    await search.refresh();
    assert.equal((await search.search(principal, [binding], {query: 'pineapple'})).hits.length, 0);
    handles.push({search, binding, principal});
  }
  await assert.rejects(handles[0].search.search(handles[1].principal, [handles[0].binding], {query: 'pineapple'}), /scope/);
});
