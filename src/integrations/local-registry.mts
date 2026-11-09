import {DatabaseSync, backup} from 'node:sqlite';
import {mkdirSync, openSync, closeSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import type {Environment, IntegrationRecord, UpdateOptions} from './types.mjs';
import type {IntegrationRegistry} from './ports.mjs';

const denied = () => Object.assign(new Error('Integration scope is not authorized'), {status: 403});
const conflict = () => Object.assign(new Error('Integration changed; refresh and retry'), {code: 'ConditionalCheckFailedException', status: 409});
/** One durable registry bound permanently to one organization and environment. */
export function createSingleOrganizationRegistry({path, organizationId, environment = 'selfhost'}: {path: string; organizationId: string; environment?: Environment}) {
  if (!/^org_[A-Za-z0-9]+$/.test(organizationId)) throw new Error('Configure one WorkOS organization');
  const databasePath = resolve(path);
  mkdirSync(dirname(databasePath), {recursive: true, mode: 0o700});
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  db.exec('CREATE TABLE IF NOT EXISTS integration_binding (id INTEGER PRIMARY KEY CHECK(id=1), organization TEXT NOT NULL, environment TEXT NOT NULL); CREATE TABLE IF NOT EXISTS integrations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, record TEXT NOT NULL);');
  db.prepare('INSERT OR IGNORE INTO integration_binding VALUES (1, ?, ?)').run(organizationId, environment);
  const binding = db.prepare('SELECT organization, environment FROM integration_binding WHERE id=1').get();
  if (binding?.organization !== organizationId || binding.environment !== environment) {db.close(); throw new Error('Registry belongs to another organization or environment');}
  const scope = (tenantId: string, userId?: string) => {
    if (tenantId !== organizationId || userId !== undefined && !/^user_[A-Za-z0-9]+$/.test(userId)) throw denied();
  };
  const validate = (record: IntegrationRecord) => {
    scope(record.tenantId, record.userId);
    if (record.environment !== environment || !/^int_[a-f0-9]{26}$/.test(record.integrationId) || !/^[a-z]+$/.test(record.provider)) throw denied();
    return record;
  };
  const decode = (row: Record<string, unknown>): IntegrationRecord => {
    if (typeof row.record !== 'string') throw new Error('Invalid integration record');
    return validate(JSON.parse(row.record) as IntegrationRecord);
  };
  const select = (tenantId: string, userId: string, id: string): IntegrationRecord | null => {
    scope(tenantId, userId);
    const row = db.prepare('SELECT record FROM integrations WHERE id=? AND user_id=?').get(id, userId);
    return row ? decode(row) : null;
  };
  const transaction = <T,>(operation: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {const value = operation(); db.exec('COMMIT'); return value;} catch (error) {db.exec('ROLLBACK'); throw error;}
  };
  const registry: IntegrationRegistry = {
    async list(tenantId, userId) {scope(tenantId, userId); return db.prepare('SELECT record FROM integrations WHERE user_id=? ORDER BY id').all(userId).map(decode);},
    async listTenant(tenantId) {scope(tenantId); return db.prepare('SELECT record FROM integrations ORDER BY id').all().map(decode);},
    async get(tenantId, userId, id) {return select(tenantId, userId, id);},
    async create(record) {
      validate(record);
      return transaction(() => {
        if (db.prepare('SELECT id FROM integrations WHERE id=?').get(record.integrationId)) throw conflict();
        const serialized = JSON.stringify(record);
        db.prepare('INSERT INTO integrations VALUES (?, ?, ?)').run(record.integrationId, record.userId, serialized);
        return decode({record: serialized});
      });
    },
    async update(identity, fields, options: UpdateOptions = {}) {
      scope(identity.tenantId, identity.userId);
      for (const key of ['tenantId', 'userId', 'integrationId'] as const) if (fields[key] !== undefined && fields[key] !== identity[key]) throw denied();
      if (fields.environment !== undefined && fields.environment !== environment) throw denied();
      return transaction(() => {
        const current = select(identity.tenantId, identity.userId, identity.integrationId);
        if (!current || options.whenStatus && !options.whenStatus.includes(current.status)) throw conflict();
        if (Object.entries(options.whenFields ?? {}).some(([key, expected]) => !isDeepStrictEqual((current as unknown as Record<string, unknown>)[key], expected))) throw conflict();
        const next = validate({...current, ...fields, updatedAt: new Date().toISOString()});
        const serialized = JSON.stringify(next);
        db.prepare('UPDATE integrations SET record=? WHERE id=? AND user_id=?').run(serialized, identity.integrationId, identity.userId);
        return decode({record: serialized});
      });
    },
  };
  return {...registry, close: () => db.close(), async backup(destination: string) {
    const target = resolve(destination);
    // Reserve a fresh path; never overwrite an existing database or backup.
    closeSync(openSync(target, 'wx', 0o600));
    return backup(db, target);
  }};
}
