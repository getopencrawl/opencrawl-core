import {isDeepStrictEqual} from 'node:util';
import type {ApplicationDatabase} from './postgres.mjs';

export type ConnectorCacheReceipt=
 | {pipeline:string;key:string;sha256:string;sourceRecords:number;records:number}
 | {pipeline:string;fingerprint:string;checksum?:string;sourceRecords?:number;records:number;objects:number;ignored?:number};
export interface ConnectorCacheRetirement {
 version:1;kind:'object'|'snapshot';bucket:string;key:string;sourceHash:string;
 disposition:'full-temporal-connector-catchup';receipt:ConnectorCacheReceipt;
}
/** Historical index identity hashes are not independently recoverable from
 * these objects. Retain typed evidence, never live indexing skip authority. */
export function createConnectorCacheRetirements(database:ApplicationDatabase){
 async function exists(){return (await database.pool.query("SELECT to_regclass('opencrawl_connector_cache_retirements') AS table")).rows[0].table!==null;}
 async function exportRetirement(bucket:string,key:string):Promise<ConnectorCacheRetirement|null>{
  if(!await exists())return null;
  const {rows}=await database.pool.query('SELECT * FROM opencrawl_connector_cache_retirements WHERE namespace=$1 AND bucket=$2 AND retirement_key=$3',[database.namespace,bucket,key]);
  if(!rows.length)return null;const r=rows[0];
  const receipt:ConnectorCacheReceipt=r.kind==='object'?{pipeline:r.pipeline,key:r.source_key,sha256:r.object_hash,sourceRecords:Number(r.source_records),records:Number(r.records)}:
   {pipeline:r.pipeline,fingerprint:r.fingerprint,...(r.checksum===null?{}:{checksum:r.checksum}),...(r.source_records===null?{}:{sourceRecords:Number(r.source_records)}),records:Number(r.records),objects:Number(r.objects),...(r.ignored===null?{}:{ignored:Number(r.ignored)})};
  return {version:1,kind:r.kind,bucket:r.bucket,key:r.retirement_key,sourceHash:r.source_hash,disposition:r.disposition,receipt};
 }
 return {
  async ready(){await database.ready();await database.transaction(async client=>{
   await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:connector-cache-retirements:schema',0))");
   await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_connector_cache_retirements(
    namespace text NOT NULL,bucket text NOT NULL,retirement_key text NOT NULL,kind text NOT NULL CHECK(kind IN('object','snapshot')),
    source_hash text NOT NULL CHECK(source_hash~'^[a-f0-9]{64}$'),disposition text NOT NULL CHECK(disposition='full-temporal-connector-catchup'),
    pipeline text NOT NULL,source_key text,object_hash text,fingerprint text,checksum text,source_records bigint,records bigint NOT NULL CHECK(records>=0),objects bigint,ignored bigint,
    PRIMARY KEY(namespace,bucket,retirement_key),
    CHECK(source_records IS NULL OR source_records>=0),CHECK(ignored IS NULL OR ignored>=0),
    CHECK((kind='object' AND source_key IS NOT NULL AND object_hash IS NOT NULL AND object_hash~'^[a-f0-9]{64}$' AND source_records IS NOT NULL AND fingerprint IS NULL AND checksum IS NULL AND objects IS NULL AND ignored IS NULL)
     OR(kind='snapshot' AND source_key IS NULL AND object_hash IS NULL AND fingerprint IS NOT NULL AND fingerprint~'^[a-f0-9]{64}$' AND (checksum IS NULL OR checksum~'^[a-f0-9]{64}$') AND objects IS NOT NULL AND objects>=0)))`);
  });},
  exportRetirement,
  async required(){if(!await exists())return {receipts:0,buckets:[] as string[]};const {rows}=await database.pool.query('SELECT bucket,count(*)::int AS count FROM opencrawl_connector_cache_retirements WHERE namespace=$1 GROUP BY bucket ORDER BY bucket',[database.namespace]);return {receipts:rows.reduce((sum,r)=>sum+Number(r.count),0),buckets:rows.map(r=>String(r.bucket))};},
  async importRetirement(value:ConnectorCacheRetirement){
   const r=value.receipt;
   await database.pool.query(`INSERT INTO opencrawl_connector_cache_retirements(namespace,bucket,retirement_key,kind,source_hash,disposition,pipeline,source_key,object_hash,fingerprint,checksum,source_records,records,objects,ignored)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING`,
    [database.namespace,value.bucket,value.key,value.kind,value.sourceHash,value.disposition,r.pipeline,'key'in r?r.key:null,'sha256'in r?r.sha256:null,'fingerprint'in r?r.fingerprint:null,'checksum'in r?r.checksum:null,r.sourceRecords??null,r.records,'objects'in r?r.objects:null,'ignored'in r?r.ignored:null]);
   if(!isDeepStrictEqual(await exportRetirement(value.bucket,value.key),value))throw new Error('Existing connector cache retirement differs from retained source');
  },
 };
}
