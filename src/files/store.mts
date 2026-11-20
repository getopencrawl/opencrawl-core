import type {ApplicationDatabase} from '../state/postgres.mjs';

export interface SharedHistory {
  head: string;
  bundle: Buffer;
}
export interface SharedFilesStore {
  read(tenantId: string): Promise<SharedHistory | null>;
  publish(tenantId: string, expected: string | null, next: SharedHistory, userId: string): Promise<boolean>;
}

export const bundleLimit = 8 * 1024 * 1024;

/** A native Git bundle includes all ancestors of main. Store the new bundle,
 * head and authenticated pusher in one transaction, conditional on the head
 * used by receive-pack. Multiple application replicas can serve one network. */
export function postgresSharedFiles(database: ApplicationDatabase) {
  return {
    async ready() {
      await database.transaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:shared-files:schema',0))");
        await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_shared_files (
          namespace text NOT NULL, tenant_id text NOT NULL, head text NOT NULL,
          bundle bytea NOT NULL CHECK (octet_length(bundle) <= ${bundleLimit}),
          PRIMARY KEY(namespace, tenant_id))`);
        await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_shared_file_pushes (
          namespace text NOT NULL, tenant_id text NOT NULL, head text NOT NULL,
          previous_head text, user_id text NOT NULL, pushed_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY(namespace, tenant_id, head))`);
      });
    },
    async read(tenantId: string): Promise<SharedHistory | null> {
      const result = await database.pool.query<SharedHistory>(
        'SELECT head, bundle FROM opencrawl_shared_files WHERE namespace=$1 AND tenant_id=$2',
        [database.namespace, tenantId]);
      return result.rows[0] ?? null;
    },
    async publish(tenantId: string, expected: string | null, next: SharedHistory, userId: string) {
      return database.transaction(async client => {
        const args = [database.namespace, tenantId, next.head, next.bundle];
        const result = expected === null
          ? await client.query('INSERT INTO opencrawl_shared_files(namespace,tenant_id,head,bundle) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', args)
          : await client.query('UPDATE opencrawl_shared_files SET head=$3,bundle=$4 WHERE namespace=$1 AND tenant_id=$2 AND head=$5', [...args, expected]);
        if (result.rowCount !== 1) return false;
        await client.query('INSERT INTO opencrawl_shared_file_pushes(namespace,tenant_id,head,previous_head,user_id) VALUES($1,$2,$3,$4,$5)',
          [database.namespace, tenantId, next.head, expected, userId]);
        return true;
      });
    },
  } satisfies SharedFilesStore & {ready(): Promise<void>};
}
