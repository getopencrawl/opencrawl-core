import type {PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {ensureSchemaIndex,type ApplicationDatabase} from './postgres.mjs';
import type {z} from 'zod';
import {workloadConnectionSchema,workloadOrganizationSchema,workloadLabel,type WorkloadProvider,type WorkloadConnection,type WorkloadChallenge} from '../identity/workload-schema.mjs';
type Versioned<T>={record:T|null;version:string|null};
export interface WorkloadState<Challenge extends WorkloadChallenge> {
  readConnection(organizationId:string):Promise<Versioned<WorkloadConnection>>;
  saveConnection(organizationId:string,version:string|null,record:WorkloadConnection):Promise<boolean>;
  listConnections(tenantId:string):Promise<WorkloadConnection[]>;
  readSetup(codeHash:string):Promise<Versioned<Challenge>>;
  saveSetup(codeHash:string,version:string|null,record:Challenge):Promise<boolean>;
}
const checkCode=(value:string)=>{if(!/^[a-f0-9]{64}$/.test(value))throw new Error('Invalid workload setup hash');};
/** Organization ownership and its installations commit together. Tenant lists use
 * a database index, so no independently written index can become authoritative. */
export function createWorkloadState<Challenge extends WorkloadChallenge>(database:ApplicationDatabase,provider:WorkloadProvider,challengeSchema:z.ZodType<Challenge>):WorkloadState<Challenge>&{ready():Promise<void>;
  readConnectionIn(client:PoolClient,organizationId:string):Promise<Versioned<WorkloadConnection>>;
  readSetupIn(client:PoolClient,codeHash:string):Promise<Versioned<Challenge>>;
  projectConnectionIn(client:PoolClient,organizationId:string,value:WorkloadConnection|null):Promise<void>;
  projectSetupIn(client:PoolClient,codeHash:string,value:Challenge|null):Promise<void>;
  importConnection(value:unknown):Promise<WorkloadConnection>;importSetup(codeHash:string,value:unknown):Promise<Challenge>}{
  if(provider!=='replicas'&&provider!=='devin')throw new Error('Unknown workload provider');
  const connectionSchema=workloadConnectionSchema(provider),label=workloadLabel(provider);
  const checkOrg=(value:string)=>workloadOrganizationSchema(provider).parse(value);
  const ns=database.namespace;let preparing:Promise<void>|undefined;
  const query=(sql:string,args:unknown[])=>database.pool.query(sql,args);
  async function connection(client:Pick<typeof database.pool,'query'>,org:string):Promise<Versioned<WorkloadConnection>>{
    checkOrg(org);const {rows}=await client.query(`SELECT c.record,c.revision,COALESCE((SELECT jsonb_agg(i.record ORDER BY i.ordinal) FROM opencrawl_${provider}_installations i WHERE i.namespace=c.namespace AND i.organization_id=c.organization_id),'[]'::jsonb) AS installations FROM opencrawl_${provider}_connections c WHERE namespace=$1 AND organization_id=$2`,[ns,org]);
    if(!rows[0])return {record:null,version:null};return {record:connectionSchema.parse({...rows[0].record,installations:rows[0].installations}),version:rows[0].revision};
  }
  const readConnection=(org:string)=>connection(database.pool,org);
  async function saveConnection(org:string,version:string|null,input:WorkloadConnection){checkOrg(org);const value=connectionSchema.parse(input);
    if(value.organizationId!==org||value.installations.some(i=>i.tenantId!==value.tenantId))throw new Error(label+' connection scope is invalid');
    const {installations,...record}=value;
    return database.transaction(async client=>{
      const args=[ns,org,value.tenantId,JSON.stringify(record),randomUUID()];
      const result=version===null?await client.query(`INSERT INTO opencrawl_${provider}_connections(namespace,organization_id,tenant_id,record,revision) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT DO NOTHING`,args):
        await client.query(`UPDATE opencrawl_${provider}_connections SET record=$4::jsonb,revision=$5 WHERE namespace=$1 AND organization_id=$2 AND tenant_id=$3 AND revision=$6`,[...args,version]);
      if(result.rowCount!==1)return false;
      await client.query(`DELETE FROM opencrawl_${provider}_installations WHERE namespace=$1 AND organization_id=$2`,[ns,org]);
      for(const [index,item] of installations.entries())await client.query(`INSERT INTO opencrawl_${provider}_installations(namespace,organization_id,user_id,ordinal,record) VALUES($1,$2,$3,$4,$5::jsonb)`,[ns,org,item.userId,index,JSON.stringify(item)]);
      return true;
    });
  }
  async function readSetup(codeHash:string,client:Pick<PoolClient,'query'>=database.pool):Promise<Versioned<Challenge>>{checkCode(codeHash);const {rows}=await client.query(`SELECT record,revision FROM opencrawl_${provider}_setup WHERE namespace=$1 AND code_hash=$2`,[ns,codeHash]);return rows[0]?{record:challengeSchema.parse(rows[0].record),version:rows[0].revision}:{record:null,version:null};}
  async function saveSetup(codeHash:string,version:string|null,input:Challenge){checkCode(codeHash);const record=challengeSchema.parse(input),params=[ns,codeHash,JSON.stringify(record),randomUUID()];
    const {rowCount}=version===null?await query(`INSERT INTO opencrawl_${provider}_setup(namespace,code_hash,record,revision) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT DO NOTHING`,params):await query(`UPDATE opencrawl_${provider}_setup SET record=$3::jsonb,revision=$4 WHERE namespace=$1 AND code_hash=$2 AND revision=$5`,[...params,version]);return rowCount===1;}
  return {
    async ready(){preparing??=(async()=>{await database.ready();await database.transaction(async client=>{await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`opencrawl:${provider}:schema`]);await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_${provider}_connections(namespace text NOT NULL,organization_id text NOT NULL,tenant_id text NOT NULL,record jsonb NOT NULL,revision uuid NOT NULL,PRIMARY KEY(namespace,organization_id),CHECK(record->>'organizationId'=organization_id),CHECK(record->>'tenantId'=tenant_id));
      CREATE TABLE IF NOT EXISTS opencrawl_${provider}_installations(namespace text NOT NULL,organization_id text NOT NULL,user_id text NOT NULL,ordinal integer NOT NULL,record jsonb NOT NULL,PRIMARY KEY(namespace,organization_id,user_id),UNIQUE(namespace,organization_id,ordinal),FOREIGN KEY(namespace,organization_id) REFERENCES opencrawl_${provider}_connections(namespace,organization_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS opencrawl_${provider}_setup(namespace text NOT NULL,code_hash text NOT NULL,record jsonb NOT NULL,revision uuid NOT NULL,PRIMARY KEY(namespace,code_hash))`);
      await ensureSchemaIndex(client,{table:`opencrawl_${provider}_connections`,name:`opencrawl_${provider}_connections_tenant`,keys:['namespace','tenant_id','organization_id']});
      });})().catch(error=>{preparing=undefined;throw error;});await preparing;},
    readConnection,saveConnection,readSetup,saveSetup,
    readConnectionIn:connection,readSetupIn:(client,key)=>readSetup(key,client),
    async projectConnectionIn(client,org,input){checkOrg(org);const value=input===null?null:connectionSchema.parse(input),current=(await connection(client,org)).record;
      if(value===null){await client.query(`DELETE FROM opencrawl_${provider}_connections WHERE namespace=$1 AND organization_id=$2`,[ns,org]);return;}
      if(value.organizationId!==org||value.installations.some(i=>i.tenantId!==value.tenantId)||current&&current.tenantId!==value.tenantId)throw new Error(label+' connection scope is invalid');
      if(current?.revokedAt&&value.revokedAt===null&&Date.parse(value.approvedAt)<=Date.parse(current.revokedAt))throw new Error(label+' reapproval must follow the original revocation');
      const {installations,...record}=value;await client.query(`INSERT INTO opencrawl_${provider}_connections(namespace,organization_id,tenant_id,record,revision) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(namespace,organization_id) DO UPDATE SET record=EXCLUDED.record,revision=EXCLUDED.revision`,[ns,org,value.tenantId,JSON.stringify(record),randomUUID()]);
      await client.query(`DELETE FROM opencrawl_${provider}_installations WHERE namespace=$1 AND organization_id=$2`,[ns,org]);
      for(const [index,item] of installations.entries())await client.query(`INSERT INTO opencrawl_${provider}_installations(namespace,organization_id,user_id,ordinal,record) VALUES($1,$2,$3,$4,$5::jsonb)`,[ns,org,item.userId,index,JSON.stringify(item)]);
    },
    async projectSetupIn(client,key,input){checkCode(key);const value=input===null?null:challengeSchema.parse(input),current=(await readSetup(key,client)).record;
      if(value===null){await client.query(`DELETE FROM opencrawl_${provider}_setup WHERE namespace=$1 AND code_hash=$2`,[ns,key]);return;}
      if(current&&(current.tenantId!==value.tenantId||current.userId!==value.userId||current.issuedAt!==value.issuedAt||current.expiresAt!==value.expiresAt||current.claim!==null&&!isDeepStrictEqual(current.claim,value.claim)))throw new Error(label+' setup scope is invalid');
      await client.query(`INSERT INTO opencrawl_${provider}_setup(namespace,code_hash,record,revision) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(namespace,code_hash) DO UPDATE SET record=EXCLUDED.record,revision=EXCLUDED.revision`,[ns,key,JSON.stringify(value),randomUUID()]);
    },
    async listConnections(tenant){if(!/^[A-Za-z0-9_.:-]{1,200}$/.test(tenant))throw new Error('Invalid workspace');const {rows}=await query(`SELECT c.record,COALESCE((SELECT jsonb_agg(i.record ORDER BY i.ordinal) FROM opencrawl_${provider}_installations i WHERE i.namespace=c.namespace AND i.organization_id=c.organization_id),'[]'::jsonb) AS installations FROM opencrawl_${provider}_connections c WHERE namespace=$1 AND tenant_id=$2 ORDER BY organization_id`,[ns,tenant]);return rows.map(row=>connectionSchema.parse({...row.record,installations:row.installations}));},
    async importConnection(input){const value=connectionSchema.parse(input);await saveConnection(value.organizationId,null,value);const actual=(await readConnection(value.organizationId)).record;if(!isDeepStrictEqual(value,actual))throw new Error(label+' connection import conflicts with existing data');return actual!;},
    async importSetup(codeHash,input){const value=challengeSchema.parse(input);await saveSetup(codeHash,null,value);const actual=(await readSetup(codeHash)).record;if(!isDeepStrictEqual(value,actual))throw new Error(label+' setup import conflicts with existing data');return actual!;},
  };
}
