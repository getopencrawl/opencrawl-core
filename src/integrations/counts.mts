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
  refresh(record: IntegrationRecord, provider: Provider, succeeded: Set<number>, options?: {key?: string; check?: () => void; publishOnly?: boolean}): Promise<void>;
  remove(record: IntegrationRecord): Promise<void>;
}
export interface ObjectRecordCounts extends RecordCounts {
  /** Stage one indexed object without scanning inventory or publishing totals. */
  process(record: IntegrationRecord, provider: Provider, key: string, check?: () => void): Promise<void>;
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

/** Reads never enqueue or scan. Object activities stage IDs; a
 * reauthorized sweep-completion activity selects complete snapshots and publishes. */
export function createRecordCounts({buckets, legacyBucket, repository}: {buckets: IntegrationStorage; legacyBucket: string; repository: RecordCountRepository}): ObjectRecordCounts {
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
    async process(record, provider, key, check = () => {}) {
      if (!record.s3Prefix) return;
      check();
      const match = PATH.exec(key), sync = match ? Number(match[2]) : NaN;
      if (!match || !key.startsWith(`${record.s3Prefix}/`) || !key.endsWith('.jsonl.gz') || !Number.isSafeInteger(sync) || sync < 0) return;
      const fullRefresh = provider.streams.some(stream => stream.name === match[1] && stream.syncMode.startsWith('full_refresh'));
      const object = {key, stream: match[1], sync, fullRefresh};
      const primary = provider.keys || (provider.connector?.manifest ? manifestKeys(provider.connector.manifest) : {});
      await repository.processObject(record, object, ids(record.s3Bucket || legacyBucket, object, primary[object.stream], check), check);
    },
    async refresh(record, provider, succeeded, {key, check = () => {}, publishOnly = false} = {}) {
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
        const sync = syncs.find(value => succeeded.has(value)) ?? (!publishOnly && !succeeded.size ? syncs[0] : undefined);
        if (sync !== undefined) full[stream] = sync;
      }
      for (const object of objects) {
        if (publishOnly) break;
        if (key && object.key !== key) continue;
        if (object.fullRefresh && full[object.stream] !== object.sync) continue;
        check(); await repository.processObject(record, object, ids(bucket, object, primary[object.stream], check), check);
      }
      check(); await repository.publish(record, full, Object.fromEntries(Object.entries(full).map(([stream,sync]) => [stream,objects.filter(object => object.stream===stream && object.sync===sync).map(object => object.key)])));
    },
  };
}

/** Shared self-host/cloud orchestration. Resolve current authority for every
 * activity; no authorization, inventory or provider-result cache crosses calls. */
export function createCountMeasurement({counts, resolve, jobs}: {
  counts: ObjectRecordCounts;
  resolve(): Promise<{record: IntegrationRecord; provider: Provider}>;
  jobs(connectionId: string, limit: number): Promise<Array<{status?: string; jobId: string | number}>>;
}) {
  const binding = ({record, provider}: {record: IntegrationRecord; provider: Provider}) => JSON.stringify([
    record.environment, record.tenantId, record.userId, record.integrationId, record.provider,
    record.s3Bucket, record.s3Prefix, record.airbyte?.connectionId, provider.streams, provider.keys, provider.connector?.manifest,
  ]);
  async function current(check: () => void) {
    check();
    const resolved = await resolve();
    if (resolved.record.status !== 'active') throw Object.assign(new Error('Measurement connection is inactive'), {permanent: true});
    check();
    return resolved;
  }
  return {
    async afterObject(key: string, check: () => void) {
      const {record, provider} = await current(check);
      await counts.process(record, provider, key, check);
    },
    async afterSweep(check: () => void) {
      const initial = await current(check), identity = binding(initial);
      const {record, provider} = initial;
      const completed = record.airbyte?.connectionId ? await jobs(record.airbyte.connectionId, 100) : [];
      // A slow provider response must not admit work after scope/binding changes.
      const latest = await current(check);
      if (binding(latest) !== identity) throw Object.assign(new Error('Measurement connection changed'), {permanent: true});
      // Only indexed objects have been staged. Never stream newly arrived or
      // unselected source files here; expected keys keep partial snapshots hidden.
      await counts.refresh(record, provider, new Set(completed.filter(job => job.status === 'succeeded').map(job => Number(job.jobId))), {check, publishOnly: true});
    },
  };
}
