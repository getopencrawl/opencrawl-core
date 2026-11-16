import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createOnlineJournal} from '../dist/src/state/online-journal.mjs';
const url=process.env.OPENCRAWL_TEST_POSTGRES_URL,live=(name,run)=>test(name,{skip:!url},run);
const empty=()=>({version:null,operationId:null,revision:null,deleted:true,bytes:null,contentType:null});
function store(){const values=new Map();return {values,read:async key=>values.get(key)??empty(),putIfVersion:async(key,version,m)=>{if((values.get(key)?.version??null)!==version)return false;values.set(key,{version:'etag-'+m.operationId,operationId:m.operationId,revision:m.revision,deleted:false,bytes:Buffer.from(m.bytes),contentType:m.contentType});return true;},deleteIfVersion:async(key,version,m)=>{if((values.get(key)?.version??null)!==version)return false;values.set(key,{version:'tombstone-'+m.operationId,operationId:m.operationId,revision:m.revision,deleted:true,bytes:null,contentType:null});return true;}};}
const put=(key,value='value',more={})=>({operationId:randomUUID(),key,mutation:{kind:'put',bytes:Buffer.from(value),contentType:'text/plain'},...more});
async function fixture(t){
 const admin=new Pool({connectionString:url,max:2}),schema='oc_shadow_'+randomUUID().replaceAll('-','');await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:url,max:8,options:'-c search_path='+schema}),database={pool,namespace:'online-'+randomUUID()},epoch=randomUUID(),sourceId='test-source';
 t.after(async()=>{await pool.end();const c=await admin.connect();try{await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:identity-schema:maintenance',0))");await c.query('DROP SCHEMA '+schema+' CASCADE');await c.query('COMMIT');}finally{c.release();await admin.end();}});
 const j=createOnlineJournal({database,epoch,sourceId});await j.ready();await pool.query('CREATE TABLE projection(key text PRIMARY KEY,value bytea,deleted boolean NOT NULL,revision bigint NOT NULL)');
 const apply=async(c,i)=>{await c.query('INSERT INTO projection(key,value,deleted,revision) VALUES($1,$2,$3,$4) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,deleted=EXCLUDED.deleted,revision=EXCLUDED.revision',[i.key,i.mutation.kind==='put'?i.mutation.bytes:null,i.mutation.kind==='delete',i.revision]);};
 return {admin,pool,database,epoch,sourceId,j,apply,store:store()};
}
live('intent is durable and session epoch/key locks remain held across external IO; uncertain key blocks successors',async t=>{
 const f=await fixture(t),request=put('k'),original=f.store.putIfVersion;
 f.store.putIfVersion=async(...args)=>{
  const row=(await f.pool.query('SELECT state,dispatched FROM opencrawl_online_migration_journal WHERE operation_id=$1',[request.operationId])).rows[0];assert.deepEqual(row,{state:'pending',dispatched:true});
  for(const key of [JSON.stringify(['online-migration',f.database.namespace,f.epoch]),JSON.stringify([f.database.namespace,f.epoch,f.sourceId,'k'])]){
   const c=await f.pool.connect();try{const acquired=(await c.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[key])).rows[0].acquired;if(acquired)await c.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);assert.equal(acquired,false);}finally{c.release();}
  }
  throw Error('unconfirmed network result');
 };
 await assert.rejects(f.j.mutate(request,f.store),{code:'ONLINE_MIGRATION_EXTERNAL_OUTCOME_UNCERTAIN'});
 await assert.rejects(f.j.mutate(put('k','later'),f.store),{code:'ONLINE_MIGRATION_UNRESOLVED_INTENT'});
 f.store.putIfVersion=original;assert.equal((await f.j.reconcile('k',f.store)).state,'applied');assert.equal((await f.j.mutate(request,f.store)).revision,'1');
 await assert.rejects(f.j.mutate({...request,mutation:{...request.mutation,bytes:Buffer.from('changed')}},f.store),{code:'ONLINE_MIGRATION_OPERATION_ID_REUSED'});
 assert.equal((await f.j.mutate(put('k','next'),f.store)).revision,'2');
});
live('pending hole closes only through reconciliation; replay effects and checkpoint rollback together',async t=>{
 const f=await fixture(t),a=put('a'),original=f.store.putIfVersion;f.store.putIfVersion=async()=>{throw Error('lost request');};await assert.rejects(f.j.mutate(a,f.store));f.store.putIfVersion=original;
 await f.j.mutate(put('b'),f.store);assert.equal(await f.j.closedFrontier(),'0');
 const waiting=await f.j.replayPage({consumer:'projection',apply:f.apply});assert.equal(waiting.checkpoint,'0');assert.equal(waiting.pending,true);assert.equal(waiting.applied,0);
 await assert.rejects(f.j.replayPage({consumer:'projection',through:'2',apply:f.apply}),{code:'ONLINE_MIGRATION_FRONTIER_NOT_CLOSED'});
 await f.j.reconcile('a',f.store);assert.equal(await f.j.closedFrontier(),'2');
 await assert.rejects(f.j.replayPage({consumer:'projection',through:'2',apply:async(c,i)=>{await f.apply(c,i);if(i.sequence==='2')throw Error('fault after effects');}}),/fault after effects/);
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM projection')).rows[0].n,0);assert.equal((await f.pool.query("SELECT sequence FROM opencrawl_online_migration_checkpoints WHERE consumer='projection'")).rows[0]?.sequence??'0','0');
 const first=await f.j.replayPage({consumer:'projection',through:'2',limit:1,apply:f.apply});assert.equal(first.checkpoint,'1');assert.equal(first.caughtUp,false);
 const second=await f.j.replayPage({consumer:'projection',through:'2',limit:1,apply:f.apply});assert.equal(second.checkpoint,'2');assert.equal(second.caughtUp,true);
 assert.equal((await f.j.replayPage({consumer:'projection',through:'2',apply:()=>assert.fail('Already applied')})).applied,0);
});
live('logical absence includes tombstones, revisions never repeat, and backfill cannot resurrect deletion',async t=>{
 const f=await fixture(t);await f.j.mutate(put('a'),f.store);const deleted=await f.j.mutate({operationId:randomUUID(),key:'a',mutation:{kind:'delete'}},f.store);assert.equal(deleted.revision,'2');assert.notEqual(deleted.resultVersion,null);
 assert.deepEqual(await f.j.backfillIfUnchanged({key:'a',apply:()=>assert.fail('No stale backfill')}),{applied:false});await f.j.replayPage({consumer:'p',apply:f.apply});assert.equal((await f.pool.query("SELECT deleted FROM projection WHERE key='a'")).rows[0].deleted,true);
 const recreated=await f.j.mutate(put('a','new',{condition:{version:null}}),f.store);assert.equal(recreated.expectedVersion,deleted.resultVersion);assert.equal(recreated.revision,'3');assert.equal(recreated.state,'applied');
 const rejected=await f.j.mutate(put('a','bad',{condition:{version:null}}),f.store);assert.equal(rejected.state,'notApplied');assert.equal(rejected.revision,'4');
 await f.j.replayPage({consumer:'p',apply:f.apply});assert.equal((await f.pool.query("SELECT convert_from(value,'UTF8') AS v,revision FROM projection WHERE key='a'")).rows[0].v,'new');
});
live('backfill callback includes the source read under key gate; commit precedes concurrent mutation and later replay',async t=>{
 const f=await fixture(t);f.store.values.set('old',{version:'legacy',operationId:null,revision:null,deleted:false,bytes:Buffer.from('old'),contentType:'text/plain'});
 const result=await f.j.backfillIfUnchanged({key:'old',apply:async c=>{const value=await f.store.read('old',{maxBytes:1024});const peer=await f.pool.connect();try{const lock=JSON.stringify([f.database.namespace,f.epoch,f.sourceId,'old']);assert.equal((await peer.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[lock])).rows[0].acquired,false);}finally{peer.release();}await c.query('INSERT INTO projection VALUES($1,$2,false,0)',['old',value.bytes]);}});assert.equal(result.applied,true);
 await f.j.mutate(put('old','new'),f.store);await f.j.replayPage({consumer:'p',apply:f.apply});assert.equal((await f.pool.query("SELECT convert_from(value,'UTF8') AS v FROM projection WHERE key='old'")).rows[0].v,'new');
 const mismatch=await f.j.mutate(put('untouched','attempt',{condition:{version:'not-current'}}),f.store);assert.equal(mismatch.state,'notApplied');assert.equal((await f.j.backfillIfUnchanged({key:'untouched',apply:async()=>{}})).applied,true,'Definitively unapplied attempts cannot hide baseline data');
});
live('fence drains every source in an epoch and prevents later admission; namespace separation remains exact',async t=>{
 const f=await fixture(t),other=createOnlineJournal({database:f.database,epoch:f.epoch,sourceId:'other'});await other.ready();const os=store(),write=os.putIfVersion;os.putIfVersion=async()=>{throw Error('timeout');};await assert.rejects(other.mutate(put('same'),os));
 await assert.rejects(f.j.fence(),{code:'ONLINE_MIGRATION_EPOCH_HAS_PENDING_INTENTS'});os.putIfVersion=write;await other.reconcile('same',os);assert.equal((await f.j.fence()).fenced,true);
 await assert.rejects(other.mutate(put('another'),os),{code:'ONLINE_MIGRATION_EPOCH_NOT_ACTIVE'});await assert.rejects(f.j.backfillIfUnchanged({key:'baseline',apply:async()=>{}}),{code:'ONLINE_MIGRATION_EPOCH_NOT_ACTIVE'});
 const isolated=createOnlineJournal({database:{...f.database,namespace:f.database.namespace+'-b'},epoch:f.epoch,sourceId:'other'});await isolated.ready();assert.equal((await isolated.mutate(put('same','separate'),store())).sequence,'1');assert.equal(await isolated.closedFrontier(),'1');
});
live('journal corruption cannot move a projection checkpoint across a missing sequence',async t=>{
 const f=await fixture(t);for(const key of ['a','b','c'])await f.j.mutate(put(key),f.store);await f.pool.query('DELETE FROM opencrawl_online_migration_journal WHERE sequence=2');
 await assert.rejects(f.j.replayPage({consumer:'p',through:'3',apply:f.apply}),{code:'ONLINE_MIGRATION_JOURNAL_SEQUENCE_HOLE'});assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM projection')).rows[0].n,0);
});
live('parity inspection holds the key gate and reports newer or unresolved source changes instead of success',async t=>{
 const f=await fixture(t);await f.j.mutate(put('a'),f.store);assert.deepEqual(await f.j.frontierState(),{allocated:'1',closed:'1',pending:false});
 const seen=await f.j.observeKey({key:'a',through:'1',read:async()=>{
  const c=await f.pool.connect();try{const lock=JSON.stringify([f.database.namespace,f.epoch,f.sourceId,'a']);assert.equal((await c.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[lock])).rows[0].acquired,false);}finally{c.release();}return 'verified-at-one';
 }});assert.deepEqual(seen,{observed:true,value:'verified-at-one'});
 await f.j.mutate(put('a','two'),f.store);assert.deepEqual(await f.j.observeKey({key:'a',through:'1',read:()=>assert.fail('Newer state is drift')}),{observed:false,reason:'newer-mutation'});
 f.store.putIfVersion=async()=>{throw Error('uncertain');};await assert.rejects(f.j.mutate(put('b'),f.store));assert.deepEqual(await f.j.frontierState(),{allocated:'3',closed:'2',pending:true});
 assert.deepEqual(await f.j.observeKey({key:'b',through:'2',read:()=>assert.fail('Pending state is drift')}),{observed:false,reason:'pending'});
});

live('pending metadata pages are bounded and cannot move or fabricate a replay checkpoint',async t=>{
 const f=await fixture(t);assert.ok(Object.isFrozen(f.j.binding));assert.deepEqual(f.j.binding,{namespace:f.database.namespace,epoch:f.epoch,sourceId:f.sourceId});
 f.store.putIfVersion=async()=>{throw Error('unknown result');};for(const key of ['a','b','c'])await assert.rejects(f.j.mutate(put(key),f.store));
 const first=await f.j.pendingPage({limit:2});assert.deepEqual(first.entries.map(x=>x.sequence),['1','2']);assert.equal(first.next,'2');assert.deepEqual(Object.keys(first.entries[0]).sort(),['key','operationId','sequence']);
 const second=await f.j.pendingPage({after:first.next,limit:2});assert.deepEqual(second.entries.map(x=>x.sequence),['3']);assert.equal(second.next,null);
 assert.equal(await f.j.closedFrontier(),'0');assert.equal(await f.j.replayCheckpoint('missing'),null);await assert.rejects(f.j.pendingPage({limit:65}));
});
live('historical payload above sixteen MiB remains valid within the sixty-four MiB journal format',async t=>{
 const f=await fixture(t),bytes=Buffer.alloc(16*1024*1024+1,42);await f.j.mutate({operationId:randomUUID(),key:'large',mutation:{kind:'put',bytes,contentType:'application/octet-stream'}},f.store);
 let size=0;const result=await f.j.replayPage({consumer:'bounded',apply:async(_c,intent)=>{size=intent.mutation.bytes.length;}});assert.equal(size,bytes.length);assert.equal(result.checkpoint,'1');assert.equal(await f.j.replayCheckpoint('bounded'),'1');
});
