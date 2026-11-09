import type {ConnectionRecord, ConnectionStatus} from './types.mjs';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync, chmodSync} from 'node:fs';
import {dirname, resolve} from 'node:path';

type Row = Record<string, string | number | null>;
const COLUMNS = {id: 'id', provider: 'provider', status: 'status', createdAt: 'created_at', updatedAt: 'updated_at', nonce: 'nonce',
  connectedAccountId: 'connected_account_id', composioUser: 'composio_user', workspaceId: 'workspace_id', label: 'label',
  error: 'error', startDate: 'start_date', lastSyncAt: 'last_sync_at', lastSyncStatus: 'last_sync_status', lastSyncError: 'last_sync_error'} as const;
type Column = keyof typeof COLUMNS;

/**
 * Single-host source registry shared by the API (connections, Composio key), the sync runner
 * (./sync.mts: sync state and results) and the indexer. Only the runner methods below write
 * `state` and the last_sync_* columns. Secrets stay in this 0600 file and never leave
 * the host except to Composio or the provider they belong to.
 */
export function createRegistry(path: string) {
  path = resolve(path);
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      nonce TEXT, connected_account_id TEXT, composio_user TEXT, workspace_id TEXT, label TEXT, settings TEXT NOT NULL DEFAULT '{}',
      api_key TEXT, start_date TEXT NOT NULL, error TEXT,
      state TEXT, last_sync_at TEXT, last_sync_status TEXT, last_sync_error TEXT)`);
  const now = () => new Date().toISOString();
  const record = (row: Row | undefined): ConnectionRecord | null => row ? {
    ...Object.fromEntries(Object.entries(COLUMNS).map(([field, column]) => [field, row[column] ?? null])),
    settings: JSON.parse(String(row.settings || '{}')),
  } as ConnectionRecord : null;
  return {
    path,
    setting: (key: string) => (db.prepare('SELECT value FROM settings WHERE key=?').get(key) as Row | undefined)?.value as string | undefined,
    setSetting(key: string, value: string | null) {
      if (value === null) db.prepare('DELETE FROM settings WHERE key=?').run(key);
      else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
    },
    get: (id: string) => record(db.prepare('SELECT * FROM connections WHERE id=?').get(id) as Row | undefined),
    list: (statuses?: ConnectionStatus[]) => (db.prepare('SELECT * FROM connections ORDER BY created_at, id').all() as Row[]).map(row => record(row)!)
      .filter(r => !statuses || statuses.includes(r.status)),
    create(input: {id: string; provider: string; status: ConnectionStatus; startDate: string; nonce?: string | null; connectedAccountId?: string | null;
      composioUser?: string | null; workspaceId?: string | null; label?: string | null; settings?: Record<string, string | number>; apiKey?: string | null}) {
      const stamp = now();
      db.prepare(`INSERT INTO connections (id, provider, status, created_at, updated_at, nonce, connected_account_id, composio_user, workspace_id, label, settings, api_key, start_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.id, input.provider, input.status, stamp, stamp, input.nonce ?? null, input.connectedAccountId ?? null,
        input.composioUser ?? null, input.workspaceId ?? null, input.label ?? null, JSON.stringify(input.settings || {}), input.apiKey ?? null, input.startDate);
      return record(db.prepare('SELECT * FROM connections WHERE id=?').get(input.id) as Row)!;
    },
    /** Compare-and-set on status, so a callback or retry can claim a record exactly once. */
    update(id: string, whenStatus: ConnectionStatus[], fields: Partial<Pick<ConnectionRecord, 'status' | 'workspaceId' | 'label' | 'error' | 'nonce' | 'settings'>> & {apiKey?: null}) {
      const sets: string[] = [], values: (string | null)[] = [];
      for (const [field, value] of Object.entries(fields)) {
        const column = field === 'settings' ? 'settings' : field === 'apiKey' ? 'api_key' : COLUMNS[field as Column];
        sets.push(`${column}=?`); values.push(field === 'settings' ? JSON.stringify(value) : value as string | null);
      }
      const result = db.prepare(`UPDATE connections SET ${[...sets, 'updated_at=?'].join(', ')} WHERE id=? AND status IN (${whenStatus.map(() => '?').join(', ')})`)
        .run(...values, now(), id, ...whenStatus);
      return result.changes === 1 ? record(db.prepare('SELECT * FROM connections WHERE id=?').get(id) as Row)! : null;
    },
    /** Runner only: the secrets and checkpoint a sync needs. */
    syncInput(id: string) {
      const row = db.prepare('SELECT api_key, state FROM connections WHERE id=?').get(id) as {api_key: string | null; state: string | null} | undefined;
      return {apiKey: row?.api_key ?? null, state: JSON.parse(row?.state || '[]') as unknown[]};
    },
    /** Runner only: commits a checkpoint while the connection is still syncable. */
    saveState: (id: string, state: unknown[]) => db.prepare("UPDATE connections SET state=? WHERE id=? AND status IN ('active', 'error')").run(JSON.stringify(state), id).changes === 1,
    syncStatus(id: string, status: 'running' | 'succeeded' | 'failed', error: string | null = null) {
      if (status === 'running') db.prepare("UPDATE connections SET last_sync_status='running' WHERE id=?").run(id);
      else db.prepare('UPDATE connections SET last_sync_at=?, last_sync_status=?, last_sync_error=? WHERE id=?').run(now(), status, error, id);
    },
    /** Runner only: after raw data is deleted. */
    markDisconnected: (id: string) => db.prepare("UPDATE connections SET status='disconnected', state=NULL, updated_at=? WHERE id=? AND status='disconnecting'").run(now(), id),
    /** Makes the runner treat the connection as due now. */
    requestSync: (id: string) => db.prepare('UPDATE connections SET last_sync_at=NULL WHERE id=?').run(id),
    close: () => db.close(),
  };
}
export type Registry = ReturnType<typeof createRegistry>;
