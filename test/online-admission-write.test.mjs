import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createApplicationDatabase} from '../dist/src/state/postgres.mjs';
import {prepareOnlineAdmissionSchemaIn,readApplicationAdmission,onlineApplicationAdmissionHash} from '../dist/src/state/application-admission.mjs';
import {createOnlineWriteAuthority} from '../dist/src/state/online-authority.mjs';
import {createOnlineJournal} from '../dist/src/state/online-journal.mjs';
import {readOnlineAdmissionSnapshotIn,writeOnlineApplicationAdmissionIn,reconcileOnlineApplicationAdmission} from '../dist/src/state/online-admission-write.mjs';
const pg=process.env.OPENCRAWL_TEST_POSTGRES_URL,source={version:1,bucket:'admission-source',prefix:'sessions/production/v1',organizationId:null};
function proof(namespace){return {format:1,namespace,epoch:randomUUID(),targetId:'a'.repeat(64),protocol:'online-test-v1',source,attemptId:randomUUID(),sealedAt:new Date().toISOString(),sourceCount:2,preparationReceiptHash:'b'.repeat(64),enrollmentReceiptHash:'c'.repeat(64),candidateHash:'d'.repeat(64),sourceSetHash:'e'.repeat(64),closedFrontiersHash:'f'.repeat(64),coverageHash:'1'.repeat(64),retirementHash:'2'.repeat(64),nativeBindingHash:'3'.repeat(64),drainReceiptHash:'4'.repeat(64)};}
test('internal admission write refuses malformed proof before database access',async()=>{
 await assert.rejects(writeOnlineApplicationAdmissionIn({query(){assert.fail('no query')}},{proof:{...proof('test'),coverageHash:'unverified'},snapshot:{}}),/Application admission/);
});
async function fixture(t){
 const schema='oc_admit_write_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:pg,max:1});await admin.query('CREATE SCHEMA '+schema);
 const database=createApplicationDatabase({connectionString:pg,namespace:'admission-write-'+randomUUID(),sourceIdentity:source,onlineTargetId:'a'.repeat(64),options:'-c search_path='+schema,max:4});
 const gatePool=new Pool({connectionString:pg,options:'-c search_path='+schema,max:2,connectionTimeoutMillis:3000}),p=proof(database.namespace),authority=createOnlineWriteAuthority({database:{pool:gatePool,namespace:database.namespace},epoch:p.epoch,protocol:p.protocol});
 t.after(async()=>{await gatePool.end();await database.close();const client=await admin.connect();try{await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:identity-schema:maintenance',0))");await client.query('DROP SCHEMA '+schema+' CASCADE');await client.query('DROP SCHEMA IF EXISTS '+database.identitySchema+' CASCADE');await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();await admin.end();}});
 await database.ready();await database.transaction(async client=>{await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:application:schema',0))");await prepareOnlineAdmissionSchemaIn(client);});
 await authority.prepare({receiptHash:p.preparationReceiptHash});await authority.activate({receiptHash:p.enrollmentReceiptHash,verify:async b=>({...b,receiptHash:p.enrollmentReceiptHash})});await authority.prepareFinalization();
 for(const sourceId of ['one','two']){const journal=createOnlineJournal({database,epoch:p.epoch,sourceId});await journal.prepareSchema();await journal.registerSource({bindingHash:'5'.repeat(64),enrollmentReceiptHash:'6'.repeat(64)});}
 return {database,authority,p};
}
// Atomic terminal-state contract fixtures only. Hash inputs below deliberately
// do not claim a completed source backfill, typed parity or production upgrade.
async function finalTransaction(f,run,{epochGate=true}={}){
 return f.authority.withFinalization(f.p,async client=>{
  const gate=JSON.stringify(['online-migration',f.database.namespace,f.p.epoch]);
  if(epochGate)assert.equal((await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held',[gate])).rows[0].held,true);
  try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');try{return await run(client);}finally{await client.query('ROLLBACK');}}
  finally{if(epochGate)assert.equal((await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0)) AS held',[gate])).rows[0].held,true);}
 });
}
test('actual PG terminal write requires both exclusive gates and the original read-write snapshot',{skip:!pg},async t=>{
 const f=await fixture(t);
 await assert.rejects(f.database.transaction(async client=>{await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');const snapshot=await readOnlineAdmissionSnapshotIn(client);await writeOnlineApplicationAdmissionIn(client,{proof:f.p,snapshot});}),/EXCLUSIVE_GATE_REQUIRED/);
 await assert.rejects(finalTransaction(f,async client=>writeOnlineApplicationAdmissionIn(client,{proof:f.p,snapshot:await readOnlineAdmissionSnapshotIn(client)}),{epochGate:false}),/EXCLUSIVE_GATE_REQUIRED/);
 await finalTransaction(f,async client=>{const snapshot=await readOnlineAdmissionSnapshotIn(client);await client.query('COMMIT');await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await assert.rejects(writeOnlineApplicationAdmissionIn(client,{proof:f.p,snapshot}),/SNAPSHOT_CHANGED/);});
 await assert.rejects(finalTransaction(f,async client=>writeOnlineApplicationAdmissionIn(client,{proof:{...f.p,sourceCount:3},snapshot:await readOnlineAdmissionSnapshotIn(client)})),/FRONTIER_NOT_CLOSED/);
 assert.equal((await f.authority.status()).mode,'journal');await assert.rejects(readApplicationAdmission(f.database),/incomplete/);
});
test('actual PG terminal rows and writer modes roll back together before commit',{skip:!pg},async t=>{
 const f=await fixture(t);
 await assert.rejects(finalTransaction(f,async client=>{
  const result=await writeOnlineApplicationAdmissionIn(client,{proof:f.p,snapshot:await readOnlineAdmissionSnapshotIn(client)});assert.equal(result.committed,false);
  assert.equal((await readApplicationAdmission({...f.database,pool:client})).receiptHash,onlineApplicationAdmissionHash(f.p));
  await assert.rejects(readApplicationAdmission(f.database),/incomplete/);throw Error('abort after terminal writes');
 }),/abort after terminal writes/);
 assert.deepEqual(await reconcileOnlineApplicationAdmission(f.authority,f.p),{status:'not-admitted',authority:'journal'});
 assert.equal((await f.database.pool.query('SELECT count(*)::int AS n FROM opencrawl_online_application_admissions')).rows[0].n,0);
 assert.equal((await f.authority.status()).mode,'journal');
});
test('actual PG lost commit reply reconciles exact terminal receipt and never reopens journal authority',{skip:!pg},async t=>{
 const f=await fixture(t);
 await assert.rejects(finalTransaction(f,async client=>{
  await writeOnlineApplicationAdmissionIn(client,{proof:f.p,snapshot:await readOnlineAdmissionSnapshotIn(client)});
  await client.query('COMMIT');throw Error('simulated lost commit acknowledgement');
 }),/lost commit acknowledgement/);
 const recovered=await reconcileOnlineApplicationAdmission(f.authority,f.p);assert.equal(recovered.status,'committed');assert.equal(recovered.receiptHash,onlineApplicationAdmissionHash(f.p));
 assert.equal((await f.authority.status()).mode,'target');
 await assert.rejects(f.authority.run({sourceId:'one',key:'state/key'},{legacy:async()=>assert.fail('legacy dispatch'),journal:async()=>assert.fail('journal dispatch')}),/TARGET_ADMITTED/);
 await assert.rejects(reconcileOnlineApplicationAdmission(f.authority,{...f.p,attemptId:randomUUID()}),/DIFFERENT_ADMISSION/);
 await assert.rejects(finalTransaction(f,async()=>assert.fail('another admission')),/TARGET_ADMITTED/);
});
test('actual PG recovery refuses a potentially in-flight final transaction',{skip:!pg},async t=>{
 const f=await fixture(t);
 await finalTransaction(f,async()=>{await assert.rejects(reconcileOnlineApplicationAdmission(f.authority,f.p),/BUSY/);});
 assert.equal((await reconcileOnlineApplicationAdmission(f.authority,f.p)).status,'not-admitted');
});
