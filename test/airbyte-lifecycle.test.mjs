import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
import {createPostgresIntegrationRegistry} from '../dist/src/integrations/local-registry.mjs';
import {createIntegrationCommands} from '../dist/src/state/integration-commands.mjs';
import {createIntegrationResources} from '../dist/src/state/integration-resources.mjs';
import {createIntegrations} from '../dist/src/integrations/service.mjs';
const live=(name,run)=>test(name,{skip:!postgresUrl},run);
const principal={tenantId:'org_team',userId:'user_admin'};
const fixtureKey='fixture-secret-nonproduction';
const absent=()=>Object.assign(new Error('Gone'),{status:404});

async function fixture(t){
  const database=await applicationDatabaseFixture(t);
  const environment='production';
  const commands=createIntegrationCommands({database,environment,encryptionKey:randomBytes(32)});
  const resources=createIntegrationResources({database,environment});
  const registry=createPostgresIntegrationRegistry({database,environment,bindingId:'airbyte-test',authorizeTenant:()=>true,commands:commands.transactional});
  await commands.ready();await resources.ready();await registry.ready();
  const refs=[],effects=[],stored=new Map();
  let latestJob=null,allow=true;
  const provider={id:'notes',scope:'team',auth:'api-key',owner:r=>'workspace='+r.tenantId,
    keyHelp:{pattern:'^fixture-'},connector:{docker:{},name:'notes'},account:async()=>({label:'Notes',workspace:principal.tenantId}),
    total:async()=>42,sourceConfiguration:({apiKey})=>({apiKey}),streams:[]};
  const airbyte={
    sourceDefinitions:async()=>[{name:'notes',id:'definition'}],
    createDestination:async input=>store('destinationId','destination',input),createSource:async input=>{
      assert.equal(input.configuration.apiKey,fixtureKey);return store('sourceId','source',input);
    }, createConnection:async input=>store('connectionId','connection',input),
    latestSyncJobId:async()=>latestJob,
    sync:async id=>{assert.equal(id,'connection');effects.push('sync');latestJob='1';},
    destinations:async()=>[...stored.values()].filter(r=>r.destinationId==='destination'&&!r.connectionId),
    sources:async()=>[...stored.values()].filter(r=>r.sourceId==='source'&&!r.connectionId),
    connections:async()=>[...stored.values()].filter(r=>r.connectionId),
    resource:async(_type,id)=>{if(!stored.has(id))throw absent();return stored.get(id);},
    drainConnection:async(id,r)=>{assert.equal(id,'connection');if(r)r.status='inactive';},
    deleteConnection:async id=>remove(id),deleteSource:async id=>remove(id),deleteDestination:async id=>remove(id),
  };
  function store(field,id,input){
    effects.push('create '+id);
    stored.set(id,{[field]:id,name:input.name,workspaceId:'airbyte',...(field==='connectionId'?{sourceId:input.sourceId,destinationId:input.destinationId,status:input.status}:{})});
    return {[field]:id};
  }
  function remove(id){effects.push('delete '+id);if(!stored.delete(id))throw absent();}
  const options={environment,appUrl:'https://fixture.example',registry,providers:{notes:provider},airbyte,workspaceId:async mode=>{assert.equal(mode,'existing');return 'airbyte';},
    legacyBucket:'legacy',buckets:{get:async tenant=>tenant,async deletePrefix(bucket,prefix){
      assert.equal(bucket,principal.tenantId);assert.match(prefix,/^raw\/v1\/source=notes\/workspace=org_team\/connection=int_[a-f0-9]{26}\/$/);
      effects.push('delete data');return 7;
    }},destination:{validate(){},prepare:async()=>({}),settings:async()=>({})},oauth:{},
    lifecycle:{commands,resources,requests:registry,start:async reference=>{refs.push(reference);throw new Error('Start RPC unavailable');},
      authorize:async (command,record)=>allow&&record.tenantId===command.reference.tenantId&&command.requestedBy===principal.userId,
      validateCleanupTarget:async record=>{assert.equal(record.s3Bucket,principal.tenantId);return record.s3Prefix;}}};
  const product=()=>createIntegrations(options);
  const connect=async()=>{await product().connect(principal,'notes',{apiKey:fixtureKey});return refs.at(-1);};
  const read=ref=>registry.get(ref.tenantId,ref.userId,ref.integrationId);
  const step=ref=>product().executeCommand(ref);
  async function finish(ref){for(let n=0;n<15;n++)if(await step(ref)==='done')return;assert.fail('Command never finished');}
  return {database,registry,resources,commands,provider,options,product,connect,read,step,finish,airbyte,stored,effects,refs,revoke(){allow=false;}};
}

live('accepted Airbyte commands advance through worker replacement and lost provider responses',async t=>{
  const f=await fixture(t),ref=await f.connect();
  const transitions=[];
  f.options.onConnectorTransition=async r=>{assert.equal((await f.read(ref)).status,r.status);transitions.push(r.status);};
  assert.deepEqual(f.effects,[]);
  assert.deepEqual((await f.commands.listPending({})).commands,[ref]);
  assert.equal((await f.read(ref)).status,'provisioning');
  for(const value of [ref,await f.read(ref),await f.commands.read(ref)])assert.ok(!JSON.stringify(value).includes(fixtureKey));
  assert.equal((await f.commands.readSecret(ref)).apiKey,fixtureKey);
  await assert.rejects(f.step({...ref,tenantId:'org_other'}),/Unknown integration command/);
  await f.step(ref);
  assert.deepEqual(f.effects,['create destination']);
  const create=f.airbyte.createSource;
  let discover=false;
  f.airbyte.createSource=async input=>{await create(input);throw new Error('Lost POST response');};
  const sources=f.airbyte.sources;
  f.airbyte.sources=async()=>discover?sources():[];
  await assert.rejects(f.step(ref),/Lost POST response/);
  await assert.rejects(f.step(ref),{code:'ProvisioningRecoveryPending'});
  assert.equal((await f.read(ref)).error,'recovery');
  assert.equal(f.effects.filter(effect=>effect==='create source').length,1);
  discover=true;
  await f.step(ref);
  assert.deepEqual(await f.commands.readSecret(ref),{});
  await f.step(ref);
  const sync=f.airbyte.sync;
  f.airbyte.sync=async id=>{await sync(id);throw new Error('Lost initial sync response');};
  await assert.rejects(f.step(ref),/Lost initial sync/);
  await f.finish(ref);await f.finish(ref);
  assert.deepEqual(f.effects,['create destination','create source','create connection','sync']);
  assert.equal((await f.commands.read(ref)).status,'completed');
  assert.equal((await f.read(ref)).status,'active');
  await f.product().disconnect(principal,'notes');
  const removal=f.refs.at(-1);
  assert.equal((await f.read(ref)).status,'disconnecting');
  f.revoke();
  await f.finish(removal);await f.finish(removal);
  assert.deepEqual(f.effects.slice(4),['delete connection','delete source','delete destination','delete data']);
  assert.equal((await f.read(ref)).deletedObjects,7);
  assert.equal((await f.read(ref)).status,'disconnected');
  assert.deepEqual(transitions,['active','disconnected']);
});

live('superseded provisioning and an unverified cleanup target cannot mutate foreign resources',async t=>{
  const f=await fixture(t),ref=await f.connect();
  await f.step(ref);
  const original=await f.read(ref);
  await f.registry.update(original,{airbyteWorkspaceId:'foreign'});
  await assert.rejects(f.step(ref),/workspace binding changed/);
  assert.deepEqual(f.effects,['create destination']);
  await f.registry.update(original,{airbyteWorkspaceId:'airbyte'});
  await f.product().disconnect(principal,'notes');
  const removal=f.refs.at(-1);
  assert.equal(await f.step(ref),'done');assert.equal((await f.commands.read(ref)).status,'superseded');
  const destination=f.stored.get('destination');
  f.stored.set('destination',{...destination,name:destination.name.replace('org_team','org_other')});
  await assert.rejects(f.step(removal),{code:'ProvisioningRecoveryPending'});
  assert.deepEqual(f.effects,['create destination']);
  f.stored.set('destination',destination);
  const record=await f.read(removal);
  await f.registry.update(record,{s3Prefix:record.s3Prefix.replace('org_team','org_other')});
  await assert.rejects(f.step(removal),/Invalid cleanup landing scope/);
  assert.deepEqual(f.effects,['create destination']);
  await f.registry.update(record,{s3Prefix:record.s3Prefix});
  await f.finish(removal);
});

live('revocation terminates an unstarted provision and drops its secret',async t=>{
  const f=await fixture(t),ref=await f.connect();
  f.revoke();
  assert.equal(await f.step(ref),'done');
  assert.equal((await f.commands.read(ref)).failureReason,'authorization_denied');
  assert.deepEqual(await f.commands.readSecret(ref),{});
  assert.deepEqual(f.effects,[]);
});

live('worker replacement erases the envelope after the provider source has already been recorded',async t=>{
  const f=await fixture(t),ref=await f.connect();
  let fail=true;
  f.options.lifecycle.commands={...f.commands,async clearSecret(r){
    if(fail){fail=false;throw new Error('Lost envelope erase');}
    return f.commands.clearSecret(r);
  }};
  await f.step(ref);
  await assert.rejects(f.step(ref),/Lost envelope erase/);
  assert.equal((await f.read(ref)).airbyte.sourceId,'source');
  assert.equal((await f.commands.readSecret(ref)).apiKey,fixtureKey);
  f.airbyte.createConnection=async()=>{throw new Error('Downstream unavailable');};
  await assert.rejects(f.step(ref),/Downstream unavailable/);
  assert.deepEqual(await f.commands.readSecret(ref),{});
});

live('a finalized migrated destination requires the exact connection, migration name, bucket and prefix before any deletion',async t=>{
  const f=await fixture(t),ref=await f.connect();
  await f.finish(ref);
  const record=await f.read(ref);
  await f.registry.update(record,{airbyteLandingMode:'scoped-v1',airbyteMigration:null});
  await f.product().disconnect(principal,'notes');
  const removal=f.refs.at(-1),dest=f.stored.get('destination'),name='opencrawl-scoped-'+record.integrationId+'-'+'c'.repeat(24);
  const configuration={s3_bucket_name:record.s3Bucket,s3_bucket_path:record.s3Prefix};
  f.options.lifecycle.migratedDestinationMatches=(binding,r)=>r.name===name&&r.configuration?.s3_bucket_name===binding.s3Bucket&&r.configuration?.s3_bucket_path===binding.s3Prefix;
  for(const overrides of [{name:name+'1',configuration},{name,configuration:{...configuration,s3_bucket_name:'other'}},{name,configuration:{...configuration,s3_bucket_path:'other'}}]){
    f.stored.set('destination',{...dest,...overrides});
    await assert.rejects(f.step(removal),{code:'ProvisioningRecoveryPending'});
    assert.equal(f.effects.includes('delete connection'),false);
  }
  f.stored.set('destination',{...dest,name,configuration});
  await f.finish(removal);
  assert.equal((await f.read(ref)).status,'disconnected');
});

live('cleanup preserves existing external holds and retires only the positively bound grant',async t=>{
  const f=await fixture(t),ref=await f.connect();
  await f.step(ref);
  await f.product().disconnect(principal,'notes');
  const removal=f.refs.at(-1),record=await f.read(removal);
  await f.registry.update(record,{cleanupBlockedReason:'external-writer-proof-required'});
  await assert.rejects(f.step(removal),/awaiting external reconciliation/);
  assert.deepEqual(f.effects,['create destination']);
  const grantId='account-pending';
  await f.registry.update(record,{cleanupBlockedReason:null,connectedAccountId:grantId,oauthIntent:{resource:'link',attemptId:'old-attempt',requestedAt:record.createdAt}});
  await assert.rejects(f.step(removal),/awaiting external reconciliation/);
  await f.registry.update(record,{oauthIntent:null});
  f.options.workspaceId=async mode=>{assert.equal(mode,'existing');return 'airbyte';};
  delete f.provider.auth;f.provider.toolkit='notes';
  let retired=0,owner='production:org_other:user_admin';
  f.options.oauth.account=async()=>({id:grantId,toolkit:{slug:'notes'},user_id:owner});
  f.options.oauth.remove=async id=>{assert.equal(id,grantId);retired++;};
  await assert.rejects(f.finish(removal),/grant binding changed/);
  assert.equal(retired,0);
  owner='production:org_team:user_admin';
  await f.finish(removal);await f.finish(removal);
  assert.equal(retired,1);
  assert.equal((await f.read(removal)).status,'disconnected');
});

live('OAuth consent admits only a positively bound grant and the worker recovers its account metadata',async t=>{
  const f=await fixture(t);
  const id='int_'+'a'.repeat(26),grant='account-tested',nonce='one-time-state';
  const base={...principal,integrationId:id,environment:'production',scope:'team',provider:'notes',createdAt:new Date().toISOString(),startDate:'2026-01-01',
    status:'connecting',nonce,connectedAccountId:grant,s3Bucket:principal.tenantId,provisionProtocol:1};
  await f.registry.create(base);
  delete f.provider.auth;f.provider.toolkit='notes';
  const source=()=>f.product().complete(principal,'notes',new URLSearchParams({integration:id,state:nonce}));
  let owner='production:org_other:user_admin';
  f.options.oauth.account=async()=>({id:grant,status:'ACTIVE',toolkit:{slug:'notes'},user_id:owner});
  assert.equal((await source()).ok,false);assert.deepEqual(f.refs,[]);
  owner='production:org_team:user_admin';
  assert.equal((await source()).ok,true);
  const ref=f.refs[0];
  const accepted=await f.read(ref);assert.equal(accepted.lifecycleCommandId,ref.commandId);assert.equal(accepted.status,'provisioning');
  assert.deepEqual(f.effects,[]);
  assert.equal((await source()).ok,true);assert.equal(f.refs.length,1);
  await f.step(ref);
  assert.equal((await f.read(ref)).account,'Notes');assert.ok((await f.read(ref)).s3Prefix.endsWith('connection='+id));
});

live('legacy discovery advances past settled rows and stops returning claimed operations',async t=>{
  const f=await fixture(t),base={...principal,environment:'production',scope:'team',provider:'notes',createdAt:new Date().toISOString(),startDate:'2026-01-01'};
  for(const [char,status] of [['a','active'],['b','provisioning'],['c','disconnecting'],['d','disconnected']])
    await f.registry.create({...base,tenantId:'org_'+char,integrationId:'int_'+char.repeat(26),status});
  const first=await f.registry.listUnclaimedLifecycle({limit:1});
  assert.equal(first.records.length,1);assert.equal(first.records[0].status,'provisioning');assert.ok(first.cursor);
  await f.product().recoverRecord(first.records[0]);
  const second=await f.registry.listUnclaimedLifecycle({cursor:first.cursor,limit:1});
  assert.equal(second.records.length,1);assert.equal(second.records[0].status,'disconnecting');
  await f.product().recoverRecord(second.records[0]);
  assert.equal((await f.registry.listUnclaimedLifecycle()).records.length,0);
  assert.deepEqual(f.effects,[]);assert.equal(f.refs.length,2);
});
