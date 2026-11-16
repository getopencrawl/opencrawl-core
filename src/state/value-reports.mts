import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {ApplicationDatabase} from './postgres.mjs';
import {parseValueReport} from '../application/value-report.mjs';
import type {ValueReport} from '../application/reports.mjs';
export interface ValueReportState {read(tenantId:string):Promise<ValueReport|null>;write(tenantId:string,value:ValueReport):Promise<void>}
const tenantHash=(tenant:string)=>{if(!/^[A-Za-z0-9_.:-]{1,200}$/.test(tenant))throw new Error('Explicit workspace required');return createHash('sha256').update(tenant).digest('hex');};
/** One bounded report per workspace; producers and readers share PostgreSQL. */
export function createValueReports(database:ApplicationDatabase):ValueReportState&{ready():Promise<void>;importReport(hash:string,input:unknown):Promise<unknown>;exportReport(hash:string):Promise<unknown|null>}{
  const ns=database.namespace;let preparing:Promise<void>|undefined;
  function encode(value:unknown){const bytes=JSON.stringify(value);if(!value||typeof value!=='object'||Array.isArray(value)||Buffer.byteLength(bytes)>65536)throw new Error('Invalid saved value report');return bytes;}
  return {
    async exportReport(hash){if(!/^[a-f0-9]{64}$/.test(hash))throw new Error('Invalid value report owner');const {rows}=await database.pool.query('SELECT report FROM opencrawl_value_reports WHERE namespace=$1 AND tenant_hash=$2',[ns,hash]);return rows[0]?.report??null;},
    async ready(){preparing??=(async()=>{await database.ready();await database.transaction(async client=>{await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:value-reports:schema',0))");await client.query('CREATE TABLE IF NOT EXISTS opencrawl_value_reports(namespace text NOT NULL,tenant_hash text NOT NULL,report jsonb NOT NULL,PRIMARY KEY(namespace,tenant_hash))');});})().catch(error=>{preparing=undefined;throw error;});await preparing;},
    async read(tenant){const {rows}=await database.pool.query('SELECT report FROM opencrawl_value_reports WHERE namespace=$1 AND tenant_hash=$2',[ns,tenantHash(tenant)]);return rows[0]?parseValueReport(JSON.stringify(rows[0].report)):null;},
    async write(tenant,value){const bytes=encode(value);if(!parseValueReport(bytes))throw new Error('Unsupported value report');await database.pool.query('INSERT INTO opencrawl_value_reports(namespace,tenant_hash,report) VALUES($1,$2,$3::jsonb) ON CONFLICT(namespace,tenant_hash) DO UPDATE SET report=EXCLUDED.report',[ns,tenantHash(tenant),bytes]);},
    async importReport(hash,input){if(!/^[a-f0-9]{64}$/.test(hash))throw new Error('Invalid value report owner');const bytes=encode(input);await database.pool.query('INSERT INTO opencrawl_value_reports(namespace,tenant_hash,report) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING',[ns,hash,bytes]);const {rows}=await database.pool.query('SELECT report FROM opencrawl_value_reports WHERE namespace=$1 AND tenant_hash=$2',[ns,hash]);if(!isDeepStrictEqual(input,rows[0].report))throw new Error('Value report import conflicts with existing data');return rows[0].report;},
  };
}
