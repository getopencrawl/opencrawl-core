import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {gzipSync} from 'node:zlib';
import {MockActivityEnvironment} from '@temporalio/testing';
import {createRecordCounts, createCountMeasurement} from '../dist/src/integrations/counts.mjs';
import {connectorActivities} from '../dist/src/connectors/temporal/worker.mjs';
import {withTestState} from './fixtures/memory-application-state.mjs';

function fixture(size = 1) {
  const record = {environment:'selfhost',tenantId:'org_team',userId:'user_a',integrationId:'int_'+'a'.repeat(26),provider:'slack',status:'active',s3Bucket:'owned',s3Prefix:'raw/v1/source=slack/workspace=T123/connection=int_'+'a'.repeat(26),airbyte:{connectionId:'source-a'}};
  const provider = {streams:[{name:'users',syncMode:'full_refresh'}],keys:{channel_messages:['ts'],users:['id']}};
  const binding = {tenantId:record.tenantId,connectionId:record.integrationId,workspaceId:'T123',provider:'slack',access:'team-public',rawPrefix:record.s3Prefix+'/'};
  const object = (stream, sync, part) => `${binding.rawPrefix}stream=${stream}/date=2026-11-16/sync=${sync}/${part}.jsonl.gz`;
  const raw = new Map(Array.from({length:size},(_,i)=>[object('channel_messages',1,i),gzipSync(JSON.stringify({_airbyte_extracted_at:1000,_airbyte_data:{channel_id:'C123',ts:`1234567890.${String(i).padStart(6,'0')}`,text:'fixture'}}))]));
  const staged = new Set(), calls = {listings:0,entries:0,jobs:0,streams:0,publications:0,processes:0,resolutions:0};
  let failure, published;
  const repository = {
    async processObject(_record, item, ids, check) {
      calls.processes++;
      if(staged.has(item.key))return;
      for await(const id of ids){check();assert.equal(typeof id,'string');}
      if(failure){const error=failure;failure=null;throw error;}
      staged.add(item.key);
    },
    async publish(_record, full, expected){calls.publications++;published={full,expected};},
  };
  const buckets = {
    async list(bucket,prefix){assert.equal(bucket,record.s3Bucket);assert.equal(prefix,record.s3Prefix+'/');calls.listings++;calls.entries+=raw.size;return [...raw.keys()].map(key=>({key,size:1}));},
    async stream(bucket,key){assert.equal(bucket,record.s3Bucket);calls.streams++;return Readable.from(raw.get(key));},
  };
  const counts=createRecordCounts({buckets,legacyBucket:'fallback',repository});
  let jobs = async()=>[{jobId:1,status:'succeeded'}];
  const measurement=createCountMeasurement({counts,resolve:async()=>{calls.resolutions++;return {record:{...record,airbyte:{...record.airbyte}},provider};},jobs:async(id,limit)=>{assert.equal(id,'source-a');assert.equal(limit,100);calls.jobs++;return jobs();}});
  const store={bucket:'owned',get:async key=>raw.get(key),listPage:async()=>({keys:[...raw.keys()],nextToken:null})};
  const search={identity:'fixture-search',ensureIndex:async()=>{},putDocuments:async()=>{}};
  const resolved=withTestState({binding,store,search,...measurement});
  const activities=connectorActivities({resolve:async()=>resolved}),env=new MockActivityEnvironment();
  return {record,provider,raw,object,staged,calls,counts,measurement,activities,env,failOnce:error=>{failure=error;},setJobs:value=>{jobs=value;},published:()=>published};
}

for(const size of [100,1000]) test(`real object activities: ${size} objects and receipt retries use one inventory/job/publication per sweep`,async()=>{
  const f=fixture(size),keys=[...f.raw.keys()];
  for(const key of keys)await f.env.run(f.activities.processObject,{key});
  assert.equal(f.calls.listings,0);assert.equal(f.calls.jobs,0);assert.equal(f.calls.publications,0);
  await f.env.run(f.activities.completeSweep,{});
  assert.deepEqual({listings:f.calls.listings,entries:f.calls.entries,jobs:f.calls.jobs,publications:f.calls.publications,streams:f.calls.streams},{listings:1,entries:size,jobs:1,publications:1,streams:size});
  for(const key of keys)assert.equal((await f.env.run(f.activities.processObject,{key})).status,'already-indexed');
  await f.env.run(f.activities.completeSweep,{});
  assert.equal(f.calls.listings,2);assert.equal(f.calls.entries,size*2);assert.equal(f.calls.jobs,2);assert.equal(f.calls.publications,2);assert.equal(f.calls.streams,size,'count receipts prevent rereading bodies');
});

test('count failure after the indexing receipt retries measurement instead of losing the object',async()=>{
  const f=fixture(),key=[...f.raw.keys()][0];f.failOnce(Error('partial count read'));
  await assert.rejects(f.env.run(f.activities.processObject,{key}),error=>error.type==='ConnectorMeasurementFailed');
  assert.equal(f.staged.size,0);
  assert.equal((await f.env.run(f.activities.processObject,{key})).status,'already-indexed');
  assert.equal(f.staged.size,1);assert.equal(f.calls.listings,0);
});

test('full-refresh inventory selects only the latest successful sync, with complete expected keys',async()=>{
  const f=fixture(0);
  for(const sync of [1,2,3])for(const part of [1,2])f.raw.set(f.object('users',sync,part),gzipSync(JSON.stringify({_airbyte_data:{id:`${sync}-${part}`}})));
  for(const key of f.raw.keys())await f.measurement.afterObject(key,()=>{});
  assert.equal(f.calls.streams,6);assert.equal(f.calls.listings,0);assert.equal(f.calls.jobs,0);
  f.setJobs(async()=>[{jobId:1,status:'succeeded'},{jobId:2,status:'succeeded'},{jobId:3,status:'running'}]);
  await f.measurement.afterSweep(()=>{});
  assert.equal(f.calls.streams,6,'publication never streams raw data');assert.deepEqual(f.published(),{full:{users:2},expected:{users:[f.object('users',2,1),f.object('users',2,2)]}});
});

test('scope revocation and rebinding during provider reads prevent inventory and publication',async()=>{
  for(const change of [record=>{record.status='disconnecting';},record=>{record.s3Prefix='raw/other';},record=>{record.tenantId='org_other';}]){
    const f=fixture();f.setJobs(async()=>{change(f.record);return [{jobId:1,status:'succeeded'}];});
    await assert.rejects(f.measurement.afterSweep(()=>{}),error=>error.permanent===true);
    assert.equal(f.calls.listings,0);assert.equal(f.calls.publications,0);
  }
});

test('a sweep with no successful provider job cannot publish an in-flight full snapshot',async()=>{
  const f=fixture(0),key=f.object('users',3,1);f.raw.set(key,gzipSync(JSON.stringify({_airbyte_data:{id:'one'}})));
  await f.measurement.afterObject(key,()=>{});f.setJobs(async()=>[{jobId:3,status:'running'}]);
  await f.measurement.afterSweep(()=>{});assert.deepEqual(f.published(),{full:{},expected:{}});
});

test('dependency failures retry from fresh scope and cancellation never publishes',async()=>{
  const f=fixture();f.setJobs(async()=>{throw Error('provider unavailable');});
  await assert.rejects(f.env.run(f.activities.completeSweep,{}),error=>error.type==='ConnectorMeasurementFailed'&&!error.message.includes('provider unavailable'));
  assert.equal(f.calls.listings,0);assert.equal(f.calls.publications,0);
  f.setJobs(async()=>[{jobId:1,status:'succeeded'}]);await f.env.run(f.activities.completeSweep,{});assert.equal(f.calls.jobs,2);assert.equal(f.calls.publications,1);
  await assert.rejects(f.measurement.afterSweep(()=>{throw Error('cancelled');}),/cancelled/);assert.equal(f.calls.publications,1);
});

test('foreign and non-count keys cannot stream raw data',async()=>{
  const f=fixture();
  for(const key of ['raw/other/stream=channel_messages/date=d/sync=1/1.jsonl.gz',f.record.s3Prefix+'/workspace-snapshot',f.record.s3Prefix+'/stream=channel_messages/date=d/sync=99999999999999999999/1.jsonl.gz'])await f.counts.process(f.record,f.provider,key);
  assert.equal(f.calls.streams,0);assert.equal(f.calls.listings,0);
});
