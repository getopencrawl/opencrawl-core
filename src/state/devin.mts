import {randomUUID} from 'node:crypto';
import {ensureSchemaIndex,type ApplicationDatabase} from './postgres.mjs';
import {connectionSchema,devinOrganization,challengeSchema,type DevinConnection,type DevinChallenge} from '../identity/devin-schema.mjs';
type Versioned<T>={record:T|null;version:string|null};
export interface DevinState {
  readConnection(organizationId:string):Promise<Versioned<DevinConnection>>;
  saveConnection(organizationId:string,version:string|null,record:DevinConnection):Promise<boolean>;
  listConnections(tenantId:string):Promise<DevinConnection[]>;
  readSetup(codeHash:string):Promise<Versioned<DevinChallenge>>;
  saveSetup(codeHash:string,version:string|null,record:DevinChallenge):Promise<boolean>;
}
const checkCode=(value:string)=>{if(!/^[a-f0-9]{64}$/.test(value))throw new Error('Invalid workload setup hash');};
/** Organization ownership and its installations commit together. Tenant lists use
 * a database index, so no independently written index can become authoritative. */
export function createDevinState(database:ApplicationDatabase):DevinState & {ready():Promise<void>} {
  const checkOrg=(value:string)=>devinOrganization.parse(value);
  const ns=database.namespace;let preparing:Promise<void>|undefined;
  const query=(sql:string,args:unknown[])=>database.pool.query(sql,args);
  async function connection(client:Pick<typeof database.pool,'query'>,org:string):Promise<Versioned<DevinConnection>>{
    checkOrg(org);const {rows}=await client.query(`SELECT c.record,c.revision,COALESCE((SELECT jsonb_agg(i.record ORDER BY i.ordinal) FROM opencrawl_devin_installations i WHERE i.namespace=c.namespace AND i.organization_id=c.organization_id),'[]'::jsonb) AS installations FROM opencrawl_devin_connections c WHERE namespace=$1 AND organization_id=$2`,[ns,org]);
    if(!rows[0])return {record:null,version:null};return {record:connectionSchema.parse({...rows[0].record,installations:rows[0].installations}),version:rows[0].revision};
  }
  const readConnection=(org:string)=>connection(database.pool,org);
  async function saveConnection(org:string,version:string|null,input:DevinConnection){checkOrg(org);const value=connectionSchema.parse(input);
    if(value.organizationId!==org||value.installations.some(i=>i.tenantId!==value.tenantId))throw new Error('Devin connection scope is invalid');
    const {installations,...record}=value;
    return database.transaction(async client=>{
      const args=[ns,org,value.tenantId,JSON.stringify(record),randomUUID()];
      const result=version===null?await client.query(`INSERT INTO opencrawl_devin_connections(namespace,organization_id,tenant_id,record,revision) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT DO NOTHING`,args):
        await client.query(`UPDATE opencrawl_devin_connections SET record=$4::jsonb,revision=$5 WHERE namespace=$1 AND organization_id=$2 AND tenant_id=$3 AND revision=$6`,[...args,version]);
      if(result.rowCount!==1)return false;
      await client.query(`DELETE FROM opencrawl_devin_installations WHERE namespace=$1 AND organization_id=$2`,[ns,org]);
      for(const [index,item] of installations.entries())await client.query(`INSERT INTO opencrawl_devin_installations(namespace,organization_id,user_id,ordinal,record) VALUES($1,$2,$3,$4,$5::jsonb)`,[ns,org,item.userId,index,JSON.stringify(item)]);
      return true;
    });
  }
  async function readSetup(codeHash:string):Promise<Versioned<DevinChallenge>>{checkCode(codeHash);const {rows}=await query(`SELECT record,revision FROM opencrawl_devin_setup WHERE namespace=$1 AND code_hash=$2`,[ns,codeHash]);return rows[0]?{record:challengeSchema.parse(rows[0].record),version:rows[0].revision}:{record:null,version:null};}
  async function saveSetup(codeHash:string,version:string|null,input:DevinChallenge){checkCode(codeHash);const record=challengeSchema.parse(input),params=[ns,codeHash,JSON.stringify(record),randomUUID()];
    const {rowCount}=version===null?await query(`INSERT INTO opencrawl_devin_setup(namespace,code_hash,record,revision) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT DO NOTHING`,params):await query(`UPDATE opencrawl_devin_setup SET record=$3::jsonb,revision=$4 WHERE namespace=$1 AND code_hash=$2 AND revision=$5`,[...params,version]);return rowCount===1;}
  return {
    async ready(){preparing??=(async()=>{await database.ready();await database.transaction(async client=>{await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`opencrawl:devin:schema`]);await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_devin_connections(namespace text NOT NULL,organization_id text NOT NULL,tenant_id text NOT NULL,record jsonb NOT NULL,revision uuid NOT NULL,PRIMARY KEY(namespace,organization_id),CHECK(record->>'organizationId'=organization_id),CHECK(record->>'tenantId'=tenant_id));
      CREATE TABLE IF NOT EXISTS opencrawl_devin_installations(namespace text NOT NULL,organization_id text NOT NULL,user_id text NOT NULL,ordinal integer NOT NULL,record jsonb NOT NULL,PRIMARY KEY(namespace,organization_id,user_id),UNIQUE(namespace,organization_id,ordinal),FOREIGN KEY(namespace,organization_id) REFERENCES opencrawl_devin_connections(namespace,organization_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS opencrawl_devin_setup(namespace text NOT NULL,code_hash text NOT NULL,record jsonb NOT NULL,revision uuid NOT NULL,PRIMARY KEY(namespace,code_hash))`);
      await ensureSchemaIndex(client,{table:`opencrawl_devin_connections`,name:`opencrawl_devin_connections_tenant`,keys:['namespace','tenant_id','organization_id']});
      });})().catch(error=>{preparing=undefined;throw error;});await preparing;},
    readConnection,saveConnection,readSetup,saveSetup,
    async listConnections(tenant){if(!/^[A-Za-z0-9_.:-]{1,200}$/.test(tenant))throw new Error('Invalid workspace');const {rows}=await query(`SELECT c.record,COALESCE((SELECT jsonb_agg(i.record ORDER BY i.ordinal) FROM opencrawl_devin_installations i WHERE i.namespace=c.namespace AND i.organization_id=c.organization_id),'[]'::jsonb) AS installations FROM opencrawl_devin_connections c WHERE namespace=$1 AND tenant_id=$2 ORDER BY organization_id`,[ns,tenant]);return rows.map(row=>connectionSchema.parse({...row.record,installations:row.installations}));},
  };
}
