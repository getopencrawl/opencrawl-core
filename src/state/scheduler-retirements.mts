import {isDeepStrictEqual} from 'node:util';
import type {ApplicationDatabase} from './postgres.mjs';

/** No runtime scheduler consumes these records. They prove which obsolete
 * scheduling instruction was replaced by a full PostgreSQL-era Temporal scan. */
export interface SchedulerRetirement {
  kind:'pending'|'failed'|'cursor'|'reconcile';
  sourceKey?:string;
  disposition:'full-temporal-catchup'|'deleted';
  generation:'postgres-app-state-v1';
  nextToken?:string|null;
  updatedAt?:string;
  attempts?:number;
  lastAttempt?:string;
  nextAttempt?:number;
  error?:'INDEXING_FAILED';
}
export function createSchedulerRetirements(database:ApplicationDatabase){
  async function exportRetirement(key:string):Promise<SchedulerRetirement|null>{
    const {rows}=await database.pool.query(`SELECT kind,source_key,disposition,generation,next_token,updated_at,attempts,last_attempt,next_attempt,error
      FROM opencrawl_scheduler_retirements WHERE namespace=$1 AND retirement_key=$2`,[database.namespace,key]);
    if(!rows.length)return null;
    const row=rows[0];
    return {kind:row.kind,disposition:row.disposition,generation:row.generation,
      ...(row.source_key===null?{}:{sourceKey:row.source_key}),
      ...(['cursor','reconcile'].includes(row.kind)?{nextToken:row.next_token}:{}),
      ...(row.updated_at===null?{}:{updatedAt:row.updated_at}),
      ...(row.attempts===null?{}:{attempts:Number(row.attempts),lastAttempt:row.last_attempt,nextAttempt:Number(row.next_attempt),error:row.error})};
  }
  return {
    async ready(){await database.ready();await database.transaction(async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:scheduler-retirements:schema',0))");
      await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_scheduler_retirements(
        namespace text NOT NULL,retirement_key text NOT NULL,kind text NOT NULL CHECK(kind IN('pending','failed','cursor','reconcile')),
        source_key text,disposition text NOT NULL CHECK(disposition IN('full-temporal-catchup','deleted')),
        generation text NOT NULL CHECK(generation='postgres-app-state-v1'),next_token text,updated_at text,
        attempts bigint,last_attempt text,next_attempt bigint,error text,
        PRIMARY KEY(namespace,retirement_key),
        CHECK((kind IN('pending','failed'))=(source_key IS NOT NULL)),
        CHECK(disposition<>'deleted' OR kind IN('pending','failed')),
        CHECK(kind='cursor' OR updated_at IS NULL),
        CHECK(kind IN('cursor','reconcile') OR next_token IS NULL),
        CHECK((kind='failed' AND attempts>0 AND last_attempt IS NOT NULL AND next_attempt>=0 AND error='INDEXING_FAILED')
          OR (kind<>'failed' AND attempts IS NULL AND last_attempt IS NULL AND next_attempt IS NULL AND error IS NULL)))`);
    });},
    exportRetirement,
    async importRetirement(key:string,value:SchedulerRetirement){
      await database.pool.query(`INSERT INTO opencrawl_scheduler_retirements(namespace,retirement_key,kind,source_key,disposition,generation,next_token,updated_at,attempts,last_attempt,next_attempt,error)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
        [database.namespace,key,value.kind,value.sourceKey??null,value.disposition,value.generation,value.nextToken??null,value.updatedAt??null,value.attempts??null,value.lastAttempt??null,value.nextAttempt??null,value.error??null]);
      if(!isDeepStrictEqual(await exportRetirement(key),value))throw new Error('Existing scheduler retirement differs from migration source');
    },
  };
}
