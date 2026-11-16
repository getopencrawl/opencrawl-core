import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {createBoundObjectMigration,onlineProjectionValue,type BoundObjectMigrationOptions} from './object-migration.mjs';
import type {OnlineIntent} from './online-journal.mjs';

/** Typed shadow projection only. This module never makes an installation ready.
 * Its caller supplies the journal/backfill transaction's real PoolClient. */
function fail(message:string):never{throw Object.assign(new Error('Online projection: '+message),{code:'ONLINE_PROJECTION_CONFLICT'});}
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
function canonical(value:unknown):unknown{
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value;
 if(Buffer.isBuffer(value))return ['bytes',value.toString('base64')];
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item)]));
 return fail('unsupported target value');
}
export const onlineProjectionHash=(value:unknown)=>hash(JSON.stringify(canonical(value)));
function revision(value:string){if(!/^(0|[1-9][0-9]*)$/.test(value)||BigInt(value)>9223372036854775807n)fail('invalid source revision');}
function bounded(value:string,max:number){if(typeof value!=='string'||!value||value.includes('\0')||Buffer.byteLength(value)>max)fail('invalid source binding');}
export interface OnlineTenantEnrollmentRequest {tenantId:string;evidence:unknown}
export function createOnlineProjection({epoch,sourceId,journalBinding,enrollment,...options}:BoundObjectMigrationOptions&{
 epoch:string;sourceId:string;enrollment:{verifierId:string;initialReceiptHash:string;verify(request:OnlineTenantEnrollmentRequest):Promise<{tenantId:string;receiptHash:string}>};journalBinding:Readonly<{namespace:string;epoch:string;sourceId:string}>;
}){
 const {database}=options,namespace=database.namespace;bounded(sourceId,2048);bounded(enrollment.verifierId,512);if(!/^[a-f0-9]{64}$/.test(enrollment.initialReceiptHash)||typeof enrollment.verify!=='function')fail('invalid tenant enrollment verifier');
 const verifyEnrollment=enrollment.verify,verifierId=enrollment.verifierId,initialReceiptHash=enrollment.initialReceiptHash;if(!uuid.test(epoch))fail('invalid epoch');
 if(journalBinding.namespace!==namespace||journalBinding.epoch!==epoch||journalBinding.sourceId!==sourceId)fail('journal binding differs from projection');
 const initialTenants=Object.freeze([...options.tenantIds]),retiredTenantHashes=Object.freeze([...(options.retiredTenantHashes??[])]);
 const object=createBoundObjectMigration({...options,tenantIds:initialTenants,retiredTenantHashes}),scope=[namespace,epoch,sourceId];
 const bindingHash=onlineProjectionHash({bucket:options.store.bucket,prefix:options.prefix,purpose:options.credentialPurpose??'capture',tenantIds:[...initialTenants].sort(),retiredTenantHashes:[...retiredTenantHashes].sort(),verifierId,initialReceiptHash});
 let preparing:Promise<void>|undefined,enrollmentRevision:string|undefined,enrolledTenants:readonly string[]=[];
 async function ready(){
  preparing??=(async()=>{
   await object.ready();await object.prepareOnline();
   await database.transaction(async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:online-projection:schema',0))");
    await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_online_projection_namespaces(namespace text PRIMARY KEY,epoch uuid NOT NULL);
      CREATE TABLE IF NOT EXISTS opencrawl_online_projection_bindings(namespace text NOT NULL,epoch uuid NOT NULL,source_id text NOT NULL,binding_hash text NOT NULL CHECK(binding_hash~'^[a-f0-9]{64}$'),enrollment_revision bigint NOT NULL DEFAULT 0 CHECK(enrollment_revision>=0 AND enrollment_revision<=100000),PRIMARY KEY(namespace,epoch,source_id));
      CREATE TABLE IF NOT EXISTS opencrawl_online_projection_tenants(namespace text NOT NULL,epoch uuid NOT NULL,source_id text NOT NULL,tenant_id text NOT NULL,tenant_hash text NOT NULL CHECK(tenant_hash~'^[a-f0-9]{64}$'),receipt_hash text NOT NULL CHECK(receipt_hash~'^[a-f0-9]{64}$'),PRIMARY KEY(namespace,epoch,source_id,tenant_id),UNIQUE(namespace,epoch,source_id,tenant_hash));
      CREATE TABLE IF NOT EXISTS opencrawl_online_projection_heads(namespace text NOT NULL,epoch uuid NOT NULL,target_key text COLLATE "C" NOT NULL,source_id text NOT NULL,source_key text COLLATE "C" NOT NULL,domain text NOT NULL,revision bigint NOT NULL CHECK(revision>=0),operation_id uuid,source_version text NOT NULL,content_hash text NOT NULL CHECK(content_hash~'^[a-f0-9]{64}$'),target_hash text NOT NULL CHECK(target_hash~'^[a-f0-9]{64}$'),deleted boolean NOT NULL,
      PRIMARY KEY(namespace,epoch,target_key),UNIQUE(namespace,epoch,source_id,source_key),CHECK((revision=0 AND operation_id IS NULL) OR (revision>0 AND operation_id IS NOT NULL)))`);
    await client.query('INSERT INTO opencrawl_online_projection_namespaces VALUES($1,$2) ON CONFLICT DO NOTHING',[namespace,epoch]);await assertEpoch(client);
    await client.query('INSERT INTO opencrawl_online_projection_bindings(namespace,epoch,source_id,binding_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[...scope,bindingHash]);
    const actual=(await client.query('SELECT binding_hash FROM opencrawl_online_projection_bindings WHERE namespace=$1 AND epoch=$2 AND source_id=$3',scope)).rows[0];if(actual?.binding_hash!==bindingHash)fail('reviewed source binding changed');
    for(const tenantId of initialTenants)await insertEnrollment(client,tenantId,initialReceiptHash);
   });
  })();try{await preparing;}catch(error){preparing=undefined;throw error;}
 }
 async function assertEpoch(client:PoolClient){const row=(await client.query('SELECT epoch FROM opencrawl_online_projection_namespaces WHERE namespace=$1 FOR SHARE',[namespace])).rows[0];if(row?.epoch!==epoch)fail('namespace is owned by a different projection epoch');}
 async function insertEnrollment(client:PoolClient,tenantId:string,receiptHash:string){
  await assertEpoch(client);
  const row=(await client.query('SELECT binding_hash FROM opencrawl_online_projection_bindings WHERE namespace=$1 AND epoch=$2 AND source_id=$3 FOR UPDATE',scope)).rows[0];if(row?.binding_hash!==bindingHash)fail('source binding changed');
  const prior=(await client.query('SELECT tenant_hash,receipt_hash FROM opencrawl_online_projection_tenants WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND tenant_id=$4',[...scope,tenantId])).rows[0];
  if(prior){if(prior.tenant_hash!==hash(tenantId))fail('tenant identity changed');return {enrolled:false,receiptHash:prior.receipt_hash as string};}
  await client.query('INSERT INTO opencrawl_online_projection_tenants VALUES($1,$2,$3,$4,$5,$6)',[...scope,tenantId,hash(tenantId),receiptHash]);
  await client.query('UPDATE opencrawl_online_projection_bindings SET enrollment_revision=enrollment_revision+1 WHERE namespace=$1 AND epoch=$2 AND source_id=$3',scope);return {enrolled:true,receiptHash};
 }
 async function enrollTenant(request:OnlineTenantEnrollmentRequest){
  if(!request||typeof request.tenantId!=='string'||request.tenantId.length>200||!/^(?:org_[A-Za-z0-9]+|personal:user_[A-Za-z0-9]+)$/.test(request.tenantId)||retiredTenantHashes.includes(hash(request.tenantId)))fail('invalid tenant enrollment');
  const serialized=JSON.stringify(request);if(!serialized||Buffer.byteLength(serialized)>65536)fail('tenant enrollment evidence exceeds bound');
  const frozen=JSON.parse(serialized) as OnlineTenantEnrollmentRequest,tenantId=frozen.tenantId;
  const verified=await verifyEnrollment(frozen);if(verified.tenantId!==tenantId||!/^[a-f0-9]{64}$/.test(verified.receiptHash))fail('tenant enrollment verifier mismatch');
  return database.transaction(client=>insertEnrollment(client,tenantId,verified.receiptHash));
 }
 async function enrolled(client:PoolClient){
  await assertEpoch(client);
  const bound=(await client.query('SELECT binding_hash,enrollment_revision::text FROM opencrawl_online_projection_bindings WHERE namespace=$1 AND epoch=$2 AND source_id=$3',scope)).rows[0];if(bound?.binding_hash!==bindingHash)fail('projection is not prepared for this source');
  if(enrollmentRevision!==bound.enrollment_revision){
   const rows=(await client.query('SELECT tenant_id,tenant_hash FROM opencrawl_online_projection_tenants WHERE namespace=$1 AND epoch=$2 AND source_id=$3 ORDER BY tenant_id LIMIT 100001',scope)).rows;
   if(rows.length>100000||rows.length!==Number(bound.enrollment_revision)||rows.some(row=>row.tenant_hash!==hash(row.tenant_id)))fail('tenant enrollment coverage changed');
   enrolledTenants=Object.freeze(rows.map(row=>String(row.tenant_id)));enrollmentRevision=bound.enrollment_revision;
  }
  return enrolledTenants;
 }
 async function project(client:PoolClient,input:{key:string;bytes:Buffer|null;revision:string;operationId:string|null;version:string}){
  bounded(input.key,8192);bounded(input.version,2048);revision(input.revision);
  if(input.revision==='0'?input.operationId!==null:input.operationId===null||!uuid.test(input.operationId))fail('invalid source operation');
  // Freeze decode input before the first SQL await; callbacks cannot redirect it.
  const key=input.key,version=input.version,rev=input.revision,operationId=input.operationId,bytes=input.bytes===null?null:Buffer.from(input.bytes);
  const decoded=object.decodeOnline(key,bytes,await enrolled(client)),targetKey=JSON.stringify([decoded.domain,...decoded.identity]);bounded(targetKey,8192);
  const value=onlineProjectionValue(decoded),contentHash=bytes===null?hash('deleted'):hash(bytes),targetHash=onlineProjectionHash(value);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['online-projection',namespace,targetKey])]);
  const prior=(await client.query('SELECT source_id,source_key,domain,revision,operation_id,source_version,content_hash,target_hash,deleted FROM opencrawl_online_projection_heads WHERE namespace=$1 AND epoch=$2 AND target_key=$3 FOR UPDATE',[namespace,epoch,targetKey])).rows[0];
  if(prior&&(prior.source_id!==sourceId||prior.source_key!==key||prior.domain!==decoded.domain))fail('canonical target has a different source publisher');
  const current=await object.readOnlineIn(client,decoded),currentHash=onlineProjectionHash(current);
  if(prior){
   if(prior.deleted&&bytes!==null&&['capture-credentials','connector-grants','replicas-connections','replicas-setup'].includes(decoded.domain))fail('deleted security identity cannot be reused');
   revision(prior.revision);if(currentHash!==prior.target_hash)fail('typed target changed outside its source projection');
   if(BigInt(prior.revision)>BigInt(rev))fail('stale projection revision');
   if(prior.revision===rev){if(prior.operation_id!==operationId||prior.source_version!==version||prior.content_hash!==contentHash||prior.target_hash!==targetHash||prior.deleted!==(bytes===null))fail('source revision was reused');return;}
  }else if(current!==null&&currentHash!==targetHash)fail('initial typed target conflicts with source');
  // Domain owners retain privacy/revocation/held-operation invariants even when
  // the current target is absent. Unsupported deletions never silently pass.
  await object.projectOnlineIn(client,decoded);
  if(onlineProjectionHash(await object.readOnlineIn(client,decoded))!==targetHash)fail('typed readback differs from source');
  await client.query(`INSERT INTO opencrawl_online_projection_heads(namespace,epoch,target_key,source_id,source_key,domain,revision,operation_id,source_version,content_hash,target_hash,deleted) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT(namespace,epoch,target_key) DO UPDATE SET revision=EXCLUDED.revision,operation_id=EXCLUDED.operation_id,source_version=EXCLUDED.source_version,content_hash=EXCLUDED.content_hash,target_hash=EXCLUDED.target_hash,deleted=EXCLUDED.deleted`,[namespace,epoch,targetKey,sourceId,key,decoded.domain,rev,operationId,version,contentHash,targetHash,bytes===null]);
 }
 async function apply(client:PoolClient,intent:OnlineIntent){
  if(intent.namespace!==namespace||intent.epoch!==epoch||intent.sourceId!==sourceId||intent.state!=='applied'||!intent.resultVersion)fail('journal intent is not applied in this source binding');
  if(intent.revision==='0')fail('journal revision cannot be baseline');
  await project(client,{key:intent.key,bytes:intent.mutation.kind==='put'?intent.mutation.bytes:null,revision:intent.revision,operationId:intent.operationId,version:intent.resultVersion});
 }
 async function backfill(client:PoolClient,input:{key:string;bytes:Buffer;version:string}){await project(client,{...input,revision:'0',operationId:null});}
 return {binding:Object.freeze({namespace,epoch,sourceId,bindingHash}),ready,apply,backfill,enrollTenant};
}
