import {Pool, type PoolClient, type PoolConfig} from 'pg';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {ApplicationSourceIdentity} from './settings.mjs';

/** One operator-owned application database. Temporal keeps its own database. */
export interface ApplicationDatabase {
  readonly pool: Pool;
  readonly identityPool: Pool;
  readonly namespace: string;
  readonly identitySchema: string;
  readonly sourceIdentity?:ApplicationSourceIdentity;
  ready(): Promise<void>;
  transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createApplicationDatabase({namespace,sourceIdentity, ...config}: PoolConfig & {namespace: string;sourceIdentity?:ApplicationSourceIdentity}): ApplicationDatabase {
  if (!namespace || namespace.length > 2048 || namespace.includes('\0')) throw new Error('A stable application-state namespace is required');
  const identitySchema = 'oc_auth_' + createHash('sha256').update(namespace).digest('hex').slice(0, 24);
  const defaults: PoolConfig = {max: 8, connectionTimeoutMillis: 10000, ...config};
  const pool = new Pool(defaults);
  // Better Auth's pinned native PostgreSQL adapter uses unqualified table names.
  // The identifier is derived locally, never interpolated from operator input.
  const identityPool = new Pool({...defaults, max: 4, options: `${config.options || ''} -c search_path=${identitySchema}`.trim()});
  for (const current of [pool, identityPool]) current.on('error', () => {});
  let preparing: Promise<void> | undefined;
  let closed = false;
  async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    if (closed) throw new Error('Application database is closed');
    const client = await pool.connect();
    let destroy = false;
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {await client.query('ROLLBACK');} catch {destroy = true;}
      throw error;
    } finally {client.release(destroy);}
  }
  return {
    pool, identityPool, namespace, identitySchema,sourceIdentity, transaction,
    async ready() {
      if (closed) throw new Error('Application database is closed');
      preparing ??= transaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:application:schema', 0))");
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${identitySchema}`);
        await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_application_schema (
          singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), version integer NOT NULL);
          INSERT INTO opencrawl_application_schema(singleton, version) VALUES(true, 1) ON CONFLICT DO NOTHING;
          CREATE TABLE IF NOT EXISTS opencrawl_application_installations (
            namespace text PRIMARY KEY, source_identity jsonb NOT NULL, migration_id uuid NOT NULL,
            state text NOT NULL CHECK(state IN ('importing','ready')), created_at timestamptz NOT NULL DEFAULT now(),
            verified_at timestamptz, source_manifest_hash text,inventory_complete boolean NOT NULL DEFAULT false,
            CHECK(state <> 'ready' OR verified_at IS NOT NULL));
          ALTER TABLE opencrawl_application_installations ADD COLUMN IF NOT EXISTS inventory_complete boolean NOT NULL DEFAULT false;
          CREATE TABLE IF NOT EXISTS opencrawl_application_migration_sources (
            namespace text NOT NULL REFERENCES opencrawl_application_installations(namespace),
            source_key text NOT NULL,domain text NOT NULL,source_version text,source_hash text NOT NULL,
            source_bytes bigint NOT NULL CHECK(source_bytes>=0),PRIMARY KEY(namespace,source_key));
          CREATE TABLE IF NOT EXISTS opencrawl_application_migrations (
            namespace text NOT NULL REFERENCES opencrawl_application_installations(namespace),
            domain text NOT NULL, source_key text NOT NULL, source_version text, source_hash text NOT NULL,
            target_hash text NOT NULL, imported_rows bigint NOT NULL CHECK(imported_rows >= 0),
            completed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(namespace, domain, source_key))`);
        const result = await client.query('SELECT version FROM opencrawl_application_schema WHERE singleton');
        if (result.rows[0]?.version !== 1) throw new Error('Unsupported application database schema; use the supported upgrade');
      }).catch(error => {preparing = undefined; throw error;});
      await preparing;
    },
    async close() {if (closed) return; closed = true; await Promise.all([pool.end(), identityPool.end()]);},
  };
}

/** Preparing schemas does not authorize runtime reads of a half-imported store. */
export async function requireApplicationStateReady(database: ApplicationDatabase): Promise<void> {
  const result = await database.pool.query('SELECT state,source_identity FROM opencrawl_application_installations WHERE namespace=$1', [database.namespace]);
  if (result.rows[0]?.state !== 'ready') throw Object.assign(new Error('Application-state migration is incomplete; run the supported upgrade before starting writers'), {status: 503});
  if(database.sourceIdentity&&!isDeepStrictEqual(result.rows[0].source_identity,database.sourceIdentity))throw Object.assign(new Error('Application-state source binding differs from this runtime; use the supported migration'),{status:503});
}
