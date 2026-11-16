import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
import {createSingleOrganizationRegistry} from '../dist/src/integrations/local-registry.mjs';
import {createIntegrationCommands} from '../dist/src/state/integration-commands.mjs';
import {ensureWriteBarrierSchema,createPostgresWriteBarrier} from '../dist/src/state/write-barriers.mjs';
import {finalizeIntegrationLifecycles,verifyIntegrationLifecycles,migratedIntegrationCommand} from '../dist/src/state/lifecycle-migration.mjs';
const base={environment:'selfhost',tenantId:'org_team',userId:'user_owner',provider:'github',scope:'team',createdAt:'2026-01-01',startDate:'2026-01-01'};
async function fixture(t,fields){
 const database=await applicationDatabaseFixture(t),commands=createIntegrationCommands({database,environment:'selfhost'});await commands.ready();await ensureWriteBarrierSchema(database);
 const registry=createSingleOrganizationRegistry({database,organizationId:'org_team',commands:commands.transactional});
 const records=fields.map((fields,i)=>({...base,integrationId:'int_'+(i+1).toString(16).padStart(26,'0'),...fields}));
 for(const record of records)await registry.create(record);
 const options={namespace:database.namespace,environment:'selfhost',organizationId:'org_team',records,commands:commands.transactional};
 return {database,commands,registry,records,options,read:()=>registry.listTenant('org_team')};
}
test('legacy lifecycle readiness transition is deterministic and preserves consent, fences and resource evidence',{skip:!postgresUrl},async t=>{
 const intent={resource:'sourceId',workspaceId:'workspace',name:'original-name',attemptId:'attempt',requestedAt:'2026-01-01'};
 const f=await fixture(t,[{status:'connecting',nonce:'pending-consent'},{status:'provisioning',provider:'granola',provisionIntent:intent,provisionRun:'old-run',provisionVersion:'old-version',resourceVersion:'old-resources',airbyte:{destinationId:'destination'}},{status:'error',error:'recovery'},{status:'disconnecting',airbyte:{connectionId:'connection'}},{status:'disconnected',dataDeletedAt:'2026-02-01',disconnectedAt:'2026-02-02',deletedObjects:9,airbyte:{connectionId:'already-deleted'}},{status:'error',error:'reconnect'},{status:'active'}]);
 const disconnected=f.records[4],barrier=createPostgresWriteBarrier({database:f.database,tenantId:disconnected.tenantId,connectionId:disconnected.integrationId});
 const oldFence={version:1,namespace:'selfhost',tenantId:disconnected.tenantId,connectionId:disconnected.integrationId,closedAt:123,writers:[{id:'uncertain',operation:'object-put',phase:'writing',startedAt:1,instance:'old-process',target:'landing/raw'}]};await barrier.importFence(oldFence);
 const result=await f.database.transaction(async client=>{
  const first=await finalizeIntegrationLifecycles({...f.options,client}),second=await finalizeIntegrationLifecycles({...f.options,client});assert.deepEqual(first,second);
  assert.deepEqual(await verifyIntegrationLifecycles({...f.options,client}),first);return first;
 });
 assert.deepEqual([result.provision,result.disconnect,result.awaitingConsent,result.reconnectRequired,result.preserved],[2,2,1,1,1]);assert.equal((await f.commands.listPending({})).commands.length,4);
 const current=await f.read();
 for(let i=0;i<current.length;i++){
  const original=f.records[i],next=current[i];
  if([1,2,3,4].includes(i)){
   const operation=i<3?'provision':'disconnect',reference=migratedIntegrationCommand(f.database.namespace,original,operation);
   assert.equal(next.lifecycleCommandId,reference.commandId);assert.equal((await f.commands.read(reference)).requestedBy,'user_owner');assert.deepEqual(await f.commands.readSecret(reference),{});
   const {lifecycleCommandId,lifecycleOperation,status,...preserved}=next;assert.deepEqual(preserved,(({status,...rest})=>rest)(original));
  }else assert.deepEqual(next,original);
 }
 assert.deepEqual(await barrier.exportFence(),oldFence);assert.equal(current[4].dataDeletedAt,'2026-02-01');
 await assert.rejects(barrier.run('object-put',()=>assert.fail('Deletion cannot reopen writers')),{status:403});
});
test('readiness failure rolls back all commands, lifecycle transitions and new fences together',{skip:!postgresUrl},async t=>{
 const f=await fixture(t,[{status:'provisioning'},{status:'disconnected',airbyte:{connectionId:'old'}}]);
 await assert.rejects(f.database.transaction(async client=>{await finalizeIntegrationLifecycles({...f.options,client});throw Error('Interrupted before readiness commit');}),/Interrupted/);
 assert.deepEqual(await f.read(),f.records);assert.deepEqual((await f.commands.listPending({})).commands,[]);
 assert.equal((await f.database.pool.query('SELECT 1 FROM opencrawl_write_fences WHERE namespace=$1',[f.database.namespace])).rowCount,0);
 await f.database.transaction(client=>finalizeIntegrationLifecycles({...f.options,client}));assert.equal((await f.commands.listPending({})).commands.length,2);
});
test('mismatched final readback rolls back earlier lifecycle commands and never adopts foreign scope',{skip:!postgresUrl},async t=>{
 const f=await fixture(t,[{status:'provisioning'},{status:'disconnecting'}]);await f.registry.update(f.records[1],{resourceVersion:'unexpected'});
 await assert.rejects(f.database.transaction(client=>finalizeIntegrationLifecycles({...f.options,client})),/differs/);assert.equal((await f.commands.listPending({})).commands.length,0);assert.deepEqual((await f.read())[0],f.records[0]);
 await assert.rejects(f.database.transaction(client=>finalizeIntegrationLifecycles({...f.options,organizationId:'org_other',client})),/another installation/);
});

test('legacy abandoned grants and uncertain consent requests become cleanup commands without occupying a provider slot',{skip:!postgresUrl},async t=>{
 const intent={resource:'link',attemptId:'a'.repeat(32),requestedAt:'2026-01-01',callbackUrl:'https://self.example/callback'};
 const f=await fixture(t,[{status:'abandoned',provider:'notion',connectedAccountId:'grant'},{status:'abandoned',provider:'notion',oauthIntent:intent},{status:'abandoned'}]);
 const result=await f.database.transaction(client=>finalizeIntegrationLifecycles({...f.options,client}));assert.equal(result.disconnect,2);assert.equal(result.preserved,1);
 const current=await f.read();assert.equal(current[0].status,'abandoned');assert.equal(current[0].connectedAccountId,'grant');assert.deepEqual(current[1].oauthIntent,intent);assert.deepEqual(current[2],f.records[2]);assert.equal((await f.commands.listPending({})).commands.length,2);
});
