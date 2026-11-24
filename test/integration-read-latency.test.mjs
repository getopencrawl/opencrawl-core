import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {createIntegrations} from '../dist/src/integrations/service.mjs';
import {createRecordCounts} from '../dist/src/integrations/counts.mjs';
import {usageReport} from '../dist/src/application/usage.mjs';
import {sourceProgress,sourceStatus} from '../dist/src/application/source-model.mjs';
import {applicationDatabaseFixture} from './fixtures/application-database.mjs';
import {createSingleOrganizationRegistry} from '../dist/src/integrations/local-registry.mjs';
import {connectorCountScope} from '../dist/src/integrations/count-admission.mjs';
import {createConnectorCounts} from '../dist/src/state/connector-counts.mjs';
const gate = () => Promise.withResolvers();
const principal = {tenantId:'org_a',userId:'user_a'};
const provider = {id:'slack',scope:'team',name:'Slack',streams:[],progressStream:['messages'],progress:[]};
const record = {...principal,environment:'production',integrationId:'int_'+'a'.repeat(26),provider:'slack',status:'active',createdAt:'2026-01-01',s3Bucket:'owned',s3Prefix:'raw/connection',airbyte:{connectionId:'connection'}};
const service = (airbyte, records=[record], options={}) => createIntegrations({environment:'production',appUrl:'https://app.example',providers:{slack:provider},airbyte,...options,
  registry:{listTenant:async tenant=>records.filter(record=>record.tenantId===tenant)},buckets:{},oauth:{},destination:{},workspaceId:async()=>'workspace',legacyBucket:'owned'});

test('cold and concurrent reads return immediately while one status refresh remains blocked',async()=>{
  const jobs=gate(), streams=gate(),calls=[];
  const integrations=service({jobs:async()=>{calls.push('jobs');return jobs.promise;},streamCounts:async()=>{calls.push('streams');return streams.promise;}});
  const a=integrations.list(principal),b=integrations.list(principal);await tick();
  assert.deepEqual(calls,['jobs','streams']);
  assert.equal((await a)[0].state,'connected');assert.equal((await a)[0].synced,undefined);
  assert.equal((await a)[0].statusRefreshing,true);assert.deepEqual(await b,await a);
  assert.equal(sourceProgress((await a)[0]),'Checking sync status…');
  jobs.resolve([{jobId:1,status:'succeeded'}]);streams.resolve({messages:12});
  await tick();assert.equal((await integrations.list(principal))[0].synced,12);
  await integrations.list(principal);assert.deepEqual(calls,['jobs','streams']);
});

test('the latest job determines activity and prior success distinguishes recurring syncs', async () => {
  async function card(statuses) {
    const jobs = statuses.map((status, i) => ({jobId: statuses.length - i, status}));
    const integrations = service({jobs: async () => jobs, streamCounts: async () => ({messages: 12})});
    await integrations.list(principal);
    await tick();
    return (await integrations.list(principal))[0];
  }
  assert.equal((await card([])).state, 'connected');
  assert.equal((await card(['succeeded', 'incomplete'])).state, 'synced');
  assert.equal((await card(['failed', 'incomplete'])).state, 'error');
  assert.equal(sourceStatus(await card(['running'])).label, 'Importing');
  assert.equal(sourceStatus(await card(['running', 'succeeded'])).label, 'Syncing');
});

test('status caching cannot reuse colliding connection IDs across organizations and failures can retry',async()=>{
  let calls=0,fail=true,time=0;
  const integrations=service({jobs:async()=>{calls++;if(fail)throw Error('unavailable');return [{jobId:1,status:'succeeded'}];},streamCounts:async()=>({messages:calls})},[record,{...record,tenantId:'org_b'}],{now:()=>time});
  await integrations.list(principal);await tick();
  assert.equal((await integrations.list(principal))[0].statusUnavailable,true);assert.equal(calls,1);
  fail=false;time=5000;await integrations.list(principal);await tick();
  assert.equal((await integrations.list(principal))[0].state,'synced');
  await integrations.list({...principal,tenantId:'org_b'});assert.equal(calls,3);
});

test('refresh serves recent measurements, retries with backoff, expires stale data and observes disconnects',async()=>{
  let time=0,fail=false,calls=0;const records=[record],pending=gate();
  const integrations=service({jobs:async()=>{calls++;if(fail)return pending.promise;return [{jobId:1,status:'succeeded'}];},streamCounts:async()=>({messages:12})},records,{now:()=>time});
  await integrations.list(principal);await tick();fail=true;time=5000;
  const old=(await integrations.list(principal))[0];assert.equal(old.synced,12);assert.equal(old.statusRefreshing,true);
  await integrations.list(principal);assert.equal(calls,2);
  pending.reject(Error('offline'));await tick();
  const failed=(await integrations.list(principal))[0];assert.equal(failed.synced,12);assert.equal(failed.statusUnavailable,true);assert.equal(calls,2);
  assert.equal(sourceStatus(failed).label,'Status unavailable');assert.match(sourceProgress(failed),/last measurement/);
  time=300001;const expired=(await integrations.list(principal))[0];assert.equal(expired.state,'connected');assert.equal(expired.synced,undefined);
  records.splice(0);assert.equal((await integrations.list(principal))[0].state,'disconnected');
});

test('durable counts remain readable while a slow recount runs, and scoped caches do not collide',async()=>{
  const scans=gate(), saved=gzipSync(JSON.stringify({version:1,read:[],ids:{messages:['one','two']},full:{}}));
  let reads=0,lists=0;
  const buckets={read:async bucket=>{reads++;if(bucket==='other')throw Object.assign(Error('missing'),{status:404});return saved;},list:async()=>{lists++;return scans.promise;},write:async()=>{},stream:async()=>assert.fail('No objects')};
  const counts=createRecordCounts({buckets,legacyBucket:'owned'});
  // A live handle keeps this isolated test alive while the bounded, unrefed deadline runs.
  const alive=setInterval(()=>{},1000);
  try {
    assert.deepEqual(await counts.get(record,provider,new Set([1]),{wait:10}),{messages:2});
    const repeated=counts.get(record,provider,new Set([1]),{wait:1000});
    assert.deepEqual(await repeated,{messages:2});assert.equal(reads,1);assert.equal(lists,1);
    assert.equal(await counts.get({...record,tenantId:'org_b',s3Bucket:'other'},provider,new Set([1]),{wait:10}),null);
    assert.equal(reads,2);assert.equal(lists,2);
  } finally {scans.resolve([]);clearInterval(alive);await tick();}
});

test('usage reports do not execute synthetic full-text latency probes',async()=>{
  let usageReads=0;
  const report=await usageReport({principal,directory:{organizations:{getOrganization:async()=>({name:'Team'})},userManagement:{listOrganizationMemberships:async()=>({data:[]})}},
    search:{usage:async()=>{usageReads++;return {people:[],lifetimeEvents:0};},overlap:async()=>({timeZone:'UTC',measuredAt:new Date().toISOString(),sessions:0,daily:[]}),search:async()=>assert.fail('Usage must not run a search benchmark')}});
  assert.equal(usageReads,1);assert.equal(report.ingestion,null);
});

test('integration cards show durable measurements without waiting for a raw-data recount', {timeout:2000}, async t=>{
  const scan=gate();t.after(()=>scan.resolve([]));
  const saved=gzipSync(JSON.stringify({version:1,read:[],ids:{messages:['one','two']},full:{}}));
  const integrations=createIntegrations({environment:'production',appUrl:'https://app.example',providers:{slack:provider},
    registry:{listTenant:async()=>[record]},oauth:{},destination:{},workspaceId:async()=>'workspace',legacyBucket:'owned',
    airbyte:{jobs:async()=>[{jobId:1,status:'succeeded'}],streamCounts:async()=>({messages:999})},
    buckets:{read:async()=>saved,list:async()=>scan.promise,write:async()=>{},stream:async()=>assert.fail('No objects')}});
  const alive=setInterval(()=>{},1000);t.after(()=>clearInterval(alive));
  // The scan remains unresolved until cleanup. The page must still return the durable count.
  await integrations.list(principal);await tick();
  assert.equal((await integrations.list(principal))[0].synced,2);
});

test('missing distinct counts stay unknown instead of reporting cumulative Airbyte rows as unique records', {timeout:2000}, async t=>{
  const scan=gate();t.after(()=>scan.resolve([]));
  const integrations=createIntegrations({environment:'production',appUrl:'https://app.example',providers:{slack:provider},
    registry:{listTenant:async()=>[record]},oauth:{},destination:{},workspaceId:async()=>'workspace',legacyBucket:'owned',
    airbyte:{jobs:async()=>[{jobId:1,status:'succeeded',rowsSynced:999}],streamCounts:async()=>({messages:999})},
    buckets:{read:async()=>{throw Object.assign(Error('missing'),{status:404});},list:async()=>scan.promise,write:async()=>{},stream:async()=>assert.fail('No objects')}});
  const alive=setInterval(()=>{},1000);t.after(()=>clearInterval(alive));
  await integrations.list(principal);await tick();
  const card=(await integrations.list(principal))[0];assert.equal(card.state,'synced');assert.equal(card.synced,undefined);assert.deepEqual(card.rows,[]);
});

test('a source outside the runtime worker scope keeps reading its existing durable count', {timeout:2000}, async t=>{
  const snapshot=gzipSync(JSON.stringify({version:1,read:[],ids:{messages:['a','b']},full:{}}));
  const scan=gate();t.after(()=>scan.resolve([]));
  const integrations=createIntegrations({environment:'production',appUrl:'https://app.example',providers:{slack:provider},
    registry:{listTenant:async()=>[record]},oauth:{},destination:{},workspaceId:async()=>'workspace',legacyBucket:'owned',
    airbyte:{jobs:async()=>[{jobId:1,status:'succeeded'}],streamCounts:async()=>({messages:999})},
    recordCounts:{accepts:()=>false,request:async()=>assert.fail('Outside worker scope'),schedule:async()=>assert.fail('Outside worker scope')},
    buckets:{read:async()=>snapshot,list:async()=>scan.promise,write:async()=>{},stream:async()=>assert.fail('No objects')}});
  const alive=setInterval(()=>{},1000);t.after(()=>clearInterval(alive));
  await integrations.list(principal);await tick();assert.equal((await integrations.list(principal))[0].synced,2);
});

test('durable admission bounds the source-card request and never reads raw objects', {timeout:2000}, async()=>{
  let time=10, jobReads=0, rawReads=0;
  const demand=gate(), wake=gate(), requests=[], scheduled=[];
  const jobs=[{jobId:8,status:'running'}, {jobId:'7',status:'succeeded'}, {jobId:7,status:'succeeded'},
    {jobId:'invalid',status:'succeeded'}, {jobId:6,status:'failed'}];
  const buckets={list(){rawReads++;throw Error('Unexpected raw listing');},read(){rawReads++;throw Error('Unexpected legacy snapshot');}};
  const integrations=createIntegrations({environment:'production',appUrl:'https://app.example',providers:{slack:provider},now:()=>time,
    registry:{listTenant:async()=>[record]},oauth:{},destination:{},workspaceId:async()=>'workspace',legacyBucket:'owned',buckets,
    airbyte:{jobs:async()=>{jobReads++;return jobs;},streamCounts:async()=>({messages:999})},
    recordCounts:{request:async(...args)=>{requests.push(args);return demand.promise;},schedule:async ref=>{scheduled.push(ref);await wake.promise;}}});
  await Promise.all([integrations.list(principal),integrations.list(principal)]);await tick();
  const hash=createHash('sha256').update(JSON.stringify(['owned','raw/connection/','slack'])).digest('hex');
  assert.deepEqual(requests,[[{...principal,environment:'production',integrationId:record.integrationId,binding:hash},[7],10,true]]);
  assert.deepEqual(scheduled,[]);assert.equal(rawReads,0);
  const first=(await integrations.list(principal))[0];
  assert.equal(first.state,'syncing');assert.equal(first.synced,undefined);assert.equal(first.statusUnavailable,false);
  demand.resolve({counts:{messages:12},dispatch:true});await tick();
  assert.equal((await integrations.list(principal))[0].synced,12);
  assert.deepEqual(scheduled,[{...principal,connectionId:record.integrationId}]);
  // Delivery is still blocked. Status remains refreshable, and another poll cannot duplicate the admission.
  time+=5001;await integrations.list(principal);await tick();
  assert.equal(jobReads,2);assert.equal(requests.length,1);assert.equal((await integrations.list(principal))[0].synced,12);
  jobs[0]={jobId:8,status:'succeeded'};time+=5001;await integrations.list(principal);await tick();
  assert.deepEqual(requests[1].slice(1),[[7,8],time,false]);
  assert.equal(scheduled.length,1);
  wake.reject(Error('Temporal unavailable'));await tick();
  assert.equal((await integrations.list(principal))[0].statusUnavailable,false);assert.equal(rawReads,0);
});

test('count admission isolates bindings, limits job history and preserves the last snapshot through a database outage',async()=>{
  let time=1000, rows=[record], fail=false;const requests=[], scheduled=[];
  const successes=Array.from({length:120},(_,i)=>({status:'succeeded',jobId:i+1}));
  const integrations=createIntegrations({environment:'production',appUrl:'https://app.example',providers:{slack:provider},now:()=>time,
    registry:{listTenant:async tenant=>rows.filter(r=>r.tenantId===tenant)},oauth:{},destination:{},workspaceId:async()=>'workspace',legacyBucket:'owned',buckets:{},
    airbyte:{jobs:async()=>successes,streamCounts:async()=>({messages:999})},
    recordCounts:{request:async(scope,ids)=>{requests.push([scope,ids]);if(fail)throw Error('Database unavailable');return {counts:{messages:0},dispatch:false};},
      schedule:async ref=>{scheduled.push(ref);}}});
  await integrations.list(principal);await tick();assert.equal((await integrations.list(principal))[0].synced,0);
  assert.deepEqual(requests[0][1],Array.from({length:100},(_,i)=>i+1));assert.deepEqual(scheduled,[]);
  time+=5001;await integrations.list(principal);await tick();assert.equal(requests.length,1);
  fail=true;time+=60_001;await integrations.list(principal);await tick();assert.equal(requests.length,2);
  const current=(await integrations.list(principal))[0];assert.equal(current.synced,0);assert.equal(current.statusUnavailable,false);
  rows=[{...record,s3Bucket:'replacement'}];await integrations.list(principal);await tick();
  assert.equal((await integrations.list(principal))[0].synced,undefined);assert.notEqual(requests[0][0].binding,requests.at(-1)[0].binding);
  rows=[{...record,tenantId:'org_b'}];const other={...principal,tenantId:'org_b'};
  await integrations.list(other);await tick();assert.equal((await integrations.list(other))[0].synced,undefined);
  assert.equal(requests.at(-1)[0].tenantId,'org_b');
});

test('disconnect revokes the canonical binding before erasing its counts and landing objects',async()=>{
  let saved={...record}, erased, matches=false;const calls=[];
  const integrations=createIntegrations({environment:'production',appUrl:'https://app.example',providers:{slack:provider},
    registry:{listTenant:async()=>[saved],update:async(_record,fields)=>{saved={...saved,...fields};calls.push(saved.status);return saved;}},
    oauth:{},destination:{},workspaceId:async()=>'workspace',legacyBucket:'owned',
    airbyte:{deleteConnection:async()=>{}},buckets:{deletePrefix:async()=>{calls.push('raw');return 2;}},
    recordCounts:{erase:async scope=>{erased=scope;calls.push('counts');return matches;}}});
  await assert.rejects(integrations.disconnect(principal,'slack'), /binding changed/);
  assert.deepEqual(calls,['disconnecting','counts']);
  matches=true;calls.length=0;
  await integrations.disconnect(principal,'slack');
  assert.deepEqual(calls,['disconnecting','counts','raw','disconnected']);
  assert.deepEqual({tenantId:erased.tenantId,userId:erased.userId,integrationId:erased.integrationId},{...principal,integrationId:record.integrationId});
});

test('a mismatched registry row cannot admit a durable count request',async()=>{
  let records=[{...record,tenantId:'org_other'}], attempts=0;
  const integrations=createIntegrations({environment:'production',appUrl:'https://app.example',providers:{slack:provider},
    registry:{listTenant:async()=>records},buckets:{},oauth:{},destination:{},workspaceId:async()=>'workspace',legacyBucket:'owned',
    airbyte:{jobs:async()=>{attempts++;return [];},streamCounts:async()=>({})},
    recordCounts:{request:async()=>{attempts++;throw Error('Unexpected demand');}}});
  assert.equal((await integrations.list(principal))[0].state,'unavailable');
  records=[{...record,environment:'staging'}];
  assert.equal((await integrations.list(principal))[0].state,'unavailable');
  assert.equal(attempts,0);
});

test('a cold source card serves its prewarmed PostgreSQL measurement while Temporal is unavailable',{timeout:30000},async t=>{
  const database=await applicationDatabaseFixture(t);
  const registry=createSingleOrganizationRegistry({database,organizationId:principal.tenantId});t.after(()=>registry.close());
  const row={...record,scope:'team',environment:'selfhost',s3Prefix:'raw/v1/source=slack/workspace=T1/connection='+record.integrationId};
  await registry.create(row);
  const state=createConnectorCounts(database,row.s3Bucket);
  const scope=connectorCountScope('selfhost',row.tenantId,row.userId,row.integrationId,{bucket:row.s3Bucket,rawPrefix:row.s3Prefix+'/',provider:'slack'});
  await state.seed(scope,{messages:12});
  const wake=gate();
  const integrations=createIntegrations({environment:'selfhost',appUrl:'https://self.example',providers:{slack:provider},registry,
    oauth:{},destination:{},workspaceId:async()=>'workspace',legacyBucket:row.s3Bucket,buckets:{list:async()=>assert.fail('Unexpected raw listing')},
    airbyte:{jobs:async()=>[{jobId:7,status:'succeeded'}],streamCounts:async()=>({messages:999})},
    recordCounts:{...state,schedule:async reference=>{wake.resolve(reference);throw Error('Temporal unavailable');}}});
  await integrations.list(principal);
  assert.deepEqual(await wake.promise,{...principal,connectionId:row.integrationId});
  const card=(await integrations.list(principal))[0];assert.equal(card.synced,12);assert.equal(card.statusUnavailable,false);
});
