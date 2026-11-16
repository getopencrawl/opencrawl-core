import {createHash} from 'node:crypto';
import {digest} from '../connectors/scope.mjs';
import type {ApplicationDatabase} from './postgres.mjs';
import type {Environment, IntegrationRecord} from '../integrations/types.mjs';
export const integrationDrainFingerprint=(namespace:string,record:IntegrationRecord,legacyBucket?:string)=>createHash('sha256').update(JSON.stringify(['integration-drain-v1',namespace,record.environment,record.tenantId,record.userId,record.integrationId,record.resourceVersion??null,record.airbyteWorkspaceId??null,record.airbyte?.connectionId??null,record.airbyte?.sourceId??null,record.airbyte?.destinationId??null,record.s3Bucket??legacyBucket??null,record.s3Prefix??null])).digest('hex');
const required = () => Object.assign(new Error('External writer settlement requires operator verification'), {code:'EXTERNAL_WRITER_PROOF_REQUIRED'});
/** This receipt records an operator's independently verified terminal writer and
 * storage disposition. A cancel response, quiet period, or job age is not proof. */
export function createIntegrationDrainProofs({database,environment}:{database:ApplicationDatabase;environment:Environment}) {
  const key=(record:IntegrationRecord)=>{
    if(record.environment!==environment||!record.tenantId||!record.userId||!record.integrationId)throw required();
    return [database.namespace,environment,record.tenantId,record.userId,record.integrationId];
  };
  const fingerprint=(record:IntegrationRecord)=>integrationDrainFingerprint(database.namespace,record,database.sourceIdentity?.bucket);
  let preparing:Promise<void>|undefined;
  async function ready(){preparing??=database.ready().then(()=>database.transaction(async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:integration-drain-proofs:schema',0))");
    await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_integration_drain_proofs (
    namespace text NOT NULL,environment text NOT NULL,tenant_id text NOT NULL,user_id text NOT NULL,integration_id text NOT NULL,
    fingerprint text NOT NULL,evidence text NOT NULL,verified_by text NOT NULL,verified_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(namespace,environment,tenant_id,user_id,integration_id,fingerprint))`);
  })).catch(error=>{preparing=undefined;throw error;});await preparing;}
  return {
    ready,
    async inspect(record:IntegrationRecord){
      const params=key(record),exists=await database.pool.query("SELECT to_regclass('opencrawl_integration_drain_proofs') AS name");
      const saved=exists.rows[0]?.name?await database.pool.query('SELECT verified_at FROM opencrawl_integration_drain_proofs WHERE namespace=$1 AND environment=$2 AND tenant_id=$3 AND user_id=$4 AND integration_id=$5 AND fingerprint=$6',[...params,fingerprint(record)]):{rows:[]};
      return {fingerprint:fingerprint(record),recorded:!!saved.rows.length,recordedAt:saved.rows[0]?.verified_at??null};
    },
    async requireProof(record:IntegrationRecord){
      // No Airbyte connection could have written landing objects when no create
      // intent or connection ever existed. Native writers still drain separately.
      key(record);
      if(!record.airbyte?.connectionId&&!record.provisionIntent)return;
      await ready();const {rows}=await database.pool.query('SELECT 1 FROM opencrawl_integration_drain_proofs WHERE namespace=$1 AND environment=$2 AND tenant_id=$3 AND user_id=$4 AND integration_id=$5 AND fingerprint=$6',[...key(record),fingerprint(record)]);
      if(!rows.length)throw required();
    },
    /** Restricted operator/migration seam; never expose through tenant HTTP. */
    async recordVerifiedProof(record:IntegrationRecord,{evidence,verifiedBy}:{evidence:string;verifiedBy:string}){
      if(!['disconnecting','disconnected'].includes(record.status)||record.provisionIntent)throw Object.assign(new Error('Explicit terminal writer evidence and operator identity required'),{code:'EXTERNAL_WRITER_PROOF_REQUIRED'});
      if(!evidence?.trim()||evidence.length>8192||!verifiedBy?.trim()||verifiedBy.length>200)throw Object.assign(new Error('Explicit terminal writer evidence and operator identity required'),{code:'DRAIN_EVIDENCE_INVALID'});
      if(record.s3Prefix&&!record.s3Bucket&&!database.sourceIdentity?.bucket)throw required();
      await ready();await database.transaction(async client=>{
        const params=key(record);
        const authoritative=await client.query('SELECT record FROM opencrawl_integrations WHERE namespace=$1 AND environment=$2 AND tenant_id=$3 AND user_id=$4 AND integration_id=$5 FOR UPDATE',params);
        const current=authoritative.rows[0]?.record as IntegrationRecord|undefined;
        if(!current||!['disconnecting','disconnected'].includes(current.status)||current.provisionIntent||fingerprint(current)!==fingerprint(record))throw required();
        const fenceKey='control/connectors/write-barriers/v1/'+digest([environment,record.tenantId,record.integrationId])+'.json';
        const fence=await client.query('SELECT closed_at,barrier_namespace,tenant_id,resource_id FROM opencrawl_write_fences WHERE namespace=$1 AND fence_key=$2 FOR UPDATE',[database.namespace,fenceKey]);
        const pending=await client.query("SELECT 1 FROM opencrawl_resource_writers WHERE namespace=$1 AND fence_key=$2 AND phase='writing' LIMIT 1",[database.namespace,fenceKey]);
        // A proof observed before the last admitted sync/scheduler settles could
        // be invalidated without changing resource IDs. Never accept it then.
        if(!fence.rows.length||fence.rows[0].closed_at===null||fence.rows[0].barrier_namespace!==environment||fence.rows[0].tenant_id!==record.tenantId||fence.rows[0].resource_id!==record.integrationId||pending.rows.length)throw required();
        await client.query(`INSERT INTO opencrawl_integration_drain_proofs(namespace,environment,tenant_id,user_id,integration_id,fingerprint,evidence,verified_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,[...params,fingerprint(current),evidence,verifiedBy]);
      });
    },
  };
}
