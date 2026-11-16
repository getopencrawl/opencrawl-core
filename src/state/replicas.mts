import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {ApplicationDatabase} from './postgres.mjs';
import {replicasConnectionSchema,replicasChallengeSchema,type ReplicasConnection,type ReplicasChallenge} from '../identity/replicas-connections.mjs';
type Versioned<T>={record:T|null;version:string|null};
export interface ReplicasState {
  readConnection(organizationId:string):Promise<Versioned<ReplicasConnection>>;
  saveConnection(organizationId:string,version:string|null,record:ReplicasConnection):Promise<boolean>;
  listConnections(tenantId:string):Promise<ReplicasConnection[]>;
  readSetup(codeHash:string):Promise<Versioned<ReplicasChallenge>>;
  saveSetup(codeHash:string,version:string|null,record:ReplicasChallenge):Promise<boolean>;
}
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const checkOrg=(value:string)=>{if(!uuid.test(value))throw new Error('Invalid Replicas organization');};
const checkCode=(value:string)=>{if(!/^[a-f0-9]{64}$/.test(value))throw new Error('Invalid Replicas setup hash');};
/** Organization ownership and its installations commit together. Tenant lists use
 * a database index, so no independently written index can become authoritative. */
export function createReplicasState(database:ApplicationDatabase):ReplicasState&{ready():Promise<void>;importConnection(value:unknown):Promise<ReplicasConnection>;importSetup(codeHash:string,value:unknown):Promise<ReplicasChallenge>}{
  const ns=database.namespace;let preparing:Promise<void>|undefined;
  const query=(sql:string,args:unknown[])=>database.pool.query(sql,args);
  async function connection(client:Pick<typeof database.pool,'query'>,org:string):Promise<Versioned<ReplicasConnection>>{
    checkOrg(org);const {rows}=await client.query(`SELECT c.record,c.revision,COALESCE((SELECT jsonb_agg(i.record ORDER BY i.ordinal) FROM opencrawl_replicas_installations i WHERE i.namespace=c.namespace AND i.organization_id=c.organization_id),'[]'::jsonb) AS installations FROM opencrawl_replicas_connections c WHERE namespace=$1 AND organization_id=$2`,[ns,org]);
    if(!rows[0])return {record:null,version:null};return {record:replicasConnectionSchema.parse({...rows[0].record,installations:rows[0].installations}),version:rows[0].revision};
  }
  const readConnection=(org:string)=>connection(database.pool,org);
  async function saveConnection(org:string,version:string|null,input:ReplicasConnection){checkOrg(org);const value=replicasConnectionSchema.parse(input);
    if(value.organizationId!==org||value.installations.some(i=>i.tenantId!==value.tenantId))throw new Error('Invalid Replicas connection scope');
    const {installations,...record}=value;
    return database.transaction(async client=>{
      const args=[ns,org,value.tenantId,JSON.stringify(record),randomUUID()];
      const result=version===null?await client.query('INSERT INTO opencrawl_replicas_connections(namespace,organization_id,tenant_id,record,revision) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT DO NOTHING',args):
        await client.query('UPDATE opencrawl_replicas_connections SET record=$4::jsonb,revision=$5 WHERE namespace=$1 AND organization_id=$2 AND tenant_id=$3 AND revision=$6',[...args,version]);
      if(result.rowCount!==1)return false;
      await client.query('DELETE FROM opencrawl_replicas_installations WHERE namespace=$1 AND organization_id=$2',[ns,org]);
      for(const [index,item] of installations.entries())await client.query('INSERT INTO opencrawl_replicas_installations(namespace,organization_id,user_id,ordinal,record) VALUES($1,$2,$3,$4,$5::jsonb)',[ns,org,item.userId,index,JSON.stringify(item)]);
      return true;
    });
  }
  async function readSetup(codeHash:string):Promise<Versioned<ReplicasChallenge>>{checkCode(codeHash);const {rows}=await query('SELECT record,revision FROM opencrawl_replicas_setup WHERE namespace=$1 AND code_hash=$2',[ns,codeHash]);return rows[0]?{record:replicasChallengeSchema.parse(rows[0].record),version:rows[0].revision}:{record:null,version:null};}
  async function saveSetup(codeHash:string,version:string|null,input:ReplicasChallenge){checkCode(codeHash);const record=replicasChallengeSchema.parse(input),params=[ns,codeHash,JSON.stringify(record),randomUUID()];
    const {rowCount}=version===null?await query('INSERT INTO opencrawl_replicas_setup(namespace,code_hash,record,revision) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT DO NOTHING',params):await query('UPDATE opencrawl_replicas_setup SET record=$3::jsonb,revision=$4 WHERE namespace=$1 AND code_hash=$2 AND revision=$5',[...params,version]);return rowCount===1;}
  return {
    async ready(){preparing??=(async()=>{await database.ready();await database.transaction(async client=>{await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:replicas:schema',0))");await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_replicas_connections(namespace text NOT NULL,organization_id text NOT NULL,tenant_id text NOT NULL,record jsonb NOT NULL,revision uuid NOT NULL,PRIMARY KEY(namespace,organization_id),CHECK(record->>'organizationId'=organization_id),CHECK(record->>'tenantId'=tenant_id));
      CREATE INDEX IF NOT EXISTS opencrawl_replicas_connections_tenant ON opencrawl_replicas_connections(namespace,tenant_id,organization_id);
      CREATE TABLE IF NOT EXISTS opencrawl_replicas_installations(namespace text NOT NULL,organization_id text NOT NULL,user_id text NOT NULL,ordinal integer NOT NULL,record jsonb NOT NULL,PRIMARY KEY(namespace,organization_id,user_id),UNIQUE(namespace,organization_id,ordinal),FOREIGN KEY(namespace,organization_id) REFERENCES opencrawl_replicas_connections(namespace,organization_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS opencrawl_replicas_setup(namespace text NOT NULL,code_hash text NOT NULL,record jsonb NOT NULL,revision uuid NOT NULL,PRIMARY KEY(namespace,code_hash))`);});})().catch(error=>{preparing=undefined;throw error;});await preparing;},
    readConnection,saveConnection,readSetup,saveSetup,
    async listConnections(tenant){if(!/^[A-Za-z0-9_.:-]{1,200}$/.test(tenant))throw new Error('Invalid workspace');const {rows}=await query(`SELECT c.record,COALESCE((SELECT jsonb_agg(i.record ORDER BY i.ordinal) FROM opencrawl_replicas_installations i WHERE i.namespace=c.namespace AND i.organization_id=c.organization_id),'[]'::jsonb) AS installations FROM opencrawl_replicas_connections c WHERE namespace=$1 AND tenant_id=$2 ORDER BY organization_id`,[ns,tenant]);return rows.map(row=>replicasConnectionSchema.parse({...row.record,installations:row.installations}));},
    async importConnection(input){const value=replicasConnectionSchema.parse(input);await saveConnection(value.organizationId,null,value);const actual=(await readConnection(value.organizationId)).record;if(!isDeepStrictEqual(value,actual))throw new Error('Replicas connection import conflicts with existing data');return actual!;},
    async importSetup(codeHash,input){const value=replicasChallengeSchema.parse(input);await saveSetup(codeHash,null,value);const actual=(await readSetup(codeHash)).record;if(!isDeepStrictEqual(value,actual))throw new Error('Replicas setup import conflicts with existing data');return actual!;},
  };
}
