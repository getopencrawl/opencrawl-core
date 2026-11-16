import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createApplicationDatabase,requireApplicationStateReady} from '../dist/src/state/postgres.mjs';
import {migrateApplicationSources} from '../dist/src/state/migration-engine.mjs';
import {readApplicationAdmission,validateOnlineApplicationAdmission,onlineApplicationAdmissionHash,prepareOnlineAdmissionSchemaIn} from '../dist/src/state/application-admission.mjs';
const pg=process.env.OPENCRAWL_TEST_POSTGRES_URL,source={version:1,bucket:'admission-source',prefix:'sessions/production/v1',organizationId:null};
function proof(namespace){return {format:1,namespace,epoch:randomUUID(),targetId:'a'.repeat(64),protocol:'online-test-v1',source,attemptId:randomUUID(),sealedAt:'2026-11-16T23:00:00.000Z',sourceCount:2,preparationReceiptHash:'b'.repeat(64),enrollmentReceiptHash:'c'.repeat(64),candidateHash:'d'.repeat(64),sourceSetHash:'e'.repeat(64),closedFrontiersHash:'f'.repeat(64),coverageHash:'1'.repeat(64),retirementHash:'2'.repeat(64),nativeBindingHash:'3'.repeat(64),drainReceiptHash:'4'.repeat(64)};}
test('online admission receipt hashes normalized exact fields and refuses invented source or target metadata',()=>{
 const p=proof('fixture'),reordered=Object.fromEntries(Object.entries(p).reverse());reordered.source={organizationId:null,prefix:source.prefix,bucket:source.bucket,version:1};
 assert.equal(onlineApplicationAdmissionHash(p),onlineApplicationAdmissionHash(reordered));assert.ok(Object.isFrozen(validateOnlineApplicationAdmission(p).source));
 for(const patch of [{format:2},{extra:true},{epoch:'invalid'},{sourceCount:0},{sourceCount:100001},{coverageHash:'pending'},{sealedAt:'2026-11-16'},{source:{...source,token:'secret'}},{source:{...source,prefix:'../state'}}])assert.throws(()=>validateOnlineApplicationAdmission({...p,...patch}),/Application admission/);
});
async function fixture(t){
 const schema='oc_admission_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:pg,max:1});await admin.query('CREATE SCHEMA '+schema);
 const database=createApplicationDatabase({connectionString:pg,namespace:'admission-'+randomUUID(),sourceIdentity:source,onlineTargetId:'a'.repeat(64),options:'-c search_path='+schema,max:4});
 t.after(async()=>{await database.close();const client=await admin.connect();try{await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:identity-schema:maintenance',0))");await client.query('DROP SCHEMA '+schema+' CASCADE');await client.query('DROP SCHEMA IF EXISTS '+database.identitySchema+' CASCADE');await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();await admin.end();}});
 await database.ready();const upgrade=()=>database.transaction(async c=>{await c.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:application:schema',0))");await prepareOnlineAdmissionSchemaIn(c);});return {database,upgrade};
}
test('actual PG explicit schema upgrade preserves existing offline identity and does not invent readiness',{skip:!pg},async t=>{
 const {database,upgrade}=await fixture(t),migration=randomUUID();
 await database.pool.query("INSERT INTO opencrawl_application_installations(namespace,source_identity,migration_id,state,verified_at,source_manifest_hash,inventory_complete) VALUES($1,$2,$3,'ready',now(),$4,true)",[database.namespace,source,migration,'b'.repeat(64)]);
 const before=(await database.pool.query('SELECT ctid::text,* FROM opencrawl_application_installations')).rows[0];await upgrade();await upgrade();
 const after=(await database.pool.query('SELECT ctid::text,* FROM opencrawl_application_installations')).rows[0];for(const key of Object.keys(before))assert.deepEqual(after[key],before[key]);
 assert.equal(after.admission_kind,'offline');assert.equal(after.online_epoch,null);assert.equal((await readApplicationAdmission(database)).migrationId,migration);await requireApplicationStateReady(database);
 assert.equal((await database.pool.query('SELECT count(*)::int AS n FROM opencrawl_online_application_admissions')).rows[0].n,0);
 await assert.rejects(database.pool.query("UPDATE opencrawl_application_installations SET admission_kind='online' WHERE namespace=$1",[database.namespace]),{code:'23514'});
 await database.pool.query('ALTER TABLE opencrawl_application_installations DROP CONSTRAINT opencrawl_application_admission_mode, ADD CONSTRAINT opencrawl_application_admission_mode CHECK(true)');
 await assert.rejects(upgrade(),/incomplete admission schema/);
});
test('actual PG explicit admission schema upgrade rolls back entirely on failure',{skip:!pg},async t=>{
 const {database}=await fixture(t);await assert.rejects(database.transaction(async c=>{await c.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:application:schema',0))");await prepareOnlineAdmissionSchemaIn(c);throw Error('abort schema transaction');}),/abort schema/);
 assert.equal((await database.pool.query('SELECT version FROM opencrawl_application_schema')).rows[0].version,1);
 assert.equal((await database.pool.query("SELECT to_regclass('opencrawl_online_application_admissions') AS relation")).rows[0].relation,null);
 await assert.rejects(requireApplicationStateReady(database),/incomplete/);
});
test('actual PG startup reader requires exact sealed proof, terminal authority and deployment target',{skip:!pg},async t=>{
 const {database,upgrade}=await fixture(t);await upgrade();const p=proof(database.namespace),receipt=onlineApplicationAdmissionHash(p);
 // Read-contract fixture only. This deliberately does not exercise or claim a
 // production sealer, source parity, write drain or a completed online migration.
 await database.pool.query(`CREATE TABLE opencrawl_online_migration_epochs(namespace text,epoch uuid,state text);
 CREATE TABLE opencrawl_online_write_authorities(namespace text,epoch uuid,protocol text,mode text,preparation_receipt_hash text,enrollment_receipt_hash text,target_receipt_hash text)`);
 await database.pool.query("INSERT INTO opencrawl_application_installations(namespace,source_identity,migration_id,state,verified_at,admission_kind,online_epoch,online_receipt_hash) VALUES($1,$2,NULL,'ready',$3,'online',$4,$5)",[database.namespace,source,p.sealedAt,p.epoch,receipt]);
 await assert.rejects(readApplicationAdmission(database),/missing/);
 await database.pool.query('INSERT INTO opencrawl_online_application_admissions VALUES($1,$2,$3,$4)',[database.namespace,p.epoch,receipt,p]);
 await database.pool.query("INSERT INTO opencrawl_online_migration_epochs VALUES($1,$2,'fenced')",[database.namespace,p.epoch]);
 await database.pool.query("INSERT INTO opencrawl_online_write_authorities VALUES($1,$2,$3,'target',$4,$5,$6)",[database.namespace,p.epoch,p.protocol,p.preparationReceiptHash,p.enrollmentReceiptHash,receipt]);
 const result=await readApplicationAdmission(database);assert.equal(result.kind,'online');assert.equal(result.receiptHash,receipt);await requireApplicationStateReady(database);
 await assert.rejects(migrateApplicationSources({database,source,mode:'check',checkAccess:async()=>{},sources:async()=>assert.fail('offline importer cannot inspect an online installation')}),/Online admission cannot be changed by the offline importer/);
 await assert.rejects(readApplicationAdmission({...database,onlineTargetId:undefined}),/target binding/);
 await assert.rejects(readApplicationAdmission({...database,onlineTargetId:'f'.repeat(64)}),/changed/);
 await assert.rejects(readApplicationAdmission({...database,sourceIdentity:{...source,bucket:'other'}}),/source binding/);
 await database.pool.query("UPDATE opencrawl_online_write_authorities SET mode='journal'");await assert.rejects(requireApplicationStateReady(database),/terminal authority/);
 await database.pool.query("UPDATE opencrawl_online_write_authorities SET mode='target'");await database.pool.query("UPDATE opencrawl_online_application_admissions SET proof=jsonb_set(proof,'{coverageHash}',to_jsonb($1::text))",['0'.repeat(64)]);await assert.rejects(requireApplicationStateReady(database),/changed/);
});
