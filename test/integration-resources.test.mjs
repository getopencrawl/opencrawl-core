import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createIntegrationResources} from '../dist/src/state/integration-resources.mjs';
import {createIntegrationCommands} from '../dist/src/state/integration-commands.mjs';
import {createSingleOrganizationRegistry} from '../dist/src/integrations/local-registry.mjs';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex'),key={kind:'airbyte-definition',scope:'workspace',name:'OpenCrawl Slack',fingerprint:hash('definition')};
const live=(name,run)=>test(name,{skip:!postgresUrl},run);
live('shared resource admission is atomic across independent adapters and a lost response never authorizes another create',async t=>{
 const database=await applicationDatabaseFixture(t),a=createIntegrationResources({database,environment:'selfhost'}),b=createIntegrationResources({database,environment:'selfhost'});await Promise.all([a.ready(),b.ready()]);
 let posts=0,visible=false;const invoked=Promise.withResolvers(),release=Promise.withResolvers(),operations={find:async()=>visible?{id:'definition',fingerprint:key.fingerprint}:null,create:async()=>{posts++;invoked.resolve();await release.promise;throw Error('PRIVATE committed response lost');}};
 const first=a.ensure(key,operations);await invoked.promise;await assert.rejects(b.ensure(key,operations),{code:'ProvisioningRecoveryPending'});assert.equal(posts,1);release.resolve();await assert.rejects(first);
 await assert.rejects(b.ensure(key,operations),{code:'ProvisioningRecoveryPending'});assert.equal(posts,1);visible=true;assert.equal(await b.ensure(key,operations),'definition');assert.equal(await a.ensure(key,operations),'definition');assert.equal(posts,1);
 const row=(await database.pool.query('SELECT * FROM opencrawl_integration_resources WHERE namespace=$1',[database.namespace])).rows[0];assert.equal(row.status,'resolved');assert.doesNotMatch(JSON.stringify(row),/PRIVATE/);
});
live('shared resource scope, immutable identity and update-intent version recovery cannot cross environments',async t=>{
 const database=await applicationDatabaseFixture(t),a=createIntegrationResources({database,environment:'selfhost'}),b=createIntegrationResources({database,environment:'production'});await a.ready();let posts=0;
 const create=async()=>{posts++;return 'different-environment';};assert.equal(await a.ensure(key,{find:async()=>({id:'existing',fingerprint:key.fingerprint}),create}),'existing');
 assert.equal(await b.ensure(key,{find:async()=>null,create}),'different-environment');assert.equal(posts,1);
 await assert.rejects(a.ensure({...key,fingerprint:hash('changed')},{find:async()=>({id:'existing',fingerprint:key.fingerprint}),create}),{code:'ProvisioningRecoveryPending'});
 await assert.rejects(a.ensure(key,{find:async()=>null,create}),{code:'ProvisioningRecoveryPending'});assert.equal(posts,1);
 let actual=hash('old');const update={...key,kind:'airbyte-manifest',name:'existing',fingerprint:hash('new')},ops={find:async()=>({id:'existing',fingerprint:actual}),create:async()=>{posts++;throw Error('lost update');}};
 await assert.rejects(a.ensure(update,ops));await assert.rejects(a.ensure(update,ops),{code:'ProvisioningRecoveryPending'});assert.equal(posts,2);
 actual=hash('new');assert.equal(await a.ensure(update,ops),'existing');
});
live('concurrent consent abandonment and terminal failure use the same lock order and leave one cleanup command',async t=>{
 const database=await applicationDatabaseFixture(t),commands=createIntegrationCommands({database,environment:'selfhost',encryptionKey:Buffer.alloc(32,7)});await commands.ready();
 const registry=createSingleOrganizationRegistry({database,organizationId:'org_team',commands:commands.transactional});
 for(let i=0;i<12;i++){
  const record={environment:'selfhost',tenantId:'org_team',userId:'user_a',integrationId:'int_'+String(i).padStart(26,'0'),provider:'slack',scope:'team',status:'connecting',createdAt:new Date().toISOString(),startDate:'2026-01-01'};
  const consent=await registry.createWithLifecycle(record,'consent',{},'user_a');
  const result=await Promise.allSettled([registry.abandonWithLifecycle(record,'user_a'),commands.fail(consent,'authorization_denied')]);
  assert.ok(result.every(value=>value.status==='fulfilled'),JSON.stringify(result));
  const current=await registry.get(record.tenantId,record.userId,record.integrationId);assert.equal(current.status,'abandoned');assert.equal(current.lifecycleOperation,'disconnect');
  const pending=(await commands.listPending({})).commands.filter(value=>value.integrationId===record.integrationId);assert.equal(pending.length,1);assert.equal(pending[0].commandId,current.lifecycleCommandId);
 }
});
