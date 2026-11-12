import type {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdirSync, openSync, closeSync, existsSync} from 'node:fs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {TenantPrincipal} from '../sessions/types.mjs';
import type {Aggregation, Corpus, IndexHit, OpenSearchResponse, RealmOptions, SearchDocument, SearchRealm} from './types.mjs';
import {realmDocument, realmField, realmIndex} from './realm-format.mjs';
import {applyPatch, applyWrite} from './mutations.mjs';
import {and, keys, object, QueryCompiler, readHits, unsupported} from './sqlite-query.mjs';
import {aggregate} from './sqlite-aggregations.mjs';

const APPLICATION_ID = 0x4f435346; // OCSF: prevents opening an unrelated SQLite DB.
const VERSION = 1;
function preflight<T>(run: () => T): T {
  try {return run();} catch (error) {throw Object.assign(error as object, {writeOutcome: 'not-applied'});}
}
const fail = (message: string, status = 503) => Object.assign(new Error(message), {status, permanent: status === 403});
const corpora = new Set<Corpus>(['session', 'connector', 'memory', 'board']);
const response = (): OpenSearchResponse => ({timed_out: false, _shards: {failed: 0}, hits: {hits: [], total: {value: 0, relation: 'eq'}}, docs: [], items: []});
export function sqlitePath(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== 'sqlite:' || url.host || url.username || url.password || url.search || url.hash || !url.pathname.startsWith('/') || url.pathname.endsWith('/')) throw fail('Invalid SQLite search endpoint; use sqlite:///absolute/path/search.sqlite', 400);
  return fileURLToPath('file:' + url.pathname);
}

/** One local, durable index file; realm/corpus scoping stays mandatory. Each
 * operation owns and closes its connection, so resolver eviction cannot leak
 * handles. WAL coordinates the API and indexing worker on the same host. */
export function createSqliteRealm(options: RealmOptions): SearchRealm {
  const {tenantId, endpoint, environment = 'selfhost', generation = 'v1'} = options;
  if (typeof tenantId !== 'string' || !tenantId) throw fail('Realm tenant required', 403);
  if (options.credentials || options.username || options.password || options.replicas) throw fail('SQLite does not support remote credentials or replicas', 400);
  const path = sqlitePath(endpoint), index = options.index || realmIndex(environment, tenantId, generation);
  if (!/^[a-z][a-z0-9_-]{0,150}$/.test(index)) throw fail('Invalid realm index', 400);
  // Capture and OpenSearch consumers also import this module under Bun. Load
  // the Node-only runtime only when the operator actually selects SQLite.
  const {DatabaseSync} = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const fts = 'fts_' + createHash('sha256').update(index).digest('hex');
  const scope = (principal: TenantPrincipal) => {if (principal?.tenantId !== tenantId || principal.captureAccess !== undefined) throw fail('Realm scope denied', 403);};
  function withDatabase<T>(write: boolean, create: boolean, run: (db: DatabaseSync) => T): T {
    if (!existsSync(path)) {
      if (!create) throw fail('Realm index does not exist', 404);
      mkdirSync(dirname(path), {recursive: true, mode: 0o700});
      try {closeSync(openSync(path, 'wx', 0o600));} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;}
    }
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA busy_timeout=5000');
      const application = Number(db.prepare('PRAGMA application_id').get()!.application_id);
      if (application !== APPLICATION_ID) {
        if (application) throw fail('Not an OpenCrawl SQLite search index');
        if (!create) throw fail('Realm index does not exist', 404);
        db.exec('BEGIN IMMEDIATE');
        try {
          // Recheck after obtaining the writer lock: another process may have initialized it.
          const current = Number(db.prepare('PRAGMA application_id').get()!.application_id);
          if (current !== 0 && current !== APPLICATION_ID) throw fail('Not an OpenCrawl SQLite search index');
          if (current === 0) {
            if (db.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()) throw fail('Not an OpenCrawl SQLite search index');
            db.exec(`CREATE TABLE realms (name TEXT PRIMARY KEY, tenant TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS documents (rowid INTEGER PRIMARY KEY, realm TEXT NOT NULL, corpus TEXT NOT NULL, id TEXT NOT NULL, document TEXT NOT NULL CHECK(json_valid(document)), UNIQUE(realm,corpus,id));
            PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${VERSION};`);
          }
          db.exec('COMMIT');
        } catch (error) {db.exec('ROLLBACK'); throw error;}
      }
      if (Number(db.prepare('PRAGMA user_version').get()!.user_version) !== VERSION) throw fail('Unsupported SQLite search schema; upgrade or rebuild into a new file');
      // Concurrent initializers can return SQLITE_BUSY immediately while
      // upgrading journal locks, without invoking SQLite's busy handler.
      // Retry only this idempotent setup step, before any document mutation.
      const deadline = performance.now() + 5000, pause = new Int32Array(new SharedArrayBuffer(4));
      db.exec('PRAGMA busy_timeout=0');
      try {
        for (;;) {
          try {
            if (db.prepare('PRAGMA journal_mode=WAL').get()!.journal_mode !== 'wal') throw fail('SQLite search requires WAL mode');
            break;
          } catch (error) {
            if ((Number((error as {errcode?: number}).errcode) & 255) !== 5 || performance.now() >= deadline) throw error;
            Atomics.wait(pause, 0, 0, Math.min(20, deadline - performance.now()));
          }
        }
      } finally {db.exec('PRAGMA busy_timeout=5000');}
      db.exec('PRAGMA synchronous=FULL');
      db.function('epoch', {deterministic: true}, value => {
        const n = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
        return Number.isFinite(n) ? n : null;
      });
      let owner = db.prepare('SELECT tenant FROM realms WHERE name=?').get(index);
      if (!owner) {
        if (!create) throw fail('Realm index does not exist', 404);
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('INSERT OR IGNORE INTO realms(name,tenant) VALUES (?,?)').run(index, tenantId!);
          owner = db.prepare('SELECT tenant FROM realms WHERE name=?').get(index);
          if (owner?.tenant !== tenantId) throw fail('Realm mapping or tenant mismatch');
          db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${fts} USING fts5(title,text,topic, tokenize='unicode61 remove_diacritics 0'); COMMIT;`);
        } catch (error) {db.exec('ROLLBACK'); throw error;}
      }
      if (owner?.tenant !== tenantId) throw fail('Realm mapping or tenant mismatch');
      db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
      let result: T;
      try {result = run(db);} catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        if (write) Object.assign(error as object, {writeOutcome: 'not-applied'});
        throw error;
      }
      try {db.exec('COMMIT');} catch (error) {
        // A commit error with no remaining transaction is ambiguous. Never
        // label that outcome as unapplied; indexing barriers must reconcile it.
        if (db.isTransaction) {db.exec('ROLLBACK'); if (write) Object.assign(error as object, {writeOutcome: 'not-applied'});}
        throw error;
      }
      return result;
    } finally {db.close();}
  }
  function put(db: DatabaseSync, corpus: Corpus, id: string, document: SearchDocument) {
    db.prepare('INSERT INTO documents(realm,corpus,id,document) VALUES (?,?,?,?) ON CONFLICT(realm,corpus,id) DO UPDATE SET document=excluded.document').run(index, corpus, id, JSON.stringify(document));
    const rowid = db.prepare('SELECT rowid FROM documents WHERE realm=? AND corpus=? AND id=?').get(index, corpus, id)!.rowid;
    db.prepare(`DELETE FROM ${fts} WHERE rowid=?`).run(rowid);
    const metadata = document[corpus] as Record<string, unknown>;
    db.prepare(`INSERT INTO ${fts}(rowid,title,text,topic) VALUES (?,?,?,?)`).run(rowid, typeof document.title === 'string' ? document.title : '', typeof document.text === 'string' ? document.text : '', corpus === 'board' && typeof metadata.topic === 'string' ? metadata.topic : '');
  }
  const validateId = (id: string) => {if (typeof id !== 'string' || !/^[A-Za-z0-9_:-]{1,256}$/.test(id)) throw fail('Invalid document ID', 400);};
  return {
    backend: 'sqlite', index, tenantId, identity: endpoint + '/' + index, scope,
    async ensureIndex() {withDatabase(false, true, () => undefined);},
    async refresh(principal) {scope(principal); return withDatabase(false, true, response);},
    collection(corpus) {
      if (!corpora.has(corpus)) throw fail('Invalid corpus', 400);
      const encode = (id: string, doc: SearchDocument) => {validateId(id); if (doc.tenantId !== tenantId) throw fail('Document realm scope mismatch', 403); return realmDocument(corpus, id, doc);};
      const whereScope = () => ({sql: "d.realm=? AND d.corpus=? AND json_extract(d.document,'$.tenantId')=?", args: [index, corpus, tenantId]});
      const decode = (hit: IndexHit): IndexHit => {
        const d = hit._source;
        if (d.schema !== 1 || d.tenantId !== tenantId || d.corpus !== corpus || hit._id !== corpus + ':' + d.id || !d[corpus]) throw fail('Realm response ownership scope mismatch');
        return {...hit, _id: String(d.id), _source: {...d[corpus] as Record<string, unknown>, tenantId, ...Object.fromEntries(['text', 'title', 'sourceKey'].filter(k => d[k] !== undefined).map(k => [k, d[k]]))}};
      };
      const get = (db: DatabaseSync, id: string): SearchDocument | undefined => {
        const row = db.prepare('SELECT document FROM documents WHERE realm=? AND corpus=? AND id=?').get(index, corpus, id);
        if (!row) return undefined;
        const doc = JSON.parse(String(row.document)) as SearchDocument;
        decode({_id: corpus + ':' + id, _source: doc, _score: 0});
        return doc;
      };
      return {
        field: (field: string) => realmField(corpus, field), encode, id: (id: string) => corpus + ':' + id,
        async search(principal, body, {createIfMissing = true} = {}) {
          scope(principal);
          keys(body, ['query', 'size', `from`, 'sort', 'search_after', '_source', 'aggs', 'track_total_hits', 'track_scores', 'timeout']);
          const started = performance.now();
          const duration = body.timeout === undefined ? null : typeof body.timeout === 'string' && /^(\d+)(ms|s)$/.exec(body.timeout);
          if (duration === false || body.timeout !== undefined && !duration) unsupported('timeout (use milliseconds or seconds)');
          const timeout = duration ? Number(duration[1]) * (duration[2] === 's' ? 1000 : 1) : Infinity;
          if (duration && !Number.isSafeInteger(timeout)) unsupported('timeout');
          const result = withDatabase(false, createIfMissing, db => {
            const compiler = new QueryCompiler(fts), where = and(whereScope(), compiler.query(body.query ?? {match_all: {}}));
            const score = compiler.score(), output = response(), page = readHits(db, where, score, body);
            output.hits.total.value = page.total;
            output.hits.hits = page.hits.map(decode);
            if (Array.isArray(body._source)) {
              for (const hit of output.hits.hits) hit._source = Object.fromEntries(Object.entries(hit._source).filter(([key]) => key === 'tenantId' || (body._source as string[]).includes(key))) as SearchDocument;
            } else if (body._source === false) unsupported('_source=false; ownership fields are required');
            if (body.aggs) output.aggregations = aggregate(db, fts, where, score, body.aggs) as Record<string, Aggregation>;
            return output;
          });
          // Synchronous SQLite cannot be interrupted by the JS event loop. Never
          // return a successful result after the caller's elapsed-time budget.
          if (performance.now() - started >= timeout) throw fail('SQLite search exceeded timeout');
          return result;
        },
        async mget(principal, ids) {
          scope(principal); ids.forEach(validateId);
          if (new Set(ids).size !== ids.length) throw fail('Duplicate lookup IDs', 400);
          return withDatabase(false, true, db => ({...response(), docs: ids.map(id => {
            const doc = get(db, id);
            return doc ? {...decode({_id: corpus + ':' + id, _source: doc, _score: 0}), found: true} : {_id: id, _source: {tenantId}, _score: 0, found: false};
          })}));
        },
        async bulk(principal, items) {
          const prepared = preflight(() => {
            scope(principal);
            if (Buffer.byteLength(JSON.stringify(items)) > 4 * 1024 * 1024) throw fail('Realm bulk exceeds limit', 400);
            return items.map(item => {if (item.script) unsupported('raw scripts; use a named write policy'); return {...item, document: encode(item.id, item.document)};});
          });
          return withDatabase(true, true, db => {
              const output = response();
              for (const item of prepared) {
                const next = applyWrite(item.policy, get(db, item.id), item.document);
                if (next) put(db, corpus, item.id, next);
                output.items.push({index: {status: 200}});
              }
              return output;
            });
        },
        async delete(principal, ids) {
          preflight(() => {scope(principal); ids.forEach(validateId);});
          return withDatabase(true, true, db => {
              for (const id of ids) {
                db.prepare(`DELETE FROM ${fts} WHERE rowid IN (SELECT rowid FROM documents WHERE realm=? AND corpus=? AND id=?)`).run(index, corpus, id);
                db.prepare('DELETE FROM documents WHERE realm=? AND corpus=? AND id=?').run(index, corpus, id);
              }
              return {...response(), items: ids.map(() => ({delete: {status: 200}}))};
            });
        },
        async byQuery(principal, operation, query, mutation) {
          scope(principal);
          if (operation !== 'delete' && operation !== 'update') unsupported('mutation');
          const patch = operation === 'update' ? object(object(mutation).set) : undefined;
          return withDatabase(true, true, db => {
            const where = and(whereScope(), new QueryCompiler(fts).query(query, false));
            if (!patch) {
              // Freeze IDs in SQL before either component changes: an FTS
              // predicate no longer matches after its index rows are removed.
              db.prepare(`CREATE TEMP TABLE deletion_targets AS SELECT d.rowid AS target FROM documents d WHERE ${where.sql}`).run(...where.args);
              db.exec(`DELETE FROM ${fts} WHERE rowid IN (SELECT target FROM deletion_targets)`);
              const changed = db.prepare('DELETE FROM documents WHERE rowid IN (SELECT target FROM deletion_targets)').run().changes;
              db.exec('DROP TABLE deletion_targets');
              return {changed: Number(changed)};
            }
            // Page by immutable rowid while updating; never retain an entire resource.
            let after = 0, changed = 0;
            for (;;) {
              const rows = db.prepare(`SELECT d.rowid,d.id,d.document FROM documents d WHERE ${where.sql} AND d.rowid>? ORDER BY d.rowid LIMIT 250`).all(...where.args, after);
              if (!rows.length) break;
              for (const row of rows) {put(db, corpus, String(row.id), applyPatch(JSON.parse(String(row.document)), patch)); after = Number(row.rowid); changed++;}
            }
            return {changed};
          });
        },
        async update(principal, id, {patch, script, upsert}) {
          const {doc,fields} = preflight(() => {
            scope(principal); const doc = encode(id, upsert);
            if (script) unsupported('raw scripts; use a field patch');
            const fields = patch ?? unsupported('missing field patch');
            applyPatch(doc, fields);
            return {doc,fields};
          });
          return withDatabase(true, true, db => {const previous = get(db, id); put(db, corpus, id, previous ? applyPatch(previous, fields) : doc); return response();});
        },
      };
    },
  };
}
