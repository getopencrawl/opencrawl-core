import {DatabaseSync} from 'node:sqlite';
import {mkdirSync, chmodSync} from 'node:fs';
import {dirname, resolve} from 'node:path';

/** Durable single-host reference store. SQLite enforces CAS across processes. */
export function createLocalBoardStore(path) {
  path = resolve(path);
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS board (key TEXT PRIMARY KEY, version INTEGER NOT NULL, data BLOB NOT NULL)');
  return {
    async readVersion(key, {maxBytes = 16 * 1024 * 1024} = {}) {
      const row = db.prepare('SELECT version, data FROM board WHERE key=?').get(key);
      if (!row) return {version: null, data: null};
      if (row.data.length > maxBytes) throw new Error('Object exceeds read limit');
      return {version: row.version, data: Buffer.from(row.data)};
    },
    async compareAndSet(key, version, data) {
      const result = version === null
        ? db.prepare('INSERT INTO board VALUES (?,1,?) ON CONFLICT DO NOTHING').run(key, data)
        : db.prepare('UPDATE board SET version=version+1,data=? WHERE key=? AND version=?').run(data, key, version);
      return result.changes === 1;
    },
    close: () => db.close(),
  };
}
