import {scanTargetInventoryIn,assertTargetInventoryBoundIn,targetInventoryFailure,targetInventoryValueBytes,type OnlineOwnedInventoryItem} from './online-target-inventory-support.mjs';
import {randomUUID,createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {isDeepStrictEqual} from 'node:util';
import {sessionScope} from '../sessions/event-identity.mjs';
import {validateSetupState,type SetupStateRecord,type SetupScope} from '../setup/state.mjs';
import type {ApplicationDatabase} from './postgres.mjs';

export interface SetupState {
  read(scope:SetupScope):Promise<{record:SetupStateRecord|null;version:string|null}>;
  save(scope:SetupScope,version:string|null,record:SetupStateRecord):Promise<boolean>;
}
export interface SetupProjectionScope {tenantId:string;userHash:string}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
/** Schema-only owner seam. The caller owns this transaction; this does not
 * initialize an installation, import records or authorize runtime reads. */
export async function prepareSetupSchemaIn(client:PoolClient):Promise<void>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:setup:schema',0))");
      await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_setup_status(namespace text NOT NULL,tenant_id text NOT NULL,user_id text NOT NULL,record jsonb NOT NULL,revision uuid NOT NULL,PRIMARY KEY(namespace,tenant_id,user_id),CHECK((record->'scope'->>'tenantId') IS NOT NULL AND record->'scope'->>'tenantId'=tenant_id),CHECK((record->'scope'->>'userId') IS NOT NULL AND record->'scope'->>'userId'=user_id))`);
}

/** The owner aggregate commits atomically, including firstWin and every client.
 * Scope is explicit; the installation namespace is bound by the database. */
export function createSetupState(database:ApplicationDatabase) {
  const ns=database.namespace;let preparing:Promise<void>|undefined;
  function decode(row:Record<string,unknown>|undefined,scope?:SetupScope){
    if(!row)return {record:null,version:null};
    if(typeof row.revision!=='string'||!uuid.test(row.revision))throw new Error('Invalid setup storage revision');
    return {record:validateSetupState(row.record,scope),version:row.revision};
  }
  async function readIn(client:Pick<PoolClient,'query'>,scope:SetupScope){
    const frozen={tenantId:scope.tenantId,userId:scope.userId};sessionScope(frozen);
    const {rows}=await client.query('SELECT record,revision FROM opencrawl_setup_status WHERE namespace=$1 AND tenant_id=$2 AND user_id=$3',[ns,frozen.tenantId,frozen.userId]);
    return decode(rows[0],frozen);
  }
  function projectionScope(input:SetupProjectionScope){
    const scope={tenantId:input.tenantId,userHash:input.userHash};sessionScope({tenantId:scope.tenantId,userId:'scope-validation'});
    if(!/^[a-f0-9]{64}$/.test(scope.userHash))throw new Error('Invalid setup projection owner hash');return scope;
  }
  async function readProjectionIn(client:PoolClient,input:SetupProjectionScope){
    const scope=projectionScope(input);
    // The legacy key supplies only a user digest. Resolve it inside the already
    // enrolled tenant, never by scanning another tenant or inventing an owner.
    const {rows}=await client.query(`SELECT record,revision,user_id FROM opencrawl_setup_status WHERE namespace=$1 AND tenant_id=$2 AND sha256(convert_to(user_id,'UTF8'))=decode($3,'hex') LIMIT 2`,[ns,scope.tenantId,scope.userHash]);
    if(rows.length>1)throw new Error('Ambiguous setup projection owner');
    if(!rows[0])return {record:null,version:null};
    const owner={tenantId:scope.tenantId,userId:rows[0].user_id};if(typeof owner.userId!=='string'||hash(owner.userId)!==scope.userHash)throw new Error('Setup projection owner differs from source');
    return decode(rows[0],owner);
  }
  async function projectIn(client:PoolClient,input:SetupProjectionScope,value:SetupStateRecord|null){
    const scope=projectionScope(input),record=value===null?null:validateSetupState(value);
    if(record&&(record.scope.tenantId!==scope.tenantId||hash(record.scope.userId)!==scope.userHash))throw new Error('Setup projection owner differs from source');
    if(record)await client.query(`INSERT INTO opencrawl_setup_status(namespace,tenant_id,user_id,record,revision) VALUES($1,$2,$3,$4::jsonb,$5)
      ON CONFLICT(namespace,tenant_id,user_id) DO UPDATE SET record=EXCLUDED.record,revision=EXCLUDED.revision`,[ns,scope.tenantId,record.scope.userId,JSON.stringify(record),randomUUID()]);
    else{const prior=await readProjectionIn(client,scope);if(prior.record)await client.query('DELETE FROM opencrawl_setup_status WHERE namespace=$1 AND tenant_id=$2 AND user_id=$3',[ns,scope.tenantId,prior.record.scope.userId]);}
    const target=(await readProjectionIn(client,scope)).record;if(!isDeepStrictEqual(target,record))throw new Error('Setup projection readback differs from source');return target;
  }
  async function read(scope:SetupScope){return readIn(database.pool,scope);}
  async function save(scope:SetupScope,version:string|null,input:SetupStateRecord){
    sessionScope(scope);if(version!==null&&!uuid.test(version))throw new Error('Invalid setup storage revision');
    const record=validateSetupState(input,scope),args=[ns,scope.tenantId,scope.userId,JSON.stringify(record),randomUUID()];
    const result=version===null?await database.pool.query('INSERT INTO opencrawl_setup_status(namespace,tenant_id,user_id,record,revision) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT DO NOTHING',args):
      await database.pool.query('UPDATE opencrawl_setup_status SET record=$4::jsonb,revision=$5 WHERE namespace=$1 AND tenant_id=$2 AND user_id=$3 AND revision=$6',[...args,version]);
    return result.rowCount===1;
  }
  return {read,save,readIn,readProjectionIn,projectIn,
    async ready(){preparing??=(async()=>{await database.ready();await database.transaction(async client=>{
      await prepareSetupSchemaIn(client);
    });})().catch(error=>{preparing=undefined;throw error;});await preparing;},
    async importStatus(input:unknown){const record=validateSetupState(input);await save(record.scope,null,record);const target=(await read(record.scope)).record;
      if(!isDeepStrictEqual(target,record))throw new Error('Setup target differs from legacy state');return target!;},
  };
}

export async function* inventorySetupTargetsIn(database:ApplicationDatabase,client:PoolClient):AsyncGenerator<OnlineOwnedInventoryItem>{
 const repo=createSetupState(database);let previous='';
 for await(const row of scanTargetInventoryIn(client,`SELECT tenant_id,user_id,octet_length(record::text) bytes FROM opencrawl_setup_status WHERE namespace=$1 ORDER BY sha256(convert_to(tenant_id,'UTF8')),sha256(convert_to(user_id,'UTF8')),tenant_id COLLATE "C",user_id COLLATE "C"`,[database.namespace])){
  if(!Number.isSafeInteger(row.bytes)||Number(row.bytes)>524288)targetInventoryFailure('oversized Setup record');
  const scope={tenantId:String(row.tenant_id),userId:String(row.user_id)},identity=[hash(scope.tenantId),hash(scope.userId)],key=JSON.stringify(identity);if(key===previous)targetInventoryFailure('ambiguous Setup canonical identity');previous=key;
  const value=(await repo.readIn(client,scope)).record;if(!value)targetInventoryFailure('Setup owner disappeared');yield {kind:'target',domains:['setup-status'],identity,value,maxBytes:262144};
 }
}
