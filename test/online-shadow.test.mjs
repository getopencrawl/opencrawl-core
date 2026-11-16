import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createOnlineJournal,ONLINE_MAX_PAYLOAD_BYTES} from '../dist/src/state/online-journal.mjs';
import {createOnlineShadow} from '../dist/src/state/online-shadow.mjs';
import {createOnlineMigrationController} from '../dist/src/state/online-temporal/controller.mjs';
import {onlineMigrationReference} from '../dist/src/state/online-temporal/binding.mjs';
import {dropTestSchemas,postgresUrl} from './fixtures/application-database.mjs';
const live=(name,fn)=>test(name,{skip:!postgresUrl},fn),signal=()=>new AbortController().signal;
async function fixture(t,{shards=1,keys=['root/state/a','root/state/b']}={}){
 const schema='oc_shadow_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:postgresUrl,max:1});await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:postgresUrl,max:6,options:'-c search_path='+schema+' -c statement_timeout=5000 -c lock_timeout=3000'}),database={pool,namespace:schema};
 t.after(async()=>{await pool.end();try{await dropTestSchemas(admin,[schema]);}finally{await admin.end();}});
 const binding={epoch:randomUUID(),sourceId:'a'.repeat(64),targetId:'b'.repeat(64),shards},journal=createOnlineJournal({database,epoch:binding.epoch,sourceId:binding.sourceId});
 const objects=new Map(keys.map(key=>[key,{version:'legacy-'+key,operationId:null,revision:null,deleted:false,bytes:Buffer.from('old-'+key),contentType:'text/plain'}])),reads=[];let uncertain=false;
 const external={read:async key=>{reads.push(key);const x=objects.get(key);return x?{...x,bytes:x.bytes===null?null:Buffer.from(x.bytes)}:{version:null,operationId:null,revision:null,deleted:true,bytes:null,contentType:null};},putIfVersion:async(key,version,m)=>{if((objects.get(key)?.version??null)!==version)return false;objects.set(key,{version:m.operationId,operationId:m.operationId,revision:m.revision,deleted:false,bytes:Buffer.from(m.bytes),contentType:m.contentType});if(uncertain){uncertain=false;throw Error('response lost');}return true;},deleteIfVersion:async(key,version,m)=>{if((objects.get(key)?.version??null)!==version)return false;objects.set(key,{version:m.operationId,operationId:m.operationId,revision:m.revision,deleted:true,bytes:null,contentType:null});return true;}};
 const listing={listPage:async({prefix,cursor,limit})=>{const all=[...objects.keys()].filter(key=>key.startsWith(prefix)&&(!cursor||Buffer.compare(Buffer.from(key),Buffer.from(cursor))>0)).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))),page=all.slice(0,limit);return {keys:page,cursor:all.length>limit?page.at(-1):null};}};
 const config={database,binding,journal,external,listing,roots:['root/'],classify:key=>key.startsWith('root/state/')?{maxBytes:1024}:null,assertCurrent:async()=>{}};
 const shadow=createOnlineShadow(config);await shadow.ready();
 const mutate=(key,value)=>journal.mutate({operationId:randomUUID(),key,mutation:value===null?{kind:'delete'}:{kind:'put',bytes:Buffer.from(value),contentType:'text/plain'}},external);
 const rows=async()=> (await pool.query('SELECT source_key,logical_deleted,payload,revision::text,operation_id::text,source_sequence::text FROM opencrawl_online_shadow_objects ORDER BY source_key')).rows;
 return {database,binding,journal,objects,reads,external,listing,config,shadow,mutate,rows,uncertain:()=>{uncertain=true;}};
}
async function finish(controller,reference){for(let i=0;i<100;i++){const result=await controller.advance(reference,signal());if(result.parityObserved)return result;}assert.fail('bounded fixture never observed parity');}
live('actual PG shadow backfills two shards and replays global journal without importing raw objects',async t=>{
 const f=await fixture(t,{shards:2,keys:['root/state/a','root/state/b','root/state/c','root/raw/untouched']});await f.mutate('root/state/b','new-b');f.reads.length=0;
 const controller=createOnlineMigrationController({database:f.database,binding:f.binding,adapter:f.shadow.adapter,pageSize:2});
 for(let shard=0;shard<2;shard++)await finish(controller,onlineMigrationReference(f.binding,shard));
 const rows=await f.rows();assert.deepEqual(rows.map(row=>row.source_key),['root/state/a','root/state/b','root/state/c']);assert.equal(rows[1].payload.toString(),'new-b');assert.equal(rows[1].revision,'1');assert.equal(rows[0].revision,'0');assert.equal(f.reads.includes('root/raw/untouched'),false);
 assert.equal((await f.database.pool.query('SELECT count(*) FROM opencrawl_online_migration_checkpoints WHERE sequence=1')).rows[0].count,'2','every shard consumes the global contiguous journal');
 assert.equal((await f.database.pool.query("SELECT to_regclass('opencrawl_application_installations') AS relation")).rows[0].relation,null);
});
live('source READ occurs while the key gate is held; mutation history prevents a stale baseline overwrite',async t=>{
 const f=await fixture(t,{keys:['root/state/a']});const read=f.external.read;let inspected=false;
 f.external.read=async key=>{const locks=(await f.database.pool.query("SELECT mode FROM pg_locks WHERE locktype='advisory' AND granted AND pid<>pg_backend_pid()")).rows.map(row=>row.mode);assert.ok(locks.includes('ShareLock'));assert.ok(locks.includes('ExclusiveLock'));inspected=true;return read(key);};
 await f.shadow.backfill('root/state/a');assert.equal(inspected,true);f.external.read=read;
 const intent=await f.mutate('root/state/a','new');f.reads.length=0;assert.deepEqual(await f.shadow.backfill('root/state/a'),{applied:false});assert.equal(f.reads.length,0);
 await f.journal.replayPage({consumer:'test',apply:(client,x)=>f.shadow.applyJournal(client,x)});assert.equal((await f.rows())[0].payload.toString(),'new');assert.equal((await f.rows())[0].operation_id,intent.operationId);
});
live('journal apply and checkpoint commit atomically; duplicate, stale, conflicting and delete revisions are checked',async t=>{
 const f=await fixture(t,{keys:['root/state/a']});const first=await f.mutate('root/state/a','one');
 await assert.rejects(f.journal.replayPage({consumer:'atomic',apply:async(client,intent)=>{await f.shadow.applyJournal(client,intent);throw Error('after target before checkpoint');}}),/after target/);assert.equal((await f.rows()).length,0);
 await f.journal.replayPage({consumer:'atomic',apply:(client,intent)=>f.shadow.applyJournal(client,intent)});const client=await f.database.pool.connect();
 try{await client.query('BEGIN');assert.equal(await f.shadow.applyJournal(client,first),true);await client.query('COMMIT');
  await assert.rejects(f.shadow.applyJournal(client,{...first,mutation:{kind:'put',bytes:Buffer.from('conflict'),contentType:'text/plain'}}),{code:'ONLINE_MIGRATION_UNSAFE'});
  await assert.rejects(f.shadow.applyJournal(client,{...first,namespace:'foreign'}),{code:'ONLINE_MIGRATION_UNSAFE'});
 }finally{client.release();}
 await f.mutate('root/state/a',null);await f.journal.replayPage({consumer:'atomic',apply:(c,x)=>f.shadow.applyJournal(c,x)});
 const c=await f.database.pool.connect();try{await assert.rejects(f.shadow.applyJournal(c,first),{code:'ONLINE_MIGRATION_UNSAFE'});}finally{c.release();}
 const row=(await f.rows())[0];assert.equal(row.logical_deleted,true);assert.equal(row.payload,null);assert.equal(row.revision,'2');assert.equal((await f.database.pool.query("SELECT sequence FROM opencrawl_online_migration_checkpoints WHERE consumer='atomic'")).rows[0].sequence,'2');
});
live('pending mutation never passes parity; reconciliation advances through monotonically and finishes only observed parity',async t=>{
 const f=await fixture(t,{keys:['root/state/a']}),controller=createOnlineMigrationController({database:f.database,binding:f.binding,adapter:f.shadow.adapter,pageSize:2}),ref=onlineMigrationReference(f.binding,0);
 await controller.advance(ref,signal());assert.equal((await controller.advance(ref,signal())).phase,'parity');
 f.uncertain();await assert.rejects(f.mutate('root/state/a','new'),{code:'ONLINE_MIGRATION_EXTERNAL_OUTCOME_UNCERTAIN'});
 assert.deepEqual(await f.journal.frontierState(),{allocated:'1',closed:'0',pending:true});const savedRead=f.external.read;f.external.read=async()=>{throw Object.assign(Error('still uncertain'),{code:'ONLINE_MIGRATION_UNRESOLVED_INTENT'});};const pending=await controller.advance(ref,signal());assert.equal(pending.waiting,true);assert.equal(pending.parityObserved,false);
 f.external.read=savedRead;const replay=await controller.advance(ref,signal());assert.equal(replay.phase,'replay');assert.equal(replay.parityObserved,false);
 await finish(controller,ref);assert.equal((await f.rows())[0].payload.toString(),'new');const row=(await f.database.pool.query('SELECT through_sequence::text,phase FROM opencrawl_online_migration_runs')).rows[0];assert.deepEqual(row,{through_sequence:'1',phase:'caught-up'});
});
live('untracked same-body version drift and missing listing keys cannot produce false parity',async t=>{
 for(const remove of [false,true]){
  const f=await fixture(t,{keys:['root/state/a']}),controller=createOnlineMigrationController({database:f.database,binding:f.binding,adapter:f.shadow.adapter,pageSize:2}),ref=onlineMigrationReference(f.binding,0);
  await controller.advance(ref,signal());await controller.advance(ref,signal());if(remove)f.objects.delete('root/state/a');else f.objects.get('root/state/a').version='untracked-rewrite';
  await assert.rejects(finish(controller,ref),{code:'ONLINE_MIGRATION_UNSAFE'});assert.equal((await f.database.pool.query('SELECT phase FROM opencrawl_online_migration_runs')).rows[0].phase,'parity');
 }
});
live('classification capacity is explicit and rejected before body reads; oversized pages and outside roots fail',async t=>{
 const f=await fixture(t,{keys:['root/state/a']});const shadow=createOnlineShadow({...f.config,classify:()=>({maxBytes:ONLINE_MAX_PAYLOAD_BYTES+1})});f.reads.length=0;
 await assert.rejects(shadow.backfill('root/state/a'),{code:'ONLINE_MIGRATION_UNSAFE'});assert.equal(f.reads.length,0);
 await assert.rejects(f.shadow.backfill('foreign/key'),{code:'ONLINE_MIGRATION_UNSAFE'});
 const bad=createOnlineShadow({...f.config,listing:{listPage:async()=>({keys:['root/state/a','root/state/b'],cursor:null})}});
 await assert.rejects(bad.adapter.backfillPage({shard:0,shards:1,cursor:null,limit:1,signal:signal()}),{code:'ONLINE_MIGRATION_UNSAFE'});
 await assert.rejects(f.shadow.adapter.backfillPage({shard:0,shards:1,cursor:'{"stage":"shadow","after":""}',limit:1,signal:signal()}),{code:'ONLINE_MIGRATION_UNSAFE'});
});

live('shadow composition rejects a foreign journal and parity requires its own durable replay checkpoint',async t=>{
 const f=await fixture(t,{keys:['root/state/a']});
 assert.throws(()=>createOnlineShadow({...f.config,journal:{...f.journal,binding:{...f.journal.binding,epoch:randomUUID()}}}),{code:'ONLINE_MIGRATION_UNSAFE'});
 await f.shadow.backfill('root/state/a');
 await assert.rejects(f.shadow.adapter.parityPage({shard:0,shards:1,cursor:null,through:'0',limit:2,signal:signal()}),{code:'ONLINE_MIGRATION_UNSAFE'});
 await assert.rejects(f.shadow.adapter.replayPage({consumer:'wrong',shard:0,shards:1,through:'0',limit:2,signal:signal()}),{code:'ONLINE_MIGRATION_UNSAFE'});
});

live('pending reconciliation is bounded, round-robin and only suppresses the two uncertain-outcome codes',async t=>{
 const f=await fixture(t,{keys:Array.from({length:9},(_,i)=>'root/state/'+i)});
 for(const key of f.objects.keys()){f.uncertain();await assert.rejects(f.mutate(key,'new'),{code:'ONLINE_MIGRATION_EXTERNAL_OUTCOME_UNCERTAIN'});}
 const read=f.external.read;f.external.read=async()=>{throw Object.assign(Error('uncertain'),{code:'ONLINE_MIGRATION_UNRESOLVED_INTENT'});};
 const first=await f.shadow.adapter.reconcilePending({cursor:null,limit:8,signal:signal()});assert.deepEqual(first,{cursor:'8',processed:8,pending:8,settled:0,budgetExhausted:false});
 const second=await f.shadow.adapter.reconcilePending({cursor:first.cursor,limit:8,signal:signal()});assert.deepEqual(second,{cursor:null,processed:1,pending:1,settled:0,budgetExhausted:false});
 f.external.read=async()=>{throw Object.assign(Error('wrong scope'),{code:'ONLINE_MIGRATION_INVALID_EXTERNAL_STATE'});};
 await assert.rejects(f.shadow.adapter.reconcilePending({cursor:null,limit:8,signal:signal()}),{code:'ONLINE_MIGRATION_INVALID_EXTERNAL_STATE'});
 f.external.read=read;let ticks=0;const clock=t.mock.method(performance,'now',()=>ticks++===0?0:31000);
 const bounded=await f.shadow.adapter.reconcilePending({cursor:null,limit:8,signal:signal()});clock.mock.restore();
 assert.deepEqual(bounded,{cursor:'1',processed:1,pending:0,settled:1,budgetExhausted:true});
 assert.equal((await f.journal.frontierState()).closed,'1');
});
