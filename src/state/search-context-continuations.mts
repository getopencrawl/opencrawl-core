import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import type {ApplicationDatabase} from './postgres.mjs';
import {createSearchContextJobs,type SearchContextBinding,type SearchContextReference} from './search-context-jobs.mjs';

const hash=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.string().uuid(),tenant=z.string().regex(/^(org_[A-Za-z0-9]+|personal:user_[A-Za-z0-9]+)$/);
const fail=(message:string,status=409)=>Object.assign(new Error(message),{status});
const LIMIT=10000;
function id(parts:unknown[]){const bytes=createHash('sha256').update(JSON.stringify(parts)).digest();bytes[6]=(bytes[6]!&15)|80;bytes[8]=(bytes[8]!&63)|128;const hex=bytes.subarray(0,16).toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;}
export interface SearchContextContinuationReference {sourceId:string;continuationId:string}
export interface SearchContextContinuation extends SearchContextContinuationReference {tenantId:string;sourceReceipt:string;maxPassages:number;sourceConcurrency:number;segment:number;currentJobId:string;status:'pending'|'complete'|'blocked';failure:'NO_PROGRESS'|'SEGMENT_LIMIT'|null}
/** A migration-authorized command, separate from its bounded current-generation
 * segment jobs. Legacy cursors never enter this repository. */
export function createSearchContextContinuations({database,binding}:{database:ApplicationDatabase;binding:SearchContextBinding}){
 const jobs=createSearchContextJobs({database,binding}),sourceId=jobs.sourceId,ns=database.namespace;
 const ref=(value:SearchContextContinuationReference)=>{uuid.parse(value.continuationId);if(value.sourceId!==sourceId)throw fail('Search context continuation scope mismatch',403);};
 const decode=(row:Record<string,unknown>):SearchContextContinuation=>{
  if(!isDeepStrictEqual(row.binding,jobs.binding))throw fail('Search context continuation binding changed',403);
  return {sourceId,continuationId:uuid.parse(row.continuation_id),tenantId:tenant.parse(row.tenant_id),sourceReceipt:hash.parse(row.source_receipt),maxPassages:z.number().int().min(1).max(100000).parse(row.max_passages),sourceConcurrency:z.number().int().min(1).max(16).parse(row.source_concurrency),segment:z.number().int().min(0).max(LIMIT-1).parse(row.segment),currentJobId:uuid.parse(row.current_job_id),status:z.enum(['pending','complete','blocked']).parse(row.status),failure:z.enum(['NO_PROGRESS','SEGMENT_LIMIT']).nullable().parse(row.failure)};
 };
 async function read(reference:SearchContextContinuationReference){ref(reference);await jobs.assertBinding();const {rows}=await database.pool.query('SELECT * FROM opencrawl_search_context_continuations WHERE namespace=$1 AND source_id=$2 AND continuation_id=$3',[ns,sourceId,reference.continuationId]);if(!rows[0])return null;const command=decode(rows[0]);if(command.currentJobId!==id([sourceId,command.continuationId,command.segment]))throw fail('Search context continuation segment identity changed',403);if(command.status==='complete'){const final=await jobs.read({sourceId,jobId:command.currentJobId});if(!final||final.tenantId!==command.tenantId||final.continuationId!==command.continuationId||final.status!=='complete'||final.report?.complete!==true||final.report.after!==null)throw fail('Search context continuation verification receipt differs',503);}return command;}
 async function insertSegment(client:PoolClient,command:Pick<SearchContextContinuation,'continuationId'|'tenantId'|'maxPassages'|'sourceConcurrency'>,segment:number,after:unknown[]|null){
  const jobId=id([sourceId,command.continuationId,segment]),report={passages:0,skippedDeleted:0,after,complete:false};
  const inserted=await client.query(`INSERT INTO opencrawl_search_context_jobs(namespace,source_id,job_id,tenant_id,binding,max_passages,source_concurrency,status,report,continuation_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,'pending',$8::jsonb,$9) ON CONFLICT DO NOTHING`,[ns,sourceId,jobId,command.tenantId,JSON.stringify(jobs.binding),command.maxPassages,command.sourceConcurrency,JSON.stringify(report),command.continuationId]);
  if(inserted.rowCount!==1)throw fail('Search context segment identity already exists');return jobId;
 }
 let prepared:Promise<void>|undefined;
 return {sourceId,binding:jobs.binding,read,
  reference(input:{tenantId:string;sourceReceipt:string}){tenant.parse(input.tenantId);hash.parse(input.sourceReceipt);if(database.sourceIdentity?.organizationId&&database.sourceIdentity.organizationId!==input.tenantId)throw fail('Search context continuation tenant mismatch',403);return {sourceId,continuationId:id([sourceId,input.tenantId,input.sourceReceipt])};},
  async ready(){prepared??=(async()=>{await jobs.ready();await database.transaction(async client=>{await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:search-context-continuations:schema',0))");await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_search_context_continuations(namespace text NOT NULL REFERENCES opencrawl_application_installations(namespace),source_id text NOT NULL,continuation_id uuid NOT NULL,tenant_id text NOT NULL,source_receipt text NOT NULL,binding jsonb NOT NULL,max_passages integer NOT NULL CHECK(max_passages BETWEEN 1 AND 100000),source_concurrency integer NOT NULL CHECK(source_concurrency BETWEEN 1 AND 16),segment integer NOT NULL CHECK(segment BETWEEN 0 AND 9999),current_job_id uuid NOT NULL,status text NOT NULL CHECK(status IN ('pending','complete','blocked')),failure text CHECK(failure IN ('NO_PROGRESS','SEGMENT_LIMIT')),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(namespace,source_id,continuation_id),CHECK((status='blocked')=(failure IS NOT NULL))); CREATE INDEX IF NOT EXISTS opencrawl_search_context_continuation_pending ON opencrawl_search_context_continuations(namespace,source_id,continuation_id) WHERE status='pending'`);});})().catch(error=>{prepared=undefined;throw error;});await prepared;},
  async create(input:{tenantId:string;sourceReceipt:string;maxPassages:number;sourceConcurrency:number}){
   tenant.parse(input.tenantId);hash.parse(input.sourceReceipt);z.number().int().min(1).max(100000).parse(input.maxPassages);z.number().int().min(1).max(16).parse(input.sourceConcurrency);
   if(database.sourceIdentity?.organizationId&&database.sourceIdentity.organizationId!==input.tenantId)throw fail('Search context continuation tenant mismatch',403);await jobs.assertBinding();
   const continuationId=id([sourceId,input.tenantId,input.sourceReceipt]),reference={sourceId,continuationId};
   return database.transaction(async client=>{await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([ns,sourceId,'search-context-continuation-create',continuationId])]);const existing=await client.query('SELECT * FROM opencrawl_search_context_continuations WHERE namespace=$1 AND source_id=$2 AND continuation_id=$3',[ns,sourceId,continuationId]);if(existing.rows[0]){const value=decode(existing.rows[0]);if(value.tenantId!==input.tenantId||value.sourceReceipt!==input.sourceReceipt||value.maxPassages!==input.maxPassages||value.sourceConcurrency!==input.sourceConcurrency)throw fail('Search context continuation request changed');return reference;}
    // Explicit initial report bypasses any unrelated current checkpoint. This is
    // a new missing-only scan under the current binding, never a legacy resume.
    const currentJobId=await insertSegment(client,{...input,continuationId},0,null);await client.query(`INSERT INTO opencrawl_search_context_continuations(namespace,source_id,continuation_id,tenant_id,source_receipt,binding,max_passages,source_concurrency,segment,current_job_id,status) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,0,$9,'pending')`,[ns,sourceId,continuationId,input.tenantId,input.sourceReceipt,JSON.stringify(jobs.binding),input.maxPassages,input.sourceConcurrency,currentJobId]);return reference;
   });
  },
  async pending({cursor,limit=100}:{cursor?:string;limit?:number}={}){if(cursor)uuid.parse(cursor);z.number().int().min(1).max(100).parse(limit);await jobs.assertBinding();const {rows}=await database.pool.query(`SELECT continuation_id FROM opencrawl_search_context_continuations WHERE namespace=$1 AND source_id=$2 AND status='pending' AND ($3::uuid IS NULL OR continuation_id>$3) ORDER BY continuation_id LIMIT $4`,[ns,sourceId,cursor??null,limit+1]);return {references:rows.slice(0,limit).map(row=>({sourceId,continuationId:uuid.parse(row.continuation_id)})),...(rows.length>limit?{cursor:uuid.parse(rows[limit-1].continuation_id)}:{})};},
  async advance(reference:SearchContextContinuationReference,execute:(segment:SearchContextReference)=>Promise<unknown>){
   ref(reference);await jobs.assertBinding();const command=await read(reference);if(!command)throw fail('Search context continuation not found',404);if(command.status!=='pending')return command;
   const segment={sourceId,jobId:command.currentJobId},before=await jobs.read(segment);if(!before||before.tenantId!==command.tenantId||before.continuationId!==command.continuationId||before.maxPassages!==command.maxPassages||before.sourceConcurrency!==command.sourceConcurrency)throw fail('Search context continuation segment differs',403);
   // The existing segment executor owns the tenant writer lock. Do not retain a
   // second pool connection while it performs source I/O or verification.
   await execute(segment);const saved=await jobs.read(segment);if(!saved||saved.status==='pending'||!saved.report)throw fail('Search context segment did not durably finish',503);
   const complete=saved.status==='complete',failure=!complete&&saved.report.passages+saved.report.skippedDeleted===0?'NO_PROGRESS':!complete&&command.segment+1>=LIMIT?'SEGMENT_LIMIT':null;
   await database.transaction(async client=>{
    const {rows}=await client.query('SELECT * FROM opencrawl_search_context_continuations WHERE namespace=$1 AND source_id=$2 AND continuation_id=$3 FOR UPDATE',[ns,sourceId,reference.continuationId]);if(!rows[0])throw fail('Search context continuation disappeared');const current=decode(rows[0]);
    // A concurrent retry may already have committed this completed segment.
    // Never advance a different segment using a stale activity response.
    if(current.status!=='pending'||current.currentJobId!==command.currentJobId)return;
    const next=complete||failure?command.currentJobId:await insertSegment(client,command,command.segment+1,saved.report!.after);
    await client.query(`UPDATE opencrawl_search_context_continuations SET status=$4,failure=$5,current_job_id=$6,segment=$7,updated_at=now() WHERE namespace=$1 AND source_id=$2 AND continuation_id=$3`,[ns,sourceId,reference.continuationId,complete?'complete':failure?'blocked':'pending',failure,next,complete||failure?command.segment:command.segment+1]);
   });return (await read(reference))!;
  },
 };
}
