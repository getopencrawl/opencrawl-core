import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
import {createSingleOrganizationRegistry} from '../dist/src/integrations/local-registry.mjs';
import {createPostgresWriteBarrier,ensureWriteBarrierSchema} from '../dist/src/state/write-barriers.mjs';
import {createIntegrationDrainProofs} from '../dist/src/state/integration-drain-proofs.mjs';
import {runIntegrationDrainCommand} from '../dist/src/state/integration-drain-cli.mjs';
const record={environment:'selfhost',tenantId:'org_team',userId:'user_owner',integrationId:'int_'+'a'.repeat(26),provider:'slack',scope:'team',status:'disconnecting',createdAt:'2026-01-01',startDate:'2026-01-01',resourceVersion:'incarnation',airbyteWorkspaceId:'workspace',airbyte:{connectionId:'connection',sourceId:'source',destinationId:'destination'},s3Bucket:'owned',s3Prefix:'raw/v1/owned',account:'PRIVATE_ACCOUNT_LABEL',connectedAccountId:'PRIVATE_GRANT_ID'};
async function fixture(t){
 const sourceIdentity={version:1,bucket:'owned',prefix:'sessions/fixture/v1',organizationId:record.tenantId},database=await applicationDatabaseFixture(t,{sourceIdentity}),registry=createSingleOrganizationRegistry({database,organizationId:record.tenantId});await registry.create(record);await ensureWriteBarrierSchema(database);
 await database.pool.query("INSERT INTO opencrawl_application_installations(namespace,source_identity,migration_id,state,verified_at) VALUES($1,$2::jsonb,$3,'ready',now())",[database.namespace,JSON.stringify(sourceIdentity),randomUUID()]);
 const directory=await mkdtemp(join(tmpdir(),'opencrawl-drain-proof-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const barrier=createPostgresWriteBarrier({database,tenantId:record.tenantId,connectionId:record.integrationId}),proofs=createIntegrationDrainProofs({database,environment:'selfhost'});
 const args=['--integration',record.integrationId,'--owner',record.userId],run=extra=>runIntegrationDrainCommand({database,organizationId:record.tenantId,args:extra});
 const inspect=()=>run(['inspect',...args]);
 async function attest(fields={}){const proof=await inspect(),path=join(directory,'evidence.json');await writeFile(path,JSON.stringify({version:1,fingerprint:proof.fingerprint,verifiedBy:'operator-fixture',writerTermination:'Verified exact worker terminal disposition receipt A',storageSettlement:'Verified exact outstanding object writes completed receipt B',...fields}));return run(['record',...args,'--evidence',path]);}
 return {database,registry,barrier,proofs,run,args,inspect,attest,directory};
}
test('operator inspection is read-only and attestation requires exact resources and settled native admission',{skip:!postgresUrl},async t=>{
 const f=await fixture(t),before=await f.registry.get(record.tenantId,record.userId,record.integrationId),inspection=await f.inspect();
 assert.equal(inspection.native.closed,false);assert.equal(inspection.proof.recorded,false);assert.deepEqual(inspection.resources,{version:'incarnation',workspaceId:'workspace',connectionId:'connection',sourceId:'source',destinationId:'destination',bucket:'owned',prefix:'raw/v1/owned'});
 assert.equal((await f.database.pool.query('SELECT 1 FROM opencrawl_write_fences WHERE namespace=$1',[f.database.namespace])).rowCount,0);assert.deepEqual(await f.registry.get(record.tenantId,record.userId,record.integrationId),before);assert.ok(!JSON.stringify(inspection).includes('PRIVATE_'));
 await assert.rejects(f.attest(),{code:'EXTERNAL_WRITER_PROOF_REQUIRED'});await f.barrier.close();
 await assert.rejects(f.attest({fingerprint:'f'.repeat(64)}),{code:'DRAIN_TARGET_CHANGED'});
 await assert.rejects(f.attest({apiKey:'PRIVATE_TOKEN'}),{code:'DRAIN_EVIDENCE_INVALID'});
 const saved=await f.attest();assert.equal(saved.proof.recorded,true);assert.ok(!JSON.stringify(saved).includes('receipt A'));await f.proofs.requireProof(record);
 await f.attest();assert.equal((await f.database.pool.query('SELECT 1 FROM opencrawl_integration_drain_proofs WHERE namespace=$1',[f.database.namespace])).rowCount,1);
 await f.registry.update(record,{resourceVersion:'late-resource'});assert.equal((await f.inspect()).proof.recorded,false);await assert.rejects(f.proofs.requireProof({...record,resourceVersion:'late-resource'}),{code:'EXTERNAL_WRITER_PROOF_REQUIRED'});
});
test('operator proof cannot erase an uncertain writer or authorize foreign/installing scope',{skip:!postgresUrl},async t=>{
 const f=await fixture(t);await f.barrier.importFence({version:1,namespace:'selfhost',tenantId:record.tenantId,connectionId:record.integrationId,closedAt:1,writers:[{id:'uncertain',operation:'object-put',phase:'writing',startedAt:1,instance:'old-process',target:'PRIVATE_TARGET'}]});
 const inspected=await f.inspect();assert.equal(inspected.native.pending,1);assert.ok(!JSON.stringify(inspected).includes('PRIVATE_'));await assert.rejects(f.attest(),{code:'EXTERNAL_WRITER_PROOF_REQUIRED'});assert.equal((await f.barrier.inspect()).pending,1);
 await assert.rejects(f.run(['inspect','--integration',record.integrationId,'--owner','user_other']),{code:'DRAIN_SCOPE_NOT_FOUND'});
 await f.database.pool.query("UPDATE opencrawl_application_installations SET state='importing',verified_at=NULL WHERE namespace=$1",[f.database.namespace]);await assert.rejects(f.inspect(),/incomplete/);
});
test('operator evidence refuses pending create intents and schema preparation is safe concurrently',{skip:!postgresUrl},async t=>{
 const f=await fixture(t);await Promise.all(Array.from({length:12},()=>createIntegrationDrainProofs({database:f.database,environment:'selfhost'}).ready()));await f.barrier.close();
 await f.registry.update(record,{provisionIntent:{resource:'connectionId',attemptId:'late',workspaceId:'workspace',name:'pending',requestedAt:'2026-01-01'}});
 assert.equal((await f.inspect()).pendingCreate.attemptId,'late');await assert.rejects(f.attest(),/Explicit terminal/);
});


test('compiled operator entrypoint records a scoped evidence file and prints only safe metadata',{skip:!postgresUrl},async t=>{
 const f=await fixture(t),program=new URL('../dist/src/state/integration-drain-cli.mjs',import.meta.url);
 const env={PATH:process.env.PATH,OPENCRAWL_DATABASE_URL:postgresUrl,OPENCRAWL_APP_STATE_NAMESPACE:f.database.namespace,OPENCRAWL_LANDING_S3_BUCKET:'owned',OPENCRAWL_LANDING_S3_PATH:'sessions/fixture/v1',OPENCRAWL_ORGANIZATION_ID:record.tenantId};
 const execute=(...args)=>promisify(execFile)(process.execPath,[program.pathname,...args],{env});
 const inspected=JSON.parse((await execute('inspect',...f.args)).stdout);assert.equal(inspected.integrationId,record.integrationId);assert.ok(!JSON.stringify(inspected).includes('PRIVATE_'));
 await f.barrier.close();const path=join(f.directory,'command-evidence.json');
 await writeFile(path,JSON.stringify({version:1,fingerprint:inspected.fingerprint,verifiedBy:'operator-cli',writerTermination:'PRIVATE_EVIDENCE_REFERENCE_A',storageSettlement:'PRIVATE_EVIDENCE_REFERENCE_B'}));
 const saved=await execute('record',...f.args,'--evidence',path);assert.equal(JSON.parse(saved.stdout).proof.recorded,true);assert.ok(!saved.stdout.includes('PRIVATE_EVIDENCE'));
 await writeFile(path,'PRIVATE_INVALID_FILE');await assert.rejects(execute('record',...f.args,'--evidence',path),error=>error.code===1&&JSON.parse(error.stderr).code==='DRAIN_EVIDENCE_INVALID'&&!error.stderr.includes('PRIVATE_'));
});
