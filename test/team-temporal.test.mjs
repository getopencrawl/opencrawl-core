import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {TestWorkflowEnvironment} from '@temporalio/testing';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';
import {createCaptureCredentials} from '../dist/src/sessions/credentials.mjs';
import {roleWriteGuard} from '../dist/src/identity/role-write.mjs';
import {teamService} from '../dist/src/identity/team.mjs';
import {admitTeamChange,prepareTeamOperations,teamChangeActivities} from '../dist/src/identity/team-operation.mjs';
import {inventoryTeamGuards,pauseLegacyTeamGuards,resumeLegacyTeamGuards,activateTeamGuards,activateSelfhostTeamGuard} from '../dist/src/identity/team-guard-authority.mjs';
import {selfhostTeamWrites} from '../dist/src/selfhost/team-writes.mjs';
import {durableTeamWrites} from '../dist/src/identity/temporal/client.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from '@temporalio/worker';
import {buildTeamWorkflows} from '../dist/src/identity/temporal/worker.mjs';

const change={organizationId:'org_team',actorId:'user_admin',userId:'user_member',role:'remove'};
const admitted={...change,actorMembershipId:'om_user_admin',targetMembershipId:'om_user_member'};
async function fixture(t) {
  const database=await applicationDatabaseFixture(t);
  await prepareTeamOperations(database);
  const store=memorySessionStore(),prefix='test',credential=createCaptureCredentials({store,prefix});
  const members=new Map([['user_admin','admin'],['user_member','member']].map(([userId,slug])=>[userId,{
    id:'om_'+userId,organizationId:change.organizationId,userId,status:'active',role:{slug},
  }]));
  let writes=0;
  const directory={userManagement:{
    listOrganizationMemberships:async({organizationId,userId})=>({data:[...members.values()].filter(member=>member.organizationId===organizationId&&member.userId===userId)}),
    deleteOrganizationMembership:async id=>{writes++;assert.equal(id,'om_user_member');members.delete('user_member');},
    updateOrganizationMembership:async(id,{roleSlug})=>{writes++;const item=members.get('user_member');assert.equal(id,item.id);item.role={slug:roleSlug};return item;},
  }};
  const options={database,directory,store,prefix,credentials:{capture:credential},organizationId:change.organizationId};
  return {database,directory,credential,members,writes:()=>writes,options,ref:(command=admitted)=>admitTeamChange(database,command,async ref=>ref)};
}

test('team changes bind the queued reference to committed intake, guard ownership and checkpointed cleanup',{skip:!postgresUrl},async t=>{
  const f=await fixture(t),{organizationId:tenantId,userId}=change,owner={tenantId,userId};
  const issued=await f.credential.issue(owner),ref=await f.ref();
  const worker=teamChangeActivities(f.options),bad=teamChangeActivities({...f.options,organizationId:'org_other'});
  await assert.rejects(bad.advanceTeamChange(ref),/scope mismatch/);
  assert.equal((await worker.advanceTeamChange({...ref,operationId:randomUUID()})).outcome.ok,false);
  let rolledBack;
  await assert.rejects(admitTeamChange(f.database,admitted,async ref=>{rolledBack=ref;throw Error('start was not accepted');}),/not accepted/);
  assert.equal((await worker.advanceTeamChange(rolledBack)).outcome.ok,false);
  assert.equal(f.writes(),0);
  const blocked=await roleWriteGuard(f.options.store,f.options.prefix)(tenantId,'user_prior',userId,'admin');
  assert.equal((await worker.advanceTeamChange(ref)).outcome.status,409);
  await blocked.release();
  const next=await f.ref();
  const original=f.options.credentials.capture.revokeVersion;
  let attempts=0;
  f.options.credentials.capture.revokeVersion=async(...args)=>{await original(...args);if(++attempts===1)throw Error('temporary storage interruption');};
  await assert.rejects(worker.advanceTeamChange(next),/temporarily unavailable/);
  assert.equal(f.writes(),1);
  assert.equal(await f.credential.authenticate(issued.token),null);
  assert.deepEqual(await teamChangeActivities(f.options).advanceTeamChange(next),{review:false,outcome:{ok:true}});
  assert.equal(f.writes(),1);
  await worker.forgetCompletedTeamChange(next);
  assert.equal((await worker.advanceTeamChange(next)).outcome.ok,false);
});

test('queued changes reject replacement memberships for the administrator and teammate',{skip:!postgresUrl},async t=>{
  const f=await fixture(t),worker=teamChangeActivities(f.options);
  for(const userId of [change.actorId,change.userId]) {
    let queued;
    const service=teamService(f.directory,undefined,undefined,async command=>{queued=await f.ref(command);});
    await service.removeMember({id:change.actorId},change.organizationId,change.userId);
    const member=f.members.get(userId);
    f.members.set(userId,{...member,id:member.id+'_rejoined'});
    const result=await worker.advanceTeamChange(queued);
    assert.equal(result.review,false);
    assert.equal(result.outcome.status,409);
    assert.equal(f.writes(),0);
    assert.equal(f.members.get(userId).id,member.id+'_rejoined');
    await worker.forgetCompletedTeamChange(queued);
  }
});

test('a rejoin before readback cannot reactivate credentials issued to the removed membership',{skip:!postgresUrl},async t=>{
  const f=await fixture(t),ref=await f.ref(),worker=teamChangeActivities(f.options);
  const owner={tenantId:change.organizationId,userId:change.userId},old=await f.credential.issue(owner);
  const apply=f.directory.userManagement.deleteOrganizationMembership,previous=f.members.get(owner.userId);
  f.directory.userManagement.deleteOrganizationMembership=async id=>{
    await apply(id);
    f.members.set(owner.userId,{...previous,id:'om_rejoined'});
  };
  assert.equal((await worker.advanceTeamChange(ref)).review,true);
  assert.equal(await f.credential.authenticate(old.token),null);
  const after=await f.credential.issue(owner);
  assert.equal((await worker.advanceTeamChange(ref)).review,true);
  assert.ok(await f.credential.authenticate(after.token));
  assert.equal(f.writes(),1);
});

test('unconfirmed provider writes keep the original guard through retries and operator rechecks',{skip:!postgresUrl},async t=>{
  const f=await fixture(t),ref=await f.ref(),worker=teamChangeActivities(f.options);
  const apply=f.directory.userManagement.deleteOrganizationMembership;
  f.directory.userManagement.deleteOrganizationMembership=async id=>{await apply(id);throw Error('unknown outcome');};
  assert.equal((await worker.advanceTeamChange(ref)).review,true);
  assert.equal((await worker.advanceTeamChange(ref)).review,true);
  assert.equal(f.writes(),1);
  assert.equal((await worker.advanceTeamChange(await f.ref())).outcome.status,409);
  // Simulate an operator confirming the specific outstanding provider call.
  await f.database.pool.query("UPDATE opencrawl_team_operations SET phase='applied' WHERE namespace=$1 AND organization=$2 AND operation=$3 AND membership='om_user_member' AND phase='dispatching'",[f.database.namespace,ref.organizationId,ref.operationId]);
  assert.equal((await worker.advanceTeamChange(ref)).outcome.ok,true);
  assert.equal(f.writes(),1);
});

test('Temporal returns the team outcome after committed intake and resumes a reviewed removal',{skip:!postgresUrl||process.env.OPENCRAWL_TEST_TEMPORAL!=='1',timeout:150000},async t=>{
  const f=await fixture(t),queue='team-test-'+randomUUID();
  await activateNative(f);
  const binary=process.env.OPENCRAWL_TEST_TEMPORAL_BINARY;
  const environment=await TestWorkflowEnvironment.createLocal(binary?{server:{executable:{type:'existing-path',path:binary}}}:{});
  t.after(()=>environment.teardown());
  const directory=await mkdtemp(join(tmpdir(),'team-workflow-')),bundle=join(directory,'team.cjs');
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await buildTeamWorkflows(bundle);
  const start=async()=>{
    const worker=await Worker.create({connection:environment.nativeConnection,namespace:environment.namespace,taskQueue:queue,
      workflowBundle:{codePath:bundle},activities:teamChangeActivities(f.options)});
    const running=worker.run();
    return async()=>{worker.shutdown();await running;};
  };
  let stop=await start();
  try {
    const service=teamService(f.directory,undefined,undefined,durableTeamWrites(f.database,environment.client,queue));
    const actor={id:change.actorId};
    await service.changeRole(actor,change.organizationId,change.userId,'admin');
    assert.equal(f.members.get('user_member').role.slug,'admin');
    const apply=f.directory.userManagement.deleteOrganizationMembership;
    f.directory.userManagement.deleteOrganizationMembership=async id=>{await apply(id);throw Error('response unavailable');};
    await assert.rejects(service.removeMember(actor,change.organizationId,change.userId),{status:503});
    await stop();
    stop=await start();
    const {rows:[ref]}=await f.database.pool.query("UPDATE opencrawl_team_operations SET phase='applied' WHERE namespace=$1 AND phase='dispatching' RETURNING organization,operation",[f.database.namespace]);
    const handle=environment.client.workflow.getHandle('team-member/'+ref.organization+'/'+ref.operation);
    await handle.signal('recheckTeamChange');
    assert.deepEqual(await handle.result(),{ok:true});
    assert.equal(f.writes(),2);
  } finally {await stop();}
});

test('an unavailable Temporal start can occupy only two API database admissions',{skip:!postgresUrl},async t=>{
  const f=await fixture(t),bothStarted=Promise.withResolvers(),allowStarts=Promise.withResolvers();
  const waiting=Promise.withResolvers(),finish=Promise.withResolvers();
  let count=0;
  const client={connection:{withDeadline:(_time,fn)=>fn()},workflow:{start:async()=>{
    if(++count===2)bothStarted.resolve();
    await allowStarts.promise;
    return {executeUpdate:async()=>{waiting.resolve();return finish.promise;}};
  }}};
  const write=durableTeamWrites(f.database,client,'team-admissions-test');
  const first=write(admitted),second=write(admitted);
  try {
    await bothStarted.promise;
    await assert.rejects(write(admitted),{status:503});
    assert.equal(count,2);
    allowStarts.resolve();
    await waiting.promise;
    const third=write(admitted);
    finish.resolve({ok:true});
    await Promise.all([first,second,third]);assert.equal(count,3);
  } finally {allowStarts.resolve();finish.resolve({ok:true});}
});

async function activateNative(f) {
  const {database,options:{store,prefix}}=f;
  await pauseLegacyTeamGuards(database);
  const {digest}=await inventoryTeamGuards(store,prefix);
  await activateTeamGuards(database,store,prefix,digest);
}
test('SQL authority requires a complete frozen inventory and drained team operations',{skip:!postgresUrl},async t=>{
  const f=await fixture(t),{store,prefix}=f.options,key=prefix+'/organization-role-writes/org_team.json';
  const orphan=await roleWriteGuard(store,prefix)(change.organizationId,change.actorId,change.userId,'remove');
  const ref=await f.ref();
  await pauseLegacyTeamGuards(f.database);
  await assert.rejects(f.ref(),{status:503});
  await assert.rejects(teamChangeActivities(f.options).advanceTeamChange(ref),/temporarily unavailable/);
  const held=await inventoryTeamGuards(store,prefix);
  assert.deepEqual([held.held,held.idle,held.unknown],[1,0,0]);
  await assert.rejects(activateTeamGuards(f.database,store,prefix,held.digest),/reconciliation/);
  await orphan.release();
  const idle=await inventoryTeamGuards(store,prefix);
  assert.deepEqual([idle.held,idle.idle,idle.unknown],[0,1,0]);
  await assert.rejects(activateTeamGuards(f.database,store,prefix,held.digest),/changed/);
  const saved=await store.get(key);
  await store.put(key,Buffer.from('{"schemaVersion":1,"state":"idle"}'));
  const malformed=await inventoryTeamGuards(store,prefix);
  assert.equal(malformed.unknown,1);
  await assert.rejects(activateTeamGuards(f.database,store,prefix,malformed.digest),/reconciliation/);
  await store.put(key,saved);
  await resumeLegacyTeamGuards(f.database);
  const again=await f.ref();
  await f.database.pool.query("UPDATE opencrawl_team_operations SET phase='dispatching' WHERE namespace=$1 AND operation=$2",[f.database.namespace,again.operationId]);
  await pauseLegacyTeamGuards(f.database);
  const source=await inventoryTeamGuards(store,prefix);
  await assert.rejects(activateTeamGuards(f.database,store,prefix,source.digest),/uncertain/);
});
test('SQL guard serializes different operations and retains an uncertain provider outcome across worker restart',{skip:!postgresUrl},async t=>{
  const f=await fixture(t);
  await activateNative(f);
  const store=f.options.store;
  const forbid=name=>{const original=store[name];store[name]=async(key,...args)=>{assert(!key.includes('/organization-role-writes/'),'native worker used an object guard');return original(key,...args);};};
  forbid('readVersion');forbid('compareAndSet');
  const begin=Promise.withResolvers(),finish=Promise.withResolvers(),first=await f.ref(),other=await f.ref();
  const remove=f.directory.userManagement.deleteOrganizationMembership;
  let dispatches=0;
  f.directory.userManagement.deleteOrganizationMembership=async id=>{dispatches++;begin.resolve();await finish.promise;await remove(id);throw Error('lost acknowledgement');};
  const worker=teamChangeActivities(f.options),running=worker.advanceTeamChange(first);
  try {
    await begin.promise;
    assert.equal((await worker.advanceTeamChange(other)).outcome.status,409);
  }finally{finish.resolve();}
  assert.equal((await running).review,true);
  const restarted=teamChangeActivities(f.options);
  assert.equal((await restarted.advanceTeamChange(first)).review,true);
  assert.equal((await restarted.advanceTeamChange(await f.ref())).outcome.status,409);
  assert.equal(dispatches,1);
  await assert.rejects(resumeLegacyTeamGuards(f.database),/already active/);
  await f.database.pool.query("UPDATE opencrawl_team_operations SET phase='applied' WHERE namespace=$1 AND operation=$2 AND phase='dispatching'",[f.database.namespace,first.operationId]);
  assert.equal((await restarted.advanceTeamChange(first)).outcome.ok,true);
  assert.equal(dispatches,1);
});
test('self-host fence retains a standalone held guard and blocks old binaries after migration',{skip:!postgresUrl},async t=>{
  const f=await fixture(t),{database,options:{store,prefix,organizationId}}=f;
  const legacy=roleWriteGuard(store,prefix),orphan=await legacy(organizationId,change.actorId,change.userId,'remove');
  const local=selfhostTeamWrites(f.options);
  await assert.rejects(local.write({...admitted,organizationId:'org_foreign'}),{status:403});
  assert.equal((await database.pool.query('SELECT 1 FROM opencrawl_team_operations WHERE namespace=$1',[database.namespace])).rowCount,0);
  await assert.rejects(local.write(admitted),{status:503});
  assert.equal(f.writes(),0);
  await orphan.release();
  await activateSelfhostTeamGuard(database,store,prefix,organizationId);
  await assert.rejects(legacy(organizationId,change.actorId,change.userId,'remove'),{status:409});
  await assert.rejects(activateSelfhostTeamGuard(database,store,prefix,'org_different'),/binding changed/);
  const remove=f.directory.userManagement.deleteOrganizationMembership;
  f.directory.userManagement.deleteOrganizationMembership=async id=>{await remove(id);throw Error('lost acknowledgement');};
  const owner={tenantId:organizationId,userId:change.userId},issued=await f.credential.issue(owner);
  await assert.rejects(local.write(admitted),{status:503});
  const restarted=selfhostTeamWrites(f.options);
  await assert.rejects(restarted.recover(),{status:503});
  await database.pool.query("UPDATE opencrawl_team_operations SET phase='applied' WHERE namespace=$1 AND phase='dispatching'",[database.namespace]);
  await restarted.recover();
  assert.equal(await f.credential.authenticate(issued.token),null);
  assert.equal(f.writes(),1);
  assert.equal((await database.pool.query('SELECT 1 FROM opencrawl_team_operations WHERE namespace=$1',[database.namespace])).rowCount,0);
});
test('two admitted administrators cannot demote one another past the last active admin in native mode',{skip:!postgresUrl},async t=>{
  const f=await fixture(t);
  await activateNative(f);
  f.members.get(change.userId).role={slug:'admin'};
  f.directory.userManagement.updateOrganizationMembership=async(id,{roleSlug})=>{
    const member=[...f.members.values()].find(row=>row.id===id);
    member.role={slug:roleSlug};
    return member;
  };
  const worker=teamChangeActivities({...f.options,checkLastAdmin:async(_org,target)=>{
    if(![...f.members.values()].some(row=>row.userId!==target && row.role.slug==='admin'))throw Object.assign(Error('The workspace must keep an active administrator.'),{status:409,expose:true});
  }});
  const first=await f.ref({...admitted,role:'member'});
  const second=await f.ref({...admitted,actorId:change.userId,userId:change.actorId,role:'member',actorMembershipId:admitted.targetMembershipId,targetMembershipId:admitted.actorMembershipId});
  assert.equal((await worker.advanceTeamChange(first)).outcome.ok,true);
  assert.equal((await worker.advanceTeamChange(second)).outcome.status,409);
  assert.equal([...f.members.values()].filter(row=>row.role.slug==='admin').length,1);
});
