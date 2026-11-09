import type {ConnectorBinding} from '../connectors/types.mjs';
import type {SourceProgress} from '../connectors/workflow.mjs';
import {guardConnectorWrites} from '../connectors/write-barrier.mjs';
import {realmIndex} from '../search/realm.mjs';
import {createConnectorSearch} from '../connectors/search.mjs';
import {createConnectorPipeline} from '../connectors/pipeline.mjs';
import {sourcePaginationProgress, advanceSourcePagination} from '../connectors/workflow.mjs';
import {standaloneStorage} from '../sessions/standalone.mjs';
import {createRegistry} from './registry.mjs';
import {createSources} from './service.mjs';

// Self-host indexer for connected sources: every few minutes, indexes newly landed raw
// objects of each current connection. Receipts make reruns skip acknowledged objects.
const env = process.env;
const tenantId = env.OPENCRAWL_TENANT_ID || 'self-hosted';
const interval = Number(env.OPENCRAWL_SOURCES_INDEX_INTERVAL_MS || 120_000);
if (!env.OPENCRAWL_SOURCES_PATH || !env.OPENCRAWL_OPENSEARCH_URL) throw new Error('Set OPENCRAWL_SOURCES_PATH and OPENCRAWL_OPENSEARCH_URL');
const registry = createRegistry(env.OPENCRAWL_SOURCES_PATH);
const sources = createSources({registry, tenantId, origin: 'http://127.0.0.1'});
const {store} = standaloneStorage(env);
const search = createConnectorSearch({endpoint: env.OPENCRAWL_OPENSEARCH_URL, environment: 'selfhost', tenantId, index: realmIndex('selfhost', tenantId)});
// Waits out S3/OpenSearch start-up (a plain restart ignores depends_on) instead of crash-looping.
for (let attempt = 1; ; attempt++) {
  try { await store.checkAccess(); await search.ensureIndex(); break; }
  catch (error) {
    if (attempt >= 60) throw error;
    console.error(JSON.stringify({event: 'sources.index.waiting', message: String((error as Error).message).slice(0, 200)}));
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

async function index(binding: ConnectorBinding) {
  const pipeline = createConnectorPipeline({binding, ...guardConnectorWrites({binding, store, search})});
  let cursor: string | null = null, objects = 0, records = 0, failed = 0;
  let progress: SourceProgress | null = sourcePaginationProgress();
  do {
    const page = await pipeline.listPage({cursor});
    progress = advanceSourcePagination(progress, page);
    for (const key of page.keys) {
      // One bad object must not block the rest; it stays unacknowledged and is retried next pass.
      try { const result = await pipeline.processObject({key}); if (result.status === 'indexed') objects++; records += result.records; }
      catch (error) { failed++; console.error(JSON.stringify({event: 'sources.index.object_failed', connection: binding.connectionId, message: String((error as Error).message).slice(0, 300)})); }
    }
    cursor = page.cursor;
  } while (cursor);
  return {objects, records, failed};
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stopping = true; });
while (!stopping) {
  for (const binding of sources.bindings()) {
    try {
      const result = await index(binding);
      if (result.objects || result.failed) { await search.refresh(); console.log(JSON.stringify({event: 'sources.index', provider: binding.provider, connection: binding.connectionId, ...result})); }
    } catch (error) {
      console.error(JSON.stringify({event: 'sources.index.failed', provider: binding.provider, connection: binding.connectionId, message: String((error as Error).message).slice(0, 300)}));
    }
  }
  for (let waited = 0; waited < interval && !stopping; waited += 1000) await new Promise(resolve => setTimeout(resolve, 1000));
}
registry.close();
