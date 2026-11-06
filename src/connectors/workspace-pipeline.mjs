import {authorize, digest, invalidRecord, objectStream, selectedObject, pipelineVersion} from './scope.mjs';
import {readRecords} from './records.mjs';
import {workspaceAccumulator} from './workspace.mjs';

export function createWorkspacePipeline({binding, store, search, checkActive = async () => {}, heartbeat = () => {}}) {
  const principal = {tenantId: binding.tenantId};
  const taskKey = binding.rawPrefix + 'workspace-snapshot';
  async function active() {authorize(principal, binding); await checkActive(binding);}
  async function inventory() {
    let cursor, keys = [], ignored = 0;
    do {
      await active();
      const page = await store.listPage(binding.rawPrefix, {continuationToken: cursor, maxKeys: 1000});
      for (const key of page.keys) {if (selectedObject(binding, key)) keys.push(key); else ignored++;}
      cursor = page.nextToken;
      if (keys.length + ignored > 10000) invalidRecord('Workspace snapshot exceeds 10000 objects; partition before retrying');
      heartbeat({objects: keys.length});
    } while (cursor);
    return {keys: keys.sort(), ignored};
  }
  return {
    async listPage({cursor} = {}) {
      await active();
      if (cursor) invalidRecord('Unexpected workspace snapshot cursor');
      return {keys: [taskKey], cursor: null, ignored: 0};
    },
    async processObject({key}) {
      await active();
      if (key !== taskKey) invalidRecord('Snapshot task outside connector scope');
      const before = await inventory();
      const fingerprint = digest(before.keys);
      const receipt = `derived/indexing/${pipelineVersion(binding)}/${digest([binding.tenantId, binding.connectionId, search.identity])}/snapshot-${fingerprint}.json`;
      if (await store.get(receipt, {maxBytes: 8192})) return {status: 'already-indexed', records: 0};
      const accumulator = workspaceAccumulator(binding), checksums = [];
      let sourceRecords = 0;
      for (const sourceKey of before.keys) {
        await active();
        const stream = objectStream(binding, sourceKey);
        const result = await readRecords(store, sourceKey, envelope => accumulator.add(stream, envelope, sourceKey), {heartbeat});
        checksums.push([sourceKey, result.sha256]); sourceRecords += result.records;
      }
      let batch = [], batchBytes = 0, records = 0;
      async function flush() {
        if (!batch.length) return;
        await active(); await search.putDocuments(principal, binding, batch);
        records += batch.length; batch = []; batchBytes = 0; heartbeat({records});
      }
      for (const doc of accumulator.documents()) {
        const bytes = Buffer.byteLength(JSON.stringify(doc));
        if (batch.length >= 100 || batchBytes + bytes > 1024 * 1024) await flush();
        if (!doc.document.parentId) await flush();
        batch.push(doc); batchBytes += bytes;
        // Publish the parent only after all preceding children committed.
        if (doc.document.parentId) continue;
        await flush();
      }
      await flush();
      if (digest((await inventory()).keys) !== fingerprint) throw new Error('Source inventory changed during snapshot; retry to include new files');
      await active();
      await store.put(receipt, Buffer.from(JSON.stringify({pipeline: pipelineVersion(binding), fingerprint,
        checksum: digest(checksums), sourceRecords, records, objects: before.keys.length, ignored: before.ignored})), 'application/json');
      return {status: 'indexed', records};
    },
  };
}
