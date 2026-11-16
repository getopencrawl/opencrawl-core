import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {PoolClient} from 'pg';
import type {Environment,IntegrationRecord} from '../integrations/types.mjs';
import type {IntegrationCommandOperation,IntegrationCommandReference} from '../integrations/temporal/types.mjs';
import type {TransactionalIntegrationCommands} from './integration-commands.mjs';
import {digest} from '../connectors/scope.mjs';

export interface LifecycleMigrationOptions {
 client:PoolClient;namespace:string;environment:Environment;organizationId:string;
 records:IntegrationRecord[];commands:TransactionalIntegrationCommands;
}
export interface LifecycleMigrationReport {
 provision:number;disconnect:number;awaitingConsent:number;reconnectRequired:number;preserved:number;
 commands:IntegrationCommandReference[];
}
/** Existing requested deletion remains authorized after actor revocation. Setup
 * only names its original owner as a candidate; activities revalidate current
 * membership/role before every side effect. Consent-pending rows are untouched. */
function operation(record:IntegrationRecord):IntegrationCommandOperation|null {
 if(record.status==='disconnecting'||record.status==='disconnected'||record.status==='abandoned'&&(record.connectedAccountId||record.oauthIntent))return 'disconnect';
 if(record.status==='provisioning'||record.status==='error'&&['setup','recovery'].includes(record.error||''))return 'provision';
 return null;
}
export function migratedIntegrationCommand(namespace:string,record:IntegrationRecord,op:IntegrationCommandOperation):IntegrationCommandReference {
 if(!namespace||!['production','staging','selfhost'].includes(record.environment)||!/^org_[A-Za-z0-9]+$/.test(record.tenantId)||!/^user_[A-Za-z0-9]+$/.test(record.userId)||!/^int_[a-f0-9]{26}$/.test(record.integrationId))throw new Error('Invalid legacy lifecycle scope');
 const commandId='migration_'+createHash('sha256').update(JSON.stringify(['integration-lifecycle-migration-v1',namespace,record.environment,record.tenantId,record.userId,record.integrationId,op])).digest('hex');
 return {environment:record.environment,tenantId:record.tenantId,userId:record.userId,integrationId:record.integrationId,commandId};
}
const key=(options:LifecycleMigrationOptions,record:IntegrationRecord)=>[options.namespace,options.environment,record.tenantId,record.userId,record.integrationId];
const nextRecord=(record:IntegrationRecord,op:IntegrationCommandOperation,reference:IntegrationCommandReference):IntegrationRecord=>({...record,
 status:op==='disconnect'?record.status==='abandoned'?'abandoned':'disconnecting':'provisioning',lifecycleOperation:op,lifecycleCommandId:reference.commandId});
const report=():LifecycleMigrationReport=>({provision:0,disconnect:0,awaitingConsent:0,reconnectRequired:0,preserved:0,commands:[]});
function validate(options:LifecycleMigrationOptions,record:IntegrationRecord){
 if(record.environment!==options.environment||record.tenantId!==options.organizationId)throw new Error('Legacy integration belongs to another installation');
 migratedIntegrationCommand(options.namespace,record,'provision');
}
function count(result:LifecycleMigrationReport,record:IntegrationRecord,op:IntegrationCommandOperation|null,reference?:IntegrationCommandReference){
 if(op&&reference){result[op==='provision'?'provision':'disconnect']++;result.commands.push(reference);}
 else if(record.status==='connecting')result.awaitingConsent++;
 else if(record.status==='error'&&record.error==='reconnect')result.reconnectRequired++;
 else result.preserved++;
}

/** Caller owns one transaction, after exact legacy import verification. Do not
 * COMMIT this transition separately from changing installation state to ready. */
export async function finalizeIntegrationLifecycles(options:LifecycleMigrationOptions):Promise<LifecycleMigrationReport>{
 const result=report();
 for(const original of options.records){
  validate(options,original);const op=operation(original),params=key(options,original);
  const {rows}=await options.client.query('SELECT record FROM opencrawl_integrations WHERE namespace=$1 AND environment=$2 AND tenant_id=$3 AND user_id=$4 AND integration_id=$5 FOR UPDATE',params);
  if(!rows[0])throw new Error('Legacy lifecycle target is missing');
  if(original.lifecycleCommandId){
   const reference={environment:original.environment,tenantId:original.tenantId,userId:original.userId,integrationId:original.integrationId,commandId:original.lifecycleCommandId};
   const existing=await options.commands.read(options.client,reference);
   if(!existing||!isDeepStrictEqual(rows[0].record,original))throw new Error('Existing lifecycle marker is missing its preserved command backing');
   result.preserved++;continue;
  }
  if(!op){if(!isDeepStrictEqual(rows[0].record,original))throw new Error('Legacy lifecycle target differs before transition');count(result,original,null);continue;}
  const reference=migratedIntegrationCommand(options.namespace,original,op),next=nextRecord(original,op,reference);
  if(!isDeepStrictEqual(rows[0].record,original)&&!isDeepStrictEqual(rows[0].record,next))throw new Error('Legacy lifecycle target differs before transition');
  await options.commands.enqueue(options.client,reference,op,{},original.userId);
  const command=await options.commands.read(options.client,reference);
  if(!command||command.status!=='pending'||command.operation!==op||command.requestedBy!==original.userId)throw new Error('Migrated lifecycle command differs from its requested work');
  if(!isDeepStrictEqual(rows[0].record,next))await options.client.query('UPDATE opencrawl_integrations SET record=$6::jsonb,status=$7,revision=revision+1 WHERE namespace=$1 AND environment=$2 AND tenant_id=$3 AND user_id=$4 AND integration_id=$5',[...params,JSON.stringify(next),next.status]);
  if(op==='disconnect'){
   const fenceKey='control/connectors/write-barriers/v1/'+digest([options.environment,original.tenantId,original.integrationId])+'.json';
   await options.client.query(`INSERT INTO opencrawl_write_fences(namespace,fence_key,barrier_namespace,tenant_id,resource_id,closed_at)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(namespace,fence_key) DO UPDATE SET closed_at=COALESCE(opencrawl_write_fences.closed_at,EXCLUDED.closed_at)`,[options.namespace,fenceKey,options.environment,original.tenantId,original.integrationId,Date.now()]);
  }
  count(result,original,op,reference);
 }
 await verifyIntegrationLifecycles(options);
 return result;
}

/** Independent final readback inside the same readiness transaction. */
export async function verifyIntegrationLifecycles(options:LifecycleMigrationOptions):Promise<LifecycleMigrationReport>{
 const result=report();
 for(const original of options.records){
  validate(options,original);const op=original.lifecycleCommandId?null:operation(original),reference=op?migratedIntegrationCommand(options.namespace,original,op):undefined;
  const expected=op&&reference?nextRecord(original,op,reference):original;
  const {rows}=await options.client.query('SELECT record FROM opencrawl_integrations WHERE namespace=$1 AND environment=$2 AND tenant_id=$3 AND user_id=$4 AND integration_id=$5',key(options,original));
  if(!isDeepStrictEqual(rows[0]?.record,expected))throw new Error('Migrated lifecycle readback differs');
  if(op&&reference){
   const command=await options.commands.read(options.client,reference);
   if(!command||command.status!=='pending'||command.operation!==op||command.requestedBy!==original.userId)throw new Error('Migrated lifecycle command readback differs');
   if(op==='disconnect'){
    const fenceKey='control/connectors/write-barriers/v1/'+digest([options.environment,original.tenantId,original.integrationId])+'.json';
    const fence=await options.client.query('SELECT closed_at,barrier_namespace,tenant_id,resource_id FROM opencrawl_write_fences WHERE namespace=$1 AND fence_key=$2',[options.namespace,fenceKey]);
    if(fence.rows[0]?.closed_at==null||fence.rows[0].barrier_namespace!==options.environment||fence.rows[0].tenant_id!==original.tenantId||fence.rows[0].resource_id!==original.integrationId)throw new Error('Migrated deletion admission is not closed');
   }
  }
  count(result,original,op,reference);
 }
 return result;
}
