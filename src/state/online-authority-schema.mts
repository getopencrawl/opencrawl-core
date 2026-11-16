import type {PoolClient} from 'pg';

const table='opencrawl_online_write_authorities';
const oldMode="CHECK ((mode = ANY (ARRAY['legacy'::text, 'journal'::text])))";
const oldState="CHECK ((((mode = 'legacy'::text) AND (enrollment_receipt_hash IS NULL)) OR ((mode = 'journal'::text) AND (enrollment_receipt_hash IS NOT NULL) AND (enrollment_receipt_hash ~ '^[a-f0-9]{64}$'::text))))";
const newMode="CHECK ((mode = ANY (ARRAY['legacy'::text, 'journal'::text, 'target'::text])))";
const newState="CHECK ((((mode = 'legacy'::text) AND (enrollment_receipt_hash IS NULL) AND (target_receipt_hash IS NULL)) OR ((mode = 'journal'::text) AND (enrollment_receipt_hash IS NOT NULL) AND (enrollment_receipt_hash ~ '^[a-f0-9]{64}$'::text) AND (target_receipt_hash IS NULL)) OR ((mode = 'target'::text) AND (enrollment_receipt_hash IS NOT NULL) AND (enrollment_receipt_hash ~ '^[a-f0-9]{64}$'::text) AND (target_receipt_hash IS NOT NULL) AND (target_receipt_hash ~ '^[a-f0-9]{64}$'::text))))";
function fail():never{throw Object.assign(new Error('Online authority target schema differs from the supported contract'),{code:'ONLINE_AUTHORITY_TARGET_SCHEMA'});}
/** Called by explicit operator preparation under the authority and schema
 * locks. This admits no target and changes no authority row. */
export async function prepareOnlineAuthorityTargetSchemaIn(client:PoolClient){
 const column=(await client.query("SELECT atttypid::regtype::text AS type,attnotnull,atthasdef,attidentity,attgenerated FROM pg_attribute WHERE attrelid=$1::regclass AND attname='target_receipt_hash' AND NOT attisdropped",[table])).rows[0];
 async function constraints(mode:string,state:string){
  const rows=(await client.query("SELECT conname,convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass AND conname=ANY($2::text[])",[table,[table+'_mode_check',table+'_check']])).rows;
  if(rows.length!==2||rows.some(row=>!row.convalidated||row.definition!==(row.conname===table+'_mode_check'?mode:state)))fail();
 }
 if(!column){
  await constraints(oldMode,oldState);
  await client.query(`ALTER TABLE opencrawl_online_write_authorities ADD COLUMN target_receipt_hash text,
   DROP CONSTRAINT opencrawl_online_write_authorities_mode_check,DROP CONSTRAINT opencrawl_online_write_authorities_check,
   ADD CONSTRAINT opencrawl_online_write_authorities_mode_check CHECK(mode IN ('legacy','journal','target')),
   ADD CONSTRAINT opencrawl_online_write_authorities_check CHECK(
    (mode='legacy' AND enrollment_receipt_hash IS NULL AND target_receipt_hash IS NULL) OR
    (mode='journal' AND enrollment_receipt_hash IS NOT NULL AND enrollment_receipt_hash~'^[a-f0-9]{64}$' AND target_receipt_hash IS NULL) OR
    (mode='target' AND enrollment_receipt_hash IS NOT NULL AND enrollment_receipt_hash~'^[a-f0-9]{64}$' AND target_receipt_hash IS NOT NULL AND target_receipt_hash~'^[a-f0-9]{64}$'))`);
 }else if(column.type!=='text'||column.attnotnull||column.atthasdef||column.attidentity||column.attgenerated)fail();
 await constraints(newMode,newState);
}
