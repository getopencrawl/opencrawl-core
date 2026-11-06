import {authorize, objectStream, receiptKey, selectedObject, validateBinding} from './scope.mjs';
import {normalizeSlack} from './slack.mjs';
import {normalizeGitHub} from './github.mjs';
import {readRecords} from './records.mjs';
import {createWorkspacePipeline} from './workspace-pipeline.mjs';
import {pipelineVersion} from './scope.mjs';


/** One fixed authorized connection, one scoped bucket adapter, one scoped index. */
export function createConnectorPipeline({binding, store, search, checkActive = async () => {}, heartbeat = () => {}}) {
  validateBinding(binding);
  if (['granola', 'circleback', 'notion'].includes(binding.provider)) return createWorkspacePipeline({binding, store, search, checkActive, heartbeat});
  const principal = {tenantId: binding.tenantId};
  async function active() { authorize(principal, binding); await checkActive(binding); }
  return {
    async listPage({cursor} = {}) {
      await active();
      const page = await store.listPage(binding.rawPrefix, {continuationToken: cursor, maxKeys: 100});
      const keys = page.keys.filter(key => selectedObject(binding, key));
      return {keys, cursor: page.nextToken || null, ignored: page.keys.length - keys.length};
    },
    async processObject({key}) {
      await active();
      const stream = objectStream(binding, key);
      const receipt = receiptKey(binding, search.identity, key);
      if (await store.get(receipt, {maxBytes: 8192})) return {status: 'already-indexed', records: 0};
      let batch = [], records = 0, batchBytes = 0;
      async function flush() {
        if (!batch.length) return;
        await active();
        await search.putDocuments(principal, binding, batch);
        records += batch.length; batch = []; batchBytes = 0;
        heartbeat({records});
      }
      const result = await readRecords(store, key, async envelope => {
        const documents = binding.provider === 'slack' ? [normalizeSlack(binding, stream, envelope, key)] : normalizeGitHub(binding, stream, envelope, key);
        for (const normalized of documents) {
          const bytes = Buffer.byteLength(JSON.stringify(normalized));
          if (batch.length >= 100 || batchBytes + bytes > 1024 * 1024) await flush();
          if (binding.provider !== 'slack' && !normalized.document.parentId && batch.some(d => d.document.parentId)) await flush();
          batch.push(normalized); batchBytes += bytes;
        }
      }, {heartbeat, maxExpanded: (binding.provider === 'github' ? 2 : 1) * 1024 * 1024 * 1024});
      await flush();
      await active();
      // Only acknowledge after every bulk item succeeded. Partial writes replay safely.
      await store.put(receipt, Buffer.from(JSON.stringify({pipeline: pipelineVersion(binding), key, sha256: result.sha256, sourceRecords: result.records, records})), 'application/json');
      return {status: 'indexed', records};
    },
  };
}
