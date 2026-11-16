import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
import {createPostgresControls,resourceControlIdentity} from '../dist/src/state/resource-controls.mjs';
import {createPostgresWriteBarrier,ensureWriteBarrierSchema} from '../dist/src/state/write-barriers.mjs';
import {createPostgresIndexingReceipts} from '../dist/src/state/indexing-receipts.mjs';
import {createPostgresDeletionRequests,ensureDeletionRequestSchema} from '../dist/src/state/deletion-requests.mjs';
const live=(name,run)=>test(name,{skip:!postgresUrl},run),owner={tenantId:'org_team',userId:'user_owner'};
async function fixture(t){const database=await applicationDatabaseFixture(t),controls=createPostgresControls(database),receipts=createPostgresIndexingReceipts(database);await Promise.all([controls.ready(),receipts.ready(),ensureWriteBarrierSchema(database),ensureDeletionRequestSchema(database)]);return {database,controls,receipts,fence:options=>createPostgresWriteBarrier({database,tenantId:owner.tenantId,connectionId:'int_resource',...options})};}
live('privacy updates serialize with deletion and tombstones never reopen across process or namespace',async t=>{
  const f=await fixture(t),other=await fixture(t),at=new Date().toISOString();
  await Promise.all([f.controls.update(owner,'sessions','codex','session',current=>({...current,visibility:'private',deletedAt:current?.deletedAt??null})),f.controls.update(owner,'sessions','codex','session',current=>({...current,visibility:current?.visibility??'team',deletedAt:at,deletion:{sessionId:'session',state:'pending'}}))]);
  const value=await f.controls.read(owner,'sessions','codex','session');assert.equal(value.visibility,'private');assert.equal(value.deletedAt,at);
  assert.equal(await other.controls.read(owner,'sessions','codex','session'),null);assert.equal(await f.controls.read({...owner,userId:'user_other'},'sessions','codex','session'),null);
  const restarted=createPostgresControls(f.database);assert.deepEqual(await restarted.read(owner,'sessions','codex','session'),value);
  await assert.rejects(restarted.update(owner,'sessions','codex','session',()=>({visibility:'team',deletedAt:null})),{status:403});
  await restarted.update(owner,'sessions','codex','session',current=>({...current,deletion:{sessionId:'session',state:'complete'}}));
  await assert.rejects(restarted.update(owner,'sessions','codex','session',current=>({...current,deletion:{sessionId:'session',state:'pending'}})),{status:403});
  await assert.rejects(restarted.importControl(resourceControlIdentity(owner,'sessions','codex','session'),value),{status:409});
});
live('closing a SQL fence sees in-flight writes and survives restart without admitting another write',async t=>{
  const f=await fixture(t);let release,started;const running=new Promise(resolve=>started=resolve),wait=new Promise(resolve=>release=resolve);
  const write=f.fence().run('object-put',async()=>{started();await wait;return 'written';});await running;
  const before=await f.fence().close();assert.equal(before.closed,true);assert.equal(before.pending,1);
  await assert.rejects(f.fence().run('object-put',()=>assert.fail('closed fence invoked external write')),{status:403});
  release();assert.equal(await write,'written');assert.equal((await f.fence().inspect()).pending,0);assert.equal((await f.fence().inspect()).closed,true);
  assert.equal(await f.fence({connectionId:'int_other'}).run('object-put',()=>42),42);
});
live('uncertain remote outcomes remain pending and imports preserve exact historical uncertainty',async t=>{
  const f=await fixture(t),barrier=f.fence();
  await assert.rejects(barrier.run('search-write',()=>{throw new Error('response lost after external write');}),{code:'CONNECTOR_WRITE_PENDING'});
  const before=await barrier.close();assert.equal(before.pending,1);assert.equal((await f.fence({now:()=>Date.now()+365*86400_000}).inspect()).pending,1);
  const target=await fixture(t),copy=target.fence();
  const legacy={version:1,...barrier.scope,closedAt:before.closedAt,writers:before.writers};
  await copy.importFence(legacy);assert.deepEqual(await copy.inspect(),before);await copy.importFence(legacy);
  await assert.rejects(copy.importFence({...legacy,closedAt:null}),{code:'CONNECTOR_WRITE_PENDING'});
  await assert.rejects(copy.importFence({...legacy,tenantId:'org_foreign'}),{code:'CONNECTOR_WRITE_PENDING'});
});
live('only positive no-mutation evidence settles a rejected write',async t=>{
  const f=await fixture(t);await assert.rejects(f.fence().run('object-put',()=>{throw Object.assign(new Error('known rejected'),{writeOutcome:'not-applied'});}),/known rejected/);
  assert.equal((await f.fence().close()).pending,0);
});
live('index completion receipts are scoped, bounded and verify exact migration payloads',async t=>{
  const f=await fixture(t),other=await fixture(t),key='capture/_index/generation/batches/source.json',value={status:'indexed',documents:5,indexedAt:'2026-01-01T00:00:00Z'};
  await f.receipts.put(key,value);assert.deepEqual(await f.receipts.read(key),value);assert.equal(await other.receipts.read(key),null);
  await f.receipts.importReceipt(key,value);await assert.rejects(f.receipts.importReceipt(key,{...value,documents:6}),/differs/);
  await assert.rejects(f.receipts.put(key,{value:'x'.repeat(32769)}),/exceeds/);
  await assert.rejects(f.receipts.put('../escape',value),/Invalid/);
});
live('deletion intent pagination is durable, scoped and preserves original request identities',async t=>{
  const f=await fixture(t),other=await fixture(t),requests=createPostgresDeletionRequests(f.database,'capture/v1');
  for(let i=0;i<55;i++)await requests.put(owner,{harness:'codex',sessionId:'session-'+i});
  const first=await requests.list(),second=await requests.list(first.cursor);assert.equal(first.keys.length,50);assert.equal(second.keys.length,5);assert.equal(second.cursor,null);
  const key=first.keys[0],value=await requests.read(key);await requests.importRequest(key,value);assert.deepEqual(await createPostgresDeletionRequests(f.database,'capture/v1').read(key),value);
  assert.equal(await createPostgresDeletionRequests(other.database,'capture/v1').read(key),null);
  await assert.rejects(requests.put({...owner,captureAccess:'write'},{harness:'codex',sessionId:'denied'}),{status:403});
  await assert.rejects(createPostgresDeletionRequests(f.database,'other').read(key),{permanent:true});
  await assert.rejects(requests.importRequest(key,{...value,owner:{...owner,userId:'user_foreign'}}),/identity mismatch/);
});
