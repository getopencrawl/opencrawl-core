import {test} from 'node:test';
import assert from 'node:assert/strict';
import {migrateApplicationSources,migrationHash} from '../dist/src/state/migration-engine.mjs';
import {createObjectMigration} from '../dist/src/state/object-migration.mjs';
import {createPostgresIndexingReceipts} from '../dist/src/state/indexing-receipts.mjs';
import {createSchedulerRetirements} from '../dist/src/state/scheduler-retirements.mjs';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';

const live=(name,fn)=>test(name,{skip:!postgresUrl},fn),prefix='sessions/self-hosted/v1',organizationId='org_batchfixture';
const source={version:1,bucket:'receipt-fixture',prefix,organizationId};
const date='2026-11-15T01:00:00.000Z',hash=migrationHash;
function indexed(index,tenant=organizationId){
 const sourceKey=prefix+'/tenants/'+hash(tenant)+'/users/'+hash('user_one')+'/codex/'+hash('install')+'/'+hash('session-'+index)+'/'+hash('batch-'+index)+'.json.gz';
 const key=prefix+'/_index/'+hash('search')+'/'+hash('job')+'/batches/'+hash(sourceKey)+'.json';
 return {key,value:{status:'indexed',sourceKey,documents:index,indexedAt:date,...(index%7===0?{deleted:true}:{})}};
}
function queryBudget(database){
 const texts=[];const originalQuery=database.pool.query,originalConnect=database.pool.connect;
 database.pool.query=function(...args){texts.push(typeof args[0]==='string'?args[0]:args[0].text);return originalQuery.apply(this,args);};
 database.pool.connect=function(callback){if(callback)return originalConnect.call(this,callback);return originalConnect.call(this).then(client=>{const query=client.query,release=client.release;
  client.query=function(...args){texts.push(typeof args[0]==='string'?args[0]:args[0].text);return query.apply(this,args);};
  client.release=function(...args){client.query=query;client.release=release;return release.apply(this,args);};return client;});};
 return {texts,clear:()=>{texts.length=0;},restore(){database.pool.query=originalQuery;database.pool.connect=originalConnect;}};
}
async function fixture(t,{count=205,serial=false}={}){
 const database=await applicationDatabaseFixture(t),bodies=new Map(),definitions=Array.from({length:count},(_,index)=>indexed(index));
 for(const item of definitions)bodies.set(item.key,Buffer.from(JSON.stringify(item.value)));
 let rawReads=0;const store={bucket:source.bucket,get:async()=>{rawReads++;return Buffer.from('retained raw source');}},eventIdentities={};
 const importer=createObjectMigration({database,store,prefix,organizationId,eventIdentities,registryRecords:[]});
 let inventory=0,reads=0,failAfter=Infinity,reverse=false,finalDrift=false,finalDuplicate=false,conflictAtRead=false,receiptConflict=false;
 const descriptor=(key,body)=>({key,domain:'session-indexing',version:'v1',hash:hash(body),bytes:body.length});
 async function operation(key){
  const bytes=bodies.get(key);assert.ok(bytes);const entry=descriptor(key,bytes);
  if(!serial){const sessionReceipt=importer.sessionReceipt(key,bytes);if(sessionReceipt)return {entry,sessionReceipt};}
  return {entry,readback:await importer.process(key,bytes,{write:false}),migrate:()=>importer.process(key,bytes,{write:true})};
 }
 const options={database,source,writersStopped:true,expectExisting:true,checkAccess:async()=>{},sources:async()=>({
  async *inventory(){
   inventory++;const keys=[...bodies.keys()].sort();
   for(const key of keys){yield {retainedKey:key,legacy:true};const op=await operation(key);
    if(finalDrift&&inventory>1&&key===keys.at(-1))op.entry={...op.entry,version:'changed-version'};
    yield {...op,legacy:true,mutableObject:true};
    if(finalDuplicate&&inventory>1&&key===keys.at(-1))yield {...op,legacy:true,mutableObject:true};
   }
  },
  async validateInventory(){},
  async read(entry){reads++;if(reads>failAfter)throw Error('Injected batch-boundary interruption');return operation(entry.key);},
  async readMany(entries){
   if(conflictAtRead){conflictAtRead=false;const key=entries[0].key;await createPostgresIndexingReceipts(database).put(key,{...JSON.parse(bodies.get(key)),documents:999999});}
   if(receiptConflict){receiptConflict=false;const entry=entries[0];await database.pool.query('INSERT INTO opencrawl_application_migrations(namespace,domain,source_key,source_version,source_hash,target_hash,imported_rows) VALUES($1,$2,$3,$4,$5,$6,1)',[database.namespace,entry.domain,entry.key,entry.version,hash('wrong original bytes'),hash('wrong target')]);}
   const operations=[];for(const entry of entries){reads++;if(reads>failAfter)throw Error('Injected batch-boundary interruption');operations.push(await operation(entry.key));}
   return reverse?operations.reverse():operations;
  },
  async finalize(){return {fixture:true};},
 })};
 return {database,bodies,definitions,importer,options,rawReads:()=>rawReads,run:(mode='migrate',extra={})=>migrateApplicationSources({...options,mode,...extra}),
  interruptAfter(value){failAfter=value;},resume(){failAfter=Infinity;reads=0;inventory=0;},reverse(){reverse=true;},drift(){finalDrift=true;},duplicate(){finalDuplicate=true;},conflictAtRead(){conflictAtRead=true;},receiptConflict(){receiptConflict=true;},resetInventories(){inventory=0;}};
}

live('receipt batches preserve the serial manifest and exact targets while reducing actual PostgreSQL statements',async t=>{
 const serial=await fixture(t,{serial:true}),batched=await fixture(t),oldBudget=queryBudget(serial.database),newBudget=queryBudget(batched.database);
 t.after(()=>{oldBudget.restore();newBudget.restore();});
 const before=await serial.run(),after=await batched.run();assert.equal(after.manifest,before.manifest);assert.equal(after.sources,205);assert.equal(after.ready,true);
 const select=database=>database.pool.query('SELECT receipt_key,payload FROM opencrawl_indexing_receipts WHERE namespace=$1 ORDER BY receipt_key',[database.namespace]);
 assert.deepEqual((await select(batched.database)).rows,(await select(serial.database)).rows);
 assert.ok(newBudget.texts.length<oldBudget.texts.length/5,JSON.stringify({serial:oldBudget.texts.length,batched:newBudget.texts.length}));
 t.diagnostic(JSON.stringify({receipts:205,serialStatements:oldBudget.texts.length,batchedStatements:newBudget.texts.length}));
 assert.equal(newBudget.texts.filter(sql=>sql.startsWith('INSERT INTO opencrawl_indexing_receipts')).length,3,'100+100+5 target batches');
 assert.equal(newBudget.texts.filter(sql=>sql.startsWith('INSERT INTO opencrawl_application_migrations')).length,3,'One per-source bookkeeping batch per target transaction');
 const rows=(await batched.database.pool.query('SELECT source_key,source_hash,target_hash,imported_rows FROM opencrawl_application_migrations WHERE namespace=$1',[batched.database.namespace])).rows;
 assert.equal(rows.length,205);for(const row of rows){assert.equal(row.source_hash,hash(batched.bodies.get(row.source_key)));assert.equal(Number(row.imported_rows),1);assert.match(row.target_hash,/^[a-f0-9]{64}$/);}
});

live('failed session receipts remain serial retirements with original raw-source evidence',async t=>{
 const f=await fixture(t,{count:3}),item=f.definitions[1],failed={status:'failed',sourceKey:item.value.sourceKey,attempts:4,lastAttempt:date,nextAttempt:123456,error:'INDEXING_FAILED'};
 f.bodies.set(item.key,Buffer.from(JSON.stringify(failed)));assert.equal(f.importer.sessionReceipt(item.key,f.bodies.get(item.key)),null);
 await f.run();assert.equal(await createPostgresIndexingReceipts(f.database).read(item.key),null);
 assert.deepEqual(await createSchedulerRetirements(f.database).exportRetirement(item.key),{kind:'failed',sourceKey:failed.sourceKey,attempts:4,lastAttempt:date,nextAttempt:123456,error:'INDEXING_FAILED',disposition:'full-temporal-catchup',generation:'postgres-app-state-v1'});
 assert.equal(f.rawReads(),4,'Initial read, operation read, serial import and final read each revalidate the original source');
});

live('completed receipt batches retain exact migration identity and resume after a later batch read fails',async t=>{
 const f=await fixture(t);f.interruptAfter(100);await assert.rejects(f.run(),/batch-boundary interruption/);
 const state=(await f.database.pool.query('SELECT migration_id,state,inventory_complete,source_manifest_hash FROM opencrawl_application_installations WHERE namespace=$1',[f.database.namespace])).rows[0];
 assert.equal(state.state,'importing');assert.equal(state.inventory_complete,true);
 const receiptRows=async()=> (await f.database.pool.query('SELECT * FROM opencrawl_application_migrations WHERE namespace=$1 ORDER BY source_key',[f.database.namespace])).rows;
 const partial=await receiptRows();assert.equal(partial.length,100);
 assert.equal((await f.database.pool.query('SELECT count(*)::int n FROM opencrawl_indexing_receipts WHERE namespace=$1',[f.database.namespace])).rows[0].n,100);
 f.resume();const result=await f.run();assert.equal(result.migrationId,state.migration_id);assert.equal(result.manifest,state.source_manifest_hash);assert.equal(result.ready,true);
 assert.deepEqual((await receiptRows()).slice(0,100),partial,'Retry preserves every previously committed receipt');
});

live('a target conflict in a receipt batch rolls back every new target and migration receipt in that batch',async t=>{
 const f=await fixture(t,{count:3}),receipts=createPostgresIndexingReceipts(f.database);await receipts.ready();f.conflictAtRead();
 await assert.rejects(f.run(),/indexing receipt differs/);
 assert.equal((await f.database.pool.query('SELECT count(*)::int n FROM opencrawl_indexing_receipts WHERE namespace=$1',[f.database.namespace])).rows[0].n,1,'Only deliberately conflicting preexisting target remains');
 assert.equal((await f.database.pool.query('SELECT count(*)::int n FROM opencrawl_application_migrations WHERE namespace=$1',[f.database.namespace])).rows[0].n,0);
 assert.equal((await f.database.pool.query('SELECT state FROM opencrawl_application_installations WHERE namespace=$1',[f.database.namespace])).rows[0].state,'importing');
});

live('conflicting per-source migration evidence rolls back all newly inserted batch targets',async t=>{
 const f=await fixture(t,{count:3});f.receiptConflict();await assert.rejects(f.run(),/Migration receipt conflicts/);
 assert.equal((await f.database.pool.query('SELECT count(*)::int n FROM opencrawl_indexing_receipts WHERE namespace=$1',[f.database.namespace])).rows[0].n,0,'Target insert is in the same rolled-back transaction as migration evidence');
 const rows=(await f.database.pool.query('SELECT source_hash FROM opencrawl_application_migrations WHERE namespace=$1',[f.database.namespace])).rows;
 assert.deepEqual(rows,[{source_hash:hash('wrong original bytes')}],'Original contradictory evidence is retained, never overwritten');
});

live('receipt batches reject reordered reads, final source drift, duplicate entries and foreign owner payloads',async t=>{
 const reordered=await fixture(t,{count:3});reordered.reverse();await assert.rejects(reordered.run(),/Source changed after inventory/);
 assert.equal((await reordered.database.pool.query('SELECT count(*)::int n FROM opencrawl_application_migrations WHERE namespace=$1',[reordered.database.namespace])).rows[0].n,0);
 const changed=await fixture(t,{count:3});changed.drift();await assert.rejects(changed.run(),/source changed during verification/i);
 const duplicate=await fixture(t,{count:3});duplicate.duplicate();await assert.rejects(duplicate.run(),/Invalid session receipt migration batch|listed twice/);
 const foreign=await fixture(t,{count:0}),item=indexed(1,'org_foreign');foreign.bodies.set(item.key,Buffer.from(JSON.stringify(item.value)));await assert.rejects(foreign.run(),/owner hash differs/);
 assert.equal((await foreign.database.pool.query('SELECT count(*)::int n FROM opencrawl_application_installations WHERE namespace=$1',[foreign.database.namespace])).rows[0].n,0);
 const extra=await fixture(t,{count:1}),[key,bytes]=[...extra.bodies][0];extra.bodies.set(key,Buffer.from(JSON.stringify({...JSON.parse(bytes),unrecognized:true})));await assert.rejects(extra.run(),/Unrecognized key/);
});
