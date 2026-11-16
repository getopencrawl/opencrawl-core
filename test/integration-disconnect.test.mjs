import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSingleOrganizationRegistry} from '../dist/src/integrations/local-registry.mjs';
import {createIntegrationResources} from '../dist/src/state/integration-resources.mjs';
import {createIntegrationCommands} from '../dist/src/state/integration-commands.mjs';
import {createIntegrations} from '../dist/src/integrations/service.mjs';
import {integrationSteps} from '../dist/src/integrations/temporal/contracts.mjs';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';

const principal={tenantId:'org_team',userId:'user_a'};
const base={...principal,integrationId:'int_'+'a'.repeat(26),environment:'selfhost',provider:'github',scope:'team',status:'active',createdAt:'2026-01-01',installationId:'42',s3Bucket:'owned',s3Prefix:'raw/v1/source=github/workspace=42/connection=int_'+'a'.repeat(26),resourceVersion:'first',airbyte:{connectionId:'connection',sourceId:'source',destinationId:'destination'}};
async function fixture(t,record=base){
 const database=await applicationDatabaseFixture(t), commands=createIntegrationCommands({database,environment:'selfhost',encryptionKey:Buffer.alloc(32,7)});await commands.ready();const resources=createIntegrationResources({database,environment:'selfhost'});await resources.ready();
 const registry=createSingleOrganizationRegistry({database,organizationId:'org_team',commands:commands.transactional});await registry.create(record);
 const removed=[],submitted=[];let held=false;
 const lifecycle={commands,resources,runProviderWrite:async(_record,_operation,write)=>write(),schedule:async ref=>{submitted.push(ref);throw Error('PRIVATE_DISPATCH_BODY');},cleanup:{
  closeWriters:async()=>{removed.push('close');},stopWriters:async()=>{removed.push('stop');},
  drainWriters:async()=>{if(held)throw Object.assign(Error('uncertain'),{code:'CONNECTOR_WRITE_PENDING'});removed.push('drain');},
  deleteDocuments:async()=>{removed.push('documents');return 2;}}};
 const options={environment:'selfhost',appUrl:'https://self.example',registry,lifecycle,legacyBucket:'owned',workspaceId:async()=>'workspace',destination:{validate(){},prepare:async()=>({}),settings:async()=>({configuration:{}})},oauth:{},providers:{github:{id:'github',scope:'team'}},
  github:{uninstall:async()=>assert.fail('Uninstalling affects other deployments')},
  buckets:{deletePrefix:async(bucket,prefix)=>{assert.equal(bucket,'owned');assert.equal(prefix,record.s3Prefix+'/');removed.push('raw');return 3;}},
  airbyte:Object.fromEntries(['Connection','Source','Destination'].map(kind=>['delete'+kind,async id=>{assert.equal((await registry.get(principal.tenantId,principal.userId,record.integrationId)).status,'disconnecting');removed.push(id);}]))};
 return {commands,registry,removed,submitted,lifecycle,options,service:createIntegrations(options),hold:value=>{held=value;}};
}

test('disconnect durably queues before dispatch and removes data only after positive settlement',{skip:!postgresUrl},async t=>{
 const f=await fixture(t);await f.service.disconnect(principal,'github');
 assert.equal(f.submitted.length,1);const ref=f.submitted[0];assert.equal((await f.commands.read(ref)).status,'pending');
 assert.equal((await f.registry.get(...[principal.tenantId,principal.userId,base.integrationId])).status,'disconnecting');assert.deepEqual(f.removed,[]);
 // A new API process resubmits the same accepted command and never performs cleanup.
 await assert.rejects(createIntegrations(f.options).recoverRecord(base),/PRIVATE_DISPATCH_BODY/);assert.deepEqual(f.submitted[1],ref);
 for(const step of ['close-writers','stop-writers'])await f.service.lifecycleStep({...ref,step});
 f.hold(true);await assert.rejects(f.service.lifecycleStep({...ref,step:'delete-data'}),{code:'CONNECTOR_WRITE_PENDING'});assert.ok(!f.removed.includes('raw'));
 f.hold(false);for(const step of integrationSteps.disconnect.slice(2))await f.service.lifecycleStep({...ref,step});await f.commands.complete(ref);
 assert.equal((await f.registry.get(principal.tenantId,principal.userId,base.integrationId)).status,'disconnected');
 assert.deepEqual(f.removed,['close','connection','source','destination','stop','drain','drain','stop','raw','documents','drain']);
 assert.equal((await f.commands.read(ref)).status,'completed');
});

test('late resource adoption forces cleanup to repeat; age never permits finalization',{skip:!postgresUrl},async t=>{
 const f=await fixture(t);await f.service.disconnect(principal,'github');const ref=f.submitted[0];
 for(const step of integrationSteps.disconnect.slice(0,-1))await f.service.lifecycleStep({...ref,step});
 await f.registry.update(base,{resourceVersion:'late',airbyte:{...base.airbyte,connectionId:'late-connection'}});
 assert.deepEqual(await f.service.lifecycleStep({...ref,step:'finalize'}),{status:'restart'});
 assert.equal((await f.registry.get(principal.tenantId,principal.userId,base.integrationId)).status,'disconnecting');
 for(const step of integrationSteps.disconnect)await f.service.lifecycleStep({...ref,step});
 assert.equal(f.removed.filter(value=>value==='raw').length,2);assert.ok(f.removed.includes('late-connection'));
});

test('provisioning retry reconciles ambiguous source creation without duplicating the request',{skip:!postgresUrl},async t=>{
 const record={...base,provider:'granola',status:'connecting',installationId:undefined,resourceVersion:undefined,s3Prefix:'raw/v1/source=granola/workspace=org_team/connection='+base.integrationId,provisionProtocol:1,airbyte:{destinationId:'destination'},airbyteWorkspaceId:'workspace',startDate:'2026-01-01'};
 const f=await fixture(t,record);let calls=0,visible=false;
 const ref=await f.registry.requestLifecycle(record,'provision',{apiKey:'PRIVATE_PROVIDER_KEY'},principal.userId);
 const provider={id:'granola',auth:'api-key',scope:'team',owner:()=> 'workspace=org_team',connector:{name:'source',manifest:{}},streams:[],sourceConfiguration:({apiKey})=>({apiKey})};
 const service=createIntegrations({...f.options,providers:{granola:provider},airbyte:{
  declarativeSources:async()=>[{name:'source',id:'definition',manifest:{}}],
  createSource:async input=>{calls++;assert.equal(input.configuration.apiKey,'PRIVATE_PROVIDER_KEY');throw Error('PRIVATE_PROVIDER_BODY');},
  sources:async()=>visible?[{sourceId:'source',workspaceId:'workspace',name:'selfhost org_team user_a granola '+record.integrationId}]:[]}});
 await service.lifecycleStep({...ref,step:'prepare'});
 await assert.rejects(service.lifecycleStep({...ref,step:'source'}),/PRIVATE_PROVIDER_BODY/);assert.equal(calls,1);
 await assert.rejects(service.lifecycleStep({...ref,step:'source'}),{code:'ProvisioningRecoveryPending'});assert.equal(calls,1);
 await f.commands.clearSecret(ref);visible=true;await service.lifecycleStep({...ref,step:'source'});assert.equal(calls,1);
 assert.equal((await f.registry.get(record.tenantId,record.userId,record.integrationId)).airbyte.sourceId,'source');assert.deepEqual(await f.commands.readSecret(ref),{});
});

test('startup recovery skips records without recoverable desired state',async()=>{
 const record={...base,status:'provisioning'};let current;
 const service=createIntegrations({environment:'selfhost',appUrl:'https://self.example',providers:{github:{id:'github',scope:'team'}},registry:{get:async()=>current},airbyte:{sync:async()=>assert.fail('Recovery cannot create a sync')},oauth:{},buckets:{},destination:{},legacyBucket:'owned',workspaceId:async()=>'workspace'});
 for(const fields of [{status:'active'},{status:'connecting'},{status:'disconnected'},{status:'error',error:'reconnect'},{status:'error',error:'sign-in'}]){current={...record,...fields};await service.recoverRecord(record);}
 current=null;await service.recoverRecord(record);current={...record,tenantId:'org_foreign'};await assert.rejects(service.recoverRecord(record),/scope/);
 current=record;await assert.rejects(service.recoverRecord(record),{status:503});
});

test('a superseded command failure cannot overwrite the newer disconnect or restore its secret',{skip:!postgresUrl},async t=>{
 const record={...base,status:'provisioning',provisionProtocol:1};const f=await fixture(t,record);
 const setup=await f.registry.requestLifecycle(record,'provision',{apiKey:'PRIVATE_KEY'},principal.userId);
 const cleanup=await f.registry.requestLifecycle(record,'disconnect',{},principal.userId);
 await f.commands.fail(setup,'authorization_denied');
 const current=await f.registry.get(record.tenantId,record.userId,record.integrationId);
 assert.equal(current.status,'disconnecting');assert.equal(current.lifecycleCommandId,cleanup.commandId);assert.equal((await f.commands.read(setup)).status,'superseded');assert.deepEqual(await f.commands.readSecret(setup),{});
});

test('OAuth preparation resolves account landing scope before destination validation',{skip:!postgresUrl},async t=>{
 const record={...base,provider:'notion',status:'connecting',s3Prefix:undefined,airbyte:undefined,resourceVersion:undefined,connectedAccountId:'account',provisionProtocol:1};
 const f=await fixture(t,record),ref=await f.registry.requestLifecycle(record,'provision',{},principal.userId);
 const service=createIntegrations({...f.options,providers:{notion:{id:'notion',scope:'team',auth:'oauth',owner:()=> 'workspace=org_team',account:async()=>({label:'Workspace',workspace:'org_team'})}},
  destination:{validate(value){assert.equal(value.s3Prefix,'raw/v1/source=notion/workspace=org_team/connection='+record.integrationId);},prepare:async()=>({}),settings:async()=>({configuration:{}})}});
 assert.deepEqual(await service.lifecycleStep({...ref,step:'prepare'}),{status:'done'});assert.equal((await f.registry.get(record.tenantId,record.userId,record.integrationId)).workspace,'org_team');
});


test('migration with a lost API key asks for reconnect before allocating new resources, while an adopted source can continue',{skip:!postgresUrl},async t=>{
 const record={...base,provider:'granola',status:'provisioning',provisionProtocol:1,airbyte:{destinationId:'destination'},airbyteWorkspaceId:'workspace',s3Prefix:'raw/v1/source=granola/workspace=org_team/connection='+base.integrationId};
 const f=await fixture(t,record),ref=await f.registry.requestLifecycle(record,'provision',{},principal.userId);let prepared=0;
 const provider={id:'granola',auth:'api-key',scope:'team',owner:()=> 'workspace=org_team',total:async()=>assert.fail('Lost optional estimate key cannot block an adopted source')};
 const service=createIntegrations({...f.options,providers:{granola:provider},destination:{validate(){},prepare:async()=>{prepared++;return {};}}});
 await assert.rejects(service.lifecycleStep({...ref,step:'prepare'}),{code:'ProvisioningKeyRequired'});assert.equal(prepared,0);
 await f.registry.update(record,{airbyte:{...record.airbyte,sourceId:'adopted-source'}});
 assert.deepEqual(await service.lifecycleStep({...ref,step:'prepare'}),{status:'done'});assert.equal(prepared,1);
});

test('Airbyte definition creation and manifest publication retain a shared intent before source creation',{skip:!postgresUrl},async t=>{
 const record={...base,provider:'granola',status:'provisioning',provisionProtocol:1,sharedResourceProtocol:1,s3Prefix:'raw/v1/source=granola/workspace=org_team/connection='+base.integrationId,airbyte:{destinationId:'destination'},airbyteWorkspaceId:'workspace',startDate:'2026-01-01'};
 const f=await fixture(t,record),ref=await f.registry.requestLifecycle(record,'provision',{apiKey:'PRIVATE_KEY'},principal.userId);let creates=0,sources=0,visible=false;
 const provider={id:'granola',auth:'api-key',scope:'team',owner:()=> 'workspace=org_team',connector:{name:'OpenCrawl definition',manifest:{}},sourceConfiguration:()=>({})};
 const service=createIntegrations({...f.options,providers:{granola:provider},airbyte:{declarativeSources:async()=>visible?[{id:'definition',name:provider.connector.name,manifest:{}}]:[],createDeclarativeSource:async()=>{creates++;throw Error('provider committed definition');},createSource:async()=>{sources++;return {sourceId:'source'};}}});
 await service.lifecycleStep({...ref,step:'prepare'});await assert.rejects(service.lifecycleStep({...ref,step:'source'}),/committed/);await assert.rejects(service.lifecycleStep({...ref,step:'source'}),{code:'ProvisioningRecoveryPending'});assert.deepEqual([creates,sources],[1,0]);
 visible=true;await service.lifecycleStep({...ref,step:'source'});assert.deepEqual([creates,sources],[1,1]);assert.equal((await f.registry.get(record.tenantId,record.userId,record.integrationId)).airbyte.sourceId,'source');
});
