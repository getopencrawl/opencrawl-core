import {randomBytes} from 'node:crypto';
import type {ApplicationDatabase} from './postgres.mjs';
import type {Environment} from '../integrations/types.mjs';
export interface IntegrationResourceKey {kind:'airbyte-definition'|'airbyte-manifest'|'oauth-auth-config';scope:string;name:string;fingerprint:string}
export interface IntegrationResource {id:string;fingerprint:string}
export interface IntegrationResources {
 ensure(key:IntegrationResourceKey,operations:{find():Promise<IntegrationResource|null>;create():Promise<string>}):Promise<string>;
}
const pending=()=>Object.assign(new Error('Shared provider resource is waiting for positive reconciliation'),{code:'ProvisioningRecoveryPending',status:503});
const valid=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\x00-\x1f\x7f]/.test(value);
interface Saved {attempt_id:string;fingerprint:string;resource_id:string|null;status:'pending'|'resolved'}
/** Shared definitions/configurations have one durable create/update claim across
 * all connection commands. No network call runs while holding a SQL transaction. */
export function createIntegrationResources({database,environment}:{database:ApplicationDatabase;environment:Environment}):IntegrationResources&{ready():Promise<void>}{
 if(!['selfhost','production','staging'].includes(environment))throw new Error('Explicit integration resource environment required');
 let preparing:Promise<void>|undefined;
 function params(key:IntegrationResourceKey){
  if(!['airbyte-definition','airbyte-manifest','oauth-auth-config'].includes(key.kind)||![key.scope,key.name].every(valid)||!/^[a-f0-9]{64}$/.test(key.fingerprint))throw new Error('Invalid shared integration resource scope');
  return [database.namespace,environment,key.kind,key.scope,key.name];
 }
 const where='namespace=$1 AND environment=$2 AND kind=$3 AND scope=$4 AND name=$5';
 async function read(key:IntegrationResourceKey){return (await database.pool.query<Saved>(`SELECT attempt_id,fingerprint,resource_id,status FROM opencrawl_integration_resources WHERE ${where}`,params(key))).rows[0];}
 async function settle(key:IntegrationResourceKey,claim:Saved,id:string){
  if(!valid(id)||claim.resource_id&&claim.resource_id!==id)throw pending();
  const changed=await database.pool.query(`UPDATE opencrawl_integration_resources SET status='resolved',resource_id=$7,settled_at=now() WHERE ${where} AND attempt_id=$6 AND status='pending'`,[...params(key),claim.attempt_id,id]);
  if(!changed.rowCount){const current=await read(key);if(current?.attempt_id!==claim.attempt_id||current.resource_id!==id||current.status!=='resolved')throw pending();}
  return id;
 }
 return {
  async ready(){preparing??=database.transaction(async client=>{await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:integration-resources:schema',0))");await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_integration_resources(
   namespace text NOT NULL,environment text NOT NULL,kind text NOT NULL CHECK(kind IN ('airbyte-definition','airbyte-manifest','oauth-auth-config')),scope text NOT NULL,name text NOT NULL,
   fingerprint text NOT NULL,attempt_id text NOT NULL,resource_id text,status text NOT NULL CHECK(status IN ('pending','resolved')),requested_at timestamptz NOT NULL DEFAULT now(),settled_at timestamptz,
   PRIMARY KEY(namespace,environment,kind,scope,name))`);}).catch(error=>{preparing=undefined;throw error;});await preparing;},
  async ensure(key,{find,create}){
   const values=params(key),observed=await find();
   if(observed&&(!valid(observed.id)||!/^[a-f0-9]{64}$/.test(observed.fingerprint)))throw pending();
   const claim=await database.transaction(async client=>{
    // A per-resource lock also protects the initially absent row. It is held only
    // for admission, never across provider network calls.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['opencrawl:shared-resource',...values])]);
    let saved=(await client.query<Saved>(`SELECT attempt_id,fingerprint,resource_id,status FROM opencrawl_integration_resources WHERE ${where} FOR UPDATE`,values)).rows[0];
    if(saved?.status==='pending')return {saved,create:false};
    if(saved?.status==='resolved'&&saved.fingerprint===key.fingerprint)return {saved,create:false};
    // Only a manifest can replace a resolved resource version. Definition/config
    // keys are immutable identities; drift cannot silently allocate another one.
    if(saved&&(key.kind!=='airbyte-manifest'||!observed||observed.id!==saved.resource_id))throw pending();
    const attempt=randomBytes(16).toString('hex'),adopt=observed?.fingerprint===key.fingerprint;
    saved={attempt_id:attempt,fingerprint:key.fingerprint,resource_id:observed?.id??null,status:adopt?'resolved':'pending'};
    await client.query(`INSERT INTO opencrawl_integration_resources(namespace,environment,kind,scope,name,fingerprint,attempt_id,resource_id,status,settled_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $9='resolved' THEN now() ELSE NULL END)
      ON CONFLICT(namespace,environment,kind,scope,name) DO UPDATE SET fingerprint=EXCLUDED.fingerprint,attempt_id=EXCLUDED.attempt_id,resource_id=EXCLUDED.resource_id,status=EXCLUDED.status,requested_at=now(),settled_at=EXCLUDED.settled_at`,
      [...values,key.fingerprint,attempt,saved.resource_id,saved.status]);
    return {saved,create:!adopt};
   });
   if(claim.saved.status==='resolved'){
    if(!observed||observed.id!==claim.saved.resource_id||observed.fingerprint!==claim.saved.fingerprint)throw pending();return observed.id;
   }
   if(!claim.create){
    // Any caller can settle an older version, but it cannot mistake that result
    // for the version this caller requested. The next activity retries its update.
    if(!observed||observed.fingerprint!==claim.saved.fingerprint)throw pending();
    const id=await settle(key,claim.saved,observed.id);if(claim.saved.fingerprint!==key.fingerprint)throw pending();return id;
   }
   const id=await create();return settle(key,claim.saved,id);
  },
 };
}
