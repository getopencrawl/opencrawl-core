import {DatabaseSync} from 'node:sqlite';
import {chmodSync, mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import type {Airbyte} from './airbyte.mjs';
import type {AirbyteJob, AirbyteResource, ConnectorDefinition, ConnectorManifest} from './types.mjs';
import type {ConnectorRunner} from './connector-runner.mjs';

/** Runs declarative manifests; pinned to the version the hosted Airbyte workspace publishes against. */
export const DECLARATIVE_IMAGE = 'airbyte/source-declarative-manifest:7.45.1';
type Kind = 'declarative' | 'source' | 'destination' | 'connection';
type Row = Record<string, unknown>;
interface Store {put(key: string, body: Uint8Array, contentType?: string): Promise<unknown>}
interface ConfiguredStream {name: string; syncMode: string; cursorField?: string[]}
interface CatalogStream {name: string; namespace?: string; json_schema?: unknown; supported_sync_modes?: string[]; default_cursor_field?: string[]; source_defined_primary_key?: string[][]}
interface StateMessage {type?: string; stream?: {stream_descriptor?: {name?: string; namespace?: string}}; data?: unknown; global?: unknown}
export interface LocalAirbyteOptions {
  /** SQLite file shared by the app (which enqueues) and the worker (which runs jobs). */
  path: string; workspaceId: string;
  /** Operator-installed images, resolved by name like Airbyte custom source definitions. */
  definitions?: ConnectorDefinition[];
  /** Encrypts stored source configuration (API keys, app private keys). 32 bytes. */
  secretKey?: Buffer;
  runner?: ConnectorRunner; store?: Store;
  partBytes?: number; now?: () => number; log?: (event: string, data: Record<string, unknown>) => void;
}
const status = (code: number, message: string) => Object.assign(new Error(message), {status: code});
const uuidOf = (value: string) => {const h = createHash('sha256').update(value).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;};

/** Quartz cron (sec min hour day month weekday [year]) as Airbyte accepts, evaluated per UTC minute. */
export function cronMatches(expression: string, at: Date) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length < 6 || fields.length > 7) throw new Error('Invalid cron expression');
  const [, minute, hour, day, month, weekday] = fields;
  const match = (field: string, value: number, low: number) => field.split(',').some(part => {
    if (part === '*' || part === '?') return true;
    const [range, step] = part.split('/'), every = step === undefined ? 1 : Number(step);
    const [from, to] = range === '*' ? [low, Infinity] : range.includes('-') ? range.split('-').map(Number) : [Number(range), step === undefined ? Number(range) : Infinity];
    if (![every, from, to].every(n => Number.isFinite(n) || n === Infinity) || every < 1) throw new Error('Invalid cron expression');
    return value >= from && value <= to && (value - from) % every === 0;
  });
  // Evaluate every field so an unsupported expression fails when created, not when first due.
  return [match(minute, at.getUTCMinutes(), 0), match(hour, at.getUTCHours(), 0), match(day, at.getUTCDate(), 1),
    match(month, at.getUTCMonth() + 1, 1), match(weekday, at.getUTCDay() + 1, 1)].every(Boolean);
}

/** Airbyte's public-API stream modes to protocol configured-catalog modes. */
export function configuredCatalog(discovered: CatalogStream[], configured: ConfiguredStream[]) {
  return {streams: configured.map(({name, syncMode, cursorField}) => {
    const stream = discovered.find(s => s.name === name);
    if (!stream) throw new Error(`Source does not offer stream ${name}`);
    const incremental = syncMode.startsWith('incremental');
    const destination = syncMode.endsWith('overwrite') ? 'overwrite' : /dedup/.test(syncMode) ? 'append_dedup' : 'append';
    return {stream, sync_mode: incremental ? 'incremental' : 'full_refresh', destination_sync_mode: destination,
      ...(incremental ? {cursor_field: cursorField || stream.default_cursor_field || []} : {}),
      ...(destination === 'append_dedup' ? {primary_key: stream.source_defined_primary_key || []} : {}),
      generation_id: 0, minimum_generation_id: 0, sync_id: 0};
  })};
}

/**
 * The subset of the Airbyte public API used by integrations, implemented by
 * running source images directly. Records land in the object store with the S3
 * destination's layout and envelope, so indexing is unchanged.
 */
export function createLocalAirbyte({path, workspaceId, definitions = [], secretKey, runner, store, partBytes = 8 * 1024 * 1024, now = Date.now, log = () => {}}: LocalAirbyteOptions) {
  if (secretKey && secretKey.length !== 32) throw new Error('Connector secret key must be 32 bytes');
  const file = resolve(path);
  mkdirSync(dirname(file), {recursive: true, mode: 0o700});
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  db.exec(`CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK(id=1), workspace TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS resources (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, connection TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL,
      started INTEGER, updated INTEGER NOT NULL, rows INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, stats TEXT NOT NULL DEFAULT '{}', failure TEXT);
    CREATE TABLE IF NOT EXISTS state (connection TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS schedule (connection TEXT PRIMARY KEY, minute INTEGER NOT NULL);`);
  db.prepare('INSERT OR IGNORE INTO binding VALUES (1, ?)').run(workspaceId);
  if (db.prepare('SELECT workspace FROM binding WHERE id=1').get()?.workspace !== workspaceId) {db.close(); throw new Error('Connector state belongs to another workspace');}
  const docker = new Map(definitions.filter(d => d.docker).map(d => [uuidOf('docker:' + d.name), d]));

  const seal = (value: unknown) => {
    const text = JSON.stringify(value);
    if (!secretKey) return text;
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', secretKey, iv);
    const body = Buffer.concat([cipher.update(text), cipher.final()]);
    return 'v1:' + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  };
  const open = (text: string): unknown => {
    if (!text.startsWith('v1:')) return JSON.parse(text);
    if (!secretKey) throw new Error('Connector secret key is required');
    const bytes = Buffer.from(text.slice(3), 'base64'), decipher = createDecipheriv('aes-256-gcm', secretKey, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
  };
  const transaction = <T,>(operation: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {const value = operation(); db.exec('COMMIT'); return value;} catch (error) {db.exec('ROLLBACK'); throw error;}
  };
  const scope = (id: string) => {if (id !== workspaceId) throw status(404, 'Workspace not found');};
  const get = (kind: Kind, id: string) => {
    const row = db.prepare('SELECT body FROM resources WHERE id=? AND kind=? AND deleted=0').get(id, kind);
    if (!row) throw status(404, `${kind} not found`);
    return open(String(row.body)) as Row;
  };
  const list = (kind: Kind) => db.prepare('SELECT id, name, body FROM resources WHERE kind=? AND deleted=0 ORDER BY rowid').all(kind)
    .map(row => ({id: String(row.id), name: String(row.name), body: open(String(row.body)) as Row}));
  const insert = (kind: Kind, name: string, body: Row) => {
    const id = randomUUID();
    db.prepare('INSERT INTO resources (id, kind, name, body) VALUES (?, ?, ?, ?)').run(id, kind, name, seal(body));
    return id;
  };
  const remove = (kind: Kind, id: string) => {
    if (!db.prepare('UPDATE resources SET deleted=1 WHERE id=? AND kind=? AND deleted=0').run(id, kind).changes) throw status(404, `${kind} not found`);
  };
  const job = (row: Row): AirbyteJob => ({jobId: Number(row.id), status: String(row.status), rowsSynced: Number(row.rows),
    ...(row.started ? {startTime: new Date(Number(row.started)).toISOString()} : {}), lastUpdatedAt: new Date(Number(row.updated)).toISOString()});
  const enqueue = (connectionId: string) => transaction(() => {
    get('connection', connectionId);
    if (db.prepare("SELECT id FROM jobs WHERE connection=? AND status IN ('pending','running')").get(connectionId)) throw status(409, 'A sync is already running');
    const at = now(), id = db.prepare("INSERT INTO jobs (connection, status, created, updated) VALUES (?, 'pending', ?, ?)").run(connectionId, at, at).lastInsertRowid;
    return job(db.prepare('SELECT * FROM jobs WHERE id=?').get(id)!);
  });
  const summary = (kind: 'source' | 'destination' | 'connection', item: {id: string; name: string; body: Row}): AirbyteResource => ({
    id: item.id, name: item.name, workspaceId, [kind + 'Id']: item.id,
    ...(kind === 'connection' ? {sourceId: item.body.sourceId as string, destinationId: item.body.destinationId as string, status: 'active'} : {}),
  });

  const api: Airbyte = {
    async declarativeSources(id) {scope(id); return list('declarative').map(d => ({id: d.id, name: d.name, workspaceId, manifest: d.body.manifest as ConnectorManifest}));},
    async createDeclarativeSource(id, name, manifest) {scope(id); return {id: insert('declarative', name, {manifest}), name, workspaceId};},
    async updateDeclarativeSource(id, definitionId, manifest) {
      scope(id); get('declarative', definitionId);
      db.prepare("UPDATE resources SET body=? WHERE id=? AND kind='declarative'").run(seal({manifest}), definitionId);
    },
    async sourceDefinitions(id) {scope(id); return [...docker].map(([definitionId, d]) => ({id: definitionId, name: d.name, workspaceId, dockerRepository: d.docker!.repository, dockerImageTag: d.docker!.tag}));},
    async destinations(id) {scope(id); return list('destination').map(d => summary('destination', d));},
    async sources(id) {scope(id); return list('source').map(d => summary('source', d));},
    async connections(id) {scope(id); return list('connection').map(d => summary('connection', d));},
    async destinationDefinitions(id) {scope(id); return [{id: uuidOf('destination:object-store'), name: 'OpenCrawl object store', workspaceId}];},
    async destinationDefinitionVersion() {return {dockerRepository: 'opencrawl/object-store', dockerImageTag: 'local', supportsRefreshes: false};},
    async createDestinationDefinition() {throw status(501, 'Destination definitions are built in');},
    async createDestination(input) {
      const {workspaceId: id, name, configuration} = input as {workspaceId: string; name: string; configuration?: Row};
      scope(id);
      const prefix = configuration?.s3_bucket_path;
      if (typeof prefix !== 'string' || !prefix || prefix.split('/').some(p => p === '.' || p === '..')) throw status(422, 'Destination needs a landing path');
      // Storage credentials stay with the runtime; only the landing path is kept.
      const destinationId = insert('destination', name, {prefix});
      return {id: destinationId, destinationId, name, workspaceId};
    },
    async deleteDestination(id) {remove('destination', id);},
    async createSource(input) {
      const {workspaceId: id, name, definitionId, configuration} = input as {workspaceId: string; name: string; definitionId: string; configuration: Row};
      scope(id);
      if (!docker.has(definitionId)) get('declarative', definitionId);
      const sourceId = insert('source', name, {definitionId, configuration});
      return {id: sourceId, sourceId, name, workspaceId};
    },
    async deleteSource(id) {remove('source', id);},
    async createConnection(input) {
      const {name, sourceId, destinationId, schedule, configurations} = input as {name: string; sourceId: string; destinationId: string; schedule?: {cronExpression?: string}; configurations?: {streams?: ConfiguredStream[]}};
      get('source', sourceId); get('destination', destinationId);
      const cron = schedule?.cronExpression || null;
      if (cron) cronMatches(cron, new Date(0));
      const connectionId = insert('connection', name, {sourceId, destinationId, cron, streams: configurations?.streams || []});
      return {id: connectionId, connectionId, name, workspaceId, sourceId, destinationId};
    },
    async deleteConnection(id) {
      transaction(() => {
        remove('connection', id);
        db.prepare("UPDATE jobs SET status='cancelled', updated=? WHERE connection=? AND status='pending'").run(now(), id);
      });
    },
    async sync(connectionId) {return enqueue(connectionId);},
    async streamCounts(connectionId) {
      const counts: Record<string, number> = {};
      let found = false;
      for (const row of db.prepare('SELECT status, stats FROM jobs WHERE connection=? ORDER BY id DESC LIMIT 100').all(connectionId)) {
        const running = ['pending', 'running'].includes(String(row.status));
        for (const [stream, stat] of Object.entries(JSON.parse(String(row.stats)) as Record<string, {emitted: number; committed: number}>)) {
          found = true; counts[stream] = (counts[stream] || 0) + (running ? stat.emitted : stat.committed);
        }
      }
      return found ? counts : null;
    },
    async jobs(connectionId, limit = 20) {return db.prepare('SELECT * FROM jobs WHERE connection=? ORDER BY id DESC LIMIT ?').all(connectionId, limit).map(job);},
  };

  /** Executes one claimed job end to end. */
  async function execute(jobId: number, connectionId: string, signal: AbortSignal) {
    if (!runner || !store) throw new Error('This process cannot run connectors');
    const connection = get('connection', connectionId), source = get('source', String(connection.sourceId)), destination = get('destination', String(connection.destinationId));
    const definition = docker.get(String(source.definitionId));
    const image = definition ? `${definition.docker!.repository}:${definition.docker!.tag}` : DECLARATIVE_IMAGE;
    const config = definition ? source.configuration : {...source.configuration as Row, __injected_declarative_manifest: get('declarative', String(source.definitionId)).manifest};
    const alive = () => {if (signal.aborted || !db.prepare("SELECT 1 FROM resources WHERE id=? AND kind='connection' AND deleted=0").get(connectionId)) throw Object.assign(new Error('Connection removed'), {code: 'ABORT_ERR'});};
    const outcome: {streams: CatalogStream[] | null; failed: boolean} = {streams: null, failed: false};
    const discovered = await runner.run({image, command: 'discover', files: {config}, signal, label: `discover:${jobId}`}, text => {
      const message = parse(text);
      if (message?.type === 'CATALOG') outcome.streams = (message.catalog as {streams?: CatalogStream[]})?.streams || [];
      if (message?.type === 'TRACE' && (message.trace as Row)?.type === 'ERROR') outcome.failed = true;
    });
    if (discovered.exitCode !== 0 || outcome.failed || !outcome.streams) throw new Error('Connector discovery failed');
    const catalog = configuredCatalog(outcome.streams, connection.streams as ConfiguredStream[]);
    const prior = db.prepare('SELECT body FROM state WHERE connection=?').get(connectionId);
    const saved = prior ? open(String(prior.body)) as StateMessage[] : [];
    const prefix = String(destination.prefix).replace(/\/+$/, '') + '/';
    const parts = new Map<string, {lines: Buffer[]; bytes: number; records: number}>(), sequence = new Map<string, number>();
    const stats: Record<string, {emitted: number; committed: number}> = {};
    let rows = 0, bytes = 0, state = saved, lastProgress = 0;
    const progress = (force = false) => {
      if (!force && now() - lastProgress < 5000) return;
      lastProgress = now();
      db.prepare('UPDATE jobs SET rows=?, bytes=?, stats=?, updated=? WHERE id=?').run(rows, bytes, JSON.stringify(stats), now(), jobId);
    };
    async function flush(stream: string) {
      const part = parts.get(stream);
      if (!part?.records) return;
      alive();
      const at = new Date(now()), n = sequence.get(stream) || 0;
      sequence.set(stream, n + 1);
      const body = gzipSync(Buffer.concat(part.lines));
      await store!.put(`${prefix}stream=${stream}/date=${at.toISOString().slice(0, 10)}/sync=${jobId}/${at.getTime()}_${n}.jsonl.gz`, body, 'application/gzip');
      stats[stream].committed += part.records; rows += part.records; bytes += body.length;
      parts.delete(stream);
    }
    const merge = (message: StateMessage) => {
      if (message.type === 'STREAM') {
        const d = message.stream?.stream_descriptor;
        return [...state.filter(s => s.type !== 'STREAM' || s.stream?.stream_descriptor?.name !== d?.name || s.stream?.stream_descriptor?.namespace !== d?.namespace), message];
      }
      return [message];
    };
    const read = await runner.run({image, command: 'read', files: {config, catalog, ...(saved.length ? {state: saved} : {})}, signal, label: `read:${jobId}`}, async text => {
      const message = parse(text);
      if (message?.type === 'RECORD') {
        const record = message.record as {stream?: string; data?: unknown; emitted_at?: number; meta?: {changes?: unknown[]}};
        if (typeof record?.stream !== 'string' || !record.data || typeof record.data !== 'object') return;
        const line = Buffer.from(JSON.stringify({_airbyte_raw_id: randomUUID(), _airbyte_extracted_at: Number.isSafeInteger(record.emitted_at) ? record.emitted_at : now(),
          _airbyte_meta: {changes: record.meta?.changes || [], sync_id: jobId}, _airbyte_generation_id: 0, _airbyte_data: record.data}) + '\n');
        const part = parts.get(record.stream) || {lines: [], bytes: 0, records: 0};
        part.lines.push(line); part.bytes += line.length; part.records++; parts.set(record.stream, part);
        (stats[record.stream] ||= {emitted: 0, committed: 0}).emitted++;
        if (part.bytes >= partBytes) await flush(record.stream);
        progress();
      } else if (message?.type === 'STATE') {
        // A checkpoint is durable only after every record before it has landed.
        for (const stream of [...parts.keys()]) await flush(stream);
        alive();
        state = merge(message.state as StateMessage);
        transaction(() => {
          db.prepare('INSERT INTO state VALUES (?, ?) ON CONFLICT(connection) DO UPDATE SET body=excluded.body').run(connectionId, seal(state));
          db.prepare('UPDATE jobs SET rows=?, bytes=?, stats=?, updated=? WHERE id=?').run(rows, bytes, JSON.stringify(stats), now(), jobId);
        });
      } else if (message?.type === 'TRACE' && (message.trace as Row)?.type === 'ERROR') outcome.failed = true;
    });
    for (const stream of [...parts.keys()]) await flush(stream);
    progress(true);
    // Connector stderr and TRACE messages can echo configuration; only counts are logged.
    if (read.exitCode !== 0 || outcome.failed) throw Object.assign(new Error('Connector read failed'), {exitCode: read.exitCode, stderrBytes: read.stderrBytes});
  }
  const parse = (text: string): Row | null => {try {const value = JSON.parse(text); return value && typeof value === 'object' ? value : null;} catch {return null;}};

  let timer: NodeJS.Timeout | undefined, running: Promise<void> | undefined;
  const controllers = new Set<AbortController>();
  /** Enqueues due scheduled syncs and runs pending jobs one at a time. Worker only. */
  async function tick() {
    const at = new Date(now()), minute = Math.floor(at.getTime() / 60000);
    for (const connection of list('connection')) {
      const cron = connection.body.cron as string | null;
      if (!cron || !cronMatches(cron, at)) continue;
      const fired = db.prepare('SELECT minute FROM schedule WHERE connection=?').get(connection.id);
      if (fired && Number(fired.minute) >= minute) continue;
      db.prepare('INSERT INTO schedule VALUES (?, ?) ON CONFLICT(connection) DO UPDATE SET minute=excluded.minute').run(connection.id, minute);
      try {enqueue(connection.id);} catch (error) {if ((error as {status?: number}).status !== 409) throw error;}
    }
    while (true) {
      const claimed = transaction(() => {
        const next = db.prepare("SELECT id, connection FROM jobs WHERE status='pending' ORDER BY id LIMIT 1").get();
        if (next) db.prepare("UPDATE jobs SET status='running', started=?, updated=? WHERE id=?").run(now(), now(), next.id);
        return next;
      });
      if (!claimed) return;
      const id = Number(claimed.id), controller = new AbortController();
      controllers.add(controller);
      let outcome = 'succeeded';
      try {await execute(id, String(claimed.connection), controller.signal);}
      catch (error) {
        const e = error as {code?: string; exitCode?: number; stderrBytes?: number; message?: string};
        outcome = e.code === 'ABORT_ERR' ? 'cancelled' : 'failed';
        log('connector.job.failed', {jobId: id, outcome, exitCode: e.exitCode ?? null, stderrBytes: e.stderrBytes ?? null, message: e.code === 'ABORT_ERR' ? null : String(e.message).slice(0, 200)});
      } finally {controllers.delete(controller);}
      db.prepare('UPDATE jobs SET status=?, updated=? WHERE id=?').run(outcome, now(), id);
    }
  }
  return {
    ...api,
    tick,
    /** Starts the worker loop. Jobs left running by a previous process are marked incomplete and retried on schedule. */
    start({intervalMs = 30_000}: {intervalMs?: number} = {}) {
      db.prepare("UPDATE jobs SET status='failed', updated=? WHERE status='running'").run(now());
      const run = () => {if (!running) running = tick().catch(error => log('connector.scheduler.failed', {message: String((error as Error).message).slice(0, 200)})).finally(() => {running = undefined;});};
      timer = setInterval(run, intervalMs); run();
    },
    async stop() {clearInterval(timer); timer = undefined; for (const c of controllers) c.abort(); await running;},
    close() {if (db.isOpen) db.close();},
  };
}
export type LocalAirbyte = ReturnType<typeof createLocalAirbyte>;
