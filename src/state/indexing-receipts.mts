import {isDeepStrictEqual} from 'node:util';
import type {JsonObject} from '../sessions/types.mjs';
import type {ApplicationDatabase} from './postgres.mjs';
export interface IndexingReceipts {read(key:string):Promise<JsonObject|null>;put(key:string,value:JsonObject):Promise<void>}
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
