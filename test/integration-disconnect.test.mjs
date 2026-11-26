import {applicationDatabaseFixture} from './fixtures/application-database.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSingleOrganizationRegistry} from '../dist/src/integrations/local-registry.mjs';
import {createIntegrations} from '../dist/src/integrations/service.mjs';
import {selfhostServices} from '../dist/src/selfhost/services.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('self-host disconnect removes its connection without uninstalling a shared GitHub installation',async t=>{
 const database=await applicationDatabaseFixture(t);
 const dir=await mkdtemp(join(tmpdir(),'opencrawl-disconnect-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const registry=createSingleOrganizationRegistry({database,organizationId:'org_team'});t.after(()=>registry.close());
 const principal={tenantId:'org_team',userId:'user_a'};
 const record={...principal,integrationId:'int_'+'a'.repeat(26),environment:'selfhost',provider:'github',scope:'team',status:'active',createdAt:new Date().toISOString(),installationId:'42',s3Bucket:'owned',s3Prefix:'owned/connection',airbyte:{connectionId:'connection',sourceId:'source',destinationId:'destination'}};
 await registry.create(record);const removed=[];
 const service=createIntegrations({environment:'selfhost',appUrl:'https://self.example',registry,legacyBucket:'owned',workspaceId:async()=>'workspace',destination:{},oauth:{},providers:{github:{id:'github',scope:'team',unavailableReason:'Indexing not available'}},
  github:{uninstall:async()=>assert.fail('Uninstalling would affect other deployments')},
  buckets:{deletePrefix:async(bucket,prefix)=>{assert.equal(bucket,'owned');assert.equal(prefix,'owned/connection/');removed.push('data');return 3;}},
  airbyte:Object.fromEntries(['Connection','Source','Destination'].map(kind=>['delete'+kind,async id=>{assert.equal((await registry.get(principal.tenantId,principal.userId,record.integrationId)).status,'disconnecting');removed.push(id);}]))});
 await assert.rejects(service.retry(principal,'github'),{status:503});
 await service.disconnect(principal,'github');assert.deepEqual(removed,['connection','source','destination','data']);
 assert.equal((await registry.get(principal.tenantId,principal.userId,record.integrationId)).status,'disconnected');
 // A startup snapshot taken before disconnect must not recreate or sync it.
 await service.recoverRecord(record);
 assert.deepEqual(removed,['connection','source','destination','data']);
});

test('two workspace GitHub accounts are listed and disconnect must target a connection',async()=>{
 const principal={tenantId:'org_team',userId:'user_a'};
 const records=['a','b'].map((letter,i)=>({...principal,userId:'user_'+letter,integrationId:'int_'+letter.repeat(26),
  environment:'selfhost',provider:'github',scope:'team',status:'provisioning',account:'org-'+i,installationId:String(i+42),lifecycleCommandId:'command-'+i}));
 const requested=[];
 const service=createIntegrations({environment:'selfhost',appUrl:'https://self.example',registry:{listTenant:async()=>records},
  providers:{github:{id:'github',scope:'team',auth:'github-app'}},airbyte:{},oauth:{},buckets:{},destination:{},legacyBucket:'owned',workspaceId:async()=>'workspace',
  lifecycle:{requests:{requestLifecycle:async record=>{requested.push(record.integrationId);return {}; }},start:async()=>{}},log:(_event,data)=>assert.fail(JSON.stringify(data))});
 const cards=await service.list(principal);
 assert.deepEqual(cards.map(card=>card.integrationId),records.map(record=>record.integrationId));
 await assert.rejects(service.disconnect(principal,'github'),{status:409});
 await assert.rejects(service.disconnect(principal,'github','int_'+'c'.repeat(26)),{status:404});
 await service.disconnect(principal,'github',records[1].integrationId);
 assert.deepEqual(requested,[records[1].integrationId]);
});

test('startup recovery skips active, pending consent, removed and nonrecoverable error records',async()=>{
 const record={tenantId:'org_team',userId:'user_a',integrationId:'int_'+'b'.repeat(26),environment:'selfhost',provider:'github',status:'provisioning'};
 let current; const service=createIntegrations({environment:'selfhost',appUrl:'https://self.example',providers:{github:{id:'github',scope:'team'}},
  registry:{get:async()=>current},airbyte:{sync:async()=>assert.fail('Startup must not trigger a new sync')},oauth:{},buckets:{},destination:{},legacyBucket:'owned',workspaceId:async()=>'workspace'});
 for(const fields of [{status:'active'},{status:'connecting'},{status:'disconnected'},{status:'error',error:'reconnect'},{status:'error',error:'sign-in'}]){
  current={...record,...fields};await service.recoverRecord(record);
 }
 current=null;await service.recoverRecord(record);
 current={...record,tenantId:'org_foreign'};await assert.rejects(service.recoverRecord(record),/scope/);
});

test('OSS continues recovery after one interrupted connection fails',async t=>{
 const database=await applicationDatabaseFixture(t);
 const dir=await mkdtemp(join(tmpdir(),'opencrawl-recovery-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const services=selfhostServices({organizationId:'org_team',url:'https://self.example',registryPath:join(dir,'registry.sqlite'),search:{endpoint:'http://127.0.0.1:1',environment:'selfhost',tenantId:'org_team'}},{bucket:'owned'},database,
  {AIRBYTE_WORKSPACE_ID:'00000000-0000-0000-0000-000000000001',AIRBYTE_URL:'http://127.0.0.1:1',AIRBYTE_CLIENT_ID:'test',AIRBYTE_CLIENT_SECRET:'test',OPENCRAWL_LANDING_S3_ACCESS_KEY_ID:'test',OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY:'test'});
 t.after(()=>services.close());
 const base={tenantId:'org_team',userId:'user_a',environment:'selfhost',provider:'granola',scope:'team',createdAt:new Date().toISOString()};
 // The first record has an incomplete landing destination and cannot recover.
 await services.registry.create({...base,integrationId:'int_'+'a'.repeat(26),status:'provisioning'});
 const second={...base,integrationId:'int_'+'b'.repeat(26),status:'disconnecting'};
 await services.registry.create(second);
 await assert.rejects(services.recover(),AggregateError);
 assert.equal((await services.registry.get(second.tenantId,second.userId,second.integrationId)).status,'disconnected');
});
