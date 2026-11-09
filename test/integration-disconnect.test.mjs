import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSingleOrganizationRegistry} from '../dist/src/integrations/local-registry.mjs';
import {createIntegrations} from '../dist/src/integrations/service.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('self-host disconnect removes its connection without uninstalling a shared GitHub installation',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'opencrawl-disconnect-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const registry=createSingleOrganizationRegistry({path:join(dir,'registry.sqlite'),organizationId:'org_team'});t.after(()=>registry.close());
 const principal={tenantId:'org_team',userId:'user_a'};
 const record={...principal,integrationId:'int_'+'a'.repeat(26),environment:'selfhost',provider:'github',scope:'team',status:'active',createdAt:new Date().toISOString(),installationId:'42',s3Bucket:'owned',s3Prefix:'owned/connection',airbyte:{connectionId:'connection',sourceId:'source',destinationId:'destination'}};
 await registry.create(record);const removed=[];
 const service=createIntegrations({environment:'selfhost',appUrl:'https://self.example',registry,legacyBucket:'owned',workspaceId:async()=>'workspace',destination:{},oauth:{},providers:{github:{id:'github',scope:'team'}},
  github:{uninstall:async()=>assert.fail('Uninstalling would affect other deployments')},
  buckets:{deletePrefix:async(bucket,prefix)=>{assert.equal(bucket,'owned');assert.equal(prefix,'owned/connection/');removed.push('data');return 3;}},
  airbyte:Object.fromEntries(['Connection','Source','Destination'].map(kind=>['delete'+kind,async id=>{assert.equal((await registry.get(principal.tenantId,principal.userId,record.integrationId)).status,'disconnecting');removed.push(id);}]))});
 await service.disconnect(principal,'github');assert.deepEqual(removed,['connection','source','destination','data']);
 assert.equal((await registry.get(principal.tenantId,principal.userId,record.integrationId)).status,'disconnected');
});
