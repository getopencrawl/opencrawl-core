import {createHash, randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join} from 'node:path';
import type {ApplicationDatabase} from '../state/postgres.mjs';
import {git, seedRepository} from './git.mjs';

export interface SharedFilesStore {
  readonly storageRoot: string;
  ready(): Promise<void>;
  open(tenantId: string): Promise<string>;
  syncAudit(tenantId: string, dir: string): Promise<void>;
}
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const marker = 'opencrawl-repository-id';
const logPath = (dir: string) => join(dir, 'logs', 'refs', 'heads', 'main');
type Legacy = {head: string; bundle: Buffer};
async function repositoryId(dir: string): Promise<string | null> {
  try {
    const id = await readFile(join(dir, marker), 'utf8');
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid shared Git volume marker');
    return id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// Initialize privately then rename the complete, nonempty directory on the same filesystem.
async function initialize(dir: string, legacy?: Legacy) {
  const parent = dirname(dir);
  await mkdir(parent, {recursive: true, mode: 0o700});
  const stage = await mkdtemp(join(parent, '.init-'));
  try {
    await git(stage, [
      'init',
      '--quiet',
      '--bare',
      '--initial-branch=main',
      '--object-format=sha1',
      '--template=',
      '.'
    ]);
    await git(stage, ['config', 'core.logAllRefUpdates', 'true']);
    await git(stage, ['config', 'gc.reflogExpire', 'never']);
    await git(stage, ['config', 'gc.reflogExpireUnreachable', 'never']);
    if (legacy) {
      const source = join(stage, 'migration.bundle');
      await writeFile(source, legacy.bundle, {mode: 0o600});
      await git(stage, [
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        source,
        'refs/heads/main:refs/heads/main'
      ]);
      if ((await git(stage, ['rev-parse', 'refs/heads/main'])) !== legacy.head)
        throw new Error('Legacy shared Git head mismatch');
      await git(stage, ['fsck', '--strict', '--no-progress']);
      await rm(source);
    } else await seedRepository(stage);
    await writeFile(join(stage, marker), randomUUID(), {mode: 0o600});
    try {
      await rename(stage, dir);
    } catch (error) {
      if (!(await repositoryId(dir))) throw error;
    }
  } finally {
    await rm(stage, {force: true, recursive: true});
  }
}

interface AuditEntry {
  previous: string;
  head: string;
  user: string;
  time: number;
}
// Only newline-terminated records belong to completed ref updates. Catch up in
// bounded batches, even after a long database outage. Never scan Git objects.
async function catchUp(client: Pick<ApplicationDatabase['pool'], 'query'>, scope: string[], dir: string, start: number) {
  const file = await open(logPath(dir), 'r');
  try {
    const end = (await file.stat()).size;
    if (start > end) throw new Error('Git audit log is behind its database checkpoint');
    const buffer = Buffer.alloc(64 * 1024);
    while (start < end) {
      const {bytesRead} = await file.read(buffer, 0, Math.min(buffer.length, end - start), start);
      const cut = buffer.subarray(0, bytesRead).lastIndexOf(10) + 1;
      if (!cut) {
        if (bytesRead === buffer.length) throw new Error('Malformed Git audit log');
        break;
      }
      const entries: AuditEntry[] = [];
      for (const line of buffer
        .subarray(0, cut - 1)
        .toString('utf8')
        .split('\n')) {
        const item = /^([0-9a-f]{40}) ([0-9a-f]{40}) OpenCrawl <([^>]+)> (\d+) [+-]\d{4}(?:\t|$)/.exec(line);
        if (!item) throw new Error('Unrecognized Git ref update');
        if (item[3] === 'service@localhost') continue; // Stock seed or legacy import.
        const actor = /^([\w-]+)@opencrawl\.invalid$/.exec(item[3]);
        if (!actor) throw new Error('Unrecognized Git ref identity');
        entries.push({
          previous: item[1],
          head: item[2],
          user: Buffer.from(actor[1], 'base64url').toString(),
          time: Number(item[4])
        });
      }
      if (entries.length)
        await client.query(
          `INSERT INTO opencrawl_shared_file_pushes(namespace,tenant_id,previous_head,head,user_id,pushed_at)
        SELECT $1,$2,p,h,u,to_timestamp(t) FROM unnest($3::text[],$4::text[],$5::text[],$6::double precision[]) x(p,h,u,t)
        ON CONFLICT(namespace,tenant_id,head) DO NOTHING`,
          [
            ...scope,
            entries.map((x) => x.previous),
            entries.map((x) => x.head),
            entries.map((x) => x.user),
            entries.map((x) => x.time)
          ]
        );
      start += cut;
    }
    await client.query(
      'UPDATE opencrawl_git_repositories SET audit_offset=$3 WHERE namespace=$1 AND tenant_id=$2',
      [...scope, start]
    );
  } finally {
    await file.close();
  }
}

function location(root: string, namespace: string, tenant: string) {
  if (!tenant || !namespace || !isAbsolute(root)) throw new Error('Invalid shared Git storage binding');
  const key = digest(tenant);
  return join(root, digest(namespace), key.slice(0, 2), key + '.git');
}

/** Verify the disk identity against the control plane's independent receipt without creating a repository. */
export async function matchingExistingRepository(root: string, namespace: string, tenant: string, expectedId: string) {
  const dir = location(root, namespace, tenant);
  if (!expectedId || (await repositoryId(dir)) !== expectedId) throw new Error('Restore the registered Git volume before serving this network');
  return dir;
}

/** Provision through the same atomic initialization path that first-time Git clients use. */
export async function provisionRepository(store: SharedFilesStore, tenant: string) {
  const id = await repositoryId(await store.open(tenant));
  if (!id) throw new Error('Missing shared Git volume marker');
  return id;
}

export function fileRepositories(
  root: string,
  namespace: string,
  database?: ApplicationDatabase
): SharedFilesStore {
  if (!namespace || !isAbsolute(root))
    throw new Error('Shared Git requires a namespace and an absolute storage root');
  const base = join(root, digest(namespace));
  const directory = (tenant: string) => location(root, namespace, tenant);
  async function syncAudit(tenant: string, dir: string) {
    if (!database) return;
    if (dir !== directory(tenant)) throw new Error('Git audit scope mismatch');
    const scope = [namespace, tenant];
    const size = (await stat(logPath(dir))).size;
    const state = await database.pool.query(
      'SELECT audit_offset FROM opencrawl_git_repositories WHERE namespace=$1 AND tenant_id=$2',
      scope
    );
    if (!state.rowCount) throw new Error('Unregistered Git volume');
    if (Number(state.rows[0].audit_offset) === size) return;
    await database.transaction(async (client) => {
      const locked = await client.query(
        'SELECT audit_offset FROM opencrawl_git_repositories WHERE namespace=$1 AND tenant_id=$2 FOR UPDATE',
        scope
      );
      await catchUp(client, scope, dir, Number(locked.rows[0].audit_offset));
    });
  }
  return {
    storageRoot: root,
    async ready() {
      await mkdir(base, {recursive: true, mode: 0o700});
      if (database)
        await database.transaction(async (client) => {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:shared-files:schema',0))"
          );
          await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_git_repositories(namespace text NOT NULL,tenant_id text NOT NULL,
          repository_id uuid NOT NULL,audit_offset bigint NOT NULL DEFAULT 0,PRIMARY KEY(namespace,tenant_id))`);
          await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_shared_file_pushes(namespace text NOT NULL,tenant_id text NOT NULL,
          head text NOT NULL,previous_head text,user_id text NOT NULL,pushed_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(namespace,tenant_id,head))`);
        });
    },
    async open(tenant) {
      const dir = directory(tenant);
      if (!database) {
        if (!(await repositoryId(dir))) await initialize(dir);
        return dir;
      }
      const scope = [namespace, tenant];
      const select = 'SELECT repository_id FROM opencrawl_git_repositories WHERE namespace=$1 AND tenant_id=$2';
      let row = (await database.pool.query(select, scope)).rows[0];
      if (!row)
        row = await database.transaction(async (client) => {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(scope)]);
          const prior = (await client.query(select, scope)).rows[0];
          if (prior) return prior;
          let id = await repositoryId(dir);
          if (!id) {
            const legacy = (await client.query("SELECT to_regclass('opencrawl_shared_files') AS table_id"))
              .rows[0].table_id;
            const old = legacy
              ? (
                  await client.query<Legacy>(
                    'SELECT head,bundle FROM opencrawl_shared_files WHERE namespace=$1 AND tenant_id=$2',
                    scope
                  )
                ).rows[0]
              : undefined;
            await initialize(dir, old);
            id = await repositoryId(dir);
          }
          await client.query(
            'INSERT INTO opencrawl_git_repositories(namespace,tenant_id,repository_id) VALUES($1,$2,$3)',
            [...scope, id]
          );
          return {repository_id: id};
        });
      if ((await repositoryId(dir)) !== row.repository_id)
        throw new Error('Restore the registered Git volume before serving this network');
      await syncAudit(tenant, dir);
      return dir;
    },
    syncAudit
  };
}
export function postgresSharedFiles(database: ApplicationDatabase, root: string) {
  return fileRepositories(root, database.namespace, database);
}
