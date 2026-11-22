import type {ApplicationDatabase,ApplicationTransaction} from '../state/postgres.mjs';
import type {DevinSession} from './devin-api.mjs';
import type {DevinSessionCursor} from './devin-live-session.mjs';

export async function lockDevinOrganization(db: ApplicationTransaction, namespace: string, organization: string) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['devin-capture-org',namespace,organization])]);
}

export interface DevinCatalogCursor {
  after?: string;
  pageHistory?: string[];
  updatedSince?: number;
  through?: number;
}

export interface DevinRecordingRow {
  organization: string;
  generation: string;
  revision: string;
  credential: Buffer | null;
  enabled_at: number;
  enabled_by: string;
  health: 'connected' | 'retrying' | 'needs-key' | 'disconnected';
  checked_at: number | null;
  retry_at: number;
  failures: number;
  catalog_at: number;
  catalog: DevinCatalogCursor;
}
export interface DevinCaptureRow {
  session_id: string;
  source: DevinSession;
  cursor: DevinSessionCursor;
  revision: string;
  due: number;
  failures: number;
  state: 'active' | 'idle' | 'complete' | 'private' | 'excluded';
}

export function devinRecordingStore(database: ApplicationDatabase) {
  const namespace = database.namespace;
  let prepared: Promise<void> | undefined;
  function ready() {
    prepared ??= database.transaction(async db => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:devin-api:schema',0))");
      await db.query(`CREATE TABLE IF NOT EXISTS opencrawl_devin_api_connections (
        namespace text NOT NULL, tenant text NOT NULL, organization text NOT NULL,
        generation uuid NOT NULL, revision uuid NOT NULL, credential bytea,
        enabled_at double precision NOT NULL, enabled_by text NOT NULL, health text NOT NULL,
        checked_at double precision, retry_at double precision NOT NULL DEFAULT 0,
        failures integer NOT NULL DEFAULT 0, catalog_at double precision NOT NULL DEFAULT 0,
        catalog jsonb NOT NULL DEFAULT '{}', PRIMARY KEY(namespace,tenant))`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS opencrawl_devin_api_active_organization
        ON opencrawl_devin_api_connections(namespace,organization) WHERE health<>'disconnected'`);
      await db.query(`CREATE TABLE IF NOT EXISTS opencrawl_devin_api_sessions (
        namespace text NOT NULL, tenant text NOT NULL, generation uuid NOT NULL, session_id text NOT NULL,
        source jsonb NOT NULL, cursor jsonb NOT NULL, revision uuid NOT NULL, due double precision NOT NULL,
        state text NOT NULL DEFAULT 'active', stored_at double precision, failures integer NOT NULL DEFAULT 0,
        PRIMARY KEY(namespace,tenant,generation,session_id))`);
      await db.query(`CREATE INDEX IF NOT EXISTS opencrawl_devin_api_session_due
        ON opencrawl_devin_api_sessions(namespace,tenant,generation,due,session_id) WHERE state IN ('active','idle')`);
      await db.query(`CREATE INDEX IF NOT EXISTS opencrawl_devin_api_session_stored
        ON opencrawl_devin_api_sessions(namespace,tenant,generation,stored_at DESC) WHERE stored_at IS NOT NULL`);
      await db.query(`CREATE INDEX IF NOT EXISTS opencrawl_devin_api_session_failures
        ON opencrawl_devin_api_sessions(namespace,tenant,generation) WHERE failures>0`);
      await db.query(`CREATE TABLE IF NOT EXISTS opencrawl_devin_api_seen (
        namespace text NOT NULL, tenant text NOT NULL, generation uuid NOT NULL, session_id text NOT NULL,
        event_id text NOT NULL, PRIMARY KEY(namespace,tenant,generation,session_id,event_id),
        FOREIGN KEY(namespace,tenant,generation,session_id) REFERENCES opencrawl_devin_api_sessions ON DELETE CASCADE)`);
    }).catch(error => { prepared = undefined; throw error; });
    return prepared;
  }
  async function connection(db: ApplicationTransaction, tenant: string) {
    return (await db.query<DevinRecordingRow>(
      'SELECT * FROM opencrawl_devin_api_connections WHERE namespace=$1 AND tenant=$2',
      [namespace, tenant],
    )).rows[0];
  }
  // An uncommitted first connection has no row to lock. The same lock also
  // fences disconnect and repeated or in-flight worker commits.
  async function locked<T>(tenant: string, operation: (db: ApplicationTransaction, row: DevinRecordingRow | undefined) => Promise<T>) {
    await ready();
    return database.transaction(async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['devin-api',namespace,tenant])]);
      return operation(db, await connection(db, tenant));
    });
  }
  return {namespace, ready, locked};
}
