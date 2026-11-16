import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MockActivityEnvironment} from '@temporalio/testing';
import {createSingleOrganizationRegistry} from '../dist/src/integrations/local-registry.mjs';
import {createIntegrationResources} from '../dist/src/state/integration-resources.mjs';
import {createIntegrationCommands} from '../dist/src/state/integration-commands.mjs';
import {createIntegrations} from '../dist/src/integrations/service.mjs';
import {integrationActivities} from '../dist/src/integrations/temporal/activities.mjs';
import {integrationSteps} from '../dist/src/integrations/temporal/contracts.mjs';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
const owner={tenantId:'org_team',userId:'user_owner'},provider={id:'notion',name:'Notion',scope:'team',toolkit:'notion',auth:'oauth',authConfig:{name:'OpenCrawl',credentials:{client_secret:'PRIVATE_CLIENT_SECRET'}}};
const live=(name,run)=>test(name,{skip:!postgresUrl},run);
async function fixture(t){
 const database=await applicationDatabaseFixture(t),key=Buffer.alloc(32,7),commands=createIntegrationCommands({database,environment:'selfhost',encryptionKey:key});await commands.ready();const resources=createIntegrationResources({database,environment:'selfhost'});await resources.ready();
 const registry=createSingleOrganizationRegistry({database,organizationId:owner.tenantId,commands:commands.transactional});
 const calls={config:0,link:0,recoverConfig:0,recoverLink:0,removed:[]},scheduled=[];let now=Date.now(),authorized=true;
 const oauth={authConfig:async()=>{calls.config++;return 'config';},recoverAuthConfig:async()=>{calls.recoverConfig++;return calls.config?'config':null;},
  link:async()=>{calls.link++;return {connected_account_id:'grant',redirect_url:'https://provider.example/authorize?state=PRIVATE_FLOW',expires_at:new Date(now+600000).toISOString()};},
  recoverLink:async()=>{calls.recoverLink++;return {connected_account_id:'grant'};},remove:async id=>{calls.removed.push(id);}};
 const lifecycle={commands,resources,schedule:async ref=>{scheduled.push(ref);},runProviderWrite:async(_r,_op,fn)=>fn(),cleanup:{closeWriters:async()=>{},stopWriters:async()=>{},drainWriters:async()=>{},deleteDocuments:async()=>0}};
 const options={environment:'selfhost',appUrl:'https://self.example',registry,lifecycle,legacyBucket:'owned',buckets:{get:async()=>'owned'},workspaceId:async()=>'workspace',destination:{},oauth,airbyte:{},providers:{notion:provider},consentWaitMs:1,now:()=>now};
 const service=createIntegrations(options),activityOptions={resolve:async()=>({commands,runner:{step:service.lifecycleStep},authorize:async()=>{if(!authorized)throw Object.assign(Error('PRIVATE_AUTH_BODY'),{status:403});}})},activities=integrationActivities(activityOptions),env=new MockActivityEnvironment();
 const record=()=>registry.listTenant(owner.tenantId).then(rows=>rows.sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt)).at(-1));
 const start=async()=>{await assert.rejects(service.connect(owner,'notion'),{code:'ConsentPending'});return scheduled.at(-1);};
 const step=(ref,step)=>env.run(activities.executeIntegrationStep,{...ref,step});
 return {database,key,commands,registry,oauth,service,options,calls,scheduled,record,start,step,env,activities,advance:ms=>{now+=ms;},revoke:()=>{authorized=false;},cleanup:async ref=>{for(const step of integrationSteps.disconnect)await service.lifecycleStep({...ref,step});await commands.complete(ref);}};
}
live('consent is durably queued before provider work, API retries reuse encrypted result and secret never enters activity output',async t=>{
 const f=await fixture(t),ref=await f.start();assert.deepEqual([f.calls.config,f.calls.link],[0,0]);
 await assert.rejects(f.service.connect(owner,'notion'),{code:'ConsentPending'});assert.equal((await f.commands.listPending({})).commands.length,1);
 await f.step(ref,'consent-config');assert.deepEqual(await f.step(ref,'consent-link'),{status:'done'});
 const result=await f.service.connect(owner,'notion');assert.match(result.redirectUrl,/PRIVATE_FLOW/);assert.deepEqual(await createIntegrations(f.options).connect(owner,'notion'),result);assert.deepEqual([f.calls.config,f.calls.link],[1,1]);
 const rows=await f.database.pool.query('SELECT ciphertext FROM opencrawl_integration_command_secrets WHERE namespace=$1',[f.database.namespace]);assert.equal(rows.rowCount,1);assert.ok(!rows.rows[0].ciphertext.includes(Buffer.from('PRIVATE_FLOW')));
 assert.doesNotMatch(JSON.stringify(await f.record()),/PRIVATE_FLOW|PRIVATE_CLIENT_SECRET/);assert.equal((await f.commands.read(ref)).status,'pending');
 const waiting=await f.step(ref,'consent-expire');assert.equal(waiting.status,'done');assert.ok(waiting.waitUntil>Date.now());assert.doesNotMatch(JSON.stringify(waiting),/PRIVATE/);
 await assert.rejects(createIntegrationCommands({database:f.database,environment:'selfhost',encryptionKey:Buffer.alloc(32,8)}).readConsentResult(ref));
});
live('lost provider link response recovers only the exact grant and terminal cleanup is atomic and recoverable',async t=>{
 const f=await fixture(t),ref=await f.start();await f.step(ref,'consent-config');let held;
 f.oauth.link=async input=>{f.calls.link++;held=input;throw Error('PRIVATE_PROVIDER_COMMITTED_RESPONSE_LOST');};
 await assert.rejects(f.step(ref,'consent-link'),error=>{assert.doesNotMatch(error.message,/PRIVATE/);return !error.nonRetryable;});
 const pending=await f.record();assert.equal(pending.oauthIntent.resource,'link');assert.equal(held.requestId,pending.oauthIntent.attemptId);assert.ok(!JSON.stringify(pending).includes('PRIVATE'));
 f.oauth.recoverLink=async input=>{assert.deepEqual(input,held);return null;};await assert.rejects(f.step(ref,'consent-link'),{type:'IntegrationProvisioningPending'});assert.equal(f.calls.link,1);
 f.oauth.recoverLink=async input=>{assert.deepEqual(input,held);return {connected_account_id:'recovered-grant'};};
 const enqueue=f.commands.transactional.enqueue;f.commands.transactional.enqueue=async()=>{throw Error('PRIVATE_SQL_BODY');};
 await assert.rejects(f.step(ref,'consent-link'),{type:'IntegrationCommandStorageFailed'});assert.equal((await f.commands.read(ref)).status,'pending');assert.equal((await f.record()).status,'connecting');
 f.commands.transactional.enqueue=enqueue;await assert.rejects(f.step(ref,'consent-link'),{type:'IntegrationReconnectRequired',nonRetryable:true});
 const abandoned=await f.record(),cleanup=(await f.commands.listPending({})).commands[0];assert.equal(abandoned.status,'abandoned');assert.equal(abandoned.connectedAccountId,'recovered-grant');assert.equal(abandoned.lifecycleCommandId,cleanup.commandId);assert.equal((await f.commands.read(ref)).status,'failed');
 f.revoke();await f.cleanup(cleanup);assert.deepEqual(f.calls.removed,['recovered-grant']);assert.equal((await f.record()).status,'disconnected');assert.equal(f.calls.link,1);
});
live('lost auth-config response is read-only reconciled from saved nonsecret intent before creating one link',async t=>{
 const f=await fixture(t),ref=await f.start();f.oauth.authConfig=async()=>{f.calls.config++;throw Error('provider committed');};
 await assert.rejects(f.step(ref,'consent-config'));assert.equal((await f.record()).oauthIntent.resource,'auth-config');
 f.oauth.recoverAuthConfig=async input=>{assert.deepEqual(input,{toolkit:'notion',name:'OpenCrawl selfhost org_team'});return null;};await assert.rejects(f.step(ref,'consent-config'));assert.equal(f.calls.config,1);
 f.oauth.recoverAuthConfig=async()=> 'adopted-config';await f.step(ref,'consent-config');await f.step(ref,'consent-link');assert.equal(f.calls.config,1);assert.equal(f.calls.link,1);assert.equal((await f.record()).authConfigId,'adopted-config');
});
live('expired consent queues cleanup without a browser return, while a verified callback wins over stale expiry and failure',async t=>{
 const f=await fixture(t),ref=await f.start();await f.step(ref,'consent-config');await f.step(ref,'consent-link');f.advance(600001);
 assert.deepEqual(await f.step(ref,'consent-expire'),{status:'superseded'});const cleanup=(await f.commands.listPending({})).commands[0];assert.equal((await f.commands.read(cleanup)).operation,'disconnect');assert.equal(await f.commands.readConsentResult(ref),null);await f.cleanup(cleanup);
 const second=await f.start();await f.step(second,'consent-config');
 const provision=await f.registry.requestLifecycle(await f.record(),'provision',{},owner.userId);
 assert.deepEqual(await f.step(second,'consent-expire'),{status:'superseded'});await f.commands.fail(second,'authorization_denied');assert.equal((await f.record()).lifecycleCommandId,provision.commandId);assert.equal((await f.record()).status,'provisioning');
});
live('current authorization revocation retires consent and accepted cleanup survives the revocation',async t=>{
 const f=await fixture(t),ref=await f.start();await f.step(ref,'consent-config');await f.step(ref,'consent-link');f.revoke();
 await assert.rejects(f.env.run(f.activities.describeIntegrationCommand,ref),{type:'IntegrationAuthorizationDenied'});assert.equal(await f.commands.readConsentResult(ref),null);
 const cleanup=(await f.commands.listPending({})).commands[0];await f.step(cleanup,'close-writers');await f.cleanup(cleanup);assert.deepEqual(f.calls.removed,['grant']);
});
live('an already dispatched provider response is adopted by abandoned cleanup, never by a superseded setup command',async t=>{
 const f=await fixture(t),ref=await f.start();await f.step(ref,'consent-config');const invoked=Promise.withResolvers(),release=Promise.withResolvers();
 f.oauth.link=async()=>{f.calls.link++;invoked.resolve();await release.promise;return {connected_account_id:'late-grant',redirect_url:'https://provider.example/PRIVATE_FLOW'};};
 const running=f.step(ref,'consent-link');await invoked.promise;const cleanup=await f.registry.abandonWithLifecycle(await f.record(),owner.userId);
 f.oauth.recoverLink=async()=>null;await assert.rejects(f.step(cleanup,'stop-writers'));release.resolve();assert.deepEqual(await running,{status:'superseded'});assert.equal((await f.record()).connectedAccountId,'late-grant');assert.equal(await f.commands.readConsentResult(ref),null);
 await f.cleanup(cleanup);assert.deepEqual(f.calls.removed,['late-grant']);assert.equal(f.calls.link,1);
});
live('consent output cannot be changed, revived after supersession, or read after expiry',async t=>{
 const f=await fixture(t),ref=await f.start(),result={redirectUrl:'https://provider.example/PRIVATE_FLOW',expiresAt:Date.now()+10000};
 await f.commands.writeConsentResult(ref,result);await f.commands.writeConsentResult(ref,result);await assert.rejects(f.commands.writeConsentResult(ref,{...result,expiresAt:result.expiresAt+1}),{status:409});
 await f.database.pool.query('UPDATE opencrawl_integration_command_secrets SET expires_at=now()-interval \'1 second\' WHERE namespace=$1',[f.database.namespace]);assert.equal(await f.commands.readConsentResult(ref),null);
 await f.registry.abandonWithLifecycle(await f.record(),owner.userId);await assert.rejects(f.commands.writeConsentResult(ref,result),{status:409});assert.equal(await f.commands.readConsentResult(ref),null);
});
