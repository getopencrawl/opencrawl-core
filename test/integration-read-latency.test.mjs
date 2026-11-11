import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {gzipSync} from 'node:zlib';
import {createIntegrations} from '../dist/src/integrations/service.mjs';
import {createRecordCounts} from '../dist/src/integrations/counts.mjs';
import {usageReport} from '../dist/src/application/usage.mjs';
const gate = () => Promise.withResolvers();
const principal = {tenantId:'org_a',userId:'user_a'};
const provider = {id:'slack',scope:'team',name:'Slack',streams:[],progressStream:['messages'],progress:[]};
const record = {...principal,environment:'production',integrationId:'int_'+'a'.repeat(26),provider:'slack',status:'active',createdAt:'2026-01-01',s3Bucket:'owned',s3Prefix:'raw/connection',airbyte:{connectionId:'connection'}};
const service = (airbyte, records=[record]) => createIntegrations({environment:'production',appUrl:'https://app.example',providers:{slack:provider},airbyte,
  registry:{listTenant:async tenant=>records.filter(record=>record.tenantId===tenant)},buckets:{},oauth:{},destination:{},workspaceId:async()=>'workspace',legacyBucket:'owned'});

test('integration job and stream reads run together and concurrent readers share the in-flight result',async()=>{
  const jobs=gate(), streams=gate(),calls=[];
  const integrations=service({jobs:async()=>{calls.push('jobs');return jobs.promise;},streamCounts:async()=>{calls.push('streams');return streams.promise;}});
  const a=integrations.list(principal),b=integrations.list(principal);await tick();
  assert.deepEqual(calls,['jobs','streams']);
  jobs.resolve([{jobId:1,status:'succeeded'}]);streams.resolve({messages:12});
  assert.equal((await a)[0].synced,12);assert.deepEqual(await b,await a);
  await integrations.list(principal);assert.deepEqual(calls,['jobs','streams']);
});

test('status caching cannot reuse colliding connection IDs across organizations and failures can retry',async()=>{
  let calls=0,fail=true;
  const integrations=service({jobs:async()=>{calls++;if(fail)throw Error('unavailable');return [{jobId:1,status:'succeeded'}];},streamCounts:async()=>({messages:calls})},[record,{...record,tenantId:'org_b'}]);
  assert.equal((await integrations.list(principal))[0].state,'unavailable');fail=false;
  assert.equal((await integrations.list(principal))[0].state,'synced');
  await integrations.list({...principal,tenantId:'org_b'});assert.equal(calls,3);
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
    search:{usage:async()=>{usageReads++;return {people:[],lifetimeEvents:0};},search:async()=>assert.fail('Usage must not run a search benchmark')}});
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
  assert.equal((await integrations.list(principal))[0].synced,2);
});

test('missing distinct counts stay unknown instead of reporting cumulative Airbyte rows as unique records', {timeout:2000}, async t=>{
  const scan=gate();t.after(()=>scan.resolve([]));
  const integrations=createIntegrations({environment:'production',appUrl:'https://app.example',providers:{slack:provider},
    registry:{listTenant:async()=>[record]},oauth:{},destination:{},workspaceId:async()=>'workspace',legacyBucket:'owned',
    airbyte:{jobs:async()=>[{jobId:1,status:'succeeded',rowsSynced:999}],streamCounts:async()=>({messages:999})},
    buckets:{read:async()=>{throw Object.assign(Error('missing'),{status:404});},list:async()=>scan.promise,write:async()=>{},stream:async()=>assert.fail('No objects')}});
  const alive=setInterval(()=>{},1000);t.after(()=>clearInterval(alive));
  const card=(await integrations.list(principal))[0];assert.equal(card.state,'synced');assert.equal(card.synced,undefined);assert.deepEqual(card.rows,[]);
});
