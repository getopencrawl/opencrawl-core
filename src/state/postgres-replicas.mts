import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {PoolClient} from 'pg';
import {challengeSchema,scope,uuid,type ReplicasConnection,type ReplicasChallenge} from '../identity/replicas-schema.mjs';
import type {StoreVersion} from '../sessions/types.mjs';
import {ensureSchemaIndex,type ApplicationDatabase} from './postgres.mjs';
import {checkedConnection,codeHash,type ReplicasRepository} from './replicas-objects.mjs';

const table='opencrawl_replicas_approvals',authority='opencrawl_replicas_authority';
type Kind='organization'|'setup';
type RecordValue=ReplicasConnection|ReplicasChallenge;
export interface ReplicasImportReceipt {organizations:number;setupCodes:number;tenantIndexes:number;sha256:string}

export function postgresReplicasRecords(database:ApplicationDatabase, requireReceipt=false) {
  const ns=database.namespace,source=database.sourceIdentity;
  if (!source) throw new Error('Replicas database source identity is required');
  function checkTenant(tenant:string) {
    scope.parse(tenant);
    if (source?.organizationId && tenant!==source.organizationId) throw new Error('Replicas source tenant mismatch');
  }
  let prepared:Promise<void>|undefined;
  function ready() {
    prepared??=database.transaction(async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:replicas-approvals:schema',0))");
      await client.query(`CREATE TABLE IF NOT EXISTS ${table} (
        namespace text NOT NULL,kind text NOT NULL CHECK(kind IN ('organization','setup')),id text NOT NULL,
        tenant_id text NOT NULL,record jsonb NOT NULL,revision uuid NOT NULL,PRIMARY KEY(namespace,kind,id),
        CHECK ((record->>'tenantId') IS NOT DISTINCT FROM tenant_id));
        CREATE TABLE IF NOT EXISTS ${authority} (
          namespace text PRIMARY KEY,source jsonb NOT NULL,receipt jsonb NOT NULL,activated_at timestamptz NOT NULL DEFAULT now())`);
      await ensureSchemaIndex(client,{table,name:'opencrawl_replicas_approvals_tenant',keys:['namespace','tenant_id','id'],predicate:{column:'kind',equals:'organization'}});
      if (requireReceipt && !await receipt(client)) throw new Error('Replicas PostgreSQL import receipt is required');
    }).catch(error=>{prepared=undefined;throw error;});
    return prepared;
  }
  async function receipt(client:Pick<PoolClient,'query'>):Promise<ReplicasImportReceipt|null> {
    const {rows}=await client.query(`SELECT source,receipt FROM ${authority} WHERE namespace=$1`,[ns]);
    if (!rows.length) return null;
    if (!isDeepStrictEqual(rows[0].source,source)) throw new Error('Replicas source binding changed');
    return rows[0].receipt;
  }
  async function read(id:string,kind:Kind) {
    await ready();
    const {rows}=await database.pool.query(`SELECT record,revision FROM ${table} WHERE namespace=$1 AND kind=$2 AND id=$3`,[ns,kind,id]);
    return rows[0] ? {record:rows[0].record,version:'pg:'+rows[0].revision} : {record:null,version:null};
  }
  async function save(id:string,kind:Kind,version:StoreVersion|null,value:RecordValue) {
    await ready();
    checkTenant(value.tenantId);
    const args=[ns,kind,id,value.tenantId,JSON.stringify(value),randomUUID()];
    if (version===null) {
      const result=await database.pool.query(`INSERT INTO ${table}(namespace,kind,id,tenant_id,record,revision)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,args);
      return result.rowCount===1;
    }
    // An S3 ETag can arrive from an operation that straddled cutover.
    if (typeof version!=='string'||!/^pg:[a-f0-9-]{36}$/.test(version)) return false;
    const result=await database.pool.query(`UPDATE ${table} SET record=$5,revision=$6
      WHERE namespace=$1 AND kind=$2 AND id=$3 AND tenant_id=$4 AND revision=$7`,[...args,version.slice(3)]);
    return result.rowCount===1;
  }
  const repository:ReplicasRepository={
    async readConnection(id) {
      uuid.parse(id);
      const {record,version}=await read(id,'organization');
      if (record) checkTenant(record.tenantId);
      return {record:record && checkedConnection(id,record),version};
    },
    saveConnection(id,version,input) {
      const record=checkedConnection(id,input);
      return save(id,'organization',version,record);
    },
    async listConnections(tenant) {
      checkTenant(tenant);
      await ready();
      const {rows}=await database.pool.query(`SELECT id,record FROM ${table} WHERE namespace=$1 AND kind='organization'
        AND tenant_id=$2 AND record->>'revokedAt' IS NULL ORDER BY id LIMIT 10001`,[ns,tenant]);
      if (rows.length>10000) throw new Error('Replicas connection listing exceeds limit');
      return rows.map(row=>checkedConnection(row.id,row.record));
    },
    async readSetup(hash) {
      codeHash(hash);
      const {record,version}=await read(hash,'setup');
      if (record) checkTenant(record.tenantId);
      return {record:record && challengeSchema.parse(record),version};
    },
    saveSetup(hash,version,input) {
      const record=challengeSchema.parse(input);
      return save(codeHash(hash),'setup',version,record);
    },
  };

  return {ready,repository,receipt,checkTenant};
}

export function createPostgresReplicasRepository(database:ApplicationDatabase) {
  const {ready,repository}=postgresReplicasRecords(database,true);
  return {ready,repository};
}
