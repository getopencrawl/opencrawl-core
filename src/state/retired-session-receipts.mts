import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import type {ApplicationDatabase} from './postgres.mjs';
import {digest,sourceBatchIdentity} from '../sessions/event-identity.mjs';
import {digest as scopeDigest} from '../connectors/scope.mjs';
import {isSessionHarness} from '../sessions/types.mjs';
import {sessionIndexingReceiptSchema} from './indexing-receipts.mjs';

const hash=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/),text=z.string().min(1).max(8192),number=z.number().int().nonnegative().safe(),date=z.string().refine(value=>Number.isFinite(Date.parse(value)));
export const failedSessionReceiptSchema=z.strictObject({status:z.literal('failed'),sourceKey:text,attempts:number.min(1),lastAttempt:date,nextAttempt:number,error:z.literal('INDEXING_FAILED')});
export const retiredSessionProofSchema=z.strictObject({tenantId:id,userId:id,harness:z.string().refine(isSessionHarness),sessionId:id,proof:text});
export type RetiredSessionProof=z.infer<typeof retiredSessionProofSchema>;
const schema=z.strictObject({version:z.literal(1),disposition:z.literal('deleted-retired-owner'),bucket:text,prefix:text,key:text,sourceHash:hash,sourceBytesBase64:z.string().max(43700),
 receipt:z.union([sessionIndexingReceiptSchema,failedSessionReceiptSchema]),proof:retiredSessionProofSchema,
 evidence:z.strictObject({controlKey:text,controlHash:hash,deletedAt:date,fenceKey:text,fenceHash:hash,closedAt:number})});
export type RetiredSessionReceipt=z.infer<typeof schema>;
export function retiredSessionLocations(prefix:string,proof:RetiredSessionProof){
 const tenantHash=digest(proof.tenantId),userHash=digest(proof.userId),sessionHash=digest(proof.sessionId),owner=prefix+'/tenants/'+tenantHash+'/users/'+userHash;
 const connectionId=digest(JSON.stringify([prefix,proof.userId,proof.harness,proof.sessionId]));
 return {tenantHash,userHash,sessionHash,connectionId,controlKey:owner+'/controls/sessions/'+proof.harness+'/'+sessionHash+'.json',fenceKey:owner+'/controls/write-barriers/'+scopeDigest(['sessions',tenantHash,connectionId])+'.json'};
}
function validate(value:RetiredSessionReceipt){
 const saved=schema.parse(value),bytes=Buffer.from(saved.sourceBytesBase64,'base64'),identity=sourceBatchIdentity(saved.prefix,saved.receipt.sourceKey),scope=retiredSessionLocations(saved.prefix,saved.proof);
 const suffix=new RegExp('^'+saved.prefix.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/_index/[a-f0-9]{64}/[a-f0-9]{64}/batches/'+digest(saved.receipt.sourceKey)+'\\.json$');
 if(saved.prefix.split('/').some(part=>!part||part==='.'||part==='..')||!suffix.test(saved.key)||!identity||identity.tenantHash!==scope.tenantHash||identity.userHash!==scope.userHash||identity.sessionHash!==scope.sessionHash||identity.harness!==saved.proof.harness||saved.evidence.controlKey!==scope.controlKey||saved.evidence.fenceKey!==scope.fenceKey||bytes.length>32768||bytes.toString('base64')!==saved.sourceBytesBase64||digest(bytes)!==saved.sourceHash||!isDeepStrictEqual(JSON.parse(bytes.toString('utf8')),saved.receipt))throw new Error('Retired session receipt evidence binding differs');
 return saved;
}
/** Offline audit only. No runtime indexing or scheduling path reads this table. */
export function createRetiredSessionReceipts(database:ApplicationDatabase){
 async function read(client:Pick<PoolClient,'query'>,bucket:string,key:string):Promise<RetiredSessionReceipt|null>{
  const {rows}=await client.query('SELECT * FROM opencrawl_retired_session_receipts WHERE namespace=$1 AND bucket=$2 AND receipt_key=$3',[database.namespace,bucket,key]);if(!rows.length)return null;const r=rows[0];
  const receipt=r.status==='indexed'?{status:'indexed' as const,sourceKey:r.source_key,documents:Number(r.documents),indexedAt:r.indexed_at,...(r.deleted===null?{}:{deleted:r.deleted})}:
   {status:'failed' as const,sourceKey:r.source_key,attempts:Number(r.attempts),lastAttempt:r.last_attempt,nextAttempt:Number(r.next_attempt),error:r.error};
  return validate({version:1,disposition:'deleted-retired-owner',bucket:r.bucket,prefix:r.source_prefix,key:r.receipt_key,sourceHash:r.source_hash,sourceBytesBase64:r.source_bytes.toString('base64'),receipt,
   proof:{tenantId:r.tenant_id,userId:r.user_id,harness:r.harness,sessionId:r.session_id,proof:r.proof_reference},evidence:{controlKey:r.control_key,controlHash:r.control_hash,deletedAt:r.deleted_at,fenceKey:r.fence_key,fenceHash:r.fence_hash,closedAt:Number(r.closed_at)}});
 }
 return {
  async ready(){await database.ready();await database.transaction(async client=>{
   await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:retired-session-receipts:schema',0))");
   await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_retired_session_receipts(
    namespace text NOT NULL,bucket text NOT NULL,receipt_key text NOT NULL,source_prefix text NOT NULL,source_hash text NOT NULL CHECK(source_hash~'^[a-f0-9]{64}$'),source_bytes bytea NOT NULL CHECK(octet_length(source_bytes)<=32768),
    source_key text NOT NULL,status text NOT NULL CHECK(status IN('indexed','failed')),documents bigint,indexed_at text,deleted boolean,attempts bigint,last_attempt text,next_attempt bigint,error text,
    tenant_id text NOT NULL,user_id text NOT NULL,harness text NOT NULL,session_id text NOT NULL,proof_reference text NOT NULL,
    control_key text NOT NULL,control_hash text NOT NULL CHECK(control_hash~'^[a-f0-9]{64}$'),deleted_at text NOT NULL,fence_key text NOT NULL,fence_hash text NOT NULL CHECK(fence_hash~'^[a-f0-9]{64}$'),closed_at bigint NOT NULL CHECK(closed_at>=0),
    PRIMARY KEY(namespace,bucket,receipt_key),
    CHECK((status='indexed' AND documents>=0 AND indexed_at IS NOT NULL AND attempts IS NULL AND last_attempt IS NULL AND next_attempt IS NULL AND error IS NULL)
     OR(status='failed' AND documents IS NULL AND indexed_at IS NULL AND deleted IS NULL AND attempts>0 AND last_attempt IS NOT NULL AND next_attempt>=0 AND error='INDEXING_FAILED')))`);
  });},
  async exportRetirement(bucket:string,key:string){if((await database.pool.query("SELECT to_regclass('opencrawl_retired_session_receipts') AS relation")).rows[0].relation===null)return null;return read(database.pool,bucket,key);},
  async importRetirement(input:RetiredSessionReceipt){const value=validate(input),r=value.receipt,p=value.proof,e=value.evidence;
   await database.transaction(async client=>{
    await client.query(`INSERT INTO opencrawl_retired_session_receipts(namespace,bucket,receipt_key,source_prefix,source_hash,source_bytes,source_key,status,documents,indexed_at,deleted,attempts,last_attempt,next_attempt,error,tenant_id,user_id,harness,session_id,proof_reference,control_key,control_hash,deleted_at,fence_key,fence_hash,closed_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) ON CONFLICT DO NOTHING`,
     [database.namespace,value.bucket,value.key,value.prefix,value.sourceHash,Buffer.from(value.sourceBytesBase64,'base64'),r.sourceKey,r.status,'documents'in r?r.documents:null,'indexedAt'in r?r.indexedAt:null,'deleted'in r?r.deleted:null,'attempts'in r?r.attempts:null,'lastAttempt'in r?r.lastAttempt:null,'nextAttempt'in r?r.nextAttempt:null,'error'in r?r.error:null,p.tenantId,p.userId,p.harness,p.sessionId,p.proof,e.controlKey,e.controlHash,e.deletedAt,e.fenceKey,e.fenceHash,e.closedAt]);
    if(!isDeepStrictEqual(await read(client,value.bucket,value.key),value))throw new Error('Existing retired session receipt differs from its source or deletion proof');
   });
  },
 };
}
