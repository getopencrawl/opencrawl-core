import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {setTimeout as delay} from 'node:timers/promises';
import {createOnlineMigrationController} from '../dist/src/state/online-temporal/controller.mjs';
import {onlineMigrationBindingId,onlineMigrationReference,onlineMigrationTaskQueue,onlineMigrationWorkflowId} from '../dist/src/state/online-temporal/binding.mjs';
import {startOnlineMigration} from '../dist/src/state/online-temporal/client.mjs';
import {createOnlineJournal} from '../dist/src/state/online-journal.mjs';
import {dropTestSchemas,postgresUrl} from './fixtures/application-database.mjs';
const binding=()=>({epoch:randomUUID(),sourceId:'a'.repeat(64),targetId:'b'.repeat(64),shards:1});
const signal=()=>new AbortController().signal;
const defaults=()=>({assertCurrent:async()=>{},reconcilePending:async()=>({cursor:null,processed:0,pending:0,settled:0,budgetExhausted:false}),frontierState:async()=>({allocated:'0',closed:'0',pending:false}),backfillPage:async()=>({cursor:null,processed:0}),closedFrontier:async()=>'0',replayPage:async({through})=>({checkpoint:through,processed:0,blocked:false}),parityPage:async()=>({cursor:null,processed:0,mismatches:0})});
const live=(name,fn)=>test(name,{skip:!postgresUrl},fn);
async function fixture(t){
 const schema='oc_shadow_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:postgresUrl,max:1});await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:postgresUrl,max:5,options:'-c search_path='+schema+' -c statement_timeout=5000 -c lock_timeout=2000'}),database={pool,namespace:schema};
 t.after(async()=>{await pool.end();try{await dropTestSchemas(admin,[schema]);}finally{await admin.end();}});return {database,schema};
}
test('binding, target, epoch and shard select isolated deterministic workflow/queue identities',async()=>{
 const b=binding(),reference=onlineMigrationReference(b,0),id=onlineMigrationWorkflowId(reference);assert.equal(id,onlineMigrationWorkflowId(onlineMigrationReference({...b},0)));
 for(const delta of [{epoch:randomUUID()},{sourceId:'c'.repeat(64)},{targetId:'d'.repeat(64)},{shards:2}])assert.notEqual(onlineMigrationBindingId({...b,...delta}),reference.bindingId);
 assert.notEqual(onlineMigrationWorkflowId(onlineMigrationReference({...b,shards:2},1)),id);
 assert.throws(()=>onlineMigrationReference(b,1));assert.throws(()=>onlineMigrationBindingId({...b,password:'secret'}));assert.throws(()=>onlineMigrationBindingId({...b,shards:0}));
 let args;await startOnlineMigration({workflow:{start:async(...v)=>{args=v;return {};}}},b,0);
 assert.equal(args[0],'migrateApplicationShadowV1');assert.equal(args[1].taskQueue,onlineMigrationTaskQueue(b));assert.deepEqual(args[1].args,[reference]);assert.equal(args[1].workflowIdConflictPolicy,'USE_EXISTING');
 assert.equal(JSON.stringify(args).includes('secret'),false);
});
test('canonical physical source IDs are accepted without changing legacy binding identities',()=>{
 const b=binding(),expected=createHash('sha256').update(JSON.stringify(['online-app-state-v1',b.epoch,b.sourceId,b.targetId,b.shards])).digest('hex');
 assert.equal(onlineMigrationBindingId(b),expected);
 for(const prefix of ['s3:','dynamodb:'])assert.notEqual(onlineMigrationBindingId({...b,sourceId:prefix+b.sourceId}),expected);
 for(const sourceId of ['s3:', 'S3:'+b.sourceId,'s3:'+b.sourceId.toUpperCase(),'dynamodb:'+b.sourceId+'x','https:'+b.sourceId,'s3:dynamodb:'+b.sourceId,'s3:'+b.sourceId+'\n'])assert.throws(()=>onlineMigrationBindingId({...b,sourceId}));
 assert.throws(()=>onlineMigrationBindingId({...b,targetId:'s3:'+b.targetId}));
});
live('durable source preparation survives lost replies and never resets an existing migration cursor',async t=>{
 const {database}=await fixture(t),b={...binding(),sourceId:'dynamodb:'+'a'.repeat(64)},ref=onlineMigrationReference(b,0),seen=[];let paused=false,recoveryCalls=0;
 await database.pool.query('CREATE TABLE physical_preparation(id boolean PRIMARY KEY,pages integer NOT NULL)');await database.pool.query('INSERT INTO physical_preparation VALUES(true,0)');
 const adapter={...defaults(),prepareSource:async()=>{
  if(paused)return {ready:false};const pages=(await database.pool.query('SELECT pages FROM physical_preparation WHERE id')).rows[0].pages;
  if(pages<2){await database.pool.query('UPDATE physical_preparation SET pages=pages+1 WHERE id');if(pages===0)throw Error('lost committed inventory response');return {ready:false};}
  return {ready:true};
 },reconcilePending:async input=>{recoveryCalls++;return defaults().reconcilePending(input);},backfillPage:async({cursor})=>{seen.push(cursor);return {cursor:cursor===null?'saved-cursor':null,processed:1};}};
 const make=()=>createOnlineMigrationController({database,binding:b,adapter}),row=async()=>(await database.pool.query('SELECT phase,cursor,revision::text FROM opencrawl_online_migration_runs WHERE binding_id=$1',[ref.bindingId])).rows[0];
 await assert.rejects(make().advance(ref,signal()),/lost committed inventory/);assert.deepEqual(await row(),{phase:'backfill',cursor:null,revision:'0'});
 // A destroyed session can briefly retain its lock; wait only for that known
 // handoff, never reinterpret the physical preparation's waiting response.
 const retry=AbortSignal.timeout(5000);let waiting;
 do{waiting=await make().advance(ref,retry);if(waiting.phase==='waiting')await delay(10,undefined,{signal:retry});}while(waiting.phase==='waiting');
 assert.deepEqual(waiting,{phase:'backfill',revision:0,waiting:true,parityObserved:false});assert.deepEqual(seen,[]);assert.equal(recoveryCalls,0);
 assert.equal((await make().advance(ref,signal())).phase,'backfill');assert.deepEqual(await row(),{phase:'backfill',cursor:'saved-cursor',revision:'1'});
 paused=true;assert.equal((await make().advance(ref,signal())).waiting,true);assert.deepEqual(await row(),{phase:'backfill',cursor:'saved-cursor',revision:'1'});assert.equal(recoveryCalls,1);
 paused=false;assert.equal((await make().advance(ref,signal())).phase,'replay');assert.deepEqual(seen,[null,'saved-cursor']);assert.equal((await database.pool.query('SELECT pages FROM physical_preparation')).rows[0].pages,2);
});
live('invalid or cancelled source preparation cannot execute target work',async t=>{
 const {database}=await fixture(t);
 for(const prepared of [null,{}, {ready:1},{ready:true,cursor:'not-workflow-input'}]){
  const b=binding(),adapter={...defaults(),prepareSource:async()=>prepared,reconcilePending:async()=>assert.fail('no phase work')},controller=createOnlineMigrationController({database,binding:b,adapter});
  await assert.rejects(controller.advance(onlineMigrationReference(b,0),signal()),{code:'ONLINE_MIGRATION_UNSAFE'});
 }
 const b=binding(),cancelled=new AbortController(),controller=createOnlineMigrationController({database,binding:b,adapter:{...defaults(),prepareSource:async()=>{cancelled.abort();return {ready:true};},reconcilePending:async()=>assert.fail('no phase work')}});
 await assert.rejects(controller.advance(onlineMigrationReference(b,0),cancelled.signal));
 assert.equal((await database.pool.query('SELECT count(*)::int AS n FROM opencrawl_online_migration_runs WHERE revision<>0')).rows[0].n,0);
});
live('durable phases survive controller restart and observe parity only after bounded replay',async t=>{
 const {database}=await fixture(t),b=binding(),ref=onlineMigrationReference(b,0),seen=[];let replay=0;
 const adapter={...defaults(),backfillPage:async({cursor,limit})=>{seen.push(cursor);assert.equal(limit,2);return {cursor:cursor===null?'p1':null,processed:2};},closedFrontier:async()=>'3',replayPage:async({through})=>{assert.equal(through,'3');replay++;return {checkpoint:replay===1?'2':'3',processed:replay===1?2:1,blocked:false};},parityPage:async({cursor,through})=>{assert.equal(through,'3');return {cursor:cursor===null?'verified':null,processed:2,mismatches:0};}};
 let controller=createOnlineMigrationController({database,binding:b,adapter,pageSize:2});assert.equal((await controller.advance(ref,signal())).phase,'backfill');
 controller=createOnlineMigrationController({database,binding:b,adapter,pageSize:2});const phases=[];for(let i=0;i<5;i++)phases.push((await controller.advance(ref,signal())).phase);
 assert.deepEqual(phases,['replay','replay','parity','parity','caught-up']);assert.deepEqual(seen,[null,'p1']);
 assert.equal(replay,2);
 assert.equal((await database.pool.query("SELECT to_regclass('opencrawl_application_installations') AS relation")).rows[0].relation,null,'orchestrator creates no runtime ready authority');
});
live('same-shard concurrent delivery waits and scope/target drift cannot advance a checkpoint',async t=>{
 const {database}=await fixture(t),b=binding(),ref=onlineMigrationReference(b,0),started=Promise.withResolvers(),release=Promise.withResolvers();let calls=0,valid=true;
 const adapter={...defaults(),assertCurrent:async()=>{if(!valid)throw Object.assign(Error('scope'),{code:'ONLINE_MIGRATION_UNSAFE'});},backfillPage:async()=>{calls++;started.resolve();await release.promise;return {cursor:'next',processed:1};}};
 const controller=createOnlineMigrationController({database,binding:b,adapter});const first=controller.advance(ref,signal());await started.promise;
 assert.deepEqual(await controller.advance(ref,signal()),{phase:'waiting',revision:0,waiting:true,parityObserved:false});assert.equal(calls,1);release.resolve();await first;
 await assert.rejects(controller.advance({...ref,bindingId:'c'.repeat(64)},signal()),{code:'ONLINE_MIGRATION_UNSAFE'});
 valid=false;await assert.rejects(controller.advance(ref,signal()),{code:'ONLINE_MIGRATION_UNSAFE'});
 await database.pool.query("UPDATE opencrawl_online_migration_runs SET target_id=$1",['f'.repeat(64)]);valid=true;await assert.rejects(controller.advance(ref,signal()),{code:'ONLINE_MIGRATION_UNSAFE'});assert.equal(calls,1);
});
live('invalid progress, excessive pages and mismatched parity never report parity',async t=>{
 const {database}=await fixture(t);
 for(const result of [{cursor:'x',processed:65},{cursor:'x',processed:0},{cursor:'x'.repeat(8193),processed:1}]){
  const b=binding(),controller=createOnlineMigrationController({database,binding:b,adapter:{...defaults(),backfillPage:async()=>result}});await assert.rejects(controller.advance(onlineMigrationReference(b,0),signal()),{code:'ONLINE_MIGRATION_UNSAFE'});
 }
 const b=binding(),ref=onlineMigrationReference(b,0),controller=createOnlineMigrationController({database,binding:b,adapter:{...defaults(),parityPage:async()=>({cursor:null,processed:1,mismatches:1})}});
 await controller.advance(ref,signal());await controller.advance(ref,signal());await assert.rejects(controller.advance(ref,signal()),{code:'ONLINE_MIGRATION_UNSAFE'});
 assert.equal((await database.pool.query('SELECT phase FROM opencrawl_online_migration_runs WHERE binding_id=$1',[ref.bindingId])).rows[0].phase,'parity');
});
live('a lost checkpoint response repeats only idempotent target work and cancellation retains cursor',async t=>{
 const {database}=await fixture(t),b=binding(),ref=onlineMigrationReference(b,0);await database.pool.query('CREATE TABLE target(k text PRIMARY KEY,v text NOT NULL)');let calls=0,fail=true;
 const adapter={...defaults(),backfillPage:async()=>{calls++;await database.pool.query("INSERT INTO target VALUES('one','value') ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v");if(fail){fail=false;throw Error('lost response');}return {cursor:null,processed:1};}};
 const controller=createOnlineMigrationController({database,binding:b,adapter});await assert.rejects(controller.advance(ref,signal()),/lost response/);assert.equal((await database.pool.query('SELECT revision FROM opencrawl_online_migration_runs')).rows[0].revision,'0');
 // The failed controller destroys its connection. PostgreSQL may still hold
 // its session lock until it processes that disconnect, so an immediate retry
 // can legitimately wait without invoking target work again.
 const retrySignal=AbortSignal.timeout(5000);let recovered;
 do {recovered=await controller.advance(ref,retrySignal);if(recovered.waiting){assert.equal(calls,1);await delay(10,undefined,{signal:retrySignal});}} while(recovered.waiting);
 assert.equal(recovered.phase,'replay');assert.equal(calls,2);assert.equal((await database.pool.query('SELECT count(*) FROM target')).rows[0].count,'1');
 const cancelled=new AbortController();cancelled.abort();await assert.rejects(controller.advance(ref,cancelled.signal));assert.equal((await database.pool.query('SELECT phase FROM opencrawl_online_migration_runs')).rows[0].phase,'replay');
});
live('actual journal gates source read, replays newer mutations and preserves target transaction checkpoints',async t=>{
 const {database}=await fixture(t),b=binding(),ref=onlineMigrationReference(b,0),journal=createOnlineJournal({database,epoch:b.epoch,sourceId:b.sourceId});await journal.ready();await database.pool.query('CREATE TABLE target(k text PRIMARY KEY,v text NOT NULL)');
 const source=new Map([['a',{version:'original-a',operationId:null,revision:null,deleted:false,bytes:Buffer.from('old-a'),contentType:'text/plain'}],['b',{version:'original-b',operationId:null,revision:null,deleted:false,bytes:Buffer.from('old-b'),contentType:'text/plain'}]]);let reads=[];
 const store={read:async key=>structuredClone(source.get(key)),putIfVersion:async(key,version,mutation)=>{if(source.get(key)?.version!==version)return false;source.set(key,{version:mutation.operationId,operationId:mutation.operationId,revision:mutation.revision,deleted:false,bytes:Buffer.from(mutation.bytes),contentType:mutation.contentType});return true;},deleteIfVersion:async()=>assert.fail('no delete in fixture')};
 store.read=async key=>{const x=source.get(key);return {...x,bytes:Buffer.from(x.bytes)};};
 const put=async(client,key,bytes)=>client.query('INSERT INTO target VALUES($1,$2) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v',[key,bytes.toString()]);
 const adapter={...defaults(),backfillPage:async({cursor})=>{const key=cursor===null?'a':'b';await journal.backfillIfUnchanged({key,apply:async client=>{reads.push(key);const body=await store.read(key);await put(client,key,body.bytes);}});return {cursor:key==='a'?'b':null,processed:1};},closedFrontier:()=>journal.closedFrontier(),replayPage:async({consumer,through,limit})=>{const x=await journal.replayPage({consumer,through,limit,apply:async(client,intent)=>put(client,intent.key,intent.mutation.bytes)});return {checkpoint:x.checkpoint,processed:x.applied+x.notApplied,blocked:x.pending};},parityPage:async()=>{const rows=(await database.pool.query('SELECT k,v FROM target ORDER BY k')).rows;assert.deepEqual(rows,[{k:'a',v:'old-a'},{k:'b',v:'new-b'}]);return {cursor:null,processed:2,mismatches:0};}};
 const controller=createOnlineMigrationController({database,binding:b,adapter,pageSize:2});await controller.advance(ref,signal());
 await journal.mutate({operationId:randomUUID(),key:'b',mutation:{kind:'put',bytes:Buffer.from('new-b'),contentType:'text/plain'}},store);
 await controller.advance(ref,signal());assert.deepEqual(reads,['a'],'new mutation skips the baseline source read entirely');
 assert.equal((await controller.advance(ref,signal())).phase,'parity');assert.equal((await controller.advance(ref,signal())).parityObserved,true);
 assert.equal((await database.pool.query('SELECT sequence FROM opencrawl_online_migration_checkpoints')).rows[0].sequence,'1');
});


test('uncertain controller lock acquisition destroys its socket without queued unlock',async()=>{
 const queries=[],released=[],timeout=Error('Query read timeout'),client=new EventEmitter();
 client.query=async text=>{queries.push(text);if(text.includes('pg_try_advisory_lock'))throw timeout;return {rows:[],rowCount:0};};
 client.release=destroy=>released.push(destroy===true);
 const database={namespace:'timeout-fixture',pool:{options:{max:2},connect:async()=>client}},b=binding();
 const controller=createOnlineMigrationController({database,binding:b,adapter:defaults()});
 await assert.rejects(controller.advance(onlineMigrationReference(b,0),signal()),error=>error===timeout);
 assert.deepEqual(released,[false,true]);assert.equal(queries.filter(text=>text.includes('pg_advisory_unlock')).length,0);
 assert.equal(client.listenerCount('error'),0);
});
