import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createSingleOrganizationRegistry,createPostgresIntegrationRegistry} from '../dist/src/integrations/local-registry.mjs';
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
live('durable consent keeps pending rows non-live and verified provision supersedes its command',async t=>{
  const f=await fixture(t),other={...record,integrationId:'int_'+'c'.repeat(26)};
  const consent=await f.registry.createWithLifecycle(record,'consent',{},'user_admin');
  const restarted=await f.registry.createWithLifecycle(other,'consent',{},'user_admin');
  assert.equal((await f.registry.get(record.tenantId,record.userId,record.integrationId)).status,'connecting');
  assert.deepEqual(await f.registry.requestLifecycle(record,'consent',{},'user_admin'),consent);
  const provision=await f.registry.requestLifecycle(record,'provision',{},'user_admin');
  assert.equal((await f.commands.read(consent)).status,'superseded');
  assert.equal((await f.commands.read(provision)).operation,'provision');
  await assert.rejects(f.registry.requestLifecycle(record,'consent',{},'user_admin'),{status:409});
  await assert.rejects(f.registry.requestLifecycle(other,'provision',{},'user_admin'),{status:409});
  // The losing transaction must retain its consent command after slot refusal.
  assert.equal((await f.commands.read(restarted)).status,'pending');
  assert.equal((await f.registry.get(other.tenantId,other.userId,other.integrationId)).lifecycleCommandId,restarted.commandId);
});
live('abandoning consent atomically queues cleanup and leaves the provider slot available',async t=>{
  const f=await fixture(t),consent=await f.registry.createWithLifecycle(record,'consent',{},'user_admin');
  const cleanup=await f.registry.abandonWithLifecycle(record,'user_admin');
  assert.equal((await f.commands.read(consent)).status,'superseded');
  assert.equal((await f.commands.read(cleanup)).operation,'disconnect');
  assert.equal((await f.commands.read(cleanup)).requestedBy,'user_admin');
  assert.equal((await f.registry.get(record.tenantId,record.userId,record.integrationId)).status,'abandoned');
  assert.deepEqual(await f.registry.abandonWithLifecycle(record,'user_admin'),cleanup);
  const restarted={...record,integrationId:'int_'+'d'.repeat(26)};
  const provision=await f.registry.createWithLifecycle(restarted,'provision',{},'user_admin');
  assert.equal((await f.commands.read(provision)).status,'pending');
  await assert.rejects(f.registry.requestLifecycle(record,'provision',{},'user_admin'),{status:409});
  await assert.rejects(f.registry.abandonWithLifecycle(restarted,'user_admin'),{status:409});
});
live('consent create and abandon roll back every row and command on enqueue failure',async t=>{
  const f=await fixture(t),broken=createSingleOrganizationRegistry({...f.options,commands:{...f.commands.transactional,enqueue:async()=>{throw new Error('enqueue unavailable');}}});
  await assert.rejects(broken.createWithLifecycle(record,'consent',{},'user_admin'),/enqueue unavailable/);
  assert.equal(await f.registry.get(record.tenantId,record.userId,record.integrationId),null);
  const consent=await f.registry.createWithLifecycle(record,'consent',{},'user_admin');
  await assert.rejects(broken.abandonWithLifecycle(record,'user_admin'),/enqueue unavailable/);
  assert.equal((await f.commands.read(consent)).status,'pending');
  const current=await f.registry.get(record.tenantId,record.userId,record.integrationId);
  assert.equal(current.status,'connecting');assert.equal(current.lifecycleCommandId,consent.commandId);
  assert.deepEqual((await f.commands.listPending({})).commands,[consent]);
});
live('only unprovisioned consent errors can use abandonment and secrets remain provision-only',async t=>{
  const f=await fixture(t);
  for(const operation of ['consent','disconnect','sync'])await assert.rejects(f.registry.createWithLifecycle(record,operation,{apiKey:'secret'},'user_admin'),/Only provisioning/);
  await assert.rejects(f.registry.createWithLifecycle(record,'consent',{},undefined),{status:403});
  await f.registry.createWithLifecycle(record,'consent',{},'user_admin');
  const identity=[record.tenantId,record.userId,record.integrationId];
  await f.registry.update(record,{status:'error',error:'setup',airbyte:{workspaceId:'existing'}});
  await assert.rejects(f.registry.abandonWithLifecycle(record,'user_admin'),{status:409});
  await f.registry.update(record,{airbyte:{},provisionIntent:{resource:'sourceId',workspaceId:'existing',name:'source',attemptId:'attempt',requestedAt:record.createdAt}});
  await assert.rejects(f.registry.abandonWithLifecycle(record,'user_admin'),{status:409});
  await f.registry.update(record,{provisionIntent:undefined});
  await f.registry.abandonWithLifecycle(record,'user_admin');
  assert.equal((await f.registry.get(...identity)).status,'abandoned');
});
live('hosted registry uses one fixed installation with independent tenant slots and exact imports',async t=>{
 const database=await applicationDatabaseFixture(t),commands=createIntegrationCommands({database,environment:'production',encryptionKey:randomBytes(32)});await commands.ready();
 const options={database,environment:'production',bindingId:'hosted-production',authorizeTenant:id=>['org_team','personal:user_a'].includes(id),commands:commands.transactional};
 const registry=createPostgresIntegrationRegistry(options),a={...record,environment:'production'},b={...a,tenantId:'personal:user_a'};
 await registry.importRecord(a);assert.deepEqual(await registry.importRecord(a),a);
 await assert.rejects(registry.importRecord({...a,status:'active'}),{status:409});
 await registry.importRecord(b);
 const results=await Promise.all([registry.requestLifecycle(a,'provision',{},'user_admin'),registry.requestLifecycle(b,'provision',{},'user_a')]);assert.equal(results.length,2);
 const page=await registry.scanPage({limit:1});assert.equal(page.records.length,1);assert.ok(page.cursor);
 const next=await registry.scanPage({limit:1,cursor:page.cursor});assert.equal(next.records.length,1);assert.equal(next.cursor,null);assert.notEqual(page.records[0].tenantId,next.records[0].tenantId);
 assert.deepEqual(await registry.scanPage({status:'active'}),{records:[],cursor:null});
 await assert.rejects(registry.get('org_other','user_a',record.integrationId),{status:403});
 await assert.rejects(createPostgresIntegrationRegistry({...options,bindingId:'other'}).ready(),/another organization/);
 await assert.rejects(createSingleOrganizationRegistry({database,organizationId:'org_team',environment:'production'}).ready(),/another organization/);
 const restarted=createPostgresIntegrationRegistry(options);assert.equal((await restarted.exportRecord(b.tenantId,b.userId,b.integrationId)).lifecycleCommandId,results[1].commandId);
});
