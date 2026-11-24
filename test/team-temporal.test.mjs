import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {TestWorkflowEnvironment} from '@temporalio/testing';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';
import {createCaptureCredentials} from '../dist/src/sessions/credentials.mjs';
import {roleWriteGuard} from '../dist/src/identity/role-write.mjs';
import {admitTeamChange,prepareTeamOperations,teamChangeActivities} from '../dist/src/identity/team-operation.mjs';
import {durableTeamWrites} from '../dist/src/identity/temporal/client.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildTeamWorkflows,createTeamWorker} from '../dist/src/identity/temporal/worker.mjs';

const change={organizationId:'org_team',actorId:'user_admin',userId:'user_member',role:'remove'};
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
  return {database,directory,credential,members,writes:()=>writes,options,ref:(command=change)=>admitTeamChange(database,command,async ref=>ref)};
}

test('team changes bind the queued reference to committed intake, guard ownership and checkpointed cleanup',{skip:!postgresUrl},async t=>{
  const f=await fixture(t),{organizationId:tenantId,userId}=change,owner={tenantId,userId};
  const issued=await f.credential.issue(owner),ref=await f.ref();
  const worker=teamChangeActivities(f.options),bad=teamChangeActivities({...f.options,organizationId:'org_other'});
  await assert.rejects(bad.advanceTeamChange(ref),/scope mismatch/);
  assert.equal((await worker.advanceTeamChange({...ref,operationId:randomUUID()})).outcome.ok,false);
  let rolledBack;
  await assert.rejects(admitTeamChange(f.database,change,async ref=>{rolledBack=ref;throw Error('start was not accepted');}),/not accepted/);
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
  const binary=process.env.OPENCRAWL_TEST_TEMPORAL_BINARY;
  const environment=await TestWorkflowEnvironment.createLocal(binary?{server:{executable:{type:'existing-path',path:binary}}}:{});
  t.after(()=>environment.teardown());
  const directory=await mkdtemp(join(tmpdir(),'team-workflow-')),bundle=join(directory,'team.cjs');
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await buildTeamWorkflows(bundle);
  const start=async()=>{
    const {worker,connection}=await createTeamWorker({address:environment.address,namespace:'default'},queue,f.options,bundle);
    const running=worker.run();
    return async()=>{worker.shutdown();await running;await connection.close();};
  };
  let stop=await start();
  try {
    const write=durableTeamWrites(f.database,environment.client,queue);
    await write({...change,role:'admin'});
    assert.equal(f.members.get('user_member').role.slug,'admin');
    const apply=f.directory.userManagement.deleteOrganizationMembership;
    f.directory.userManagement.deleteOrganizationMembership=async id=>{await apply(id);throw Error('response unavailable');};
    await assert.rejects(write(change),{status:503});
    await stop();
    stop=await start();
    const {rows:[ref]}=await f.database.pool.query("UPDATE opencrawl_team_operations SET phase='applied' WHERE namespace=$1 AND phase='dispatching' RETURNING organization,operation",[f.database.namespace]);
    const handle=environment.client.workflow.getHandle('team-member/'+ref.organization+'/'+ref.operation);
    await handle.signal('recheckTeamChange');
    assert.deepEqual(await handle.result(),{ok:true});
    assert.equal(f.writes(),2);
  } finally {await stop();}
});
