import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReplicasState,createPostgresReplicasRepository} from '../dist/src/state/replicas.mjs';
import {createReplicasConnections} from '../dist/src/identity/replicas-connections.mjs';
import {replicasOwnerId} from '../dist/src/identity/replicas.mjs';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';

const pg={skip:!postgresUrl},tenant='org_a',other='org_b',prefix='capture-v1',bucket='fixture-bucket';
const org='11111111-1111-4111-8111-111111111111',env='22222222-2222-4222-8222-222222222222',
  vm='33333333-3333-4333-8333-333333333333',otherOrg='44444444-4444-4444-8444-444444444444';
const admin=(tenantId=tenant)=>({tenantId,userId:'admin'});
const member=(organizationId=tenant)=>({organizationId,userId:'admin',status:'active',role:{slug:'admin'}});
const sha=value=>createHash('sha256').update(value).digest('hex');
const clock=Date.UTC(2026,1,1);
async function fixture(t,{organizationId=null}={}) {
  const db=await applicationDatabaseFixture(t,{sourceIdentity:{version:1,bucket,prefix,organizationId}});
  const store=Object.assign(memorySessionStore(),{bucket});
  const state=createReplicasState(db,store,prefix);
  let time=clock,adminEnabled=true;
  const instantiate=repository=>createReplicasConnections({
    ...(repository?{repository}:{store,prefix}),tenantId:organizationId??undefined,now:()=>time,
    isAdmin:async()=>adminEnabled,
    verify:async token=>({status:200,workload:{organizationId:token,environmentId:env,workspaceId:vm}}),
  });
  return {state,db,store,instantiate,advance:ms=>{time+=ms;},removeAdmin:()=>{adminEnabled=false;}};
}
const status=expected=>e=>e.status===expected;

test('verified handoff preserves ownership, approvals, confirmed installation, expiry and revocation',pg,async t=>{
  const f=await fixture(t),bridge=f.instantiate(f.state.repository);
  const setup=await bridge.issue(admin(),member());
  await bridge.claim(setup.code,org);
  const userId=replicasOwnerId(org,env,vm);
  await bridge.confirmInstallation({tenantId:tenant,userId,owner:{kind:'shared',provider:'replicas',organizationId:org,environmentId:env,workspaceId:vm}});
  const native=createPostgresReplicasRepository(f.db);
  await assert.rejects(native.repository.readConnection(org),/receipt is required/);
  const before=await bridge.lookupOrganization(org);
  const unused=await bridge.issue(admin(),member());
  assert.equal(await f.state.active(),false);
  const plan=await f.state.migrate('check');
  assert.equal(plan.backend,'objects');
  assert.deepEqual([plan.receipt.organizations,plan.receipt.setupCodes,plan.receipt.tenantIndexes],[1,2,1]);
  const originalKeys=[...f.store.data.keys()];
  const old=(await f.state.repository.readConnection(org)).version;
  const activated=await f.state.migrate('activate');
  assert.deepEqual(activated.receipt,plan.receipt);
  assert.equal(activated.backend,'postgres');
  assert.equal(await f.state.repository.saveConnection(org,old,before),false);
  const restarted=f.instantiate(native.repository);
  assert.deepEqual(await restarted.lookupOrganization(org),before);
  assert.deepEqual(await restarted.sharedInstallations(admin()),before.installations);
  assert.deepEqual(await restarted.list(admin(other)),[]);
  assert.deepEqual(await restarted.claim(setup.code,org),{organizationId:org,tenantId:tenant,connected:true});
  await assert.rejects(restarted.claim(setup.code,otherOrg),status(409));
  await assert.rejects(restarted.revoke(admin(other),org),status(404));
  f.advance(1);await restarted.revoke(admin(),org);
  await assert.rejects(bridge.claim(setup.code,org),status(409));
  assert.equal(await bridge.resolveOrganization(org),null);
  // An older bridge-capable image with a fresh pool follows the PG receipt.
  const rollback=f.instantiate(createReplicasState(f.db,f.store,prefix).repository);
  assert.equal(await rollback.resolveOrganization(org),null);
  assert.deepEqual(await rollback.sharedInstallations(admin()),[]);
  f.advance(30*60*1000);await assert.rejects(rollback.claim(unused.code,otherOrg),status(403));
  const fresh=await rollback.issue(admin(),member());
  f.removeAdmin();await assert.rejects(rollback.claim(fresh.code,org),status(403));
  assert.deepEqual([...f.store.data.keys()],originalKeys);
  assert.ok(f.store.data.get(originalKeys.find(k=>k.includes('/organizations/'))).toString().includes('"revokedAt":null'));
  f.store.listPage=()=>{throw Error('frozen S3 inventory must not replay');};
  assert.deepEqual(await f.state.migrate('activate'),activated);
});

test('concurrent tenant claims have one owner and one setup code cannot identify two workloads',pg,async t=>{
  const f=await fixture(t),a=f.instantiate(f.state.repository),b=f.instantiate(createReplicasState(f.db,f.store,prefix).repository);
  await f.state.migrate('activate');
  const prompts=await Promise.all([a.issue(admin(),member()),b.issue(admin(other),member(other))]);
  const claims=await Promise.allSettled([a.claim(prompts[0].code,org),b.claim(prompts[1].code,org)]);
  assert.equal(claims.filter(c=>c.status==='fulfilled').length,1);
  assert.equal(claims.find(c=>c.status==='rejected').reason.status,409);
  const winningTenant=claims.find(c=>c.status==='fulfilled').value.tenantId;
  assert.equal(await b.resolveOrganization(org),winningTenant);
  const shared=workspaceId=>({tenantId:winningTenant,userId:replicasOwnerId(org,env,workspaceId),
    owner:{kind:'shared',provider:'replicas',organizationId:org,environmentId:env,workspaceId}});
  await Promise.all([a.confirmInstallation(shared(vm)),b.confirmInstallation(shared(otherOrg))]);
  assert.equal((await b.lookupOrganization(org)).installations.length,1);
  const prompt=await a.issue(admin(winningTenant),member(winningTenant));
  const competing=await Promise.allSettled([a.claim(prompt.code,org),b.claim(prompt.code,otherOrg)]);
  assert.equal(competing.filter(c=>c.status==='fulfilled').length,1);
  assert.equal(competing.find(c=>c.status==='rejected').reason.status,409);
  assert.equal(f.store.data.size,0);
});

test('an in-flight or ambiguous source write prevents activation and partial imports roll back',pg,async t=>{
  const f=await fixture(t),bridge=f.instantiate(f.state.repository);
  const entered=Promise.withResolvers(),resume=Promise.withResolvers(),cas=f.store.compareAndSet;
  f.store.compareAndSet=async(...args)=>{entered.resolve();await resume.promise;return cas(...args);};
  const issuing=bridge.issue(admin(),member());await entered.promise;
  await assert.rejects(f.state.migrate('activate'),/Unsettled/);
  resume.resolve();const setup=await issuing;
  await bridge.claim(setup.code,org);
  const index=[...f.store.data.keys()].find(key=>key.includes('/tenants/'));
  await f.store.put(index,Buffer.from('{}'));
  await assert.rejects(f.state.migrate('activate'),/Invalid Replicas tenant index/);
  assert.equal((await f.db.pool.query('SELECT 1 FROM opencrawl_replicas_approvals WHERE namespace=$1',[f.db.namespace])).rowCount,0);
  await f.store.put(index,Buffer.from(JSON.stringify({organizationId:org})));
  const forged=prefix+'/identity/replicas-v1/tenants/'+sha(other)+'/'+org+'.json';
  await f.store.put(forged,f.store.data.get(index));
  await assert.rejects(f.state.migrate('activate'),/disagree/);
  f.store.compareAndSet=async(...args)=>{await cas(...args);throw Error('uncertain result');};
  await assert.rejects(bridge.issue(admin(),member()),/uncertain/);
  await assert.rejects(f.state.migrate('activate'),/Unsettled/);
  assert.equal(await f.state.active(),false);
});

test('self-host binding rejects foreign source data and a mismatched storage target',pg,async t=>{
  const f=await fixture(t,{organizationId:tenant});
  const foreign={schemaVersion:1,tenantId:other,userId:'admin',issuedAt:clock,expiresAt:clock+1000,claim:null};
  await assert.rejects(f.state.repository.saveSetup(sha('foreign'),null,foreign),/tenant mismatch/);
  await f.store.put(prefix+'/identity/replicas-v1/setup/'+sha('foreign')+'.json',Buffer.from(JSON.stringify(foreign)));
  await assert.rejects(f.state.migrate('activate'),/tenant mismatch/);
  assert.equal(await f.state.active(),false);
  assert.throws(()=>createReplicasState(f.db,{...f.store,bucket:'different'},prefix),/must match/);
});
