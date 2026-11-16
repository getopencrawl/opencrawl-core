import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createSearchContextJobs} from '../dist/src/state/search-context-jobs.mjs';
import {createApplicationState} from '../dist/src/state/application.mjs';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
const source={version:1,bucket:'fixture-bucket',prefix:'sessions/production/v1',organizationId:null};
const binding={environment:'production',bucket:source.bucket,prefix:source.prefix,endpoint:'https://search.fixture.invalid',generation:'v1'};
async function fixture(t){const database=await applicationDatabaseFixture(t,{sourceIdentity:source});await database.pool.query("INSERT INTO opencrawl_application_installations(namespace,source_identity,migration_id,state,verified_at,inventory_complete) VALUES($1,$2::jsonb,$3,'ready',now(),true)",[database.namespace,JSON.stringify(source),randomUUID()]);const jobs=createSearchContextJobs({database,binding});await jobs.ready();return {database,jobs};}
const request={tenantId:'org_fixture',maxPassages:10,sourceConcurrency:2};
const page={passages:3,skippedDeleted:1,after:['cursor'],complete:false};

test('search-context commands and checkpoints survive replacement without accepting another source',{skip:!postgresUrl},async t=>{
 const {database,jobs}=await fixture(t),jobId=randomUUID(),ref=await jobs.create({...request,jobId});assert.deepEqual(await jobs.create({...request,jobId}),ref);
 await assert.rejects(jobs.create({...request,jobId,tenantId:'org_other'}),{status:409});
 await assert.rejects(jobs.read({...ref,sourceId:'f'.repeat(64)}),{status:403});
 await assert.rejects(jobs.execute(ref,async execution=>{await execution.save(page);throw Error('worker stopped');}),/worker stopped/);
 const restarted=createSearchContextJobs({database,binding});assert.deepEqual((await restarted.read(ref)).report,page);
 await restarted.execute(ref,async execution=>{assert.deepEqual(execution.progress,page);await execution.finish({...page,passages:9},false);});assert.equal((await jobs.read(ref)).status,'incomplete');
 const next=await jobs.create({...request});await jobs.execute(next,async execution=>{assert.equal(execution.progress.passages,0);assert.deepEqual(execution.progress.after,['cursor']);await execution.finish({passages:0,skippedDeleted:0,after:null,complete:true},true);});
 assert.equal((await jobs.read(next)).status,'complete');assert.deepEqual((await jobs.pending()).references,[]);
 await database.pool.query("UPDATE opencrawl_application_installations SET source_identity=$2::jsonb WHERE namespace=$1",[database.namespace,JSON.stringify({...source,bucket:'foreign'})]);
 await assert.rejects(jobs.read(ref),/source binding/);
});
test('search-context serialization fences simultaneous commands per tenant and retains failed pages',{skip:!postgresUrl},async t=>{
 const {jobs}=await fixture(t),first=await jobs.create(request),second=await jobs.create(request),started=Promise.withResolvers(),gate=Promise.withResolvers();
 const running=jobs.execute(first,async execution=>{await execution.save(page);started.resolve();await gate.promise;});await started.promise;
 try{await assert.rejects(jobs.execute(second,async()=>assert.fail('concurrent mutation')),{status:409});}finally{gate.resolve();}await running;
 await jobs.execute(second,async execution=>{assert.deepEqual(execution.progress.after,page.after);});
 assert.equal((await jobs.pending()).references.length,2);
});
test('completion requires verification, bounded progress and exact namespace scope',{skip:!postgresUrl},async t=>{
 const {jobs}=await fixture(t),ref=await jobs.create(request);
 await jobs.execute(ref,async execution=>{await assert.rejects(execution.save({...page,passages:100}),/Invalid/);await assert.rejects(execution.finish({...page,after:null,complete:true},false),/verified/);await execution.save(page);await assert.rejects(execution.save({...page,passages:0}),/Invalid/);});
 assert.equal((await jobs.read(ref)).status,'pending');assert.deepEqual((await jobs.read(ref)).report,page);
});
test('read-only application-state construction performs no preparation and missing schema fails closed',async()=>{
 let queries=0;const database={namespace:'read-only',ready:async()=>assert.fail('schema preparation forbidden'),transaction:async()=>assert.fail('transaction forbidden'),pool:{query:async sql=>{queries++;assert.match(sql,/^SELECT /i);throw Object.assign(Error('missing schema'),{code:'42P01'});}}};
 const state=await createApplicationState({database,prepareSchema:false});assert.equal(queries,0);
 await assert.rejects(state.indexingReceipts.read('fixture'),{code:'42P01'});assert.equal(queries,1);
});

test('contradictory persisted completion cannot masquerade as a verified outcome',{skip:!postgresUrl},async t=>{
 const {database,jobs}=await fixture(t),ref=await jobs.create(request);
 await database.pool.query("UPDATE opencrawl_search_context_jobs SET status='complete',report=$4::jsonb WHERE namespace=$1 AND source_id=$2 AND job_id=$3",[database.namespace,ref.sourceId,ref.jobId,JSON.stringify(page)]);
 await assert.rejects(jobs.read(ref),{status:503});await assert.rejects(jobs.execute(ref,async()=>assert.fail('corrupt completion must not execute')),{status:503});
});
