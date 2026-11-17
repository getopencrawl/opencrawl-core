import {scanTargetInventoryIn,targetInventoryFailure,type OnlineOwnedInventoryItem} from './online-target-inventory-support.mjs';
import type {PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import type {ApplicationDatabase} from './postgres.mjs';
import type {StoreVersion} from '../sessions/types.mjs';
export interface ConnectorSecretScope {kind:'grant'|'settings';organizationId:string;id:string}
export interface ConnectorSecrets {
  read(scope:ConnectorSecretScope,aad:string):Promise<{version:StoreVersion|null;data:Buffer|null}>;
  compareAndSet(scope:ConnectorSecretScope,aad:string,version:StoreVersion|null,data:Uint8Array):Promise<boolean>;
}
/** Each grant/configuration has its own row. Existing ciphertext and AAD survive
 * import byte-for-byte; a database move never silently decrypts saved secrets. */
export function createConnectorSecrets(database:ApplicationDatabase):ConnectorSecrets&{ready():Promise<void>;readIn(client:PoolClient,scope:ConnectorSecretScope,aad:string):Promise<{version:StoreVersion|null;data:Buffer|null}>;projectIn(client:PoolClient,scope:ConnectorSecretScope,aad:string,bytes:Buffer|null):Promise<void>;importSecret(scope:ConnectorSecretScope,aad:string,bytes:Buffer):Promise<Buffer>}{
  let preparing:Promise<void>|undefined;
  function values(scope:ConnectorSecretScope,aad:string){
    if(!/^org_[A-Za-z0-9]+$/.test(scope.organizationId)||!['grant','settings'].includes(scope.kind)||
      (scope.kind==='grant'?!/^grant_[a-f0-9]{48}$/.test(scope.id):scope.id!=='settings')||!aad||aad.length>2048||aad.split('/').some(p=>!p||p==='.'||p==='..')||
      !aad.endsWith(`/${scope.organizationId}/${scope.id}.enc`))throw new Error('Invalid connector secret scope');
    return [database.namespace,scope.kind,scope.organizationId,scope.id,aad];
  }
  function validate(bytes:Uint8Array){if(bytes.length<30||bytes.length>262144||bytes[0]!==1)throw new Error('Invalid connector secret envelope');}
  async function read(scope:ConnectorSecretScope,aad:string,client:Pick<PoolClient,'query'>=database.pool){const params=values(scope,aad);const {rows}=await client.query('SELECT aad,ciphertext,revision FROM opencrawl_connector_secrets WHERE namespace=$1 AND kind=$2 AND organization_id=$3 AND secret_id=$4',params.slice(0,4));
    if(!rows[0])return {data:null,version:null};if(rows[0].aad!==aad)throw new Error('Connector secret binding mismatch');return {data:Buffer.from(rows[0].ciphertext),version:rows[0].revision as string};}
  return {
    async ready(){preparing??=(async()=>{await database.ready();await database.transaction(async client=>{await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:connector-secrets:schema',0))");await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_connector_secrets(namespace text NOT NULL,kind text NOT NULL CHECK(kind IN ('grant','settings')),organization_id text NOT NULL,secret_id text NOT NULL,aad text NOT NULL,ciphertext bytea NOT NULL,revision uuid NOT NULL,PRIMARY KEY(namespace,kind,organization_id,secret_id))`);});})().catch(error=>{preparing=undefined;throw error;});await preparing;},
    read,
    readIn:(client,scope,aad)=>read(scope,aad,client),
    async projectIn(client,scope,aad,bytes){const params=values(scope,aad);await read(scope,aad,client);
      if(bytes===null){await client.query('DELETE FROM opencrawl_connector_secrets WHERE namespace=$1 AND kind=$2 AND organization_id=$3 AND secret_id=$4 AND aad=$5',params);return;}
      validate(bytes);await client.query('INSERT INTO opencrawl_connector_secrets(namespace,kind,organization_id,secret_id,aad,ciphertext,revision) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(namespace,kind,organization_id,secret_id) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,revision=EXCLUDED.revision',[...params,bytes,randomUUID()]);
    },
    async compareAndSet(scope,aad,version,data){const params=values(scope,aad);validate(data);const next=randomUUID();
      if(version===null){const {rowCount}=await database.pool.query('INSERT INTO opencrawl_connector_secrets(namespace,kind,organization_id,secret_id,aad,ciphertext,revision) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',[...params,Buffer.from(data),next]);return rowCount===1;}
      if(typeof version!=='string'||!/^[a-f0-9-]{36}$/.test(version))return false;
      const {rowCount}=await database.pool.query('UPDATE opencrawl_connector_secrets SET ciphertext=$6,revision=$7 WHERE namespace=$1 AND kind=$2 AND organization_id=$3 AND secret_id=$4 AND aad=$5 AND revision=$8',[...params,Buffer.from(data),next,version]);return rowCount===1;
    },
    async importSecret(scope,aad,bytes){const params=values(scope,aad);validate(bytes);await database.pool.query('INSERT INTO opencrawl_connector_secrets(namespace,kind,organization_id,secret_id,aad,ciphertext,revision) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',[...params,bytes,randomUUID()]);const actual=(await read(scope,aad)).data;if(!actual?.equals(bytes))throw new Error('Connector secret import conflicts with existing data');return actual;},
  };
}

export async function* inventoryConnectorSecretTargetsIn(database:ApplicationDatabase,client:PoolClient):AsyncGenerator<OnlineOwnedInventoryItem>{
 const repo=createConnectorSecrets(database);
 for await(const row of scanTargetInventoryIn(client,'SELECT kind,organization_id,secret_id,aad,octet_length(ciphertext) bytes FROM opencrawl_connector_secrets WHERE namespace=$1 ORDER BY kind COLLATE "C",organization_id COLLATE "C",secret_id COLLATE "C"',[database.namespace])){
  const scope:ConnectorSecretScope={kind:row.kind as 'grant'|'settings',organizationId:String(row.organization_id),id:String(row.secret_id)},aad=String(row.aad);
  if(!Number.isSafeInteger(row.bytes)||Number(row.bytes)<30||Number(row.bytes)>262144)targetInventoryFailure('invalid secret size');
  const value=(await repo.readIn(client,scope,aad)).data;if(!value||value[0]!==1)targetInventoryFailure('invalid secret envelope');
  yield {kind:'target',domains:[scope.kind==='grant'?'connector-grants':'connector-settings'],identity:[scope.kind,scope.organizationId,scope.id],value,maxBytes:262144,sourceKey:aad};
 }
}
