import {createSingleOrganizationRegistry} from '../dist/src/integrations/local-registry.mjs';
import {createPostgresWriteBarrier,ensureWriteBarrierSchema} from '../dist/src/state/write-barriers.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createIntegrationDrainProofs} from '../dist/src/state/integration-drain-proofs.mjs';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
const record={environment:'selfhost',tenantId:'org_team',userId:'user_a',integrationId:'int_'+'a'.repeat(26),status:'disconnecting',resourceVersion:'current',airbyte:{connectionId:'connection'},s3Bucket:'owned',s3Prefix:'raw/owned'};
test('external drain evidence binds the exact resource incarnation and never follows a late create',{skip:!postgresUrl},async t=>{
 const database=await applicationDatabaseFixture(t),proofs=createIntegrationDrainProofs({database,environment:'selfhost'});
 await assert.rejects(proofs.requireProof(record),{code:'EXTERNAL_WRITER_PROOF_REQUIRED'});
 await assert.rejects(proofs.recordVerifiedProof({...record,provisionIntent:{resource:'connectionId'}},{evidence:'inspection receipt',verifiedBy:'operator'}),/Explicit/);
 const registry=createSingleOrganizationRegistry({database,organizationId:record.tenantId});await registry.create({...record,provider:'slack'});await ensureWriteBarrierSchema(database);const barrier=createPostgresWriteBarrier({database,tenantId:record.tenantId,connectionId:record.integrationId});
 await assert.rejects(proofs.recordVerifiedProof(record,{evidence:'Unclosed admission',verifiedBy:'operator'}),{code:'EXTERNAL_WRITER_PROOF_REQUIRED'});await barrier.close();
 await proofs.recordVerifiedProof(record,{evidence:'Worker termination and storage completion receipt test-fixture',verifiedBy:'operator'});await proofs.requireProof(record);
 for(const changed of [{resourceVersion:'late'},{airbyte:{connectionId:'late'}},{s3Prefix:'raw/other'},{tenantId:'org_other'}])await assert.rejects(proofs.requireProof({...record,...changed}),{code:'EXTERNAL_WRITER_PROOF_REQUIRED'});
 await proofs.requireProof({...record,airbyte:{},resourceVersion:undefined});
});
