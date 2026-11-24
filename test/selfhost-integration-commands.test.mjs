import test from 'node:test';
import assert from 'node:assert/strict';
import {applicationDatabaseFixture} from './fixtures/application-database.mjs';
import {selfhostIntegrationBinding,selfhostServices} from '../dist/src/selfhost/services.mjs';

const organizationId='org_workspace';
const actor='user_operator';
const settings={organizationId,authSecret:'test-only-secret'.repeat(4),url:'https://self.example',search:{environment:'selfhost',tenantId:organizationId,endpoint:'http://127.0.0.1:1'}};
const env={AIRBYTE_WORKSPACE_ID:'00000000-0000-0000-0000-000000000001',AIRBYTE_URL:'http://127.0.0.1:1',AIRBYTE_CLIENT_ID:'test',AIRBYTE_CLIENT_SECRET:'test',OPENCRAWL_LANDING_S3_ACCESS_KEY_ID:'test',OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY:'test'};

test('self-host queues and schedules distinguish independent installations sharing one Temporal namespace',()=>{
  const first=selfhostIntegrationBinding(organizationId,'db-a');
  assert.deepEqual(first,selfhostIntegrationBinding(organizationId,'db-a'));
  for(const peer of [selfhostIntegrationBinding('org_peer','db-a'),selfhostIntegrationBinding(organizationId,'db-b')]){
    assert.notEqual(peer.sourceId,first.sourceId);assert.notEqual(peer.taskQueue,first.taskQueue);
  }
});

test('self-host cleanup uses the validated prefix and rejects another bucket before deleting anything',async t=>{
  const database=await applicationDatabaseFixture(t),listed=[];
  const store={bucket:'owned',async listPage(prefix){listed.push(prefix);return {keys:[]};}};
  const services=selfhostServices(settings,store,database,env,{directory:{},start:async()=>{}});
  t.after(()=>services.close());await services.commandWorker.ready();
  const signal=new AbortController().signal;
  async function cleanup(integrationId,s3Bucket){
    const s3Prefix='raw/v1/source=granola/workspace='+organizationId+'/connection='+integrationId;
    const record={tenantId:organizationId,userId:actor,environment:'selfhost',scope:'team',workspace:organizationId,provider:'granola',integrationId,
      status:'active',createdAt:new Date().toISOString(),startDate:'2026-01-01T00:00:00Z',s3Bucket,s3Prefix};
    await services.registry.create(record);
    const reference=await services.registry.requestLifecycle(record,'disconnect',{},actor);
    return {reference,s3Prefix};
  }
  const own=await cleanup('int_'+'1'.repeat(26),'owned');
  let step;
  for(let i=0;i<10&&step!=='done';i++)step=await services.commandWorker.execute(own.reference,signal);
  assert.equal(step,'done');assert.deepEqual(listed,[own.s3Prefix+'/']);
  const foreign=await cleanup('int_'+'2'.repeat(26),'other');
  await assert.rejects(services.commandWorker.execute(foreign.reference,signal),/storage scope denied/);
  assert.deepEqual(listed,[own.s3Prefix+'/']);
});

test('self-host adopts interrupted commands, recovers a lost start, and rechecks current authority on the worker',async t=>{
  const database=await applicationDatabaseFixture(t);
  let available=false,reads=0,starts=0;
  const directory={userManagement:{
    async getUser(id){reads++;if(!available)throw Error('directory unavailable');return {id,email:'owner@example.test',locallyEnrolled:true};},
    async listOrganizationMemberships({userId,organizationId:org}){return {data:[{id:'member',userId,organizationId:org,status:'active',role:{slug:'member'}}]};},
  }};
  const open=()=>selfhostServices(settings,{bucket:'owned'},database,env,{directory,start:async()=>{starts++;throw Error('Temporal unavailable');}});
  const api=open();t.after(()=>api.close());await api.commandWorker.ready();
  const base={tenantId:organizationId,userId:actor,environment:'selfhost',scope:'team',createdAt:new Date().toISOString(),startDate:'2026-01-01T00:00:00Z'};
  const setup={...base,provider:'granola',integrationId:'int_'+'a'.repeat(26),status:'provisioning'};
  const cleanup={...base,provider:'github',integrationId:'int_'+'b'.repeat(26),status:'disconnecting'};
  const healthy={...base,provider:'slack',integrationId:'int_'+'c'.repeat(26),status:'active'};
  await api.registry.create(setup);await api.registry.create(cleanup);await api.registry.create(healthy);
  // A consent command belongs to another runner. Its presence in this
  // installation's SQL outbox must never launch an Airbyte workflow.
  await api.registry.createWithLifecycle({...base,provider:'notion',integrationId:'int_'+'d'.repeat(26),status:'connecting'},'consent',{},actor);
  assert.equal(await api.commandWorker.adoptLegacy(null),null);
  assert.equal(starts,2);
  const worker=open();t.after(()=>worker.close());await worker.commandWorker.ready();
  assert.equal(await worker.commandWorker.adoptLegacy(null),null);assert.equal(starts,2);
  const {commands}=await worker.commandWorker.listPending({limit:50});assert.equal(commands.length,2);
  const provision=commands.find(ref=>ref.integrationId===setup.integrationId);
  const disconnect=commands.find(ref=>ref.integrationId===cleanup.integrationId);
  const signal=new AbortController().signal;
  assert.throws(()=>worker.commandWorker.execute({...provision,tenantId:'org_other'},signal),/scope denied/);
  assert.equal(reads,0);
  await assert.rejects(worker.commandWorker.execute(provision,signal),/verification unavailable/);
  assert.equal((await worker.commandWorker.listPending({limit:50})).commands.length,2);
  available=true;
  // A current member who lost admin rights cannot finish creating a shared source.
  assert.equal(await worker.commandWorker.execute(provision,signal),'done');
  const row=await database.pool.query('select status,failure_reason from opencrawl_integration_commands where namespace=$1 and command_id=$2',[database.namespace,provision.commandId]);
  assert.deepEqual(row.rows,[{status:'failed',failure_reason:'authorization_denied'}]);
  const before=reads;
  // Cleanup was authorized before the worker restart and must still finish after demotion.
  let progress;
  for(let i=0;i<10&&progress!=='done';i++)progress=await worker.commandWorker.execute(disconnect,signal);
  assert.equal(progress,'done');assert.equal(reads,before);
  assert.equal((await worker.registry.get(organizationId,actor,cleanup.integrationId)).status,'disconnected');
  assert.equal((await worker.commandWorker.listPending({limit:50})).commands.length,0);
  assert.equal((await worker.registry.get(organizationId,actor,healthy.integrationId)).lifecycleCommandId,undefined);
});
