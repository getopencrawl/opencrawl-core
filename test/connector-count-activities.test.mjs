import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {gzipSync} from 'node:zlib';
import {createCountActivities} from '../dist/src/connectors/count-activities.mjs';
import {openCountSnapshot} from '../dist/src/connectors/count-snapshot.mjs';
import {readRecords} from '../dist/src/connectors/records.mjs';
import {countBinding, createConnectorCounts} from '../dist/src/state/connector-counts.mjs';
import {recordKey} from '../dist/src/integrations/counts.mjs';
import {applicationDatabaseFixture, postgresUrl} from './fixtures/application-database.mjs';

const ref = {tenantId:'org_0123',userId:'user_0123',connectionId:'int_'+'a'.repeat(26),generation:'v1'};
const prefix = `raw/v1/source=github/workspace=team/connection=${ref.connectionId}/`;
const snapshotKey = '_opencrawl/counts/connection=' + ref.connectionId + '.json.gz';
const binding = {tenantId:ref.tenantId,connectionId:ref.connectionId,workspaceId:'team',provider:'github',access:'workspace-global',rawPrefix:prefix};
const provider = {id:'github',connector:{manifest:{streams:[{name:'files',primary_key:['path']},{name:'repositories',primary_key:['id']}]}},
  progressStream:['files'],progress:[{stream:'repositories'}],streams:[{name:'files',syncMode:'incremental_append'},
  {name:'repositories',syncMode:'full_refresh_append'},{name:'other',syncMode:'incremental_append'}]};
const key = (stream, sync, part='p') => `${prefix}stream=${stream}/date=2026-11-24/sync=${sync}/${part}.jsonl.gz`;
const line = data => JSON.stringify({_airbyte_extracted_at:123,_airbyte_data:data});
const rows = (...items) => gzipSync(items.map(line).join('\n'));

function setup(catalog = provider, persistedState) {
  const data = new Map(), versions = new Map(), reads = [], lists = [], writes = [], snapshotOpens = [], saves = [], published = [];
  const settings = {scope:true, revokeAfterRead:false, rebind:false, lostAck:false, cancelled:false, pageSize:1000, foreignKey:false, rejectLock:false};
  let run = 0, pointer = null, head = null;
  const store = {bucket:'owned',
    async get(key) {return data.get(key) ?? null;},
    async has(key) {return data.has(key);},
    async *read(key) {
      assert.ok(data.has(key),'Object present');
      if (key.startsWith(prefix)) {reads.push(key);if (settings.revokeAfterRead) settings.scope = false;}
      yield data.get(key);
    },
    async readVersion(key,{maxBytes} = {}) {
      assert.equal(key,snapshotKey);
      const bytes=data.get(key)??null;
      if (bytes && maxBytes) assert.ok(bytes.length<=maxBytes,'bounded checkpoint read');
      return {data:bytes,version:versions.get(key)??null};
    },
    async compareAndSet(key,version,bytes) {
      assert.equal(key,snapshotKey);
      if((versions.get(key)??null)!==version)return false;
      writes.push(key);data.set(key,Buffer.from(bytes));versions.set(key,(versions.get(key)??0)+1);return true;
    },
    async listPage(start, {continuationToken, maxKeys}) {
      assert.ok(start.startsWith(prefix+'stream='));assert.equal(maxKeys,1000);lists.push(start);
      const objects = [...data.keys()].filter(k=>k.startsWith(start)).sort();
      const offset = Number(continuationToken||0), end = offset + settings.pageSize;
      return {keys:settings.foreignKey?['outside-tenant']:objects.slice(offset,end),nextToken:end<objects.length?String(end):null};
    },
  };
  const state = {
    async begin() {return head;},
    async current(_scope, generation) {return head?.generation===generation?structuredClone(head):null;},
    async adopt(_scope, generation, rev, observed) {
      if(settings.rejectLock||head?.generation!==generation||head.revision!==rev)return false;
      head.progress=null;head.statePointer=observed;pointer=observed;head.revision++;return true;
    },
    async checkpoint(_scope, generation, rev, checkpoint, write) {
      if (settings.rejectLock||head?.generation!==generation||head.revision!==rev)return false;
      await write?.();
      head.progress=structuredClone(checkpoint);head.statePointer=checkpoint.snapshot;pointer=checkpoint.snapshot;head.revision++;
      if (settings.lostAck) {settings.lostAck=false;throw Error('ack lost');}
      return true;
    },
    async publish(_scope, generation, rev, counts, sha, write) {
      if (settings.rejectLock||head?.generation!==generation||head.revision!==rev)return false;
      await write?.();
      pointer=sha;published.push({...counts});head=null;return true;
    },
  };
  const activities = createCountActivities({environment:'selfhost',providers:{github:catalog}, state:persistedState || state,
    checkCancelled:()=>{if(settings.cancelled)throw Error('cancelled');},
    resolve:async input=>{
      assert.deepEqual(input,ref);
      if(!settings.scope)throw Error('revoked');
      return {binding,store:settings.rebind?{...store,bucket:'changed'}:store};
    },
    openSnapshot:async options=>{
      const local=await openCountSnapshot(options);snapshotOpens.push(local.observedPointer);
      return new Proxy(local,{get(target,prop){if(prop==='prepareSave') return async()=>{saves.push(1);return target.prepareSave();};return target[prop];}});
    },
  });
  const pass = async (succeeded=[]) => {
    run++;
    head = {generation:'20000000-0000-4000-8000-'+String(run).padStart(12,'0'),revision:0,succeeded,summary:published.at(-1)??null,statePointer:pointer,progress:null};
    const begun=await activities.beginConnectorCounts({...ref,passId:'run'+run,startedAt:run});
    return {...ref,countGeneration:begun.generation,revision:begun.revision};
  };
  const finish = async input=>{
    for (let i=0;i<30;i++){
      const next=await activities.advanceConnectorCounts(input);
      assert.ok(next,'active generation');if(next.done)return;
      input={...input,revision:next.revision};
    }
    throw Error('test scan failed to terminate');
  };
  return {activities,data,reads,lists,writes,snapshotOpens,saves,published,settings,pass,finish,get head(){return head;},
    seedLegacy(contents,counts) {
      const bytes=gzipSync(JSON.stringify(contents));data.set(snapshotKey,bytes);versions.set(snapshotKey,1);
      pointer=createHash('sha256').update(bytes).digest('hex');published.push(counts);return pointer;
    }};
}

test('a lost activity acknowledgment resumes one page checkpoint and the next pass does no raw reads or snapshot writes', async()=>{
  const f=setup();
  for(let i=0;i<20;i++)f.data.set(key('files',1,'p'+i),rows({path:'f'+i,updated:1},{path:'f0',updated:i}));
  f.data.set(key('repositories',2),rows({id:10},{id:11},{id:10}));
  f.data.set(key('repositories',3),rows({id:'running'}));f.data.set(key('other',1),rows({private:'unused'}));
  const first=await f.pass([2]);f.settings.lostAck=true;
  await assert.rejects(f.activities.advanceConnectorCounts(first),/ack lost/);
  assert.equal(f.reads.length,16);assert.equal(f.saves.length,1);assert.deepEqual(f.published,[]);
  assert.equal(f.head.progress.cursor,null);assert.equal(f.head.progress.phase,'parts');
  assert.deepEqual(Object.keys(f.head.progress).sort(),['cursor','phase','scanId','selection','snapshot']);
  const retry=await f.activities.advanceConnectorCounts(first);
  assert.equal(retry.revision,1);assert.equal(f.reads.length,16);assert.equal(f.snapshotOpens.length,1);
  await f.finish({...first,revision:retry.revision});
  assert.deepEqual(f.published,[{files:20,repositories:2}]);
  assert.equal(new Set(f.reads).size,21);assert.equal(f.reads.length,21);assert.equal(f.saves.length,2);
  const before=f.writes.length;
  await f.finish(await f.pass([2]));
  assert.deepEqual(f.published.at(-1),{files:20,repositories:2});
  assert.equal(f.reads.length,21);assert.equal(f.writes.length,before);assert.equal(f.saves.length,2);
});

test('full-refresh counting selects the newest eligible sync across pages and refreshes provisional same-key data', async()=>{
  const f=setup();f.settings.pageSize=1;
  f.data.set(key('repositories',1),rows({id:1}));
  f.data.set(key('repositories',2),rows({id:20},{id:21}));
  const active=key('repositories',3);f.data.set(active,rows({id:30},{id:31},{id:32}));
  await f.finish(await f.pass([1,2]));assert.equal(f.published.at(-1).repositories,2);
  assert.deepEqual(f.reads,[key('repositories',2)]);
  assert.ok(f.lists.includes(prefix+'stream=repositories/'));
  await f.finish(await f.pass([]));assert.equal(f.published.at(-1).repositories,3);
  f.data.set(active,rows({id:'replacement'}));
  await f.finish(await f.pass([3]));assert.equal(f.published.at(-1).repositories,1);
});

test('existing incremental receipts and a completed v1 full refresh hydrate without historical raw reads', async()=>{
  const f=setup(), old=key('files',1), fresh=key('files',2), repository=key('repositories',2);
  f.data.set(old,Buffer.from('must not reopen existing file'));f.data.set(repository,Buffer.from('must not reopen completed full refresh'));
  f.seedLegacy({version:1, read:[old], ids:{files:[recordKey({path:'x'},['path'])]}, full:{repositories:{sync:2,count:7}}}, {files:1,repositories:7});
  const writes=f.writes.length;
  await f.finish(await f.pass([2]));
  assert.deepEqual(f.reads,[]);assert.equal(f.writes.length,writes);
  assert.deepEqual(f.published.at(-1),{files:1,repositories:7});
  f.data.set(fresh,rows({path:'x',updated:true},{path:'y'}));await f.finish(await f.pass([2]));
  assert.deepEqual(f.reads,[fresh]);assert.deepEqual(f.published.at(-1),{files:2,repositories:7});
});

test('a replacement execution keeps provisional full receipts from the prior worker across the page budget', async()=>{
  const f=setup();
  for(let i=0;i<18;i++)f.data.set(key('repositories',4,'p'+i),rows({id:i}));
  const first=await f.pass(), checkpoint=await f.activities.advanceConnectorCounts(first);
  assert.equal(checkpoint.done,false);assert.equal(f.reads.length,16);
  const originalScan=f.head.progress.scanId;
  f.head.generation='30000000-0000-4000-8000-000000000001';
  assert.notEqual(f.head.generation,originalScan);
  await f.finish({...first,countGeneration:f.head.generation,revision:checkpoint.revision});
  assert.deepEqual(f.published.at(-1),{repositories:18});assert.equal(f.reads.length,18);
});

test('corrupt data and revocation leave the previously published generation intact', async()=>{
  const f=setup({...provider,progress:[]});
  f.data.set(key('files',1),rows({path:'already'}));await f.finish(await f.pass([1]));
  assert.ok(f.lists.every(prefix=>prefix.endsWith('stream=')),'no preliminary LIST on all-incremental streams');
  const before=f.writes.length;
  f.data.set(key('files',2),gzipSync(line({path:'partial'})+'\nbad json'));
  const next=await f.pass([2]);
  await assert.rejects(f.activities.advanceConnectorCounts(next),/Invalid Airbyte JSON/);
  assert.deepEqual(f.published,[{files:1}]);assert.equal(f.writes.length,before);assert.equal(f.head.revision,0);
  f.data.set(key('files',2),rows({path:'fixed'}));f.data.set(key('files',3),rows({path:'new'}));f.settings.revokeAfterRead=true;
  await assert.rejects(f.activities.advanceConnectorCounts(next),/revoked/);
  assert.equal(f.reads.includes(key('files',3)),false);
  assert.equal(f.writes.length,before);f.settings.scope=true;f.settings.revokeAfterRead=false;
  await f.finish(next);assert.deepEqual(f.published.at(-1),{files:3});
});

test('foreign listings and cancelled jobs cannot promote a source measurement', async()=>{
  const f=setup();f.settings.foreignKey=true;const pass=await f.pass([1]);
  await assert.rejects(f.activities.advanceConnectorCounts(pass),/outside connector scope/);
  assert.deepEqual(f.reads,[]);assert.deepEqual(f.published,[]);
  f.settings.foreignKey=false;f.settings.cancelled=true;
  await assert.rejects(f.activities.advanceConnectorCounts(pass),/cancelled/);
  assert.deepEqual(f.reads,[]);assert.deepEqual(f.published,[]);
});

test('landed primary keys remain countable through unrelated Airbyte changes or missing extraction times',async()=>{
  const f=setup({...provider,progress:[]}), path=key('files',2);
  const flagged={_airbyte_extracted_at:1,_airbyte_data:{path:'same',size:null},_airbyte_meta:{changes:[{field:'size',change:'NULLED'}]}};
  const untimed={_airbyte_data:{path:'second'}};
  f.data.set(path,gzipSync([flagged,untimed,{_airbyte_data:{path:'same',size:5}}].map(record=>JSON.stringify(record)).join('\n')));
  await f.finish(await f.pass([2]));assert.deepEqual(f.published,[{files:2}]);
  // Indexing still requires both a lossless row and a trusted extraction time.
  for(const [record,expected] of [[flagged,/lossy source changes/],[untimed,/Invalid Airbyte envelope/]]) {
    const store={get:async()=>gzipSync(JSON.stringify(record))};
    await assert.rejects(readRecords(store,path,()=>assert.fail('ineligible row indexed')),expected);
  }
});

test('a superseded worker can prepare a measurement but cannot modify the source snapshot',async()=>{
  const f=setup();f.data.set(key('files',1),rows({path:'x'}));const pass=await f.pass();
  f.settings.rejectLock=true;
  assert.equal(await f.activities.advanceConnectorCounts(pass),null);
  assert.equal(f.saves.length,1);assert.deepEqual(f.writes,[]);assert.deepEqual(f.published,[]);
  f.settings.rejectLock=false;await f.finish(pass);
  assert.equal(f.writes.length,1);assert.deepEqual(f.published,[{files:1}]);
});

const countScope={environment:'selfhost',tenantId:ref.tenantId,userId:ref.userId,integrationId:ref.connectionId,
  binding:countBinding('owned',prefix,'github')};
async function admit(db,state) {
  await state.ready();
  const record={s3Bucket:'owned',s3Prefix:prefix.slice(0,-1)};
  await db.pool.query(`INSERT INTO opencrawl_integrations(namespace,environment,tenant_id,user_id,integration_id,provider,status,record)
    VALUES($1,'selfhost',$2,$3,$4,'github','active',$5::jsonb)`,[db.namespace,ref.tenantId,ref.userId,ref.connectionId,JSON.stringify(record)]);
}

test('an admitted PostgreSQL head and the object store advance together through an interrupted count', {skip:!postgresUrl}, async t=>{
  const db=await applicationDatabaseFixture(t), state=createConnectorCounts(db), f=setup(provider,state), scope=countScope;
  await admit(db,state);
  assert.equal((await state.request(scope,[2],10,false)).dispatch,true);
  for(let i=0;i<19;i++)f.data.set(key('files',2,'part'+i),rows({path:'item'+i},{path:'item0'}));
  const begin=await f.activities.beginConnectorCounts({...ref,passId:'first',startedAt:10});
  const next=await f.activities.advanceConnectorCounts({...ref,countGeneration:begin.generation,revision:begin.revision});
  assert.equal(next.done,false);assert.equal(f.reads.length,16);assert.equal(f.writes.length,1);
  assert.equal(await state.read(scope),null,'partial state never replaces a card measurement');
  const recovery=await f.activities.beginConnectorCounts({...ref,passId:'recovery',startedAt:20});
  assert.notEqual(recovery.generation,begin.generation);assert.equal(recovery.revision,next.revision);
  assert.equal(await f.activities.advanceConnectorCounts({...ref,countGeneration:begin.generation,revision:next.revision}),null);
  await f.finish({...ref,countGeneration:recovery.generation,revision:recovery.revision});
  assert.equal(f.reads.length,19);assert.equal(f.writes.length,2);
  assert.deepEqual([...new Set(f.writes)],[snapshotKey],'only the existing connection count object is written');
  assert.deepEqual(await state.read(scope),{files:19});
});

test('a PostgreSQL COMMIT failure after a successful S3 CAS adopts the exact surviving object before relisting', {skip:!postgresUrl}, async t=>{
  const db=await applicationDatabaseFixture(t), scope=countScope;
  let f, failCommit=true;
  const state=createConnectorCounts({...db, transaction:operation=>db.transaction(async client=>{
    const writes=f?.writes.length;
    const result=await operation(client);
    if (failCommit && f && f.writes.length>writes) {
      failCommit=false;
      // No statement fails here. PostgreSQL raises 23503 at the real COMMIT
      // after the callback's conditional object write and SQL UPDATE succeeded.
      await client.query(`CREATE TEMP TABLE count_failure_parent(id integer PRIMARY KEY) ON COMMIT DROP;
        CREATE TEMP TABLE count_failure_child(id integer REFERENCES count_failure_parent(id) DEFERRABLE INITIALLY DEFERRED) ON COMMIT DROP;
        INSERT INTO count_failure_child VALUES(1)`);
    }
    return result;
  })});
  f=setup(provider,state);await admit(db,state);
  const previous=key('files',1,'old'), legacy={version:1,read:[previous],ids:{files:[recordKey({path:'old'},['path'])]},full:{}};
  f.data.set(previous,Buffer.from('receipted object must never be fetched'));
  const before=f.seedLegacy(legacy,{files:1});
  assert.equal(await state.seed(scope,{files:1},before),true);
  for(let i=0;i<18;i++) f.data.set(key('files',2,'p'+i),rows({path:'n'+i}));
  await state.request(scope,[2],10,false);
  const begun=await f.activities.beginConnectorCounts({...ref,passId:'first',startedAt:10});
  const input={...ref,countGeneration:begun.generation,revision:begun.revision};
  await assert.rejects(f.activities.advanceConnectorCounts(input),{code:'23503'});
  assert.deepEqual(f.writes,[snapshotKey]);assert.equal(f.reads.length,16);
  const rolledBack=await state.current(scope,begun.generation);
  assert.equal(rolledBack.revision,0);assert.equal(rolledBack.statePointer,before);assert.equal(rolledBack.progress,null);
  assert.deepEqual(await state.read(scope),{files:1});
  const actual=createHash('sha256').update(f.data.get(snapshotKey)).digest('hex');assert.notEqual(actual,before);
  const adopted=await f.activities.advanceConnectorCounts(input);
  assert.deepEqual(adopted,{revision:1,done:false});
  const repaired=await state.current(scope,begun.generation);
  assert.equal(repaired.statePointer,actual);assert.equal(repaired.progress,null);assert.deepEqual(repaired.succeeded,[2]);
  assert.equal(f.writes.length,1);assert.equal(f.reads.length,16);assert.deepEqual(await state.read(scope),{files:1});
  await f.finish({...input,revision:adopted.revision});
  assert.equal(f.reads.length,18);assert.equal(new Set(f.reads).size,18);assert.equal(f.reads.includes(previous),false);
  assert.deepEqual(f.writes,[snapshotKey,snapshotKey]);assert.deepEqual(await state.read(scope),{files:19});
});
