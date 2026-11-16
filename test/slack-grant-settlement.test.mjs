import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
import {createIntegrationCommands} from '../dist/src/state/integration-commands.mjs';
import {createSingleOrganizationRegistry} from '../dist/src/integrations/local-registry.mjs';
import {createConnectorSecrets} from '../dist/src/state/connector-secrets.mjs';
import {createPostgresWriteBarrier,ensureWriteBarrierSchema} from '../dist/src/state/write-barriers.mjs';
import {credentialVault} from '../dist/src/integrations/credential-vault.mjs';
import {runSlackGrantSettlementCommand} from '../dist/src/state/slack-grant-settlement-cli.mjs';
const record={environment:'selfhost',tenantId:'org_team',userId:'user_owner',integrationId:'int_'+'a'.repeat(26),provider:'slack',scope:'team',status:'disconnected',createdAt:'2026-01-01',startDate:'2026-01-01',resourceVersion:'first',workspace:'T_FIXTURE',connectedAccountId:'grant_'+'a'.repeat(48)};
async function fixture(t){
 const sourceIdentity={version:1,bucket:'owned',prefix:'sessions/fixture/v1',organizationId:record.tenantId},database=await applicationDatabaseFixture(t,{sourceIdentity}),key=Buffer.alloc(32,7),commands=createIntegrationCommands({database,environment:'selfhost',encryptionKey:key});await commands.ready();
 const registry=createSingleOrganizationRegistry({database,organizationId:record.tenantId,commands:commands.transactional});await registry.create(record);await ensureWriteBarrierSchema(database);
 await database.pool.query("INSERT INTO opencrawl_application_installations(namespace,source_identity,migration_id,state,verified_at) VALUES($1,$2::jsonb,$3,'ready',now())",[database.namespace,JSON.stringify(sourceIdentity),randomUUID()]);
 const secrets=createConnectorSecrets(database);await secrets.ready();const vault=credentialVault({state:{connectorSecrets:secrets},prefix:'connector-credentials/v1',organizationId:record.tenantId,key});
 await vault.write({version:1,id:record.connectedAccountId,organizationId:record.tenantId,userId:record.userId,integrationId:record.integrationId,provider:'slack',status:'REVOKED',state:'PRIVATE_FLOW',callbackUrl:'https://self.example/callback',flowExpiresAt:1,proxyToken:'PRIVATE_PROXY',accessToken:'PRIVATE_ACCESS',refreshToken:'PRIVATE_REFRESH',retirementTokens:['PRIVATE_LATE'],legacyTokenUncertainty:true,tokenIntent:{kind:'refresh',attemptId:'a'.repeat(32),requestedAt:1}},null);
 const directory=await mkdtemp(join(tmpdir(),'opencrawl-slack-proof-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const barrier=createPostgresWriteBarrier({database,tenantId:record.tenantId,connectionId:record.integrationId}),flags=['--integration',record.integrationId,'--owner',record.userId];
 const run=args=>runSlackGrantSettlementCommand({database,organizationId:record.tenantId,key,args}),inspect=()=>run(['inspect',...flags]);
 async function attest(fields={}){const path=join(directory,'evidence.json');await writeFile(path,JSON.stringify({version:1,fingerprint:(await inspect()).fingerprint,verifiedBy:'operator',exchangeDisposition:'PRIVATE_EVIDENCE_TERMINATED_ALL_EXCHANGES',providerRevocation:'PRIVATE_EVIDENCE_ISSUER_REVOKED_EXACT_GRANT',...fields}));return run(['record',...flags,'--evidence',path]);}
 return {database,commands,registry,vault,barrier,run,inspect,attest,directory,flags};
}
test('Slack operator proof is read-only on inspect, exact-version bound, encrypted, and queues remaining cleanup atomically',{skip:!postgresUrl},async t=>{
 const f=await fixture(t),before=await f.vault.read(record.connectedAccountId),inspection=await f.inspect();assert.deepEqual(inspection.uncertainty,{tokenExchange:true,legacyTokens:true});assert.doesNotMatch(JSON.stringify(inspection),/PRIVATE/);assert.deepEqual(await f.vault.read(record.connectedAccountId),before);
 await assert.rejects(f.attest(),{code:'SLACK_SETTLEMENT_NOT_READY'});await f.barrier.close();await assert.rejects(f.attest({fingerprint:'f'.repeat(64)}),{code:'SLACK_SETTLEMENT_TARGET_CHANGED'});await assert.rejects(f.attest({token:'PRIVATE_TOKEN'}),{code:'SLACK_SETTLEMENT_EVIDENCE_INVALID'});
 const saved=await f.attest();assert.equal(saved.proof.recorded,true);assert.deepEqual(saved.uncertainty,{tokenExchange:false,legacyTokens:false});assert.doesNotMatch(JSON.stringify(saved),/PRIVATE/);
 const grant=(await f.vault.read(record.connectedAccountId)).record;assert.equal(grant.accessToken,'PRIVATE_ACCESS');assert.equal(grant.refreshToken,'PRIVATE_REFRESH');assert.deepEqual(grant.retirementTokens,['PRIVATE_LATE']);assert.equal(grant.remoteRevoked,false);assert.equal(grant.settlementProof.exchangeDisposition,'PRIVATE_EVIDENCE_TERMINATED_ALL_EXCHANGES');
 const pending=(await f.commands.listPending({})).commands;assert.equal(pending.length,1);assert.equal((await f.commands.read(pending[0])).operation,'disconnect');assert.equal((await f.registry.get(record.tenantId,record.userId,record.integrationId)).lifecycleCommandId,pending[0].commandId);
 const encrypted=(await f.database.pool.query('SELECT ciphertext FROM opencrawl_connector_secrets WHERE namespace=$1',[f.database.namespace])).rows[0].ciphertext;assert.ok(!encrypted.includes(Buffer.from('PRIVATE')));
});
test('Slack proof never clears unresolved native writers, active grants or another owner',{skip:!postgresUrl},async t=>{
 const f=await fixture(t);await f.barrier.importFence({version:1,namespace:'selfhost',tenantId:record.tenantId,connectionId:record.integrationId,closedAt:1,writers:[{id:'uncertain',operation:'object-put',phase:'writing',startedAt:1,instance:'old',target:'private'}]});
 await assert.rejects(f.attest(),{code:'SLACK_SETTLEMENT_NOT_READY'});assert.equal((await f.barrier.inspect()).pending,1);assert.equal((await f.vault.read(record.connectedAccountId)).record.legacyTokenUncertainty,true);
 await assert.rejects(f.run(['inspect','--integration',record.integrationId,'--owner','user_other']),{code:'SLACK_SETTLEMENT_SCOPE_NOT_FOUND'});
 await f.database.pool.query("UPDATE opencrawl_application_installations SET state='importing',verified_at=NULL WHERE namespace=$1",[f.database.namespace]);await assert.rejects(f.inspect(),/incomplete/);
});
test('Slack proof rollback preserves uncertainty when cleanup outbox insertion fails',{skip:!postgresUrl},async t=>{
 const f=await fixture(t);await f.barrier.close();const before=await f.vault.read(record.connectedAccountId);
 // A scoped trigger simulates a database failure after encrypted proof update.
 const functionName='fixture_'+randomUUID().replaceAll('-','');
 await f.database.pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.namespace='${f.database.namespace}' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$; CREATE TRIGGER ${functionName} BEFORE INSERT ON opencrawl_integration_commands FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
 try{await assert.rejects(f.attest());assert.deepEqual(await f.vault.read(record.connectedAccountId),before);assert.deepEqual((await f.commands.listPending({})).commands,[]);}finally{await f.database.pool.query(`DROP TRIGGER ${functionName} ON opencrawl_integration_commands;DROP FUNCTION ${functionName}()`);}
});

test('compiled Slack settlement entrypoint prints safe scoped metadata and rejects malformed evidence',{skip:!postgresUrl},async t=>{
 const f=await fixture(t),program=new URL('../dist/src/state/slack-grant-settlement-cli.mjs',import.meta.url),env={PATH:process.env.PATH,OPENCRAWL_DATABASE_URL:postgresUrl,OPENCRAWL_APP_STATE_NAMESPACE:f.database.namespace,OPENCRAWL_LANDING_S3_BUCKET:'owned',OPENCRAWL_LANDING_S3_PATH:'sessions/fixture/v1',OPENCRAWL_ORGANIZATION_ID:record.tenantId,OPENCRAWL_CONNECTOR_KEY:Buffer.alloc(32,7).toString('base64')};
 const execute=(...args)=>promisify(execFile)(process.execPath,[program.pathname,...args],{env});
 const result=await execute('inspect',...f.flags);assert.equal(JSON.parse(result.stdout).grantId,record.connectedAccountId);assert.doesNotMatch(result.stdout,/PRIVATE/);
 const path=join(f.directory,'invalid.json');await writeFile(path,'PRIVATE_BAD_EVIDENCE');await assert.rejects(execute('record',...f.flags,'--evidence',path),error=>error.code===1&&JSON.parse(error.stderr).code==='SLACK_SETTLEMENT_EVIDENCE_INVALID'&&!error.stderr.includes('PRIVATE'));
});
