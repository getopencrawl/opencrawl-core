import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Pool,PoolClient} from 'pg';
import type {ApplicationSourceIdentity} from './settings.mjs';

/** The sealed receipt is written only by the final online admission owner.
 * A background traversal, workflow result or supplied hash is not admission. */
export interface OnlineApplicationAdmission {
 format:1;namespace:string;epoch:string;targetId:string;protocol:string;
 source:ApplicationSourceIdentity;attemptId:string;sealedAt:string;sourceCount:number;
 preparationReceiptHash:string;enrollmentReceiptHash:string;candidateHash:string;
 sourceSetHash:string;closedFrontiersHash:string;coverageHash:string;
 retirementHash:string;nativeBindingHash:string;drainReceiptHash:string;
}
const fields=['format','namespace','epoch','targetId','protocol','source','attemptId','sealedAt','sourceCount','preparationReceiptHash','enrollmentReceiptHash','candidateHash','sourceSetHash','closedFrontiersHash','coverageHash','retirementHash','nativeBindingHash','drainReceiptHash'] as const;
const hashes=['targetId','preparationReceiptHash','enrollmentReceiptHash','candidateHash','sourceSetHash','closedFrontiersHash','coverageHash','retirementHash','nativeBindingHash','drainReceiptHash'] as const;
const sha=/^[a-f0-9]{64}$/,uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const modeConstraint="CHECK ((((admission_kind = 'offline'::text) AND (migration_id IS NOT NULL) AND (online_epoch IS NULL) AND (online_receipt_hash IS NULL)) OR ((admission_kind = 'online'::text) AND (migration_id IS NULL) AND (online_epoch IS NOT NULL) AND (online_receipt_hash IS NOT NULL) AND (online_receipt_hash ~ '^[a-f0-9]{64}$'::text) AND (source_manifest_hash IS NULL) AND (NOT inventory_complete) AND (state = 'ready'::text))))";
function fail(reason:string):never{throw Object.assign(new Error('Application admission: '+reason),{code:'APPLICATION_ADMISSION_INVALID',status:503});}
function text(value:unknown,max:number):asserts value is string{if(typeof value!=='string'||!value||Buffer.byteLength(value)>max||/[\u0000-\u001f\u007f]/.test(value))fail('invalid binding');}
export function validateOnlineApplicationAdmission(value:OnlineApplicationAdmission):Readonly<OnlineApplicationAdmission>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...fields].sort().join(','))fail('invalid receipt');
 const input={...value,source:{...value.source}};text(input.namespace,2048);text(input.protocol,256);
 if(input.format!==1||!uuid.test(input.epoch)||!uuid.test(input.attemptId)||hashes.some(key=>!sha.test(input[key]))||!Number.isSafeInteger(input.sourceCount)||input.sourceCount<1||input.sourceCount>100000||typeof input.sealedAt!=='string'||!Number.isFinite(Date.parse(input.sealedAt))||new Date(input.sealedAt).toISOString()!==input.sealedAt)fail('invalid receipt');
 const source=input.source;
 if(Object.keys(source).sort().join(',')!=='bucket,organizationId,prefix,version'||source.version!==1||source.organizationId!==null&&(typeof source.organizationId!=='string'||!source.organizationId))fail('invalid source');
 text(source.bucket,255);text(source.prefix,8192);if(source.prefix.split('/').some(part=>!part||part==='.'||part==='..'))fail('invalid source');if(source.organizationId!==null)text(source.organizationId,2048);
 input.source=Object.freeze({version:1,bucket:source.bucket,prefix:source.prefix,organizationId:source.organizationId});
 return Object.freeze(Object.fromEntries(fields.map(key=>[key,input[key]])) as unknown as OnlineApplicationAdmission);
}
export function onlineApplicationAdmissionHash(value:OnlineApplicationAdmission){return createHash('sha256').update(JSON.stringify(validateOnlineApplicationAdmission(value))).digest('hex');}

/** Explicit operator upgrade. The caller holds the application schema lock and
 * transaction. This changes no installation state and creates no ready row. */
export async function prepareOnlineAdmissionSchemaIn(client:PoolClient){
 const version=(await client.query('SELECT version FROM opencrawl_application_schema WHERE singleton FOR UPDATE')).rows[0]?.version;
 if(version===1){
  const existing=(await client.query("SELECT attname FROM pg_attribute WHERE attrelid='opencrawl_application_installations'::regclass AND attname IN ('admission_kind','online_epoch','online_receipt_hash') AND NOT attisdropped")).rows;
  if(existing.length)fail('unknown admission schema');
  await client.query(`ALTER TABLE opencrawl_application_installations
   ADD COLUMN admission_kind text NOT NULL DEFAULT 'offline',ADD COLUMN online_epoch uuid,ADD COLUMN online_receipt_hash text,
   ALTER COLUMN migration_id DROP NOT NULL,
   ADD CONSTRAINT opencrawl_application_admission_mode CHECK(
    (admission_kind='offline' AND migration_id IS NOT NULL AND online_epoch IS NULL AND online_receipt_hash IS NULL) OR
    (admission_kind='online' AND migration_id IS NULL AND online_epoch IS NOT NULL AND online_receipt_hash IS NOT NULL AND online_receipt_hash~'^[a-f0-9]{64}$' AND source_manifest_hash IS NULL AND NOT inventory_complete AND state='ready'))`);
  await client.query(`CREATE TABLE opencrawl_online_application_admissions(namespace text PRIMARY KEY,epoch uuid NOT NULL,receipt_hash text NOT NULL CHECK(receipt_hash~'^[a-f0-9]{64}$'),proof jsonb NOT NULL CHECK(jsonb_typeof(proof)='object' AND octet_length(proof::text)<=65536))`);
  const changed=await client.query('UPDATE opencrawl_application_schema SET version=2 WHERE singleton AND version=1');if(changed.rowCount!==1)fail('schema changed');
 }else if(version!==2)fail('unsupported schema');
 await verifyOnlineAdmissionSchemaIn(client);
}
export async function verifyOnlineAdmissionSchemaIn(client:Pick<PoolClient,'query'>){
 const columns=(await client.query("SELECT attname,atttypid::regtype::text AS type,attnotnull FROM pg_attribute WHERE attrelid='opencrawl_application_installations'::regclass AND attname IN ('admission_kind','online_epoch','online_receipt_hash','migration_id') AND NOT attisdropped ORDER BY attname")).rows;
 if(!isDeepStrictEqual(columns,[{attname:'admission_kind',type:'text',attnotnull:true},{attname:'migration_id',type:'uuid',attnotnull:false},{attname:'online_epoch',type:'uuid',attnotnull:false},{attname:'online_receipt_hash',type:'text',attnotnull:false}]))fail('unsupported admission columns');
 const check=(await client.query("SELECT convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='opencrawl_application_installations'::regclass AND conname='opencrawl_application_admission_mode' AND contype='c'")).rows;
 if(check.length!==1||check[0].convalidated!==true||check[0].definition!==modeConstraint||!(await client.query("SELECT to_regclass('opencrawl_online_application_admissions') AS relation")).rows[0]?.relation)fail('incomplete admission schema');
}

/** Constant-size startup read. Detailed source/target verification belongs to
 * the sealer; this binds its immutable receipt to the terminal writer authority.
 * Existing offline readiness retains its original semantics. */
export async function readApplicationAdmission(database:{pool:Pick<Pool,'query'>;namespace:string;sourceIdentity?:ApplicationSourceIdentity;onlineTargetId?:string}){
 const row=(await database.pool.query('SELECT * FROM opencrawl_application_installations WHERE namespace=$1',[database.namespace])).rows[0];
 if(!row||row.state!=='ready')fail('migration is incomplete; run the supported upgrade before starting writers');
 if(database.sourceIdentity&&!isDeepStrictEqual(row.source_identity,database.sourceIdentity))fail('source binding differs from this runtime');
 const kind=row.admission_kind??'offline';
 if(kind==='offline'){
  if(!uuid.test(row.migration_id)||row.online_epoch!=null||row.online_receipt_hash!=null)fail('invalid offline admission');
  return Object.freeze({kind:'offline' as const,namespace:database.namespace,migrationId:String(row.migration_id),source:row.source_identity as ApplicationSourceIdentity});
 }
 if(kind!=='online'||!database.sourceIdentity||!sha.test(database.onlineTargetId??'')||row.migration_id!==null||row.source_manifest_hash!==null||row.inventory_complete!==false||!uuid.test(row.online_epoch)||!sha.test(row.online_receipt_hash)||!row.verified_at)fail('online target binding is required');
 const sealed=(await database.pool.query(`SELECT a.epoch,a.receipt_hash,a.proof,e.state AS epoch_state,w.epoch AS authority_epoch,w.protocol,w.mode,w.preparation_receipt_hash,w.enrollment_receipt_hash,w.target_receipt_hash
  FROM opencrawl_online_application_admissions a
  JOIN opencrawl_online_migration_epochs e ON e.namespace=a.namespace AND e.epoch=a.epoch
  JOIN opencrawl_online_write_authorities w ON w.namespace=a.namespace
  WHERE a.namespace=$1`,[database.namespace])).rows[0];
 if(!sealed)fail('sealed online receipt is missing');
 const proof=validateOnlineApplicationAdmission(sealed.proof),receiptHash=onlineApplicationAdmissionHash(proof);
 if(proof.namespace!==database.namespace||proof.epoch!==row.online_epoch||proof.targetId!==database.onlineTargetId||!isDeepStrictEqual(proof.source,database.sourceIdentity)||sealed.epoch!==proof.epoch||sealed.receipt_hash!==receiptHash||row.online_receipt_hash!==receiptHash||sealed.epoch_state!=='fenced'||sealed.authority_epoch!==proof.epoch||sealed.protocol!==proof.protocol||sealed.mode!=='target'||sealed.target_receipt_hash!==receiptHash||sealed.preparation_receipt_hash!==proof.preparationReceiptHash||sealed.enrollment_receipt_hash!==proof.enrollmentReceiptHash||new Date(row.verified_at).toISOString()!==proof.sealedAt)fail('online receipt or terminal authority changed');
 return Object.freeze({kind:'online' as const,namespace:database.namespace,receiptHash,proof});
}
