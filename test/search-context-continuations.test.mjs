import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createSearchContextContinuations} from '../dist/src/state/search-context-continuations.mjs';
import {createSearchContextJobs} from '../dist/src/state/search-context-jobs.mjs';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
const source={version:1,bucket:'fixture-bucket',prefix:'sessions/production/v1',organizationId:null},binding={environment:'production',bucket:source.bucket,prefix:source.prefix,endpoint:'https://search.fixture.invalid',generation:'v1'};
const input={tenantId:'org_fixture',sourceReceipt:'a'.repeat(64),maxPassages:2,sourceConcurrency:1};
async function fixture(t,boundSource=source){const database=await applicationDatabaseFixture(t,{sourceIdentity:boundSource});await database.pool.query("INSERT INTO opencrawl_application_installations(namespace,source_identity,migration_id,state,verified_at,inventory_complete) VALUES($1,$2::jsonb,$3,'ready',now(),true)",[database.namespace,JSON.stringify(boundSource),randomUUID()]);const continuations=createSearchContextContinuations({database,binding}),jobs=createSearchContextJobs({database,binding});await continuations.ready();return {database,jobs,continuations};}
const page=(after,complete=false)=>({passages:2,skippedDeleted:0,after,complete});

test('bounded continuation starts fresh, atomically advances and survives lost response without reusing unrelated cursors',{skip:!postgresUrl},async t=>{
 const {database,jobs,continuations}=await fixture(t);const unrelated=await jobs.create({tenantId:input.tenantId,maxPassages:2,sourceConcurrency:1});await jobs.execute(unrelated,e=>e.finish(page(['unrelated-old']),false));
 const ref=await continuations.create(input);assert.deepEqual((await jobs.pending()).references,[],'ordinary recovery must not dispatch continuation-owned segments');assert.deepEqual(await continuations.create(input),ref);await assert.rejects(continuations.create({...input,maxPassages:3}),{status:409});
 let calls=0;const execute=r=>jobs.execute(r,async e=>{calls++;assert.equal(e.progress.after,null);await e.finish(page(['new-1']),false);throw Error('response lost after durable segment');});
 await assert.rejects(continuations.advance(ref,execute),/response lost/);assert.equal((await continuations.read(ref)).segment,0);
 const restarted=createSearchContextContinuations({database,binding});const next=await restarted.advance(ref,r=>jobs.execute(r,()=>assert.fail('completed segment reran')));assert.equal(next.segment,1);assert.equal(next.status,'pending');assert.equal(calls,1);
 const interference=await jobs.create({tenantId:input.tenantId,maxPassages:2,sourceConcurrency:1});await jobs.execute(interference,e=>e.finish(page(['unrelated-new']),false));
 await restarted.advance(ref,r=>jobs.execute(r,async e=>{assert.deepEqual(e.progress.after,['new-1']);await e.finish(page(['new-2']),false);}));
 const complete=await restarted.advance(ref,r=>jobs.execute(r,async e=>{assert.deepEqual(e.progress.after,['new-2']);await e.finish({passages:0,skippedDeleted:0,after:null,complete:true},true);}));assert.equal(complete.status,'complete');assert.equal(complete.segment,2);assert.deepEqual((await restarted.pending()).references,[]);
 await restarted.advance(ref,()=>assert.fail('verified continuation must not rerun'));
});
test('interrupted page resumes current segment and blocks explicit zero-progress outcome',{skip:!postgresUrl},async t=>{
 const {jobs,continuations}=await fixture(t),ref=await continuations.create(input);await assert.rejects(continuations.advance(ref,r=>jobs.execute(r,async e=>{await e.save({passages:1,skippedDeleted:0,after:['half'],complete:false});throw Error('worker interrupted');})),/interrupted/);
 await continuations.advance(ref,r=>jobs.execute(r,async e=>{assert.equal(e.progress.passages,1);assert.deepEqual(e.progress.after,['half']);await e.finish(page(['next']),false);}));
 const blocked=await continuations.advance(ref,r=>jobs.execute(r,e=>e.finish({passages:0,skippedDeleted:0,after:null,complete:false},false)));assert.equal(blocked.status,'blocked');assert.equal(blocked.failure,'NO_PROGRESS');assert.deepEqual((await continuations.pending()).references,[]);await continuations.advance(ref,()=>assert.fail('blocked command auto-restarted'));
});
test('next segment creation and command advance roll back together',{skip:!postgresUrl},async t=>{
 const {database,jobs,continuations}=await fixture(t),ref=await continuations.create(input),client=await database.pool.connect(),prototype=Object.getPrototypeOf(client),query=prototype.query;client.release();let reject=true;
 const observed=t.mock.method(prototype,'query',function(sql,...args){if(reject&&typeof sql==='string'&&sql.startsWith('UPDATE opencrawl_search_context_continuations')){reject=false;return Promise.reject(Error('transition storage failed'));}return query.call(this,sql,...args);});
 await assert.rejects(continuations.advance(ref,r=>jobs.execute(r,e=>e.finish(page(['next']),false))),/transition storage/);observed.mock.restore();assert.equal((await continuations.read(ref)).segment,0);
 assert.equal(Number((await database.pool.query('SELECT count(*) FROM opencrawl_search_context_jobs WHERE namespace=$1',[database.namespace])).rows[0].count),1);
 assert.equal((await continuations.advance(ref,r=>jobs.execute(r,()=>assert.fail('persisted segment must not rerun')))).segment,1);
});
test('simultaneous continuation activity is fenced and wrong source/endpoint cannot act',{skip:!postgresUrl},async t=>{
 const {database,jobs,continuations}=await fixture(t),ref=await continuations.create(input),started=Promise.withResolvers(),release=Promise.withResolvers();
 const running=continuations.advance(ref,r=>jobs.execute(r,async e=>{started.resolve();await release.promise;await e.finish(page(null,true),true);}));await started.promise;try{await assert.rejects(continuations.advance(ref,r=>jobs.execute(r,()=>assert.fail('parallel effect'))),{status:409});}finally{release.resolve();}await running;
 const wrong=createSearchContextContinuations({database,binding:{...binding,endpoint:'https://different.fixture.invalid'}});await assert.rejects(wrong.advance(ref,()=>assert.fail('wrong source effect')),{status:403});
 await database.pool.query("UPDATE opencrawl_application_installations SET source_identity=$2::jsonb WHERE namespace=$1",[database.namespace,JSON.stringify({...source,bucket:'different'})]);await assert.rejects(continuations.advance(ref,()=>assert.fail('drifted source effect')),/source binding/);
});
test('continuation refuses a foreign or unfinished segment and retains pending recovery',{skip:!postgresUrl},async t=>{
 const {database,continuations}=await fixture(t),ref=await continuations.create(input);await assert.rejects(continuations.advance(ref,async()=>{}),/durably finish/);assert.deepEqual((await continuations.pending()).references,[ref]);const cmd=await continuations.read(ref);await database.pool.query('UPDATE opencrawl_search_context_jobs SET tenant_id=$4 WHERE namespace=$1 AND source_id=$2 AND job_id=$3',[database.namespace,ref.sourceId,cmd.currentJobId,'org_foreign']);await assert.rejects(continuations.advance(ref,()=>assert.fail('foreign segment')),{status:403});
});

test('single-organization continuation uses only operator PostgreSQL and rejects a different tenant',{skip:!postgresUrl},async t=>{
 const {jobs,continuations}=await fixture(t,{...source,organizationId:'org_fixture'});await assert.rejects(continuations.create({...input,tenantId:'org_foreign'}),{status:403});assert.throws(()=>continuations.reference({tenantId:'org_foreign',sourceReceipt:input.sourceReceipt}),{status:403});const ref=await continuations.create(input);await continuations.advance(ref,r=>jobs.execute(r,e=>e.finish({passages:0,skippedDeleted:0,after:null,complete:true},true)));assert.equal((await continuations.read(ref)).status,'complete');
});
