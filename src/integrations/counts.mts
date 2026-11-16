import type {IntegrationRecord, Provider} from './types.mjs';
import type {IntegrationStorage} from './ports.mjs';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {createGunzip} from 'node:zlib';

export interface CountObject {key: string; stream: string; sync: number; fullRefresh: boolean}
export interface LegacyCountState {version: 1; read: string[]; ids: Record<string, string[]>; full?: Record<string, {sync: number | null; count: number}>}
export interface RecordCountRepository {
  read(record: IntegrationRecord): Promise<Record<string, number> | null>;
  processObject(record: IntegrationRecord, object: CountObject, ids: AsyncIterable<string>, check?: () => void): Promise<void>;
  publish(record: IntegrationRecord, full: Record<string, number>, expected?: Record<string, string[]>): Promise<void>;
  remove(record: IntegrationRecord): Promise<void>;
}
export interface RecordCounts {
  get(record: IntegrationRecord): Promise<Record<string, number> | null>;
  refresh(record: IntegrationRecord, provider: Provider, succeeded: Set<number>, options?: {key?: string; check?: () => void}): Promise<void>;
  remove(record: IntegrationRecord): Promise<void>;
}
const PATH = /\/stream=([^/]+)\/date=[^/]+\/sync=(\d+)\//;
// Preserve the original hash protocol so imported historical IDs deduplicate.
const hash = (value: string) => createHash('sha1').update(value).digest('base64url').slice(0, 12);
export function manifestKeys(manifest: unknown) {
  const keys: Record<string, string[]> = {};
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if ('name' in node && typeof node.name === 'string' && 'primary_key' in node && Array.isArray(node.primary_key)) keys[node.name] ||= (node.primary_key as Array<string | string[]>).flat();
    Object.values(node).forEach(walk);
  };
  walk(manifest); return keys;
}
export function recordKey(data: Record<string, unknown> | undefined, key?: string[]) {
  return hash(key?.length ? JSON.stringify(key.map(field => data?.[field] ?? null)) : JSON.stringify(data));
}

/** Reads never enqueue or scan. Only a reauthorized Temporal indexing activity
 * calls refresh; each source object is published atomically by the repository. */
export function createRecordCounts({buckets, legacyBucket, repository}: {buckets: IntegrationStorage; legacyBucket: string; repository: RecordCountRepository}): RecordCounts {
  async function* ids(bucket: string, object: CountObject, keys: string[] | undefined, check: () => void) {
    const source = await buckets.stream(bucket, object.key), unzip = createGunzip();
    const lines = createInterface({input: source.pipe(unzip), crlfDelay: Infinity});
    // Propagate a source error to readline's input; pipe does not do this itself.
    source.on('error', error => unzip.destroy(error));
    try {
      for await (const line of lines) {
        check(); if (!line) continue;
        let data: Record<string, unknown> | undefined;
        try {data = JSON.parse(line)._airbyte_data;} catch {continue;}
        yield recordKey(data, keys);
      }
    } finally {lines.close(); source.destroy(); unzip.destroy();}
  }
  return {
    get: record => record.s3Prefix ? repository.read(record) : Promise.resolve(null),
    remove: record => repository.remove(record),
    async refresh(record, provider, succeeded, {key, check = () => {}} = {}) {
      if (!record.s3Prefix) return;
      check();
      const bucket = record.s3Bucket || legacyBucket;
      const primary = provider.keys || (provider.connector?.manifest ? manifestKeys(provider.connector.manifest) : {});
      const fullStreams = new Set(provider.streams.filter(stream => stream.syncMode.startsWith('full_refresh')).map(stream => stream.name));
      const objects = (await buckets.list(bucket, `${record.s3Prefix}/`)).flatMap(({key: path}) => {
        const match = PATH.exec(path), sync = match ? Number(match[2]) : NaN;
        return match && path.startsWith(`${record.s3Prefix}/`) && path.endsWith('.jsonl.gz') && Number.isSafeInteger(sync) && sync >= 0
          ? [{key: path, stream: match[1], sync, fullRefresh: fullStreams.has(match[1])}] : [];
      });
      const full: Record<string, number> = {};
      for (const stream of fullStreams) {
        const syncs = [...new Set(objects.filter(object => object.stream === stream).map(object => object.sync))].sort((a, b) => b - a);
        const sync = syncs.find(value => succeeded.has(value)) ?? (succeeded.size ? undefined : syncs[0]);
        if (sync !== undefined) full[stream] = sync;
      }
      for (const object of objects) {
        if (key && object.key !== key) continue;
        if (object.fullRefresh && full[object.stream] !== object.sync) continue;
        check(); await repository.processObject(record, object, ids(bucket, object, primary[object.stream], check), check);
      }
      check(); await repository.publish(record, full, Object.fromEntries(Object.entries(full).map(([stream,sync]) => [stream,objects.filter(object => object.stream===stream && object.sync===sync).map(object => object.key)])));
    },
  };
}
