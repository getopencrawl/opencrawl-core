import {errorInfo} from '../errors.mjs';
import type {Log} from './ports.mjs';
import type {IntegrationRecord, Provider} from './types.mjs';
import type {IntegrationStorage as TeamBuckets} from './ports.mjs';
interface CountState {read: Set<string>; ids: Record<string, Set<string>>; full: Record<string, {sync: number | null; count: number}>}
interface SavedCountState {version: number; read: string[]; ids: Record<string, string[]>; full?: CountState['full']}
interface CountEntry {state: CountState; counts: Record<string, number>; at: number; succeeded: string}
// Distinct records per stream, counted from what actually landed in the team bucket.
// Airbyte's job stats count rows written per sync, so summing them counts a full-refresh
// stream (repositories, Notion users) once per sync and an updated pull request once per
// update. Here incremental streams count distinct primary keys across every sync, and
// full-refresh streams count distinct keys in the newest finished sync. Each object is read
// once; the key sets are kept beside the data so a restart doesn't re-read everything.
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {createGunzip, gunzipSync, gzipSync} from 'node:zlib';

const VERSION = 1;
const PATH = /\/stream=([^/]+)\/date=[^/]+\/sync=(\d+)\//;
const hash = (value: string) => createHash('sha1').update(value).digest('base64url').slice(0, 12);

/** Primary key per stream name, from a declarative manifest's stream definitions. */
export function manifestKeys(manifest: unknown) {
  const keys: Record<string, string[]> = {};
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if ('name' in node && typeof node.name === 'string' && 'primary_key' in node && Array.isArray(node.primary_key)) keys[node.name] ||= (node.primary_key as Array<string | string[]>).flat();
    Object.values(node).forEach(walk);
  };
  walk(manifest);
  return keys;
}

/** The value that identifies one record: its primary key, or the whole record if it has none. */
export function recordKey(data: Record<string, unknown> | undefined, key?: string[]) {
  return hash(key?.length ? JSON.stringify(key.map(field => data?.[field] ?? null)) : JSON.stringify(data));
}

export function createRecordCounts({buckets, legacyBucket, log = () => {}, now = () => Date.now(), fresh = 60_000}: {buckets: TeamBuckets; legacyBucket: string; log?: Log; now?: () => number; fresh?: number}) {
  const states = new Map<string, CountEntry>();
  const running = new Map<string, Promise<Record<string, number> | null>>();

  const keysFor = (provider: Provider) => provider.keys || (provider.connector?.manifest ? manifestKeys(provider.connector.manifest) : {});
  const stateKey = (record: IntegrationRecord) => `_opencrawl/counts/connection=${record.integrationId}.json.gz`;

  async function load(bucket: string, record: IntegrationRecord): Promise<CountState | null> {
    try {
      const saved = JSON.parse(gunzipSync(await buckets.read(bucket, stateKey(record))).toString('utf8')) as SavedCountState;
      if (saved.version !== VERSION) return null;
      return {read: new Set(saved.read), ids: Object.fromEntries(Object.entries(saved.ids).map(([s, list]) => [s, new Set(list)])), full: saved.full || {}};
    } catch (error) {
      if (errorInfo(error).status !== 404) log('integration.counts.load_failed', {integrationId: record.integrationId, message: errorInfo(error).message});
      return null;
    }
  }

  async function save(bucket: string, record: IntegrationRecord, state: CountState) {
    const body = gzipSync(JSON.stringify({version: VERSION, read: [...state.read], ids: Object.fromEntries(Object.entries(state.ids).map(([s, set]) => [s, [...set]])), full: state.full}));
    await buckets.write(bucket, stateKey(record), body);
  }

  // Streamed: one GitHub backfill part is hundreds of megabytes once unzipped.
  async function* records(bucket: string, key: string): AsyncGenerator<Record<string, unknown>> {
    const lines = createInterface({input: (await buckets.stream(bucket, key)).pipe(createGunzip()), crlfDelay: Infinity});
    for await (const line of lines) {
      if (!line) continue;
      try { yield JSON.parse(line)._airbyte_data; } catch {}
    }
  }

  async function refresh(record: IntegrationRecord, provider: Provider, succeeded: Set<number>) {
    const bucket = record.s3Bucket || legacyBucket;
    const entry = states.get(record.integrationId);
    const state: CountState = entry?.state || await load(bucket, record) || {read: new Set(), ids: {}, full: {}};
    const keys = keysFor(provider);
    const fullRefresh = new Set(provider.streams.filter(s => s.syncMode.startsWith('full_refresh')).map(s => s.name));
    const objects = (await buckets.list(bucket, `${record.s3Prefix}/`))
      .map(o => ({...o, match: PATH.exec(o.key)})).filter(o => o.match && o.key.endsWith('.jsonl.gz'))
      .map(({key, match}) => ({key, stream: match![1], sync: Number(match![2])}));
    let changed = false;

    for (const object of objects) {
      if (fullRefresh.has(object.stream) || state.read.has(object.key)) continue;
      const ids = state.ids[object.stream] ||= new Set();
      for await (const data of records(bucket, object.key)) ids.add(recordKey(data, keys[object.stream]));
      state.read.add(object.key);
      changed = true;
    }

    // Full refresh: the newest sync that finished, or the newest one at all before any has.
    for (const stream of fullRefresh) {
      const syncs = [...new Set(objects.filter(o => o.stream === stream).map(o => o.sync))].sort((a, b) => b - a);
      const sync = syncs.find(s => succeeded.has(s)) ?? (succeeded.size ? undefined : syncs[0]);
      if (sync === undefined || state.full[stream]?.sync === sync) continue;
      const ids = new Set<string>();
      for (const object of objects.filter(o => o.stream === stream && o.sync === sync)) {
        for await (const data of records(bucket, object.key)) ids.add(recordKey(data, keys[stream]));
      }
      // A running sync's parts are still landing: count them, but read them again next time.
      state.full[stream] = {sync: succeeded.has(sync) ? sync : null, count: ids.size};
      changed = true;
    }

    if (changed) await save(bucket, record, state).catch(error => log('integration.counts.save_failed', {integrationId: record.integrationId, message: errorInfo(error).message}));
    const counts = Object.fromEntries([...Object.entries(state.ids).map(([s, set]) => [s, set.size]), ...Object.entries(state.full).map(([s, f]) => [s, f.count])]);
    states.set(record.integrationId, {state, counts, at: now(), succeeded: [...succeeded].sort().join(',')});
    return counts;
  }

  return {
    /**
     * Distinct records per stream, or null if they haven't been counted yet. Starts a recount
     * when the cached one is stale and waits up to `wait` ms for it.
     */
    async get(record: IntegrationRecord, provider: Provider, succeeded: Set<number>, {wait = 3000} = {}) {
      if (!record.s3Prefix) return null;
      const cached = states.get(record.integrationId);
      const key = [...succeeded].sort().join(',');
      if (cached && cached.succeeded === key && now() - cached.at < fresh) return cached.counts;
      if (!running.has(record.integrationId)) {
        running.set(record.integrationId, refresh(record, provider, succeeded)
          .catch(error => { log('integration.counts.failed', {integrationId: record.integrationId, message: errorInfo(error).message}); return null; })
          .finally(() => running.delete(record.integrationId)));
      }
      const timeout = new Promise<undefined>(resolve => setTimeout(resolve, wait, undefined).unref?.());
      const counts = await Promise.race([running.get(record.integrationId), timeout]);
      return counts === undefined ? cached?.counts ?? null : counts ?? cached?.counts ?? null;
    },
    forget: (integrationId: string) => states.delete(integrationId),
  };
}
