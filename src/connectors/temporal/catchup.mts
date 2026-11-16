import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Client} from '@temporalio/client';
import type {ApplicationDatabase} from '../../state/postgres.mjs';
import {requireApplicationStateReady} from '../../state/postgres.mjs';
import {createConnectorCacheRetirements} from '../../state/connector-cache-retirements.mjs';
import {digest,validateBinding} from '../scope.mjs';
import type {ConnectorBinding} from '../types.mjs';
import type {ConnectionReference} from './types.mjs';
import {startConnectorIndexing} from './client.mjs';

export interface ConnectorCatchupOptions<Cursor> {
 database:ApplicationDatabase;client:Client;sourceId:string;taskQueue:string;generation:string;
 discover(cursor:Cursor|null):Promise<{references:ConnectionReference[];cursor:Cursor|null;rejected?:number}>;
 resolve(reference:ConnectionReference&{generation:string}):Promise<{binding:ConnectorBinding;store:{bucket?:string};search:{identity:string}}>;
 verifyProducer?():Promise<void>;
}
interface Descriptor {reference:{tenantId:string;userId:string;connectionId:string};bucket:string;workspace:string;provider:string;access:string;prefix:string;index:string}
const unsafe=(message:string):never=>{throw Object.assign(new Error(message),{code:'CONNECTOR_CATCHUP_INCOMPLETE'});};
const hash=(value:unknown)=>digest(JSON.stringify(value));

/** Retired cache receipts never authorize skipping data. A full current-scope
 * workflow pass must finish before its SQL completion can authorize this gate. */
export async function activateConnectorCatchup<Cursor>(options:ConnectorCatchupOptions<Cursor>){
 const {database,client,sourceId,taskQueue,generation}=options;
 if(!sourceId||sourceId.length>200||!taskQueue||taskQueue.length>200||!/^v[1-9][0-9]*$/.test(generation)||!client.options.namespace)throw new Error('Explicit connector catch-up binding required');
 await requireApplicationStateReady(database);
 const retirement=createConnectorCacheRetirements(database),required=await retirement.required();
 if(!required.receipts)return {required:false,completed:true,connections:0};
 await options.verifyProducer?.();
 const installation=async()=>{
  await requireApplicationStateReady(database);
  const {rows}=await database.pool.query('SELECT migration_id,source_manifest_hash,inventory_complete,verified_at FROM opencrawl_application_installations WHERE namespace=$1',[database.namespace]);
  if(!rows[0]||rows[0].inventory_complete!==true||!rows[0].verified_at||!/^[a-f0-9]{64}$/.test(rows[0].source_manifest_hash))unsafe('Migration has no verified connector source manifest');
  return {migrationId:String(rows[0].migration_id),sourceManifest:String(rows[0].source_manifest_hash)};
 };
 const original=await installation();
 async function inventory(){
  const records:Descriptor[]=[],seen=new Set<string>(),cursors=new Set<string>();let cursor:Cursor|null=null,bytes=0;
  for(;;){
   const page=await options.discover(cursor);
   if(!Array.isArray(page.references)||page.references.length>1000||page.rejected!==undefined&&(!Number.isSafeInteger(page.rejected)||page.rejected!==0))unsafe('Some active connectors cannot be resolved for catch-up');
   for(const reference of page.references){
    if(!/^org_[A-Za-z0-9]+$|^personal:user_[A-Za-z0-9]+$/.test(reference.tenantId)||!/^user_[A-Za-z0-9]+$/.test(reference.userId??'')||!/^int_[a-f0-9]{26}$/.test(reference.connectionId))unsafe('Invalid current connector reference');
    const ref={tenantId:reference.tenantId,userId:reference.userId!,connectionId:reference.connectionId},key=JSON.stringify([ref.tenantId,ref.connectionId]);
    if(seen.has(key))unsafe('Duplicate current connector reference');seen.add(key);
    const resolved=await options.resolve({...ref,generation}),binding=validateBinding(resolved.binding);
    if(binding.tenantId!==ref.tenantId||binding.connectionId!==ref.connectionId||!resolved.store.bucket||!resolved.search.identity)unsafe('Connector resolution differs from its current reference');
    const descriptor={reference:ref,bucket:resolved.store.bucket!,workspace:binding.workspaceId,provider:binding.provider,access:binding.access,prefix:binding.rawPrefix,index:resolved.search.identity};
    bytes+=Buffer.byteLength(JSON.stringify(descriptor));if(records.length>=100000||bytes>64*1024*1024)unsafe('Connector catch-up inventory exceeds its supported bound');records.push(descriptor);
   }
   if(page.cursor===null)break;
   const token=JSON.stringify(page.cursor);if(!token||token.length>16384||cursors.has(token))unsafe('Connector discovery did not advance');cursors.add(token);cursor=page.cursor;
  }
  records.sort((a,b)=>Buffer.compare(Buffer.from(JSON.stringify(a.reference)),Buffer.from(JSON.stringify(b.reference))));
  const sha=createHash('sha256');for(const record of records)sha.update(JSON.stringify(record)+'\n');
  return {records,manifest:sha.digest('hex')};
 }
 const current=await inventory(),temporalNamespace=client.options.namespace;
 const activationId=hash([database.namespace,original,required,sourceId,taskQueue,generation,temporalNamespace,current.manifest]);
 await database.transaction(async sql=>{
  await sql.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:connector-catchup:schema',0))");
  await sql.query(`CREATE TABLE IF NOT EXISTS opencrawl_connector_catchups(
   namespace text NOT NULL,activation_id text NOT NULL,migration_id uuid NOT NULL,source_id text NOT NULL,reference_manifest text NOT NULL,
   generation text NOT NULL,task_queue text NOT NULL,temporal_namespace text NOT NULL,required_receipts bigint NOT NULL,connections integer NOT NULL,
   completed_at timestamptz,PRIMARY KEY(namespace,activation_id));
   CREATE TABLE IF NOT EXISTS opencrawl_connector_catchup_runs(
   namespace text NOT NULL,activation_id text NOT NULL,reference_hash text NOT NULL,tenant_id text NOT NULL,user_id text NOT NULL,connection_id text NOT NULL,
   bucket text NOT NULL,workspace text NOT NULL,provider text NOT NULL,access text NOT NULL,raw_prefix text NOT NULL,index_identity text NOT NULL,
   workflow_id text NOT NULL,run_id text,completed_at timestamptz,PRIMARY KEY(namespace,activation_id,reference_hash),
   FOREIGN KEY(namespace,activation_id) REFERENCES opencrawl_connector_catchups(namespace,activation_id))`);
 });
 const sql=await database.pool.connect(),lock=JSON.stringify([database.namespace,sourceId,'connector-catchup']);let locked=false,destroy=false;
 try{
  const acquired=await sql.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[lock]);if(!acquired.rows[0]?.locked)unsafe('Connector catch-up is already running; resume its existing execution');locked=true;
  await sql.query(`INSERT INTO opencrawl_connector_catchups(namespace,activation_id,migration_id,source_id,reference_manifest,generation,task_queue,temporal_namespace,required_receipts,connections) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,[database.namespace,activationId,original.migrationId,sourceId,current.manifest,generation,taskQueue,temporalNamespace,required.receipts,current.records.length]);
  const header=(await sql.query('SELECT migration_id,source_id,reference_manifest,generation,task_queue,temporal_namespace,required_receipts,connections FROM opencrawl_connector_catchups WHERE namespace=$1 AND activation_id=$2',[database.namespace,activationId])).rows[0];
  if(!header||header.migration_id!==original.migrationId||header.source_id!==sourceId||header.reference_manifest!==current.manifest||header.generation!==generation||header.task_queue!==taskQueue||header.temporal_namespace!==temporalNamespace||Number(header.required_receipts)!==required.receipts||header.connections!==current.records.length)unsafe('Connector catch-up installation evidence is inconsistent');
  for(const descriptor of current.records){
   const referenceHash=hash(descriptor),requestId=hash([activationId,referenceHash]),workflowId='connector-catchup-v1-'+requestId;
   await sql.query(`INSERT INTO opencrawl_connector_catchup_runs(namespace,activation_id,reference_hash,tenant_id,user_id,connection_id,bucket,workspace,provider,access,raw_prefix,index_identity,workflow_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,[database.namespace,activationId,referenceHash,descriptor.reference.tenantId,descriptor.reference.userId,descriptor.reference.connectionId,descriptor.bucket,descriptor.workspace,descriptor.provider,descriptor.access,descriptor.prefix,descriptor.index,workflowId]);
   const saved=(await sql.query('SELECT * FROM opencrawl_connector_catchup_runs WHERE namespace=$1 AND activation_id=$2 AND reference_hash=$3',[database.namespace,activationId,referenceHash])).rows[0];
   const stored={reference:{tenantId:saved.tenant_id,userId:saved.user_id,connectionId:saved.connection_id},bucket:saved.bucket,workspace:saved.workspace,provider:saved.provider,access:saved.access,prefix:saved.raw_prefix,index:saved.index_identity};
   if(!isDeepStrictEqual(stored,descriptor)||saved.workflow_id!==workflowId||Boolean(saved.run_id)!==Boolean(saved.completed_at))unsafe('Connector catch-up completion evidence is inconsistent');
   if(saved.completed_at)continue;
   await options.verifyProducer?.();
   const started=await startConnectorIndexing(client,{reference:descriptor.reference,taskQueue,generation,requestId});
   if(started.workflowId!==workflowId)unsafe('Connector catch-up workflow identity differs');
   const handle=client.workflow.getHandle(workflowId),result:unknown=await handle.result(),description=await handle.describe();
   if(!result||typeof result!=='object'||!('cursor'in result)||result.cursor!==null||!('failed'in result)||result.failed!==0||'paginationFailure'in result||description.status.name!=='COMPLETED'||description.type!=='indexConnectorV1'||description.taskQueue!==taskQueue||!description.runId)unsafe('Connector catch-up did not complete a full successful scan');
   await sql.query('UPDATE opencrawl_connector_catchup_runs SET run_id=$4,completed_at=now() WHERE namespace=$1 AND activation_id=$2 AND reference_hash=$3',[database.namespace,activationId,referenceHash,description.runId]);
  }
  const final=await inventory();
  if(final.manifest!==current.manifest||!isDeepStrictEqual(await retirement.required(),required)||!isDeepStrictEqual(await installation(),original))unsafe('Current connector scope changed during catch-up; resume with its new scope');
  await options.verifyProducer?.();
  const coverage=await sql.query('SELECT count(*)::int AS total,count(*) FILTER(WHERE completed_at IS NOT NULL AND run_id IS NOT NULL)::int AS complete FROM opencrawl_connector_catchup_runs WHERE namespace=$1 AND activation_id=$2',[database.namespace,activationId]);
  if(coverage.rows[0].total!==current.records.length||coverage.rows[0].complete!==current.records.length)unsafe('Connector catch-up evidence does not cover the current manifest');
  await sql.query('UPDATE opencrawl_connector_catchups SET completed_at=now() WHERE namespace=$1 AND activation_id=$2',[database.namespace,activationId]);
  return {required:true,completed:true,migrationId:original.migrationId,manifest:current.manifest,connections:current.records.length,activationId};
 }finally{try{if(locked)await sql.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lock]);}catch{destroy=true;}sql.release(destroy);}
}
