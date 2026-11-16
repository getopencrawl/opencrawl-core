import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createSingleOrganizationRegistry} from '../dist/src/integrations/local-registry.mjs';
import {createIntegrationCommands} from '../dist/src/state/integration-commands.mjs';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
const live=(name,run)=>test(name,{skip:!postgresUrl},run);
const record={tenantId:'org_team',userId:'user_a',integrationId:'int_'+'a'.repeat(26),environment:'selfhost',provider:'slack',scope:'team',status:'connecting',createdAt:'2026-11-01T00:00:00Z',startDate:'2026-10-01T00:00:00Z'};
async function fixture(t){
  const database=await applicationDatabaseFixture(t),commands=createIntegrationCommands({database,environment:'selfhost',encryptionKey:randomBytes(32)});await commands.ready();
  const options={database,organizationId:record.tenantId,commands:commands.transactional};
  return {database,commands,options,registry:createSingleOrganizationRegistry(options)};
}
live('registry scope and provisioning intents survive adapter restart',async t=>{
  const f=await fixture(t);await f.registry.create(record);
  await f.registry.update(record,{status:'provisioning',provisionIntent:{resource:'sourceId',workspaceId:'airbyte',name:'source',attemptId:'attempt',requestedAt:record.createdAt}},{whenStatus:['connecting']});
  const registry=createSingleOrganizationRegistry(f.options);
  assert.equal((await registry.get(record.tenantId,record.userId,record.integrationId)).provisionIntent.attemptId,'attempt');
  for(const operation of [()=>registry.listTenant('org_other'),()=>registry.get('org_other',record.userId,record.integrationId),()=>registry.create({...record,tenantId:'org_other'}),()=>registry.update(record,{tenantId:'org_other'})])await assert.rejects(operation,{status:403});
  await assert.rejects(createSingleOrganizationRegistry({...f.options,organizationId:'org_other'}).ready(),/another organization/);
  await assert.rejects(createSingleOrganizationRegistry({...f.options,environment:'production'}).ready(),/another organization/);
});
live('two independent connections cannot claim the same provisioning revision',async t=>{
  const f=await fixture(t),a=f.registry,b=createSingleOrganizationRegistry(f.options);await a.create(record);
  const results=await Promise.allSettled([a.update(record,{status:'provisioning',provisionVersion:'a'},{whenStatus:['connecting'],whenFields:{provisionVersion:undefined}}),b.update(record,{status:'provisioning',provisionVersion:'b'},{whenStatus:['connecting'],whenFields:{provisionVersion:undefined}})]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results.find(result=>result.status==='rejected').reason.code,'ConditionalCheckFailedException');
  await assert.rejects(b.create(record),{code:'ConditionalCheckFailedException'});assert.equal(await b.get(record.tenantId,'user_other',record.integrationId),null);
});
live('atomic lifecycle creation rolls back record when command enqueue fails',async t=>{
  const f=await fixture(t),registry=createSingleOrganizationRegistry({...f.options,commands:{...f.commands.transactional,enqueue:async()=>{throw new Error('test enqueue failure');}}});
  await assert.rejects(registry.createWithLifecycle(record,'provision',{apiKey:'must-not-survive'},'user_admin'),/enqueue failure/);
  assert.equal(await registry.get(record.tenantId,record.userId,record.integrationId),null);
  assert.equal((await f.commands.listPending({})).commands.length,0);
});
live('concurrent team provisioning claims one slot, command and secret',async t=>{
  const f=await fixture(t),other={...record,userId:'user_b',integrationId:'int_'+'b'.repeat(26)};
  const results=await Promise.allSettled([f.registry.createWithLifecycle(record,'provision',{apiKey:'key-a'},'user_admin'),f.registry.createWithLifecycle(other,'provision',{apiKey:'key-b'},'user_admin')]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.find(result=>result.status==='rejected').reason.status,409);
  const rows=await f.registry.listTenant(record.tenantId);assert.equal(rows.length,1);assert.equal(rows[0].status,'provisioning');
  const pending=await f.commands.listPending({});assert.equal(pending.commands.length,1);
  const reused=await f.registry.requestLifecycle(rows[0],'provision',{},'user_admin');assert.deepEqual(reused,pending.commands[0]);
  const disconnect=await f.registry.requestLifecycle(rows[0],'disconnect',{},'user_admin');
  assert.equal((await f.commands.read(reused)).status,'superseded');assert.deepEqual(await f.commands.readSecret(reused),{});
  await assert.rejects(f.registry.requestLifecycle(rows[0],'provision',{},'user_admin'),{status:409});
  assert.deepEqual(await f.registry.requestLifecycle(rows[0],'disconnect',{},'user_admin'),disconnect);
});
live('verified OAuth callback and key creation share the provider slot',async t=>{
  const f=await fixture(t),other={...record,integrationId:'int_'+'b'.repeat(26)};await f.registry.create(record);await f.registry.create(other);
  const results=await Promise.allSettled([f.registry.requestLifecycle(record,'provision',{},'user_admin'),f.registry.requestLifecycle(other,'provision',{},'user_admin')]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal((await f.commands.listPending({})).commands.length,1);
});
live('restarting OAuth consent can claim a provider slot after its prior attempt was abandoned',async t=>{
  const f=await fixture(t),restarted={...record,integrationId:'int_'+'b'.repeat(26)};
  await f.registry.create(record);
  await f.registry.update(record,{status:'abandoned'},{whenStatus:['connecting']});
  await f.registry.create(restarted);
  const command=await f.registry.requestLifecycle(restarted,'provision',{},'user_admin');
  assert.equal((await f.registry.get(record.tenantId,record.userId,record.integrationId)).status,'abandoned');
  assert.equal((await f.registry.get(restarted.tenantId,restarted.userId,restarted.integrationId)).status,'provisioning');
  assert.deepEqual((await f.commands.listPending({})).commands,[command]);
  await assert.rejects(f.registry.requestLifecycle(record,'provision',{},'user_admin'),{status:409});
});
