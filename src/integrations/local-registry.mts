import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {PoolClient} from 'pg';
import type {ApplicationDatabase} from '../state/postgres.mjs';
import type {Environment, IntegrationRecord, UpdateOptions} from './types.mjs';
import type {IntegrationRegistry} from './ports.mjs';
import type {IntegrationCommand, IntegrationCommandOperation, IntegrationCommandReference, IntegrationCommandSecret} from './temporal/types.mjs';

const denied=()=>Object.assign(new Error('Integration scope is not authorized'),{status:403});
const conflict=()=>Object.assign(new Error('Integration changed; refresh and retry'),{status:409,code:'ConditionalCheckFailedException'});
export interface IntegrationCommandTransactions {
  read(client:PoolClient,reference:IntegrationCommandReference):Promise<IntegrationCommand|null>;
  enqueue(client:PoolClient,reference:IntegrationCommandReference,operation:IntegrationCommandOperation,secrets:IntegrationCommandSecret,requestedBy:string):Promise<void>;
  supersede(client:PoolClient,reference:IntegrationCommandReference):Promise<void>;
}
export interface PostgresRegistryOptions {
  database:ApplicationDatabase; organizationId:string; environment?:Environment; commands?:IntegrationCommandTransactions;
}
export async function ensureRegistrySchema(database:ApplicationDatabase){
  await database.ready();
  await database.transaction(async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:integrations:schema',0))");
    await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_integration_bindings (
      namespace text PRIMARY KEY, organization_id text NOT NULL, environment text NOT NULL);
      CREATE TABLE IF NOT EXISTS opencrawl_integrations (
      namespace text NOT NULL, environment text NOT NULL, tenant_id text NOT NULL, user_id text NOT NULL,
      integration_id text NOT NULL, provider text NOT NULL, status text NOT NULL, revision bigint NOT NULL DEFAULT 1,
      record jsonb NOT NULL, PRIMARY KEY(namespace,environment,tenant_id,integration_id),
      CHECK(record->>'tenantId'=tenant_id),CHECK(record->>'userId'=user_id),
      CHECK(record->>'integrationId'=integration_id),CHECK(record->>'environment'=environment),
      CHECK(record->>'provider'=provider),CHECK(record->>'status'=status));
      CREATE INDEX IF NOT EXISTS opencrawl_integrations_owner ON opencrawl_integrations(namespace,environment,tenant_id,user_id)`);
  });
}

/** Historical export path retained; runtime state is PostgreSQL only. One registry
 * is bound to the installation namespace, organization and environment. */
export function createSingleOrganizationRegistry({database,organizationId,environment='selfhost',commands}:PostgresRegistryOptions){
  if(!database||!/^org_[A-Za-z0-9]+$/.test(organizationId))throw new Error('Configure one organization and its application database');
  let prepared:Promise<void>|undefined;
  async function ready(){
    prepared??=(async()=>{
      await ensureRegistrySchema(database);
      await database.pool.query('INSERT INTO opencrawl_integration_bindings(namespace,organization_id,environment) VALUES($1,$2,$3) ON CONFLICT(namespace) DO NOTHING',[database.namespace,organizationId,environment]);
      const {rows}=await database.pool.query('SELECT organization_id,environment FROM opencrawl_integration_bindings WHERE namespace=$1',[database.namespace]);
      if(rows[0]?.organization_id!==organizationId||rows[0]?.environment!==environment)throw new Error('Registry belongs to another organization or environment');
    })().catch(error=>{prepared=undefined;throw error;});
    return prepared;
  }
  const scope=(tenantId:string,userId?:string)=>{if(tenantId!==organizationId||userId!==undefined&&!/^user_[A-Za-z0-9]+$/.test(userId))throw denied();};
  const validate=(record:IntegrationRecord)=>{
    scope(record.tenantId,record.userId);
    if(record.environment!==environment||!/^int_[a-f0-9]{26}$/.test(record.integrationId)||!(/^[a-z]+$/).test(record.provider))throw denied();
    return record;
  };
  const decode=(value:unknown):IntegrationRecord=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid integration record');return validate(value as IntegrationRecord);};
  const key=(identity:Pick<IntegrationRecord,'tenantId'|'userId'|'integrationId'>)=>[database.namespace,environment,identity.tenantId,identity.userId,identity.integrationId];
  async function locked(client:PoolClient,identity:Pick<IntegrationRecord,'tenantId'|'userId'|'integrationId'>){
    scope(identity.tenantId,identity.userId);
    const {rows}=await client.query('SELECT record FROM opencrawl_integrations WHERE namespace=$1 AND environment=$2 AND tenant_id=$3 AND user_id=$4 AND integration_id=$5 FOR UPDATE',key(identity));
    return rows[0]?decode(rows[0].record):null;
  }
  async function save(client:PoolClient,record:IntegrationRecord){
    const next=validate({...record,updatedAt:new Date().toISOString()});
    await client.query('UPDATE opencrawl_integrations SET record=$6::jsonb,provider=$7,status=$8,revision=revision+1 WHERE namespace=$1 AND environment=$2 AND tenant_id=$3 AND user_id=$4 AND integration_id=$5',[...key(record),JSON.stringify(next),next.provider,next.status]);
    return next;
  }
  async function claimProvider(client:PoolClient,record:IntegrationRecord){
    const owner=record.scope==='team'?'team':record.userId;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([database.namespace,environment,record.tenantId,record.provider,owner])]);
    const {rowCount}=await client.query(`SELECT 1 FROM opencrawl_integrations WHERE namespace=$1 AND environment=$2 AND tenant_id=$3 AND provider=$4
      AND integration_id<>$5 AND status NOT IN ('connecting','disconnected','abandoned')
      AND CASE WHEN record->>'scope'='team' THEN 'team' ELSE user_id END=$6 LIMIT 1`,[database.namespace,environment,record.tenantId,record.provider,record.integrationId,owner]);
    if(rowCount)throw conflict();
  }
  function validateCommand(operation:IntegrationCommandOperation,secrets:IntegrationCommandSecret,requestedBy?:string){
    if(!commands)throw new Error('Integration workflow commands are not configured');
    if(!requestedBy||!/^user_[A-Za-z0-9]+$/.test(requestedBy))throw denied();
    if(!['consent','provision','disconnect','sync'].includes(operation))throw new Error('Unknown integration operation');
    if(Object.keys(secrets).some(field=>field!=='apiKey')||secrets.apiKey!==undefined&&(typeof secrets.apiKey!=='string'||!secrets.apiKey||secrets.apiKey.length>65536))throw new Error('Invalid integration command secret');
    if(operation!=='provision'&&secrets.apiKey!==undefined)throw new Error('Only provisioning accepts an API key');
    return {commands,requestedBy};
  }
  const registry:IntegrationRegistry={
    async list(tenantId,userId){scope(tenantId,userId);await ready();return (await database.pool.query('SELECT record FROM opencrawl_integrations WHERE namespace=$1 AND environment=$2 AND tenant_id=$3 AND user_id=$4 ORDER BY integration_id',[database.namespace,environment,tenantId,userId])).rows.map(row=>decode(row.record));},
    async listTenant(tenantId){scope(tenantId);await ready();return (await database.pool.query('SELECT record FROM opencrawl_integrations WHERE namespace=$1 AND environment=$2 AND tenant_id=$3 ORDER BY integration_id',[database.namespace,environment,tenantId])).rows.map(row=>decode(row.record));},
    async get(tenantId,userId,integrationId){scope(tenantId,userId);await ready();const {rows}=await database.pool.query('SELECT record FROM opencrawl_integrations WHERE namespace=$1 AND environment=$2 AND tenant_id=$3 AND user_id=$4 AND integration_id=$5',key({tenantId,userId,integrationId}));return rows[0]?decode(rows[0].record):null;},
    async create(record){validate(record);await ready();
      const {rowCount}=await database.pool.query('INSERT INTO opencrawl_integrations(namespace,environment,tenant_id,user_id,integration_id,provider,status,record) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING',[...key(record),record.provider,record.status,JSON.stringify(record)]);
      if(!rowCount)throw conflict();return decode(structuredClone(record));
    },
    async update(identity,fields,options:UpdateOptions={}){
      scope(identity.tenantId,identity.userId);
      for(const field of ['tenantId','userId','integrationId'] as const)if(fields[field]!==undefined&&fields[field]!==identity[field])throw denied();
      if(fields.environment!==undefined&&fields.environment!==environment)throw denied();
      await ready();return database.transaction(async client=>{
        const current=await locked(client,identity);
        if(!current||options.whenStatus&&!options.whenStatus.includes(current.status)||Object.entries(options.whenFields??{}).some(([field,expected])=>!isDeepStrictEqual((current as unknown as Record<string,unknown>)[field],expected)))throw conflict();
        return save(client,{...current,...fields});
      });
    },
  };
  async function requestLifecycle(identity:Pick<IntegrationRecord,'tenantId'|'userId'|'integrationId'>,operation:IntegrationCommandOperation,secrets:IntegrationCommandSecret={},requestedBy?:string):Promise<IntegrationCommandReference>{
    scope(identity.tenantId,identity.userId);
    const checked=validateCommand(operation,secrets,requestedBy);
    await ready();return database.transaction(async client=>{
      const record=await locked(client,identity);if(!record)throw conflict();
      const reference=(commandId:string):IntegrationCommandReference=>({environment,tenantId:record!.tenantId,userId:record!.userId,integrationId:record!.integrationId,commandId});
      const prior=record!.lifecycleCommandId?await checked.commands.read(client,reference(record!.lifecycleCommandId)):null;
      if(operation==='consent'&&record!.status!=='connecting')throw conflict();
      if(prior?.operation===operation&&prior.status==='pending')return prior.reference;
      if(operation==='disconnect'&&record!.status==='disconnected'&&prior?.operation==='disconnect')return prior.reference;
      if(record!.status==='disconnected'||record!.status==='disconnecting'&&operation!=='disconnect')throw conflict();
      if(operation==='provision'&&!(record!.status==='connecting'||record!.status==='provisioning'||record!.status==='error'&&['setup','recovery','reconnect'].includes(record!.error||'')))throw conflict();
      if(operation==='sync'&&(!record!.airbyte?.connectionId||!(record!.status==='active'||record!.status==='error'&&!['setup','recovery','reconnect'].includes(record!.error||''))))throw conflict();
      if(prior?.status==='pending'){
        if(operation!=='disconnect'&&!(operation==='provision'&&prior.operation==='consent'))throw conflict();
        await checked.commands.supersede(client,prior.reference);
      }
      if(operation==='provision')await claimProvider(client,record!);
      const ref=reference(randomUUID());
      await save(client,{...record!,status:operation==='disconnect'?'disconnecting':operation==='provision'?'provisioning':record!.status,lifecycleCommandId:ref.commandId,lifecycleOperation:operation});
      await checked.commands.enqueue(client,ref,operation,secrets,checked.requestedBy);
      return ref;
    });
  }
  async function createWithLifecycle(record:IntegrationRecord,operation:IntegrationCommandOperation,secrets:IntegrationCommandSecret={},requestedBy?:string):Promise<IntegrationCommandReference>{
    validate(record);const checked=validateCommand(operation,secrets,requestedBy);
    if(record.lifecycleCommandId||!(operation==='consent'&&record.status==='connecting'||operation==='provision'&&['connecting','provisioning'].includes(record.status)))throw conflict();
    await ready();return database.transaction(async client=>{
      if(operation==='provision')await claimProvider(client,record);
      const reference={environment,tenantId:record.tenantId,userId:record.userId,integrationId:record.integrationId,commandId:randomUUID()};
      const next={...record,status:operation==='consent'?'connecting' as const:'provisioning' as const,lifecycleCommandId:reference.commandId,lifecycleOperation:operation,updatedAt:new Date().toISOString()};
      const {rowCount}=await client.query('INSERT INTO opencrawl_integrations(namespace,environment,tenant_id,user_id,integration_id,provider,status,record) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING',[...key(next),next.provider,next.status,JSON.stringify(next)]);
      if(!rowCount)throw conflict();
      await checked.commands.enqueue(client,reference,operation,secrets,checked.requestedBy);return reference;
    });
  }
  async function abandonWithLifecycle(identity:Pick<IntegrationRecord,'tenantId'|'userId'|'integrationId'>,requestedBy?:string):Promise<IntegrationCommandReference>{
    scope(identity.tenantId,identity.userId);const checked=validateCommand('disconnect',{},requestedBy);
    await ready();return database.transaction(async client=>{
      const record=await locked(client,identity);if(!record)throw conflict();
      const consentError=record.status==='error'&&record.lifecycleOperation==='consent'&&!record.provisionIntent&&!Object.values(record.airbyte??{}).some(Boolean);
      if(!['connecting','abandoned'].includes(record.status)&&!consentError)throw conflict();
      const reference=(commandId:string):IntegrationCommandReference=>({environment,tenantId:record.tenantId,userId:record.userId,integrationId:record.integrationId,commandId});
      const prior=record.lifecycleCommandId?await checked.commands.read(client,reference(record.lifecycleCommandId)):null;
      if(record.status==='abandoned'&&prior?.operation==='disconnect'&&prior.status==='pending')return prior.reference;
      if(prior?.status==='pending')await checked.commands.supersede(client,prior.reference);
      const ref=reference(randomUUID());
      await save(client,{...record,status:'abandoned',lifecycleCommandId:ref.commandId,lifecycleOperation:'disconnect'});
      await checked.commands.enqueue(client,ref,'disconnect',{},checked.requestedBy);return ref;
    });
  }
  return {...registry,requestLifecycle,createWithLifecycle,abandonWithLifecycle,ready,close:()=>{}};
}
