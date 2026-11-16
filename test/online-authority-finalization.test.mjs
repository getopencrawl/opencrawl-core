import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createOnlineWriteAuthority} from '../dist/src/state/online-authority.mjs';
const url=process.env.OPENCRAWL_TEST_POSTGRES_URL,preparation='a'.repeat(64),enrollment='b'.repeat(64),target='c'.repeat(64),context={sourceId:'fixture',key:'state/key'};
const expected={preparationReceiptHash:preparation,enrollmentReceiptHash:enrollment};
function deferred(){let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve:()=>resolve()};}
async function fixture(t){
 const admin=new Pool({connectionString:url,max:1}),schema='authority_final_'+randomUUID().replaceAll('-','');await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:url,max:4,options:'-c search_path='+schema}),database={pool,namespace:'final-authority-'+randomUUID()},epoch=randomUUID(),protocol='final-fixture-v1',authority=createOnlineWriteAuthority({database,epoch,protocol});
 t.after(async()=>{await pool.end();try{await admin.query('DROP SCHEMA '+schema+' CASCADE');}finally{await admin.end();}});
 await authority.prepare({receiptHash:preparation});return {database,pool,epoch,protocol,authority,activate:()=>authority.activate({receiptHash:enrollment,verify:async b=>({...b,receiptHash:enrollment})})};
}
test('actual PG explicit terminal schema preparation preserves current writer authority',{skip:!url,timeout:15000},async t=>{
 const f=await fixture(t),before=(await f.pool.query('SELECT ctid::text,* FROM opencrawl_online_write_authorities')).rows[0];
 await f.authority.prepareFinalization();await f.authority.prepareFinalization();const after=(await f.pool.query('SELECT ctid::text,* FROM opencrawl_online_write_authorities')).rows[0];for(const key of Object.keys(before))assert.deepEqual(after[key],before[key]);assert.equal(after.target_receipt_hash,null);
 await assert.rejects(f.authority.withFinalization(expected,()=>assert.fail('legacy cannot finalize')),{code:'ONLINE_AUTHORITY_NOT_ACTIVATED'});await f.activate();
 await assert.rejects(f.authority.withFinalization({...expected,enrollmentReceiptHash:'d'.repeat(64)},()=>assert.fail('wrong enrollment')),{code:'ONLINE_AUTHORITY_FINALIZATION_BINDING'});
 assert.equal(await f.authority.withFinalization(expected,async(_client,alive)=>{alive();return 'gate only';}),'gate only');assert.equal((await f.authority.status()).mode,'journal');
 await f.pool.query('ALTER TABLE opencrawl_online_write_authorities DROP CONSTRAINT opencrawl_online_write_authorities_check, ADD CONSTRAINT opencrawl_online_write_authorities_check CHECK(true)');
 await assert.rejects(f.authority.prepareFinalization(),{code:'ONLINE_AUTHORITY_TARGET_SCHEMA'});assert.equal((await f.authority.status()).mode,'journal');
});
test('actual PG finalization never queues behind an accepted mutation and terminal mode refuses late callbacks',{skip:!url,timeout:15000},async t=>{
 const f=await fixture(t);await f.authority.prepareFinalization();await f.activate();const entered=deferred(),finish=deferred();t.after(()=>finish.resolve());
 const writing=f.authority.run(context,{legacy:()=>assert.fail('legacy'),journal:async()=>{entered.resolve();await finish.promise;return 'accepted';}});await entered.promise;
 await assert.rejects(f.authority.withFinalization(expected,()=>assert.fail('in-flight writer')),{code:'ONLINE_AUTHORITY_BUSY'});finish.resolve();assert.equal(await writing,'accepted');
 let late;
 await f.authority.withFinalization(expected,async(client,alive)=>{
  // Terminal-state fixture only: the separate sealer must prove parity and
  // atomically write its genuine admission before using this owner transition.
  await client.query('BEGIN');alive();late=f.authority.run({...context,key:'late'},{legacy:()=>assert.fail('terminal legacy'),journal:()=>assert.fail('terminal journal')});
  const rejected=assert.rejects(late,{code:'ONLINE_AUTHORITY_TARGET_ADMITTED'});late=rejected;
  await client.query("UPDATE opencrawl_online_write_authorities SET mode='target',target_receipt_hash=$2 WHERE namespace=$1 AND mode='journal'",[f.database.namespace,target]);await client.query('COMMIT');alive();
 });
 await late;const restarted=createOnlineWriteAuthority({database:f.database,epoch:f.epoch,protocol:f.protocol});
 assert.equal((await restarted.status()).targetReceiptHash,target);assert.equal((await restarted.prepare({receiptHash:preparation})).mode,'target');
 await assert.rejects(restarted.activate({receiptHash:enrollment,verify:()=>assert.fail('cannot reactivate')}),{code:'ONLINE_AUTHORITY_TARGET_ADMITTED'});
 await assert.rejects(restarted.withFinalization(expected,()=>assert.fail('cannot reseal through callback')),{code:'ONLINE_AUTHORITY_TARGET_ADMITTED'});
 await assert.rejects(restarted.run(context,{legacy:()=>assert.fail('legacy'),journal:()=>assert.fail('journal')}),{code:'ONLINE_AUTHORITY_TARGET_ADMITTED'});
});
