import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {ApplicationDatabase} from './postgres.mjs';
import {ensureRegistrySchema} from '../integrations/local-registry.mjs';
import {sourcePaginationProgress, advanceSourcePagination, type SourceProgress} from '../connectors/workflow.mjs';
import {digest, validateBinding} from '../connectors/scope.mjs';
import type {ConnectorBinding, ConnectorStore} from '../connectors/types.mjs';
import {captureKinds, checkpointLimit, validateCheckpoint, type SlackRunCheckpoints} from '../connectors/slack-run-checkpoints.mjs';

type Environment = 'selfhost' | 'staging' | 'production';
interface Source {
  environment: Environment;
  binding: ConnectorBinding;
  bucket: string;
  owner?: {userId: string; connectedAccountId: string};
}
const sources = 'opencrawl_slack_capture_sources';
const runs = 'opencrawl_slack_capture_runs';
const key = 'namespace=$1 AND environment=$2 AND tenant_id=$3 AND integration_id=$4';
function denied(): never {throw Object.assign(new Error('Slack checkpoint source binding changed'), {permanent: true});}

export function createSlackRunCheckpoints(database: ApplicationDatabase) {
  let preparing: Promise<void> | undefined;
  async function ready() {
    preparing ??= (async () => {
      await ensureRegistrySchema(database);
      await database.transaction(async db => {
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:slack-capture:schema',0))");
        await db.query(`CREATE TABLE IF NOT EXISTS ${sources} (
          namespace text NOT NULL, environment text NOT NULL, tenant_id text NOT NULL, integration_id text NOT NULL,
          binding text NOT NULL, imported_count bigint NOT NULL, import_digest text NOT NULL,
          PRIMARY KEY(namespace,environment,tenant_id,integration_id));
          CREATE TABLE IF NOT EXISTS ${runs} (
          namespace text NOT NULL, environment text NOT NULL, tenant_id text NOT NULL, integration_id text NOT NULL,
          kind text NOT NULL CHECK(kind IN ('files-v1','messages-v1','message-references-v1')), run_id text NOT NULL,
          revision bigint NOT NULL DEFAULT 1, body bytea NOT NULL,
          PRIMARY KEY(namespace,environment,tenant_id,integration_id,kind,run_id),
          FOREIGN KEY(namespace,environment,tenant_id,integration_id) REFERENCES ${sources} ON DELETE CASCADE)`);
      });
    })().catch(error => {preparing = undefined; throw error;});
    await preparing;
  }

  function source({environment, binding, bucket, owner}: Source) {
    validateBinding(binding);
    if (binding.provider !== 'slack' || !bucket || !['selfhost','staging','production'].includes(environment) ||
        (!owner && environment !== 'selfhost') || (owner && (!owner.userId || !owner.connectedAccountId))) denied();
    const args = [database.namespace, environment, binding.tenantId, binding.connectionId];
    const identity = digest([binding.workspaceId, bucket, binding.rawPrefix, owner?.userId ?? null, owner?.connectedAccountId ?? null]);
    async function authorize(db: PoolClient) {
      const result = await db.query(`SELECT user_id,status,provider,record FROM opencrawl_integrations WHERE ${key} FOR SHARE`, args);
      const record = result.rows[0];
      // An independent portable runner can have no integration registry entry.
      if (!record && !owner) return;
      if (!record || record.status !== 'active' || record.provider !== 'slack' || record.record.scope !== 'team' ||
          record.record.s3Bucket !== bucket || record.record.s3Prefix + '/' !== binding.rawPrefix || record.record.workspace !== binding.workspaceId ||
          (owner && (owner.userId !== record.user_id || owner.connectedAccountId !== record.record.connectedAccountId))) denied();
    }
    async function receipt(db: PoolClient) {
      const {rows} = await db.query(`SELECT binding,imported_count,import_digest FROM ${sources} WHERE ${key}`,args);
      if (rows.length && rows[0].binding !== identity) denied();
      return rows.length ? {count:Number(rows[0].imported_count), digest:String(rows[0].import_digest)} : null;
    }
    async function owned<T>(work:(db:PoolClient)=>Promise<T>):Promise<T> {
      await ready();
      return database.transaction(async db => {
        await authorize(db);
        if (!await receipt(db)) throw new Error('Slack checkpoints have not been imported');
        return work(db);
      });
    }
    const checkpoints: SlackRunCheckpoints = {
      async open(kind, runId) {
        if (!captureKinds.includes(kind) || !/^[A-Za-z0-9_-]{1,150}$/.test(runId)) denied();
        const params = [...args,kind,runId];
        const where = key+' AND kind=$5 AND run_id=$6';
        const row = await owned(async db => (await db.query(`SELECT revision,body FROM ${runs} WHERE ${where}`,params)).rows[0]);
        let revision: string | null = row?.revision ?? null;
        return {bytes: row?.body ?? null, async save(bytes) {
          validateCheckpoint(binding,kind,runId,bytes);
          revision = await owned(async db => {
            const next = revision === null
              ? await db.query(`INSERT INTO ${runs}(namespace,environment,tenant_id,integration_id,kind,run_id,body)
                  VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING revision`,[...params,bytes])
              : await db.query(`UPDATE ${runs} SET revision=revision+1,body=$7 WHERE ${where} AND revision=$8 RETURNING revision`,[...params,bytes,revision]);
            if (!next.rowCount) throw new Error('Slack checkpoint changed; retry from its latest revision');
            return next.rows[0].revision as string;
          });
        }};
      }
    };
    return {checkpoints,
      async current() {
        await ready();
        return database.transaction(async db => {await authorize(db);return receipt(db);});
      },
      // The caller quiesces previous capture writers. A binding's retained runs
      // and ownership receipt commit together, including an empty inventory.
      async adopt(store: ConnectorStore) {
        if (store.bucket !== bucket) denied();
        await ready();
        return database.transaction(async db => {
          await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['slack-checkpoint-import',...args])]);
          await authorize(db);
          const previous = await receipt(db);
          if (previous) return previous;
          await db.query(`INSERT INTO ${sources}(namespace,environment,tenant_id,integration_id,binding,imported_count,import_digest)
            VALUES($1,$2,$3,$4,$5,0,'')`,[...args,identity]);
          const hash = createHash('sha256');let count = 0;
          for (const kind of captureKinds) {
            const prefix = binding.rawPrefix+'capture/'+kind+'/';
            let token: string | null = null, last = '';
            let progress: SourceProgress | null = sourcePaginationProgress();
            do {
              // List run directories, not every immutable raw API page below them.
              const page = await store.listPage(prefix,{delimiter:'/',continuationToken:token,maxKeys:1000});
              const directories = page.prefixes !== undefined;
              const entries = page.prefixes ?? page.keys;
              token = page.nextToken ?? null;
              progress = advanceSourcePagination(progress,{keys:entries,cursor:token});
              for (const name of entries) {
                if (!name.startsWith(prefix) || name <= last) throw new Error('Invalid Slack checkpoint listing');
                last = name;
                const suffix = name.slice(prefix.length);
                const match = directories ? /^([A-Za-z0-9_-]{1,150})\/$/.exec(suffix) : /^([A-Za-z0-9_-]{1,150})\/state\.json$/.exec(suffix);
                if (!match) continue;
                const runId = match[1]!;
                const body = await store.get(prefix+runId+'/state.json',{maxBytes:checkpointLimit(kind)});
                // An object store may retain pages or a directory marker for a
                // run with no state. Flat inventories witnessed the exact object.
                if (!body && directories) continue;
                if (!body) throw new Error('Retained Slack checkpoint disappeared during import');
                validateCheckpoint(binding,kind,runId,body);
                const stored = await db.query(`INSERT INTO ${runs}(namespace,environment,tenant_id,integration_id,kind,run_id,body)
                  VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING body`,[...args,kind,runId,body]);
                if (!body.equals(stored.rows[0].body)) throw new Error('Slack checkpoint byte verification failed');
                hash.update(JSON.stringify([kind,runId,createHash('sha256').update(body).digest('hex')])+'\n');count++;
              }
            } while (token);
          }
          const checksum = hash.digest('hex');
          await db.query(`UPDATE ${sources} SET imported_count=$5,import_digest=$6 WHERE ${key}`,[...args,count,checksum]);
          return {count,digest:checksum};
        });
      }
    };
  }
  return {ready,source};
}
