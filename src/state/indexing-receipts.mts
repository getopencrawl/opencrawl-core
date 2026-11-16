import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import type {JsonObject} from '../sessions/types.mjs';
import type {ApplicationDatabase} from './postgres.mjs';
export interface IndexingReceipts {read(key:string):Promise<JsonObject|null>;put(key:string,value:JsonObject):Promise<void>}
export const sessionIndexingReceiptSchema=z.strictObject({status:z.literal('indexed'),sourceKey:z.string().max(8192),documents:z.number().int().nonnegative().safe(),indexedAt:z.string().refine(value=>Number.isFinite(Date.parse(value))),deleted:z.boolean().optional()});
export type SessionIndexingReceipt=z.infer<typeof sessionIndexingReceiptSchema>;
export interface SessionReceiptImport {key:string;value:SessionIndexingReceipt}
export const MIGRATION_RECEIPT_BATCH_SIZE=100;
/** Revalidate the narrow fast path at its SQL boundary. Tenant and source-prefix
 * authorization are established by the bound object importer before this call. */
export function validateSessionReceiptImport(item:SessionReceiptImport){
  const value=sessionIndexingReceiptSchema.parse(item.value),match=/\/_index\/[a-f0-9]{64}\/[a-f0-9]{64}\/batches\/([a-f0-9]{64})\.json$/.exec(item.key);
  if(!match||item.key.length>8192||item.key.split('/').some(part=>!part||part==='.'||part==='..')||createHash('sha256').update(value.sourceKey).digest('hex')!==match[1]||Buffer.byteLength(JSON.stringify(value))>32768)throw new Error('Invalid session indexing receipt import');
  return value;
}
function batchKeys(items:readonly SessionReceiptImport[]){
  if(!items.length||items.length>MIGRATION_RECEIPT_BATCH_SIZE||new Set(items.map(item=>item.key)).size!==items.length)throw new Error('Invalid indexing receipt migration batch');
  for(const item of items)validateSessionReceiptImport(item);
  return items.map(item=>item.key);
}
export async function readSessionReceiptBatch(client:PoolClient,namespace:string,items:readonly SessionReceiptImport[]){
  const keys=batchKeys(items),{rows}=await client.query<{receipt_key:string;payload:JsonObject}>('SELECT receipt_key,payload FROM opencrawl_indexing_receipts WHERE namespace=$1 AND receipt_key=ANY($2::text[])',[namespace,keys]);
  return new Map(rows.map(row=>[row.receipt_key,row.payload]));
}
/** Caller owns the transaction, including the per-source migration receipts. */
export async function importSessionReceiptBatch(client:PoolClient,namespace:string,items:readonly SessionReceiptImport[]){
  batchKeys(items);
  await client.query(`INSERT INTO opencrawl_indexing_receipts(namespace,receipt_key,payload) SELECT $1,entry->>'key',entry->'value' FROM jsonb_array_elements($2::jsonb) entry ON CONFLICT DO NOTHING`,[namespace,JSON.stringify(items)]);
  const found=await readSessionReceiptBatch(client,namespace,items);
  for(const item of items)if(!isDeepStrictEqual(found.get(item.key),item.value))throw new Error('Existing indexing receipt differs from migration source');
  return found;
}
/** Bounded completion evidence, keyed by the existing scope-bound pipeline key.
 * Raw captures and connector pages remain in object storage. */
export function createPostgresIndexingReceipts(database:ApplicationDatabase):IndexingReceipts&{ready():Promise<void>;importReceipt(key:string,value:JsonObject):Promise<void>}{
  const key=(value:string)=>{if(typeof value!=='string'||!value||value.length>8192||value.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Invalid indexing receipt key');return value;};
  const payload=(value:JsonObject)=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid indexing receipt');const encoded=JSON.stringify(value);if(Buffer.byteLength(encoded)>32768)throw new Error('Indexing receipt exceeds limit');return encoded;};
  return {
    async ready(){await database.ready();await database.transaction(async client=>{await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:indexing-receipts:schema',0))");await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_indexing_receipts(namespace text NOT NULL,receipt_key text NOT NULL,payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(namespace,receipt_key))`);});},
    async read(name){const {rows}=await database.pool.query('SELECT payload FROM opencrawl_indexing_receipts WHERE namespace=$1 AND receipt_key=$2',[database.namespace,key(name)]);return rows[0]?.payload??null;},
    async put(name,value){await database.pool.query('INSERT INTO opencrawl_indexing_receipts(namespace,receipt_key,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING',[database.namespace,key(name),payload(value)]);},
    async importReceipt(name,value){const encoded=payload(value);await database.transaction(async client=>{
      await client.query('INSERT INTO opencrawl_indexing_receipts(namespace,receipt_key,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING',[database.namespace,key(name),encoded]);
      const {rows}=await client.query('SELECT payload FROM opencrawl_indexing_receipts WHERE namespace=$1 AND receipt_key=$2',[database.namespace,name]);
      if(!isDeepStrictEqual(rows[0]?.payload,JSON.parse(encoded)))throw new Error('Existing indexing receipt differs from migration source');
    });},
  };
}
