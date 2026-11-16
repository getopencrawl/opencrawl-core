import type {PoolClient} from 'pg';
import {createHash} from 'node:crypto';
import type {ApplicationDatabase} from './postgres.mjs';
import type {Environment} from '../integrations/types.mjs';
import type {IntegrationCommand, IntegrationCommandReference, IntegrationCommandSecret, IntegrationCommands, IntegrationOperation} from '../integrations/temporal/types.mjs';
import {sealedEnvelope} from '../integrations/credential-vault.mjs';
import {ensureRegistrySchema} from '../integrations/local-registry.mjs';

type FailureReason = 'authorization_denied' | 'invalid_command' | 'reconnect_required';
const deny = (): never => {throw Object.assign(new Error('Integration command scope is not authorized'), {status: 403});};
const invalid = (message: string): never => {throw Object.assign(new Error(message), {status: 409});};
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,200}$/.test(value);
const columns = 'namespace=$1 AND environment=$2 AND tenant_id=$3 AND user_id=$4 AND integration_id=$5 AND command_id=$6';

export interface TransactionalIntegrationCommands {
  read(client: PoolClient, reference: IntegrationCommandReference): Promise<IntegrationCommand | null>;
  enqueue(client: PoolClient, reference: IntegrationCommandReference, operation: IntegrationOperation, secret: IntegrationCommandSecret | undefined, requestedBy: string): Promise<void>;
  supersede(client: PoolClient, reference: IntegrationCommandReference): Promise<void>;
}

/** Durable command/outbox rows. Registry writes and enqueue share one transaction.
 * Only references cross into Temporal. Secret envelopes bind all scope fields. */
export function createIntegrationCommands({database, environment, encryptionKey, secretLifetimeMs = 86400_000}: {
  database: ApplicationDatabase; environment: Environment; encryptionKey?: Uint8Array; secretLifetimeMs?: number;
}): IntegrationCommands & {ready(): Promise<void>; transactional: TransactionalIntegrationCommands} {
  if (!['production', 'staging', 'selfhost'].includes(environment)) throw new Error('Explicit integration environment is required');
  if (!Number.isSafeInteger(secretLifetimeMs) || secretLifetimeMs < 1000 || secretLifetimeMs > 7 * 86400_000) throw new Error('Invalid integration secret lifetime');
  const envelope = encryptionKey ? sealedEnvelope(encryptionKey) : null;
  const cursorScope = createHash('sha256').update(JSON.stringify([database.namespace, environment])).digest('hex');
  let preparing: Promise<void> | undefined;
  function values(reference: IntegrationCommandReference) {
    if (reference.environment !== environment || ![reference.tenantId, reference.userId, reference.integrationId, reference.commandId].every(identifier)) deny();
    return [database.namespace, environment, reference.tenantId, reference.userId, reference.integrationId, reference.commandId];
  }
  const context = (reference: IntegrationCommandReference) => JSON.stringify(['integration-command-secret-v1', ...values(reference)]);
  function secretBytes(secret: IntegrationCommandSecret | undefined) {
    if (!secret || Object.keys(secret).length === 0) return null;
    if (Object.keys(secret).some(key => key !== 'apiKey') || typeof secret.apiKey !== 'string' || !secret.apiKey || secret.apiKey.length > 65536) throw new Error('Invalid integration secret handoff');
    return Buffer.from(JSON.stringify({apiKey: secret.apiKey}));
  }
  async function read(client: Pick<PoolClient, 'query'>, reference: IntegrationCommandReference): Promise<IntegrationCommand | null> {
    const result = await client.query(`SELECT operation,status,requested_by,failure_reason FROM opencrawl_integration_commands WHERE ${columns}`, values(reference));
    const row = result.rows[0];
    return row ? {reference: {...reference}, operation: row.operation, status: row.status, requestedBy: row.requested_by,
      ...(row.failure_reason ? {failureReason: row.failure_reason} : {})} as IntegrationCommand : null;
  }
  async function removeSecret(client: Pick<PoolClient, 'query'>, reference: IntegrationCommandReference) {
    await client.query(`DELETE FROM opencrawl_integration_command_secrets WHERE ${columns}`, values(reference));
  }
  async function finish(client: Pick<PoolClient, 'query'>, reference: IntegrationCommandReference, status: 'completed' | 'superseded' | 'failed', reason: FailureReason | null = null) {
    const params = values(reference);
    const exists = await read(client, reference);
    if (!exists) deny();
    const changed=await client.query(`UPDATE opencrawl_integration_commands SET status=$7,failure_reason=$8,finished_at=now() WHERE ${columns} AND status='pending'`, [...params, status, reason]);
    if(changed.rowCount&&status==='failed')await client.query(`UPDATE opencrawl_integrations SET status='error',revision=revision+1,
      record=record||jsonb_build_object('status','error','error',$7::text,'updatedAt',$8::text)
      WHERE namespace=$1 AND environment=$2 AND tenant_id=$3 AND user_id=$4 AND integration_id=$5 AND record->>'lifecycleCommandId'=$6`,
      [...params,reason==='reconnect_required'?'reconnect':'setup',new Date().toISOString()]);
    await removeSecret(client, reference);
  }
  const transactional: TransactionalIntegrationCommands = {
    read,
    async enqueue(client, reference, operation, secret, requestedBy) {
      const params = values(reference);
      if (!identifier(requestedBy) || !['provision', 'disconnect', 'sync'].includes(operation)) throw new Error('Invalid integration lifecycle request');
      const bytes = secretBytes(secret);
      if (bytes && (!envelope || operation !== 'provision')) throw new Error('Encrypted provisioning secret storage must be configured');
      const result = await client.query(`INSERT INTO opencrawl_integration_commands
        (namespace,environment,tenant_id,user_id,integration_id,command_id,operation,requested_by,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending') ON CONFLICT DO NOTHING`, [...params, operation, requestedBy]);
      if (!result.rowCount) {
        const previous = await read(client, reference);
        if (!previous || previous.operation !== operation || (previous as IntegrationCommand & {requestedBy: string}).requestedBy !== requestedBy)
          invalid('Integration command identity was reused for a different request');
        // A retry cannot revive a completed command or restore a cleared secret.
        return;
      }
      if (bytes) await client.query(`INSERT INTO opencrawl_integration_command_secrets
        (namespace,environment,tenant_id,user_id,integration_id,command_id,ciphertext,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,now()+($8::double precision * interval '1 millisecond'))`, [...params, envelope!.seal(context(reference), bytes), secretLifetimeMs]);
    },
    supersede: (client, reference) => finish(client, reference, 'superseded'),
  };
  return {
    transactional,
    async ready() {
      preparing ??= (async () => {
        await ensureRegistrySchema(database);
        await database.transaction(async client => {
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:integration-commands:schema',0))");
          await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_integration_commands (
            sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
            namespace text NOT NULL, environment text NOT NULL, tenant_id text NOT NULL, user_id text NOT NULL,
            integration_id text NOT NULL, command_id text NOT NULL, requested_by text NOT NULL,
            operation text NOT NULL CHECK(operation IN ('provision','disconnect','sync')),
            status text NOT NULL CHECK(status IN ('pending','completed','superseded','failed')),
            failure_reason text CHECK(failure_reason IN ('authorization_denied','invalid_command','reconnect_required')),
            created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
            PRIMARY KEY(namespace,environment,tenant_id,user_id,integration_id,command_id));
            CREATE INDEX IF NOT EXISTS opencrawl_integration_commands_pending ON opencrawl_integration_commands(namespace,environment,sequence) WHERE status='pending';
            CREATE TABLE IF NOT EXISTS opencrawl_integration_command_secrets (
              namespace text NOT NULL, environment text NOT NULL, tenant_id text NOT NULL, user_id text NOT NULL,
              integration_id text NOT NULL, command_id text NOT NULL, ciphertext bytea NOT NULL, expires_at timestamptz NOT NULL,
              PRIMARY KEY(namespace,environment,tenant_id,user_id,integration_id,command_id),
              FOREIGN KEY(namespace,environment,tenant_id,user_id,integration_id,command_id)
                REFERENCES opencrawl_integration_commands(namespace,environment,tenant_id,user_id,integration_id,command_id) ON DELETE CASCADE)`);
        });
      })().catch(error => {preparing = undefined; throw error;});
      await preparing;
    },
    read: reference => read(database.pool, reference),
    async readSecret(reference) {
      const result = await database.pool.query(`SELECT s.ciphertext, s.expires_at > now() AS valid
        FROM opencrawl_integration_command_secrets s JOIN opencrawl_integration_commands c
        USING(namespace,environment,tenant_id,user_id,integration_id,command_id)
        WHERE s.namespace=$1 AND s.environment=$2 AND s.tenant_id=$3 AND s.user_id=$4 AND s.integration_id=$5 AND s.command_id=$6 AND c.status='pending'`, values(reference));
      if (!result.rows.length) return {};
      if (!result.rows[0].valid) throw Object.assign(new Error('Provisioning secret expired; reconnect the integration'), {status: 409, code: 'ProvisioningKeyRequired'});
      if (!envelope) throw new Error('Integration secret encryption key is unavailable');
      const secret = JSON.parse(envelope.open(context(reference), result.rows[0].ciphertext).toString()) as IntegrationCommandSecret;
      secretBytes(secret);
      return secret;
    },
    clearSecret: reference => removeSecret(database.pool, reference),
    complete: reference => database.transaction(client => finish(client, reference, 'completed')),
    fail: (reference: IntegrationCommandReference, reason: FailureReason) => {
      if (!['authorization_denied', 'invalid_command', 'reconnect_required'].includes(reason)) throw new Error('Invalid command failure classification');
      return database.transaction(client => finish(client, reference, 'failed', reason));
    },
    async listPending({cursor, limit = 100}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid command page size');
      let after = '0';
      if (cursor) {
        let decoded: unknown;
        try {decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());} catch {deny();}
        if (!Array.isArray(decoded) || decoded.length !== 2 || decoded[0] !== cursorScope || !/^[0-9]{1,20}$/.test(decoded[1])) deny();
        after = (decoded as [string, string])[1];
      }
      const result = await database.pool.query(`SELECT sequence,tenant_id,user_id,integration_id,command_id
        FROM opencrawl_integration_commands WHERE namespace=$1 AND environment=$2 AND status='pending' AND sequence>$3::bigint ORDER BY sequence LIMIT $4`, [database.namespace, environment, after, limit + 1]);
      const rows = result.rows.slice(0, limit);
      return {commands: rows.map(row => ({environment, tenantId: row.tenant_id, userId: row.user_id, integrationId: row.integration_id, commandId: row.command_id})),
        cursor: result.rows.length > limit ? Buffer.from(JSON.stringify([cursorScope, String(rows.at(-1)!.sequence)])).toString('base64url') : null};
    },
  };
}
