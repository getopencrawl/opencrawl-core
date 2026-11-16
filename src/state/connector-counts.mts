import type {PoolClient} from 'pg';
import type {ApplicationDatabase} from './postgres.mjs';
import type {IntegrationRecord} from '../integrations/types.mjs';
import type {LegacyCountState, RecordCountRepository} from '../integrations/counts.mjs';
import {createHash} from 'node:crypto';

const where = 'namespace=$1 AND environment=$2 AND tenant_id=$3 AND user_id=$4 AND integration_id=$5';
const fields = 'namespace,environment,tenant_id,user_id,integration_id';
const slots = '$1,$2,$3,$4,$5';
const closed = () => Object.assign(new Error('Connection measurement is closed'), {permanent: true});
const denied = () => Object.assign(new Error('Invalid connection measurement scope'), {permanent: true});
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function legacyCountsHash(saved: LegacyCountState): string {
  return digest(JSON.stringify({version:1,read:[...new Set(saved.read)].sort(),
    ids:Object.fromEntries(Object.entries(saved.ids).sort(([a],[b])=>a.localeCompare(b)).map(([stream,ids])=>[stream,[...new Set(ids)].sort()])),
    full:Object.fromEntries(Object.entries(saved.full||{}).sort(([a],[b])=>a.localeCompare(b)).map(([stream,value])=>[stream,{sync:value.sync,count:value.count}]))}));
}

/** Normalized measurement state. Bounded staging batches are invisible until
 * object completion atomically publishes IDs and its processed marker. */
export function createConnectorCounts({database, legacyBucket}: {database: ApplicationDatabase; legacyBucket: string}): RecordCountRepository & {
  ready(): Promise<void>;
  exportLegacyCounts(record: IntegrationRecord): Promise<LegacyCountState>;
  hasLegacyCounts(record: IntegrationRecord): Promise<boolean>;
  importLegacyCounts(record: IntegrationRecord, saved: LegacyCountState): Promise<{hash: string; records: number; objects: number}>;
  verify(record: IntegrationRecord): Promise<{counts: Record<string, number> | null; records: number; objects: number; pending: number}>;
} {
  let preparing: Promise<void> | undefined;
  function values(record: IntegrationRecord) {
    if (!['production','staging','selfhost'].includes(record.environment) || !/^(org_[A-Za-z0-9]+|personal:user_[A-Za-z0-9]+)$/.test(record.tenantId)
      || !/^user_[A-Za-z0-9]+$/.test(record.userId) || !/^int_[a-f0-9]{26}$/.test(record.integrationId) || !record.s3Prefix) throw denied();
    return [database.namespace, record.environment, record.tenantId, record.userId, record.integrationId];
  }
  async function lock(client: PoolClient, record: IntegrationRecord, allowClosed = false) {
    const params = values(record), bucket = record.s3Bucket || legacyBucket;
    if (!bucket) throw denied();
    await client.query(`INSERT INTO opencrawl_count_scopes(${fields},bucket,prefix) VALUES(${slots},$6,$7) ON CONFLICT DO NOTHING`, [...params,bucket,record.s3Prefix]);
    const {rows} = await client.query(`SELECT bucket,prefix,closed FROM opencrawl_count_scopes WHERE ${where} FOR UPDATE`,params);
    if (rows[0].bucket !== bucket || rows[0].prefix !== record.s3Prefix) throw denied();
    if (rows[0].closed && !allowClosed) throw closed();
    return params;
  }
  async function ready() {
    preparing ??= (async () => {
      await database.ready(); await database.transaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:connector-counts:schema',0))");
        const scope = 'namespace text NOT NULL, environment text NOT NULL, tenant_id text NOT NULL, user_id text NOT NULL, integration_id text NOT NULL';
        const fk = `FOREIGN KEY(${fields}) REFERENCES opencrawl_count_scopes(${fields}) ON DELETE CASCADE`;
        await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_count_scopes (${scope},bucket text NOT NULL,prefix text NOT NULL,closed boolean NOT NULL DEFAULT false,PRIMARY KEY(${fields}));
          CREATE TABLE IF NOT EXISTS opencrawl_count_objects (${scope},object_hash text NOT NULL,object_key text NOT NULL,stream text NOT NULL,generation text NOT NULL,complete boolean NOT NULL DEFAULT false,PRIMARY KEY(${fields},object_hash),${fk});
          CREATE TABLE IF NOT EXISTS opencrawl_count_staging (${scope},object_hash text NOT NULL,record_hash text NOT NULL,PRIMARY KEY(${fields},object_hash,record_hash),${fk});
          CREATE TABLE IF NOT EXISTS opencrawl_count_ids (${scope},stream text NOT NULL,generation text NOT NULL,record_hash text NOT NULL,PRIMARY KEY(${fields},stream,generation,record_hash),${fk});
          CREATE TABLE IF NOT EXISTS opencrawl_count_summaries (${scope},stream text NOT NULL,generation text NOT NULL,count bigint NOT NULL CHECK(count>=0),PRIMARY KEY(${fields},stream),${fk})`);
      });
    })().catch(error => {preparing = undefined; throw error;});
    await preparing;
  }
  async function read(record: IntegrationRecord) {
    await ready(); const params = values(record);
    const scope = await database.pool.query(`SELECT bucket,prefix,closed FROM opencrawl_count_scopes WHERE ${where}`,params);
    if (!scope.rows.length || scope.rows[0].closed) return null;
    if (scope.rows[0].bucket !== (record.s3Bucket || legacyBucket) || scope.rows[0].prefix !== record.s3Prefix) throw denied();
    const {rows} = await database.pool.query(`SELECT stream,count FROM opencrawl_count_summaries WHERE ${where}`,params);
    return rows.length ? Object.fromEntries(rows.map(row => [row.stream,Number(row.count)])) : null;
  }
  async function summarize(client: PoolClient, params: string[], full: Record<string, number>) {
    const {rows} = await client.query(`SELECT stream,generation,count(*)::text AS count FROM opencrawl_count_ids WHERE ${where} GROUP BY stream,generation`,params);
    for (const row of rows) if (row.generation === 'incremental' || String(full[row.stream]) === row.generation) {
      await client.query(`INSERT INTO opencrawl_count_summaries(${fields},stream,generation,count) VALUES(${slots},$6,$7,$8)
        ON CONFLICT(${fields},stream) DO UPDATE SET generation=excluded.generation,count=excluded.count`,[...params,row.stream,row.generation,row.count]);
    }
    // Empty completed full-refresh objects must publish zero too.
    for (const [stream,sync] of Object.entries(full)) {
      const result = await client.query(`SELECT 1 FROM opencrawl_count_objects WHERE ${where} AND stream=$6 AND generation=$7 AND complete LIMIT 1`,[...params,stream,String(sync)]);
      if (result.rows.length && !rows.some(row => row.stream === stream && row.generation === String(sync)))
        await client.query(`INSERT INTO opencrawl_count_summaries(${fields},stream,generation,count) VALUES(${slots},$6,$7,0) ON CONFLICT(${fields},stream) DO UPDATE SET generation=excluded.generation,count=0`,[...params,stream,String(sync)]);
    }
  }
  async function exportLegacyCounts(record: IntegrationRecord, client: Pick<PoolClient,'query'> = database.pool): Promise<LegacyCountState> {
    const params=values(record);
    const scope=await client.query(`SELECT bucket,prefix,closed FROM opencrawl_count_scopes WHERE ${where}`,params);
    if(!scope.rows.length)throw new Error('Legacy count target is absent');
    if(scope.rows[0].closed||scope.rows[0].bucket!==(record.s3Bucket||legacyBucket)||scope.rows[0].prefix!==record.s3Prefix)throw denied();
    const objects=await client.query(`SELECT object_key FROM opencrawl_count_objects WHERE ${where} AND complete AND generation='incremental' ORDER BY object_key`,params);
    const hashes=await client.query(`SELECT stream,record_hash FROM opencrawl_count_ids WHERE ${where} AND generation='incremental' ORDER BY stream,record_hash`,params);
    const summaries=await client.query(`SELECT stream,generation,count FROM opencrawl_count_summaries WHERE ${where} ORDER BY stream`,params);
    const ids:Record<string,string[]>={},full:NonNullable<LegacyCountState['full']>={};
    for(const row of hashes.rows)(ids[row.stream]??=[]).push(row.record_hash);
    for(const row of summaries.rows)if(row.generation==='incremental')ids[row.stream]??=[];else full[row.stream]={sync:row.generation==='legacy-partial'?null:Number(row.generation),count:Number(row.count)};
    return {version:1,read:objects.rows.map(row=>row.object_key),ids,full};
  }
  return {
    ready, read, exportLegacyCounts,
    async hasLegacyCounts(record) {const {rows}=await database.pool.query(`SELECT 1 FROM opencrawl_count_scopes WHERE ${where}`,values(record));return rows.length>0;},
    async processObject(record, object, ids, check = () => {}) {
      await ready(); check();
      if (!object.key.startsWith(`${record.s3Prefix}/`) || !object.stream || object.stream.length>200 || !Number.isSafeInteger(object.sync) || object.sync<0) throw denied();
      const keyHash = digest(object.key), generation = object.fullRefresh ? String(object.sync) : 'incremental';
      const admitted = await database.transaction(async client => {
        const params = await lock(client,record);
        if (object.fullRefresh) {
          const summary = await client.query(`SELECT generation FROM opencrawl_count_summaries WHERE ${where} AND stream=$6`,[...params,object.stream]);
          const published = summary.rows[0]?.generation;
          // An imported/published newer snapshot makes older unseen objects
          // irrelevant. Do not reread and retain their obsolete full-refresh IDs.
          if (typeof published === 'string' && /^\d+$/.test(published) && Number(published) > object.sync) return false;
        }
        await client.query(`INSERT INTO opencrawl_count_objects(${fields},object_hash,object_key,stream,generation) VALUES(${slots},$6,$7,$8,$9) ON CONFLICT DO NOTHING`,[...params,keyHash,object.key,object.stream,generation]);
        const {rows} = await client.query(`SELECT object_key,stream,generation,complete FROM opencrawl_count_objects WHERE ${where} AND object_hash=$6`,[...params,keyHash]);
        if (rows[0].object_key!==object.key || rows[0].stream!==object.stream || rows[0].generation!==generation) throw denied();
        return !rows[0].complete;
      });
      if (!admitted) return;
      const stage = async (batch: string[]) => database.transaction(async client => {
        check(); const params = await lock(client,record);
        const done = await client.query(`SELECT complete FROM opencrawl_count_objects WHERE ${where} AND object_hash=$6`,[...params,keyHash]);
        if (done.rows[0]?.complete) return false;
        await client.query(`INSERT INTO opencrawl_count_staging(${fields},object_hash,record_hash) SELECT ${slots},$6,unnest($7::text[]) ON CONFLICT DO NOTHING`,[...params,keyHash,batch]);
        return true;
      });
      let batch: string[] = [];
      for await (const id of ids) {
        check(); if (!/^[A-Za-z0-9_-]{12}$/.test(id)) throw denied();
        batch.push(id); if (batch.length===500) {if (!await stage(batch)) return; batch=[];}
      }
      if (batch.length && !await stage(batch)) return;
      await database.transaction(async client => {
        check(); const params = await lock(client,record);
        await client.query(`INSERT INTO opencrawl_count_ids(${fields},stream,generation,record_hash)
          SELECT ${fields},$7,$8,record_hash FROM opencrawl_count_staging WHERE ${where} AND object_hash=$6 ON CONFLICT DO NOTHING`,[...params,keyHash,object.stream,generation]);
        await client.query(`UPDATE opencrawl_count_objects SET complete=true WHERE ${where} AND object_hash=$6`,[...params,keyHash]);
        await client.query(`DELETE FROM opencrawl_count_staging WHERE ${where} AND object_hash=$6`,[...params,keyHash]);
      });
    },
    async publish(record, full, expected) {
      await ready(); await database.transaction(async client => {
        const params = await lock(client,record), complete: Record<string,number> = {};
        for (const [stream,sync] of Object.entries(full)) {
          if (!expected) {complete[stream]=sync; continue;}
          const keys=expected[stream];
          if (!keys?.length || keys.some(key=>!key.startsWith(`${record.s3Prefix}/`))) throw denied();
          const hashes=[...new Set(keys.map(digest))];
          const {rows}=await client.query(`SELECT count(*)::text AS count FROM opencrawl_count_objects WHERE ${where} AND stream=$6 AND generation=$7 AND complete AND object_hash=ANY($8::text[])`,[...params,stream,String(sync),hashes]);
          if (Number(rows[0].count)===hashes.length) complete[stream]=sync;
        }
        await summarize(client,params,complete);
      });
    },
    async remove(record) {
      if (!record.s3Prefix) return;
      await ready(); await database.transaction(async client => {
        const params = await lock(client,record,true);
        await client.query(`UPDATE opencrawl_count_scopes SET closed=true WHERE ${where}`,params);
        for (const table of ['objects','staging','ids','summaries']) await client.query(`DELETE FROM opencrawl_count_${table} WHERE ${where}`,params);
      });
    },
    async importLegacyCounts(record, saved) {
      await ready();
      if (saved?.version!==1 || !Array.isArray(saved.read) || !saved.ids || typeof saved.ids!=='object') throw new Error('Unsupported legacy count checkpoint');
      return database.transaction(async client => {
        const params = await lock(client,record); let records=0;
        for (const [stream,ids] of Object.entries(saved.ids)) {
          if (!stream || stream.length>200 || !Array.isArray(ids) || ids.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{12}$/.test(id))) throw new Error('Invalid legacy count IDs');
          const unique=[...new Set(ids)]; records+=unique.length;
          if(!unique.length)await client.query(`INSERT INTO opencrawl_count_summaries(${fields},stream,generation,count) VALUES(${slots},$6,'incremental',0) ON CONFLICT DO NOTHING`,[...params,stream]);
          for(let start=0;start<unique.length;start+=500) await client.query(`INSERT INTO opencrawl_count_ids(${fields},stream,generation,record_hash) SELECT ${slots},$6,'incremental',unnest($7::text[]) ON CONFLICT DO NOTHING`,[...params,stream,unique.slice(start,start+500)]);
        }
        for (const key of saved.read) {
          const match=typeof key==='string'&&/\/stream=([^/]+)\/date=[^/]+\/sync=\d+\//.exec(key);
          if (!match || !key.startsWith(`${record.s3Prefix}/`)) throw new Error('Invalid legacy count object scope');
          await client.query(`INSERT INTO opencrawl_count_objects(${fields},object_hash,object_key,stream,generation,complete) VALUES(${slots},$6,$7,$8,'incremental',true) ON CONFLICT DO NOTHING`,[...params,digest(key),key,match[1]]);
        }
        await summarize(client,params,{});
        for (const [stream,summary] of Object.entries(saved.full||{})) {
          if (!stream || stream.length>200 || !Number.isSafeInteger(summary.count) || summary.count<0 || summary.sync!==null&&(!Number.isSafeInteger(summary.sync)||summary.sync<0)) throw new Error('Invalid legacy full-refresh summary');
          await client.query(`INSERT INTO opencrawl_count_summaries(${fields},stream,generation,count) VALUES(${slots},$6,$7,$8) ON CONFLICT(${fields},stream) DO UPDATE SET generation=excluded.generation,count=excluded.count`,[...params,stream,summary.sync===null?'legacy-partial':String(summary.sync),summary.count]);
        }
        const actual=await client.query(`SELECT (SELECT count(*) FROM opencrawl_count_ids WHERE ${where}) AS records,(SELECT count(*) FROM opencrawl_count_objects WHERE ${where}) AS objects,(SELECT count(*) FROM opencrawl_count_staging WHERE ${where}) AS staging`,params);
        if(Number(actual.rows[0].records)!==records||Number(actual.rows[0].objects)!==new Set(saved.read).size||Number(actual.rows[0].staging)!==0)throw new Error('Legacy count import conflicts with target state');
        const hash=legacyCountsHash(await exportLegacyCounts(record,client));
        if(hash!==legacyCountsHash(saved))throw new Error('Legacy count target verification differs');
        return {hash,records,objects:new Set(saved.read).size};
      });
    },
    async verify(record) {
      const counts=await read(record), params=values(record);
      const result=await database.pool.query(`SELECT (SELECT count(*) FROM opencrawl_count_ids WHERE ${where}) AS records,(SELECT count(*) FROM opencrawl_count_objects WHERE ${where} AND complete) AS objects,(SELECT count(*) FROM opencrawl_count_objects WHERE ${where} AND NOT complete) AS pending`,params);
      return {counts,records:Number(result.rows[0].records),objects:Number(result.rows[0].objects),pending:Number(result.rows[0].pending)};
    },
  };
}
