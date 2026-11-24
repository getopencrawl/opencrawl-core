import assert from 'node:assert/strict';
import {test} from 'node:test';
import {applicationDatabaseFixture} from './fixtures/application-database.mjs';
import {countBinding,createConnectorCounts} from '../dist/src/state/connector-counts.mjs';

const bucket='test-landing',prefix='raw/v1/source=github/workspace=ws/connection=int_one';
const s={environment:'selfhost',tenantId:'org_one',userId:'user_one',integrationId:'int_one',binding:countBinding(bucket,prefix,'github')};
const p1='1'.repeat(64),p2='2'.repeat(64),p3='3'.repeat(64);
const put=async()=>{};
async function fixture(t) {
  const db=await applicationDatabaseFixture(t),state=createConnectorCounts(db,bucket);
  await state.ready();
  async function add(scope=s,storedBucket=bucket) {
    const record={tenantId:scope.tenantId,userId:scope.userId,integrationId:scope.integrationId,environment:scope.environment,provider:'github',status:'active',s3Bucket:storedBucket,s3Prefix:prefix};
    await db.pool.query('INSERT INTO opencrawl_integrations(namespace,environment,tenant_id,user_id,integration_id,provider,status,record) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
      [db.namespace,scope.environment,scope.tenantId,scope.userId,scope.integrationId,record.provider,record.status,JSON.stringify(record)]);
  }
  async function change(fields) {
    await db.pool.query("UPDATE opencrawl_integrations SET status=COALESCE($4::jsonb->>'status',status),record=record||$4::jsonb WHERE namespace=$1 AND tenant_id=$2 AND integration_id=$3",
      [db.namespace,s.tenantId,s.integrationId,JSON.stringify(fields)]);
  }
  const head=async()=> (await db.pool.query('SELECT *,xmin::text FROM opencrawl_connector_counts WHERE namespace=$1 AND tenant_id=$2',[db.namespace,s.tenantId])).rows[0];
  return {db,state,add,change,head};
}

test('recovery resumes the pinned generation, fences stale writes and redispatches fresher demand',async t=>{
  const {db,state,add}=await fixture(t);await add(s,null);
  assert.deepEqual(await state.request(s,[1],5),{counts:null,dispatch:true});
  const a=await state.begin(s,'first',10);
  assert.deepEqual(await state.begin(s,'first',10),a);
  assert.deepEqual(a.succeeded,[1]);
  const progress={phase:'parts',scanId:a.generation,selection:{files:1,issues:null},snapshot:p1,cursor:'page2',pagination:{version:1,anchor:'page2',window:'2',distance:'0'}};
  assert.equal(await state.checkpoint(s,a.generation,0,progress,put),true);
  assert.equal(await state.checkpoint(s,a.generation,0,progress,put),true,'a lost successful acknowledgement replays');
  assert.equal(await state.checkpoint(s,a.generation,0,{...progress,snapshot:p2}),false);
  assert.equal(await state.read(s),null,'a partial accumulation never becomes a card snapshot');
  assert.deepEqual(await state.request(s,[2],12,true),{counts:null,dispatch:false});
  const restarted=createConnectorCounts(db,bucket);
  const b=await restarted.begin(s,'recovery',15);
  assert.notEqual(a.generation,b.generation);
  assert.deepEqual(b.progress,progress);
  assert.deepEqual(b.succeeded,[1],'new demand cannot discard the work already completed');
  assert.equal(b.revision,1);
  assert.deepEqual(await restarted.current(s,b.generation),b);
  assert.equal(await state.begin(s,'delayed',13),null);
  assert.equal(await state.checkpoint(s,a.generation,1,{snapshot:p2,cursor:null}),false);
  assert.equal(await state.publish(s,a.generation,1,{files:2},p2),false);
  assert.equal(await restarted.publish(s,b.generation,1,{files:99},p2,put),true);
  assert.equal(await restarted.publish(s,b.generation,1,{files:99},p2,put),true,'publication reply may also be lost');
  assert.equal(await restarted.publish(s,b.generation,1,{files:98},p2),false);
  assert.equal(await restarted.current(s,b.generation),null);
  assert.deepEqual(await state.read(s),{files:99});
  assert.deepEqual(await state.listPending('selfhost',1),[s],'newer jobs survive the previous pass completion');
  const c=await state.begin(s,'next',20);
  assert.equal(c.statePointer,p2);
  assert.equal(c.progress,null);
  assert.deepEqual(c.succeeded,[1,2]);
  assert.equal(await state.publish(s,c.generation,c.revision,{files:100},p3,put),true);
  assert.equal(await state.begin(s,'after',22),null);
  assert.deepEqual(await state.listPending('selfhost',1),[]);
});

test('a single canonical binding owns the head, seeding is bounded, and disconnect revokes every operation',async t=>{
  const {state,add,db,change}=await fixture(t);await add();
  const other={...s,tenantId:'org_other'};await add(other);
  const second=await fixture(t);await second.add();
  assert.deepEqual(await state.request({...s,userId:'stranger'},[],1),{counts:null,dispatch:false});
  assert.equal(await state.seed({...s,binding:'f'.repeat(64)},{files:10}),false);
  assert.equal(await state.seed(s,{files:10},p1),true);
  assert.equal(await state.seed(s,{files:9},p2),false);
  assert.deepEqual(await state.read(s),{files:10});
  assert.equal(await state.read(other),null);
  assert.equal(await second.state.read(s),null);
  assert.deepEqual(await state.listPending(s.environment,1),[],'seeding does not create demand');
  assert.equal(await state.erase(s),false);
  const progress={snapshot:p2,cursor:null,phase:'parts'};
  await state.request(s,[3],1);
  const a=await state.begin(s,'first',2);
  assert.equal(a.statePointer,p1);
  assert.equal(await state.checkpoint(other,a.generation,0,progress),false);
  await change({s3Prefix:'replacement'});
  assert.equal(await state.current(s,a.generation),null);
  assert.equal(await state.read(s),null);
  assert.equal(await state.checkpoint(s,a.generation,0,progress),false);
  const replacement={...s,binding:countBinding(bucket,'replacement/','github')};
  await state.request(replacement,[],3);
  assert.equal(Number((await db.pool.query('SELECT count(*) FROM opencrawl_connector_counts WHERE namespace=$1',[db.namespace])).rows[0].count),1);
  const b=await state.begin(replacement,'second',4);
  assert.equal(b.statePointer,null);
  assert.equal(await state.publish(replacement,b.generation,0,{},null),true);
  assert.deepEqual(await state.read(replacement),{});
  await change({status:'disconnecting'});
  assert.equal(await state.read(replacement),null);
  assert.equal(await state.erase(s),false);
  assert.equal(await state.erase(replacement),true);
  assert.equal(await state.erase(replacement),true);
});

test('sparse observations respect active and idle cadence; lost-start leases recover without starving another tenant',async t=>{
  const {db,state,add,head}=await fixture(t);await add();
  const other={...s,tenantId:'org_two'};await add(other);
  await state.request(s,[7],10);
  await state.request(other,[7],10);
  await db.pool.query('UPDATE opencrawl_connector_counts SET dispatch_at=0 WHERE namespace=$1',[db.namespace]);
  const leases=await Promise.all([state.listPending(s.environment,1),state.listPending(s.environment,1)]);
  assert.deepEqual(leases.flat().map(scope=>scope.tenantId).sort(),[s.tenantId,other.tenantId].sort());
  const a=await state.begin(s,'run',11);
  await state.publish(s,a.generation,0,{},p1,put);
  await db.pool.query('UPDATE opencrawl_connector_counts SET published_at=$3 WHERE namespace=$1 AND tenant_id=$2',[db.namespace,s.tenantId,Date.now()-120_000]);
  const version=(await head()).xmin;
  for(const time of [12,13,14]) assert.deepEqual(await state.request(s,[],time,false),{counts:{},dispatch:false});
  assert.equal((await head()).xmin,version,'recent terminal observations issue no writes');
  assert.deepEqual(await state.request(s,[7],15,true),{counts:{},dispatch:true});
  await state.request(s,[8],14); // out-of-order result from an earlier status request
  assert.deepEqual((await head()).succeeded,[7]);
  const activeVersion=(await head()).xmin;
  assert.deepEqual(await state.request(s,[7],16,true),{counts:{},dispatch:false});
  assert.equal((await head()).xmin,activeVersion);
  const b=await state.begin(s,'active',17);
  await state.publish(s,b.generation,b.revision,{},p2,put);
  await db.pool.query('UPDATE opencrawl_connector_counts SET published_at=$3 WHERE namespace=$1 AND tenant_id=$2',[db.namespace,s.tenantId,Date.now()-7*3600_000]);
  assert.deepEqual(await state.request(s,[7],18,false),{counts:{},dispatch:true});
});

test('checkpoint schema and bounded numeric inputs reject payloads, invalid pointers and corrupt pagination', async t=>{
  const {state,add}=await fixture(t);await add();
  await assert.rejects(state.listPending('selfhost',26),/range/);
  await assert.rejects(state.request(s,[1.2],1),/observation/);
  await assert.rejects(state.request(s,Array(101).fill(1),1),/observation/);
  await assert.rejects(state.seed(s,{files:-2},p1),/prior snapshot/);
  await assert.rejects(state.seed(s,{},'another-tenant/manifest'),/prior snapshot/);
  await state.request(s,[1],1);
  const a=await state.begin(s,'run',2);
  const base={cursor:null,snapshot:p1};
  for (const p of [{...base,keys:['secret']},{...base,scanId:'raw-info'},{...base,cursor:'x'.repeat(8200)},{...base,snapshot:'bucket/key'},
    {...base,cursor:'a'.repeat(8100),pagination:{version:1,anchor:'b'.repeat(8100),window:'2',distance:'0'},selection:{['s'.repeat(127)]:1,['z'.repeat(127)]:2}},
    {...base,cursor:'p1',pagination:{version:1,anchor:'p1',window:'0',distance:'3'}}]) {
    await assert.rejects(state.checkpoint(s,a.generation,0,p));
  }
  assert.equal((await state.current(s,a.generation)).revision,0);
  await assert.rejects(state.publish(s,a.generation,0,{files:Number.MAX_SAFE_INTEGER+1},p1),/publication/);
});

test('only one revision may write the object, and a lost successful acknowledgement never repeats the PUT',async t=>{
  const {state,add}=await fixture(t);await add();
  assert.equal(await state.seed(s,{files:1},p1),true);
  assert.equal(await state.seed(s,{files:1},p1),true,'the same existing snapshot may be verified again');
  assert.equal(await state.seed(s,{files:5},p2),false);
  const losing=async()=>assert.fail('stale operation wrote the object');
  await state.request(s,[5],1);
  const a=await state.begin(s,'run',2);
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  const progress={snapshot:p2,cursor:'next'};
  let writes=0;
  const win=state.checkpoint(s,a.generation,0,progress,async()=>{
    writes++;
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const contender=state.publish(s,a.generation,0,{files:7},p2,losing);
  try {assert.equal((await state.current(s,a.generation)).statePointer,p1);}
  finally {release.resolve();}
  assert.deepEqual(await Promise.all([win,contender]),[true,false]);
  assert.equal(await state.checkpoint(s,a.generation,0,progress,losing),true);
  assert.equal((await state.current(s,a.generation)).statePointer,p2);
  assert.equal(await state.publish(s,a.generation,1,{files:8},p2,losing),true,'unchanged snapshot needs no PUT');
  assert.equal(await state.publish(s,a.generation,1,{files:8},p2,losing),true);
  assert.equal(writes,1);
});

test('a lost SQL commit adopts the actual S3 digest and resets scan position without rewriting bytes or publishing partial counts',async t=>{
  const {state,add,db}=await fixture(t);await add();
  let actual=p1,puts=0;
  await state.seed(s,{files:3},actual);
  await state.request(s,[5],1);
  const a=await state.begin(s,'run',2);
  await state.checkpoint(s,a.generation,0,{snapshot:p1,cursor:'old-page'});
  await assert.rejects(state.publish(s,a.generation,1,{files:7},p2,async()=>{throw Error('etag precondition');}),/etag precondition/);
  assert.equal((await state.current(s,a.generation)).revision,1);
  let interrupt=false;
  const failing=createConnectorCounts({...db,transaction:run=>db.transaction(async client=>{
    const result=await run(client);
    if (interrupt) throw Error('simulated rollback after PUT');
    return result;
  })},bucket);
  await failing.ready();interrupt=true;
  const upload=async()=>{assert.equal(actual,p1);actual=p2;puts++;};
  await assert.rejects(failing.checkpoint(s,a.generation,1,{snapshot:p2,cursor:'later-page'},upload),/simulated rollback/);
  assert.equal(actual,p2);
  const prior=await state.current(s,a.generation);
  assert.equal(prior.revision,1);
  assert.equal(prior.progress.cursor,'old-page');
  assert.equal(prior.statePointer,p1);
  assert.deepEqual(await state.read(s),{files:3});
  assert.equal(await state.adopt({...s,binding:'f'.repeat(64)},a.generation,1,actual),false);
  assert.equal(await state.adopt(s,a.generation,0,actual),false);
  assert.equal(await state.adopt(s,a.generation,1,actual),true);
  assert.equal(await state.adopt(s,a.generation,1,actual),true,'lost adoption receipt is idempotent');
  const adopted=await state.current(s,a.generation);
  assert.deepEqual({progress:adopted.progress,pointer:adopted.statePointer,jobs:adopted.succeeded,rev:adopted.revision},
    {progress:null,pointer:p2,jobs:[5],rev:2});
  assert.equal(await state.adopt(s,a.generation,2,p2),true);
  assert.equal((await state.current(s,a.generation)).revision,2,'matching digest needs no SQL write');
  assert.deepEqual(await state.read(s),{files:3},'adoption leaves previous card totals visible');
  assert.equal(await state.publish(s,a.generation,adopted.revision,{files:7},actual,async()=>assert.fail('adopted snapshot rewritten')),true);
  assert.equal(puts,1);
});

test('a first-checkpoint orphan keeps its provisional full-refresh scan identity across takeover and adoption',async t=>{
  const {state,add}=await fixture(t);await add();
  await state.seed(s,{repositories:9},p1);
  await state.request(s,[],1,true);
  const before=await state.begin(s,'original',2);
  // The original worker has uploaded a provisional full-refresh object stamped
  // with this scan ID, but its transaction never recorded even a first cursor.
  const replacement=await state.begin(s,'replacement',3);
  assert.notEqual(replacement.generation,before.generation);
  assert.equal(replacement.progress.scanId,before.generation);
  assert.equal(await state.adopt(s,replacement.generation,replacement.revision,p2),true);
  assert.equal(await state.adopt(s,replacement.generation,replacement.revision,p2),true);
  const resumed=await state.current(s,replacement.generation);
  assert.deepEqual(resumed.progress,{cursor:null,snapshot:p2,scanId:before.generation});
  const active={...resumed.progress,cursor:'page2',phase:'parts',selection:{repositories:12}};
  assert.equal(await state.checkpoint(s,resumed.generation,resumed.revision,active),true);
  assert.equal(await state.adopt(s,resumed.generation,resumed.revision+1,p3),true);
  assert.deepEqual((await state.current(s,resumed.generation)).progress,{cursor:null,snapshot:p3,scanId:before.generation});
});

test('a deterministic budget failure defers automatic starts for the same connection across job changes',async t=>{
  const {state,add,head}=await fixture(t);await add();
  await state.seed(s,{files:7},p1);
  await state.request(s,[1],10);
  const run=await state.begin(s,'before-budget',12);
  assert.equal(await state.deferBudget(s,run.generation,1),false);
  const since=Date.now();
  assert.equal(await state.deferBudget(s,run.generation,0),true);
  const deferred=Number((await head()).dispatch_at);
  assert.ok(deferred>=since+6*3600_000 && deferred<=Date.now()+6*3600_000);
  assert.equal(await state.deferBudget(s,run.generation,0),true);
  assert.deepEqual(await state.request(s,[1],20,true),{counts:{files:7},dispatch:false});
  assert.deepEqual(await state.request(s,[2],30,true),{counts:{files:7},dispatch:false});
  assert.equal(Number((await head()).dispatch_at),deferred);
  assert.deepEqual(await state.listPending('selfhost',1),[]);
  assert.deepEqual(await state.current(s,run.generation),run);
  assert.ok(await state.begin(s,'manual',40),'a direct operator retry can use the larger per-connection budget');
});
