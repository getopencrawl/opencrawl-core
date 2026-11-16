import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {requireApplicationStateReady,type ApplicationDatabase} from './postgres.mjs';
import type {SearchContextMigrationReport} from '../sessions/search-context-migration.mjs';
const fail=(message:string,status=409)=>Object.assign(new Error(message),{status});
const tenant=z.string().regex(/^(org_[A-Za-z0-9]+|personal:user_[A-Za-z0-9]+)$/),uuid=z.string().uuid();
const cursor=z.array(z.union([z.string().max(16384),z.number().finite(),z.null()])).max(8).nullable();
const reportSchema=z.object({passages:z.number().int().nonnegative(),skippedDeleted:z.number().int().nonnegative(),after:cursor,complete:z.boolean()}).strict();
const bindingSchema=z.object({environment:z.string().regex(/^[a-z0-9-]{1,40}$/),bucket:z.string().min(1).max(255),prefix:z.string().min(1).max(1024),endpoint:z.string().url().max(2048),generation:z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)}).strict();
export type SearchContextBinding=z.infer<typeof bindingSchema>;
export interface SearchContextReference {sourceId:string;jobId:string}
export interface SearchContextJob extends SearchContextReference {continuationId?:string;tenantId:string;maxPassages:number;sourceConcurrency:number;status:'pending'|'complete'|'incomplete';report:SearchContextMigrationReport|null}
export interface SearchContextExecution {job:SearchContextJob;progress:SearchContextMigrationReport;save(report:SearchContextMigrationReport):Promise<void>;finish(report:SearchContextMigrationReport,verified:boolean):Promise<void>}
export interface SearchContextJobs {
 readonly sourceId:string;readonly binding:SearchContextBinding;
 ready():Promise<void>;assertBinding():Promise<void>;
 create(input:{jobId?:string;tenantId:string;maxPassages:number;sourceConcurrency:number}):Promise<SearchContextReference>;
 read(reference:SearchContextReference):Promise<SearchContextJob|null>;
 pending(input?:{cursor?:string;limit?:number}):Promise<{references:SearchContextReference[];cursor?:string}>;
 execute<T>(reference:SearchContextReference,run:(execution:SearchContextExecution)=>Promise<T>):Promise<T|SearchContextJob>;
}
/** Only the missing-search-context maintenance operation uses these commands.
 * Content and search documents never enter this repository. */
export function createSearchContextJobs({database,binding:input}:{database:ApplicationDatabase;binding:SearchContextBinding}):SearchContextJobs{
 const binding=Object.freeze(bindingSchema.parse(input)),source=database.sourceIdentity;
 if(!source||source.version!==1||source.bucket!==binding.bucket||source.prefix!==binding.prefix)throw fail('Search context source binding mismatch',403);
 const sourceId=createHash('sha256').update(JSON.stringify([database.namespace,source,binding])).digest('hex'),ns=database.namespace;
 const reference=(value:SearchContextReference)=>{uuid.parse(value.jobId);if(value.sourceId!==sourceId)throw fail('Search context command scope mismatch',403);};
 const scope=(value:string)=>{tenant.parse(value);if(source.organizationId&&source.organizationId!==value)throw fail('Search context tenant scope mismatch',403);};
 const decode=(row:Record<string,unknown>):SearchContextJob=>{
  const value:SearchContextJob={sourceId,jobId:uuid.parse(row.job_id),...(row.continuation_id?{continuationId:uuid.parse(row.continuation_id)}:{}),tenantId:tenant.parse(row.tenant_id),maxPassages:z.number().int().min(1).max(100000).parse(row.max_passages),sourceConcurrency:z.number().int().min(1).max(16).parse(row.source_concurrency),status:z.enum(['pending','complete','incomplete']).parse(row.status),report:row.report===null?null:reportSchema.parse(row.report)};
  if(value.report&&(value.report.passages+value.report.skippedDeleted>value.maxPassages||value.report.complete&&value.report.after!==null)||value.status!=='pending'&&(!value.report||value.report.complete!==(value.status==='complete')))throw fail('Invalid persisted search context outcome',503);
  return value;
 };
 async function assertBinding(){await requireApplicationStateReady(database);}
 async function read(ref:SearchContextReference){reference(ref);await assertBinding();const {rows}=await database.pool.query('SELECT * FROM opencrawl_search_context_jobs WHERE namespace=$1 AND source_id=$2 AND job_id=$3',[ns,sourceId,ref.jobId]);if(rows[0]&&!isDeepStrictEqual(rows[0].binding,binding))throw fail('Search context stored binding mismatch',403);return rows[0]?decode(rows[0]):null;}
 let prepared:Promise<void>|undefined;
 return {sourceId,binding,assertBinding,read,
  async ready(){prepared??=(async()=>{await database.ready();await assertBinding();await database.transaction(async client=>{await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:search-context-jobs:schema',0))");await client.query(`
   CREATE TABLE IF NOT EXISTS opencrawl_search_context_jobs(namespace text NOT NULL REFERENCES opencrawl_application_installations(namespace),source_id text NOT NULL,job_id uuid NOT NULL,tenant_id text NOT NULL,binding jsonb NOT NULL,max_passages integer NOT NULL CHECK(max_passages BETWEEN 1 AND 100000),source_concurrency integer NOT NULL CHECK(source_concurrency BETWEEN 1 AND 16),continuation_id uuid,status text NOT NULL CHECK(status IN ('pending','complete','incomplete')),report jsonb,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(namespace,source_id,job_id));
   ALTER TABLE opencrawl_search_context_jobs ADD COLUMN IF NOT EXISTS continuation_id uuid;
   CREATE INDEX IF NOT EXISTS opencrawl_search_context_pending ON opencrawl_search_context_jobs(namespace,source_id,job_id) WHERE status='pending';
   CREATE TABLE IF NOT EXISTS opencrawl_search_context_checkpoints(namespace text NOT NULL REFERENCES opencrawl_application_installations(namespace),source_id text NOT NULL,tenant_id text NOT NULL,report jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(namespace,source_id,tenant_id));
  `);});})().catch(error=>{prepared=undefined;throw error;});await prepared;},
  async create({jobId=randomUUID(),tenantId,maxPassages,sourceConcurrency}){uuid.parse(jobId);scope(tenantId);z.number().int().min(1).max(100000).parse(maxPassages);z.number().int().min(1).max(16).parse(sourceConcurrency);await assertBinding();
   return database.transaction(async client=>{await client.query(`INSERT INTO opencrawl_search_context_jobs(namespace,source_id,job_id,tenant_id,binding,max_passages,source_concurrency,status) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,'pending') ON CONFLICT DO NOTHING`,[ns,sourceId,jobId,tenantId,JSON.stringify(binding),maxPassages,sourceConcurrency]);const {rows}=await client.query('SELECT * FROM opencrawl_search_context_jobs WHERE namespace=$1 AND source_id=$2 AND job_id=$3',[ns,sourceId,jobId]);const record=decode(rows[0]);if(record.continuationId||record.tenantId!==tenantId||record.maxPassages!==maxPassages||record.sourceConcurrency!==sourceConcurrency||!isDeepStrictEqual(rows[0].binding,binding))throw fail('Search context request identity reused with different scope');return {sourceId,jobId};});
  },
  async pending({cursor:after,limit=100}={}){if(after)uuid.parse(after);z.number().int().min(1).max(100).parse(limit);await assertBinding();const {rows}=await database.pool.query(`SELECT job_id FROM opencrawl_search_context_jobs WHERE namespace=$1 AND source_id=$2 AND status='pending' AND continuation_id IS NULL AND ($3::uuid IS NULL OR job_id>$3) ORDER BY job_id LIMIT $4`,[ns,sourceId,after??null,limit+1]);return {references:rows.slice(0,limit).map(row=>({sourceId,jobId:uuid.parse(row.job_id)})),...(rows.length>limit?{cursor:uuid.parse(rows[limit-1].job_id)}:{})};},
  async execute(ref,run){reference(ref);await assertBinding();const first=await read(ref);if(!first)throw fail('Search context command not found',404);scope(first.tenantId);
   const client=await database.pool.connect(),lock=JSON.stringify([ns,sourceId,'search-context',first.tenantId]);let acquired=false,destroy=false;
   try{
    acquired=(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[lock])).rows[0]?.acquired===true;if(!acquired)throw fail('Search context operation already running');
    const job=await read(ref);if(!job)throw fail('Search context command not found',404);if(job.status!=='pending')return job;
    const saved=await client.query('SELECT report FROM opencrawl_search_context_checkpoints WHERE namespace=$1 AND source_id=$2 AND tenant_id=$3',[ns,sourceId,job.tenantId]);
    let progress=job.report??{passages:0,skippedDeleted:0,after:saved.rows[0]?reportSchema.parse(saved.rows[0].report).after:null,complete:false};
    async function save(next:SearchContextMigrationReport,status:'pending'|'complete'|'incomplete'='pending'){
     const value=reportSchema.parse(next);if(value.passages<progress.passages||value.skippedDeleted<progress.skippedDeleted||value.passages+value.skippedDeleted>job!.maxPassages||value.complete&&value.after!==null)throw fail('Invalid search context checkpoint progress');
     await client.query('BEGIN');try{const result=await client.query(`UPDATE opencrawl_search_context_jobs SET report=$4::jsonb,status=$5,updated_at=now() WHERE namespace=$1 AND source_id=$2 AND job_id=$3 AND status='pending'`,[ns,sourceId,ref.jobId,JSON.stringify(value),status]);if(result.rowCount!==1)throw fail('Search context command changed');await client.query(`INSERT INTO opencrawl_search_context_checkpoints(namespace,source_id,tenant_id,report) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(namespace,source_id,tenant_id) DO UPDATE SET report=EXCLUDED.report,updated_at=now()`,[ns,sourceId,job!.tenantId,JSON.stringify(value)]);await client.query('COMMIT');progress=value;}catch(error){try{await client.query('ROLLBACK');}catch{destroy=true;}throw error;}
    }
    return await run({job,progress,save:next=>save(next),finish:async(next,verified)=>{if(next.complete!==verified)throw fail('Search context completion is not verified');await save(next,verified?'complete':'incomplete');}});
   }finally{if(acquired&&!destroy)try{await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lock]);}catch{destroy=true;}client.release(destroy);}
  },
 };
}
