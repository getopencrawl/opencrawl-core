import type {ChildProcessByStdio} from 'node:child_process';
import type {Readable} from 'node:stream';
import type {ObjectStore} from '../sessions/types.mjs';
import type {Registry} from './registry.mjs';
import type {ConnectionRecord, Provider} from './types.mjs';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {createGzip, type Gzip} from 'node:zlib';
import {providers as catalog} from './providers.mjs';

// Self-host source sync. Runs each connection's declarative manifest with Airbyte's
// `source-declarative-manifest` CLI (an upstream image; no Airbyte platform) and lands records
// in the deployment bucket where the connector indexer reads them:
//   raw/v1/source=<provider>/workspace=<id>/connection=<id>/stream=<s>/date=<d>/sync=<n>/part-<k>.jsonl.gz
// A checkpoint is committed only after every record before it is uploaded, so a crash re-reads
// rather than skips. Disconnected connections have their raw data deleted here.
interface AirbyteMessage {
  type: string;
  record?: {stream: string; data: Record<string, unknown>; emitted_at: number};
  state?: {type?: string; stream?: {stream_descriptor: {name: string; namespace?: string}}};
  trace?: {type: string; error?: {message?: string; internal_message?: string}};
  catalog?: {streams: Array<{name: string; json_schema: unknown; supported_sync_modes: string[]}>};
}
type Child = ChildProcessByStdio<null, Readable, Readable>;
type Run = (args: string[]) => Child;
export interface SyncOptions {
  registry: Registry; store: Pick<ObjectStore, 'put' | 'listPage'> & {delete(key: string): Promise<void>}; manifests: string;
  composioApiKey?: string; composioBaseUrl?: string; providers?: Readonly<Record<string, Provider>>;
  run?: Run; checkpointBytes?: number; now?: () => number; log?: (event: string, data: Record<string, unknown>) => void;
}

export const rawPrefix = (record: Pick<ConnectionRecord, 'provider' | 'workspaceId' | 'id'>) => `raw/v1/source=${record.provider}/workspace=${record.workspaceId}/connection=${record.id}/`;

/** Streams parsed protocol messages from one CLI invocation; rejects on a nonzero exit. */
async function* messages(child: Child) {
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  for await (const line of createInterface({input: child.stdout, crlfDelay: Infinity})) {
    if (!line.startsWith('{')) continue;
    let message: AirbyteMessage;
    try { message = JSON.parse(line) as AirbyteMessage; } catch { continue; }
    yield message;
  }
  const code = await exited;
  if (code !== 0) throw new Error(`Connector exited with ${code}: ${stderr.trim().split('\n').at(-1) || 'no output'}`);
}

/** Gzip JSONL parts per stream, uploaded together before a checkpoint is committed. */
function landing(store: SyncOptions['store'], base: string, syncId: string, date: string) {
  let open = new Map<string, {gzip: Gzip; chunks: Buffer[]}>(), part = 0, pending = 0;
  const records: Record<string, number> = {};
  return {
    records,
    get pending() { return pending; },
    write(stream: string, data: Record<string, unknown>, emittedAt: number) {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(stream)) throw new Error('Invalid stream name from connector');
      let file = open.get(stream);
      if (!file) {
        const gzip = createGzip(), chunks: Buffer[] = [];
        gzip.on('data', (chunk: Buffer) => chunks.push(chunk));
        open.set(stream, file = {gzip, chunks});
      }
      const line = JSON.stringify({_airbyte_raw_id: randomUUID(), _airbyte_extracted_at: emittedAt, _airbyte_meta: {changes: [], sync_id: Number(syncId)},
        _airbyte_generation_id: 0, _airbyte_data: data}) + '\n';
      file.gzip.write(line);
      pending += line.length;
      records[stream] = (records[stream] || 0) + 1;
    },
    async flush() {
      const files = open; open = new Map(); pending = 0;
      for (const [stream, {gzip, chunks}] of files) {
        await new Promise<void>((resolve, reject) => { gzip.once('end', resolve); gzip.once('error', reject); gzip.end(); });
        await store.put(`${base}stream=${stream}/date=${date}/sync=${syncId}/part-${String(part).padStart(5, '0')}.jsonl.gz`, Buffer.concat(chunks), 'application/gzip');
      }
      part++;
    },
    close() { for (const {gzip} of open.values()) gzip.destroy(); },
  };
}

export function createSourceSync({registry, store, manifests, composioApiKey = '', composioBaseUrl = 'https://backend.composio.dev', providers = catalog,
  run = args => spawn('source-declarative-manifest', args, {stdio: ['ignore', 'pipe', 'pipe']}),
  checkpointBytes = 64 * 1024 * 1024, now = () => Date.now(), log = () => {}}: SyncOptions) {
  const composioKey = () => composioApiKey || registry.setting('composio_api_key') || '';
  const due = (record: ConnectionRecord) => !record.lastSyncAt || now() - Date.parse(record.lastSyncAt) >= providers[record.provider].sync.everyMinutes * 60_000;

  function configFor(record: ConnectionRecord, provider: Provider, apiKey: string | null) {
    const config: Record<string, unknown> = provider.sync.config(record);
    if (provider.auth === 'api-key') {
      if (!apiKey) throw new Error('Workspace API key is missing; disconnect and connect again');
      config.api_key = apiKey;
    } else {
      const key = composioKey();
      if (!key) throw new Error('Composio API key is not configured');
      Object.assign(config, {composio_api_key: key, composio_base_url: composioBaseUrl, connected_account_id: record.connectedAccountId, user_id: record.composioUser});
    }
    return config;
  }

  /** Selected streams with schemas from discover; incremental where the manifest supports it. */
  async function configuredCatalog(provider: Provider, configPath: string) {
    let discovered: AirbyteMessage['catalog'];
    for await (const message of messages(run(['discover', '--config', configPath]))) if (message.type === 'CATALOG') discovered = message.catalog;
    if (!discovered) throw new Error('Connector returned no catalog');
    return {streams: provider.sync.streams.map(wanted => {
      const stream = discovered!.streams.find(s => s.name === wanted.name);
      if (!stream) throw new Error(`Manifest has no stream ${wanted.name}`);
      const incremental = wanted.syncMode === 'incremental' && stream.supported_sync_modes.includes('incremental');
      return {stream, sync_mode: incremental ? 'incremental' : 'full_refresh', destination_sync_mode: 'append', ...(incremental ? {cursor_field: wanted.cursorField} : {})};
    })};
  }

  async function sync(record: ConnectionRecord) {
    const provider = providers[record.provider];
    const {apiKey, state} = registry.syncInput(record.id);
    const manifest = JSON.parse(await readFile(join(manifests, `${provider.id}.json`), 'utf8'));
    const dir = await mkdtemp(join(tmpdir(), 'opencrawl-sync-'));
    const syncId = String(now()), out = landing(store, rawPrefix(record), syncId, new Date(now()).toISOString().slice(0, 10));
    // Latest checkpoint per stream (or the global one), seeded with the committed state.
    const latest = new Map<string, unknown>();
    const stateKey = (message: AirbyteMessage['state']) => message?.stream ? `stream:${message.stream.stream_descriptor.name}` : String(message?.type);
    for (const previous of state as AirbyteMessage['state'][]) latest.set(stateKey(previous), previous);
    const commit = async () => { await out.flush(); if (latest.size) registry.saveState(record.id, [...latest.values()]); };
    try {
      const paths = {config: join(dir, 'config.json'), catalog: join(dir, 'catalog.json'), state: join(dir, 'state.json')};
      await writeFile(paths.config, JSON.stringify({...configFor(record, provider, apiKey), __injected_declarative_manifest: manifest}), {mode: 0o600});
      await writeFile(paths.catalog, JSON.stringify(await configuredCatalog(provider, paths.config)), {mode: 0o600});
      await writeFile(paths.state, JSON.stringify(state), {mode: 0o600});
      for await (const message of messages(run(['read', '--config', paths.config, '--catalog', paths.catalog, '--state', paths.state]))) {
        if (message.type === 'RECORD' && message.record) out.write(message.record.stream, message.record.data, message.record.emitted_at);
        else if (message.type === 'STATE' && message.state) {
          latest.set(stateKey(message.state), message.state);
          if (out.pending >= checkpointBytes) await commit();
        } else if (message.type === 'TRACE' && message.trace?.type === 'ERROR') throw new Error(message.trace.error?.message || 'Connector failed');
      }
      await commit();
      return out.records;
    } finally {
      out.close();
      await rm(dir, {recursive: true, force: true});
    }
  }

  async function deleteRaw(record: ConnectionRecord) {
    let deleted = 0;
    // Deleting while listing shifts pages, so re-list from the start until nothing is left.
    for (;;) {
      const {keys} = await store.listPage(rawPrefix(record), {maxKeys: 1000});
      if (!keys.length) break;
      for (const key of keys) { await store.delete(key); deleted++; }
    }
    return deleted;
  }

  return {
    /** One pass: finish disconnects, then sync every due connection in turn. */
    async tick({shouldStop = () => false}: {shouldStop?: () => boolean} = {}) {
      for (const record of registry.list(['disconnecting'])) {
        if (record.workspaceId) log('sources.disconnected', {provider: record.provider, connection: record.id, deletedObjects: await deleteRaw(record)});
        registry.markDisconnected(record.id);
      }
      for (const record of registry.list(['active'])) {
        if (shouldStop()) return;
        if (!record.workspaceId || !Object.hasOwn(providers, record.provider) || !due(record)) continue;
        const started = now();
        registry.syncStatus(record.id, 'running');
        try {
          const records = await sync(record);
          registry.syncStatus(record.id, 'succeeded');
          log('sources.synced', {provider: record.provider, connection: record.id, records, seconds: (now() - started) / 1000});
        } catch (error) {
          // One connection's failure never blocks the others. Never echo secrets.
          let message = String((error as Error).message).slice(0, 500);
          for (const secret of [registry.syncInput(record.id).apiKey, composioKey()]) if (secret) message = message.replaceAll(secret, '[redacted]');
          registry.syncStatus(record.id, 'failed', message);
          log('sources.sync_failed', {provider: record.provider, connection: record.id, message});
        }
      }
    },
  };
}
