import {createGunzip} from 'node:zlib';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {PIPELINE_VERSION, authorize, objectStream, receiptKey, validateBinding} from './scope.mjs';
import {normalizeSlack} from './slack.mjs';

const MAX_COMPRESSED = 256 * 1024 * 1024;
const MAX_EXPANDED = 1024 * 1024 * 1024;
const MAX_LINE = 2 * 1024 * 1024;

/** One fixed authorized connection, one scoped bucket adapter, one scoped index. */
export function createConnectorPipeline({binding, store, search, checkActive = async () => {}, heartbeat = () => {}}) {
  validateBinding(binding);
  const principal = {tenantId: binding.tenantId};
  async function active() { authorize(principal, binding); await checkActive(binding); }
  return {
    async listPage({cursor} = {}) {
      await active();
      const page = await store.listPage(binding.rawPrefix, {continuationToken: cursor, maxKeys: 100});
      const keys = page.keys.filter(key => key.endsWith('.jsonl.gz'));
      for (const key of keys) objectStream(binding, key);
      return {keys, cursor: page.nextToken || null};
    },
    async processObject({key}) {
      await active();
      const stream = objectStream(binding, key);
      const receipt = receiptKey(binding, search.identity, key);
      if (await store.get(receipt, {maxBytes: 8192})) return {status: 'already-indexed', records: 0};
      const hash = createHash('sha256');
      async function* compressedSource() {
        if (store.read) {
          for await (const bytes of store.read(key, {maxBytes: MAX_COMPRESSED})) { hash.update(bytes); yield bytes; }
        } else {
          const bytes = await store.get(key, {maxBytes: MAX_COMPRESSED});
          if (!bytes) throw new Error('Source object is not available');
          if (bytes.length > MAX_COMPRESSED) throw Object.assign(new Error('Source object exceeds compressed limit'), {permanent: true});
          hash.update(bytes); yield bytes;
        }
      }
      let batch = [], records = 0, batchBytes = 0;
      async function flush() {
        if (!batch.length) return;
        await active();
        await search.putDocuments(principal, binding, batch);
        records += batch.length; batch = []; batchBytes = 0;
        heartbeat({records});
      }
      async function consume(line) {
        if (!line.trim()) return;
        if (Buffer.byteLength(line) > MAX_LINE) throw Object.assign(new Error('Airbyte line exceeds supported size'), {permanent: true});
        let envelope;
        try { envelope = JSON.parse(line); } catch { throw Object.assign(new Error('Invalid Airbyte JSON'), {permanent: true}); }
        const normalized = normalizeSlack(binding, stream, envelope, key);
        const bytes = Buffer.byteLength(JSON.stringify(normalized));
        if (batch.length >= 100 || batchBytes + bytes > 1024 * 1024) await flush();
        batch.push(normalized); batchBytes += bytes;
      }
      let pending = '', expanded = 0;
      const decoder = new TextDecoder('utf-8', {fatal: true});
      try {
        const decompressed = Readable.from(compressedSource()).compose(createGunzip());
        for await (const bytes of decompressed) {
          expanded += bytes.length;
          if (expanded > MAX_EXPANDED) throw Object.assign(new Error('Expanded source exceeds limit'), {permanent: true});
          pending += decoder.decode(bytes, {stream: true});
          let newline;
          while ((newline = pending.indexOf('\n')) !== -1) {
            await consume(pending.slice(0, newline)); pending = pending.slice(newline + 1);
          }
          if (Buffer.byteLength(pending) > MAX_LINE) throw Object.assign(new Error('Airbyte line exceeds supported size'), {permanent: true});
        }
        pending += decoder.decode();
        await consume(pending);
      } catch (error) {
        if (['Z_DATA_ERROR', 'Z_BUF_ERROR', 'ERR_ENCODING_INVALID_ENCODED_DATA'].includes(error.code)) throw Object.assign(new Error('Invalid gzip or UTF-8 source'), {permanent: true});
        throw error;
      }
      await flush();
      await active();
      // Only acknowledge after every bulk item succeeded. Partial writes replay safely.
      await store.put(receipt, Buffer.from(JSON.stringify({pipeline: PIPELINE_VERSION, key, sha256: hash.digest('hex'), records})), 'application/json');
      return {status: 'indexed', records};
    },
  };
}
