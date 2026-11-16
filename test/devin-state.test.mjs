import test from 'node:test';
import assert from 'node:assert/strict';
import {createDevinState} from '../dist/src/state/devin.mjs';
import {createReplicasState} from '../dist/src/state/replicas.mjs';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';

test('PostgreSQL keeps Devin ownership atomic, revocation durable and provider/installation namespaces separate',{skip:!postgresUrl},async t=>{
  const database=await applicationDatabaseFixture(t),otherDatabase=await applicationDatabaseFixture(t);
  const devin=createDevinState(database),replicas=createReplicasState(database),other=createDevinState(otherDatabase);
  await Promise.all([devin.ready(),replicas.ready(),other.ready()]);
  const org='11111111-1111-4111-8111-111111111111';
  const installation={id:org,tenantId:'org_devin',userId:'workload_devin_'+'a'.repeat(64),name:'Devin Cloud'};
  const record={schemaVersion:1,organizationId:org,tenantId:'org_devin',approvedBy:'user_admin',approvedAt:'2026-01-01T00:00:00.000Z',revokedAt:null,installations:[installation]};
  await assert.rejects(devin.saveConnection(org,null,{...record,installations:[installation,installation]}));
  assert.equal((await devin.readConnection(org)).record,null,'failed installation write rolls back ownership');
  assert.equal(await devin.saveConnection(org,null,record),true);
  const current=await devin.readConnection(org);
  assert.equal(await replicas.saveConnection(org,null,{...record,tenantId:'org_replicas',installations:[]}),true);
  assert.equal((await replicas.readConnection(org)).record.tenantId,'org_replicas');
  assert.deepEqual(await devin.listConnections('org_replicas'),[]);
  assert.equal((await other.readConnection(org)).record,null);
  assert.equal(await devin.saveConnection(org,current.version,{...record,tenantId:'org_other',installations:[]}),false);
  const revokedAt='2026-02-01T00:00:00.000Z';
  const outcomes=await Promise.all([
    devin.saveConnection(org,current.version,{...record,revokedAt}),
    devin.saveConnection(org,current.version,{...record,revokedAt}),
  ]);
  assert.equal(outcomes.filter(Boolean).length,1);
  assert.equal((await createDevinState(database).readConnection(org)).record.revokedAt,revokedAt);
  assert.equal((await replicas.readConnection(org)).record.revokedAt,null);
  const hash='b'.repeat(64),setup={schemaVersion:1,tenantId:'org_devin',userId:'user_admin',issuedAt:1000,expiresAt:2000,claim:{organizationId:org,sessionId:'devin-native-session'}};
  assert.equal(await devin.saveSetup(hash,null,setup),true);
  assert.deepEqual((await createDevinState(database).readSetup(hash)).record,setup);
  assert.equal((await replicas.readSetup(hash)).record,null);
  assert.equal((await other.readSetup(hash)).record,null);
  await assert.rejects(replicas.saveSetup(hash,null,setup));
  const nativeOrg='org-11111111111141118111111111111111';
  assert.equal(await devin.saveConnection(nativeOrg,null,{...record,organizationId:nativeOrg,installations:[]}),true);
  assert.equal((await createDevinState(database).readConnection(nativeOrg)).record.organizationId,nativeOrg);
  await assert.rejects(replicas.readConnection(nativeOrg));
  await assert.rejects(replicas.saveConnection(nativeOrg,null,{...record,organizationId:nativeOrg,installations:[]}));
});
