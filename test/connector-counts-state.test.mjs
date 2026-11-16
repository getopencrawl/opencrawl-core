import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {gzipSync} from 'node:zlib';
import {createConnectorCounts,legacyCountsHash} from '../dist/src/state/connector-counts.mjs';
import {createRecordCounts,recordKey} from '../dist/src/integrations/counts.mjs';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
const record={environment:'selfhost',tenantId:'org_team',userId:'user_a',integrationId:'int_'+'a'.repeat(26),provider:'slack',status:'active',s3Bucket:'owned',s3Prefix:'raw/v1/source=slack/workspace=T123/connection=int_'+'a'.repeat(26)};
const object=(stream='messages',sync=1,part=1,fullRefresh=false)=>({key:record.s3Prefix+`/stream=${stream}/date=2026-01-01/sync=${sync}/${part}.jsonl.gz`,stream,sync,fullRefresh});
async function* keys(...values){for(const value of values)yield recordKey({id:value},['id']);}
async function fixture(t){const database=await applicationDatabaseFixture(t),repository=createConnectorCounts({database,legacyBucket:'owned'});await repository.ready();return {database,repository};}

test('normalized counts publish only completed objects and retry partial batches without double counting',{skip:!postgresUrl},async t=>{
 const {repository}=await fixture(t);const first=object();
 await assert.rejects(repository.processObject(record,first,(async function*(){for(let i=0;i<600;i++)yield recordKey({id:i},['id']);throw Error('interrupted raw read');})()),/interrupted/);
 await repository.publish(record,{});assert.equal(await repository.read(record),null);assert.equal((await repository.verify(record)).pending,1);
 await repository.processObject(record,first,keys(...Array.from({length:600},(_,i)=>i)));await repository.publish(record,{});assert.deepEqual(await repository.read(record),{messages:600});
 await repository.processObject(record,object('messages',2),keys(0,1,600));await repository.publish(record,{});assert.deepEqual(await repository.read(record),{messages:601});
 await repository.processObject(record,first,(async function*(){assert.fail('Completed raw object must not be read');})());
 assert.deepEqual(await repository.verify(record),{counts:{messages:601},records:601,objects:2,pending:0});
});

test('full refresh counts select one sync while incremental hashes deduplicate across syncs',{skip:!postgresUrl},async t=>{
 const {repository}=await fixture(t);
 await repository.processObject(record,object('users',1,1,true),keys('one','two'));await repository.publish(record,{users:1});assert.deepEqual(await repository.read(record),{users:2});
 await repository.processObject(record,object('users',2,1,true),keys('three'));await repository.publish(record,{users:2});assert.deepEqual(await repository.read(record),{users:1});
 await repository.processObject(record,object('users',3,1,true),keys());await repository.publish(record,{users:3});assert.deepEqual(await repository.read(record),{users:0});
});

test('removal tombstone rejects paused or new measurement writes and scopes isolate IDs',{skip:!postgresUrl},async t=>{
 const {repository}=await fixture(t),paused=Promise.withResolvers(),release=Promise.withResolvers();
 const writing=repository.processObject(record,object(),(async function*(){yield*keys('first');paused.resolve();await release.promise;yield*keys('second');})());await paused.promise;
 await repository.remove(record);release.resolve();await assert.rejects(writing,/closed/);assert.equal(await repository.read(record),null);
 await assert.rejects(repository.processObject(record,object('messages',2),keys('third')),/closed/);await assert.rejects(repository.publish(record,{}),/closed/);
 const other={...record,tenantId:'org_other'};await repository.processObject(other,object(),keys('separate'));await repository.publish(other,{});assert.deepEqual(await repository.read(other),{messages:1});
});

test('legacy counts import preserves hashes, full summaries and exact object checkpoints idempotently',{skip:!postgresUrl},async t=>{
 const {repository}=await fixture(t),saved={version:1,read:[object().key],ids:{messages:[recordKey({id:'old'},['id'])]},full:{users:{sync:3,count:9}}};
 const receipt=await repository.importLegacyCounts(record,saved);assert.equal(receipt.records,1);assert.equal(receipt.objects,1);assert.match(receipt.hash,/^[a-f0-9]{64}$/);assert.equal(receipt.hash,legacyCountsHash(saved));assert.equal(legacyCountsHash(await repository.exportLegacyCounts(record)),legacyCountsHash(saved));
 assert.deepEqual(await repository.read(record),{messages:1,users:9});await repository.importLegacyCounts(record,saved);
 await repository.processObject(record,object('messages',2),keys('old','new'));await repository.publish(record,{});assert.deepEqual(await repository.read(record),{messages:2,users:9});
 await assert.rejects(repository.importLegacyCounts(record,{...saved,read:['raw/other/stream=messages/date=d/sync=1/x.jsonl.gz']}),/scope/);
});

test('measurement reads touch SQL only; explicit refresh streams raw content and never writes object storage',{skip:!postgresUrl},async t=>{
 const {repository}=await fixture(t);let scans=0,streams=0;
 const buckets={list:async()=>{scans++;return [{key:object().key,size:1}];},stream:async()=>{streams++;return Readable.from(gzipSync(JSON.stringify({_airbyte_data:{id:1}})+'\n'));},read:async()=>assert.fail('Counts are not blob state'),write:async()=>assert.fail('Counts are not blob state')};
 const counts=createRecordCounts({repository,buckets,legacyBucket:'owned'}),provider={streams:[],keys:{messages:['id']}};
 assert.equal(await counts.get(record),null);assert.equal(scans,0);await counts.refresh(record,provider,new Set([1]));assert.deepEqual(await counts.get(record),{messages:1});assert.equal(streams,1);await counts.refresh(record,provider,new Set([1]));assert.equal(streams,1);
});

test('a completed full-refresh measurement never publishes only part of its object set',{skip:!postgresUrl},async t=>{
 const {repository}=await fixture(t),first=object('users',1,1,true),second=object('users',1,2,true);
 await repository.processObject(record,first,keys('one'));await repository.publish(record,{users:1},{users:[first.key,second.key]});assert.equal(await repository.read(record),null);
 await repository.processObject(record,second,keys('two'));await repository.publish(record,{users:1},{users:[first.key,second.key]});assert.deepEqual(await repository.read(record),{users:2});
});
