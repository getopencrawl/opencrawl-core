import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
const {createOnlineJournal}=await import(process.env.OPENCRAWL_ONLINE_JOURNAL_SOURCE||'../dist/src/state/online-journal.mjs');
const epoch='11111111-1111-4111-8111-111111111111',binding={bindingHash:'a'.repeat(64),enrollmentReceiptHash:'b'.repeat(64)};
function fixture(){
 let state={epochs:new Map(),sources:new Map(),bindings:new Map()},failInsert=false,waitConnect;const calls=[],releases=[];
 const key=args=>JSON.stringify(args.slice(0,3)),epochKey=args=>JSON.stringify(args.slice(0,2));
 const pool={async connect(){if(waitConnect)await waitConnect;const client=new EventEmitter();let before;
  client.release=destroy=>releases.push(Boolean(destroy));client.query=async(sql,args=[])=>{
   calls.push(sql);if(sql.startsWith('BEGIN')){before=structuredClone(state);return {rows:[]};}if(sql==='COMMIT'){before=undefined;return {rows:[]};}if(sql==='ROLLBACK'){state=before??state;return {rows:[]};}
   if(sql.startsWith('SELECT pg_advisory_'))return {rows:[]};
   if(sql.startsWith('INSERT INTO opencrawl_online_migration_epochs')){if(!state.epochs.has(epochKey(args)))state.epochs.set(epochKey(args),'active');return {rows:[],rowCount:1};}
   if(sql.startsWith('SELECT state'))return {rows:state.epochs.has(epochKey(args))?[{state:state.epochs.get(epochKey(args))}]:[]};
   if(sql.startsWith('SELECT sequence FROM'))return {rows:state.sources.has(key(args))?[{sequence:state.sources.get(key(args))}]:[]};
   if(sql.startsWith('SELECT binding_hash'))return {rows:state.bindings.has(key(args))?[state.bindings.get(key(args))]:[]};
   if(sql.startsWith('SELECT s.sequence')){const bound=state.bindings.get(key(args));return {rows:bound&&state.sources.has(key(args))?[{sequence:state.sources.get(key(args)),...bound}]:[]};}
   if(sql.startsWith('INSERT INTO opencrawl_online_migration_sources')){assert.ok(!state.sources.has(key(args)));state.sources.set(key(args),'0');return {rows:[],rowCount:1};}
   if(sql.startsWith('INSERT INTO opencrawl_online_migration_source_bindings')){if(failInsert)throw Error('insert fault');state.bindings.set(key(args),{binding_hash:args[3],enrollment_receipt_hash:args[4]});return {rows:[],rowCount:1};}
   assert.fail('Unexpected SQL: '+sql);
  };return client;}};
 const database={pool,namespace:'source-registration'},journal=(sourceId='source')=>createOnlineJournal({database,epoch,sourceId});
 return {database,journal,calls,releases,get state(){return state;},set failInsert(v){failInsert=v;},set waitConnect(v){waitConnect=v;}};
}
test('bound source registration is row-only and a recreated journal attaches read-only',async()=>{
 const f=fixture(),expected={namespace:f.database.namespace,epoch,sourceId:'source',...binding};assert.deepEqual(await f.journal().registerSource(binding),expected);
 assert.ok(f.calls.every(sql=>!/^CREATE|^ALTER/.test(sql)));f.calls.length=0;assert.deepEqual(await f.journal().attachSource(binding),expected);
 assert.equal(f.calls[0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');assert.ok(f.calls.every(sql=>/^(BEGIN|SELECT|COMMIT)/.test(sql)));assert.equal(f.state.sources.size,1);
});
test('registration rejects rebinding and cannot adopt even an empty unbound source',async()=>{
 const f=fixture();await f.journal().registerSource(binding);
 for(const changed of [{...binding,bindingHash:'c'.repeat(64)},{...binding,enrollmentReceiptHash:'c'.repeat(64)}])await assert.rejects(f.journal().registerSource(changed),{code:'ONLINE_MIGRATION_SOURCE_BINDING_CHANGED'});
 f.state.sources.set(JSON.stringify([f.database.namespace,epoch,'unbound']),'0');await assert.rejects(f.journal('unbound').registerSource(binding),{code:'ONLINE_MIGRATION_UNBOUND_SOURCE_CANNOT_BE_ADOPTED'});
 assert.equal(f.state.bindings.size,1);
});
test('failed binding insert rolls back source and epoch together; attachment never repairs absence',async()=>{
 const f=fixture();f.failInsert=true;await assert.rejects(f.journal().registerSource(binding),/insert fault/);assert.equal(f.state.sources.size,0);assert.equal(f.state.epochs.size,0);assert.equal(f.releases.at(-1),true);
 f.calls.length=0;await assert.rejects(f.journal().attachSource(binding),{code:'ONLINE_MIGRATION_EPOCH_NOT_ACTIVE'});assert.ok(!f.calls.some(sql=>/^(INSERT|CREATE|ALTER)/.test(sql)));
});
test('registration freezes input before connection wait and attachment refuses fenced epoch or other source',async()=>{
 const f=fixture();let release;f.waitConnect=new Promise(resolve=>{release=resolve;});const request={...binding},pending=f.journal().registerSource(request);request.bindingHash='c'.repeat(64);release();await pending;
 await assert.rejects(f.journal('other').attachSource(binding),{code:'ONLINE_MIGRATION_SOURCE_NOT_REGISTERED'});
 f.state.epochs.set(JSON.stringify([f.database.namespace,epoch]),'fenced');await assert.rejects(f.journal().attachSource(binding),{code:'ONLINE_MIGRATION_EPOCH_NOT_ACTIVE'});
});

test('actual PostgreSQL source preparation, registration, attachment and conflicts', {skip:!process.env.OPENCRAWL_TEST_POSTGRES_URL},async t=>{
 const [{Pool},{randomUUID},{dropTestSchemas}]=await Promise.all([import('pg'),import('node:crypto'),import('./fixtures/application-database.mjs')]);
 const url=process.env.OPENCRAWL_TEST_POSTGRES_URL,schema='oc_shadow_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url,max:1});
 await admin.query('CREATE SCHEMA '+schema);const pool=new Pool({connectionString:url,max:5,options:'-c search_path='+schema});
 t.after(async()=>{try{await pool.end();await dropTestSchemas(admin,[schema]);}finally{await admin.end();}});
 const database={pool,namespace:'source-registration-'+randomUUID()},ep=randomUUID(),journal=id=>createOnlineJournal({database,epoch:ep,sourceId:id});
 await journal('schema-only').prepareSchema();assert.equal((await pool.query('SELECT count(*)::int AS n FROM opencrawl_online_migration_sources')).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int AS n FROM opencrawl_online_migration_epochs')).rows[0].n,0);
 await t.test('registration is durable and recreated journal attaches without schema writes',async()=>{
  const expected=await journal('bound').registerSource(binding);const client=await pool.connect();try{await client.query('BEGIN READ ONLY');assert.deepEqual(await journal('bound').attachSourceIn(client,binding),expected);await client.query('COMMIT');}finally{client.release();}
  assert.deepEqual(await journal('bound').attachSource(binding),expected);
 });
 await t.test('caller transaction rollback leaves no half registered source',async()=>{
  const client=await pool.connect();try{await client.query('BEGIN');await journal('rollback').registerSourceIn(client,binding);await client.query('ROLLBACK');}finally{client.release();}
  await assert.rejects(journal('rollback').attachSource(binding),{code:'ONLINE_MIGRATION_SOURCE_NOT_REGISTERED'});assert.equal((await pool.query("SELECT count(*)::int AS n FROM opencrawl_online_migration_source_bindings WHERE source_id='rollback'")).rows[0].n,0);
 });
 await t.test('competing different exact bindings produce one winner, and unbound rows cannot be adopted',async()=>{
  const outcomes=await Promise.allSettled([journal('race').registerSource(binding),journal('race').registerSource({...binding,bindingHash:'c'.repeat(64)})]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.filter(x=>x.status==='rejected'&&x.reason.code==='ONLINE_MIGRATION_SOURCE_BINDING_CHANGED').length,1);
  await journal('unbound').ready();await assert.rejects(journal('unbound').registerSource(binding),{code:'ONLINE_MIGRATION_UNBOUND_SOURCE_CANNOT_BE_ADOPTED'});await assert.rejects(journal('bound').ready(),{code:'ONLINE_MIGRATION_BOUND_SOURCE_REQUIRES_ATTACHMENT'});
 });
 await t.test('fenced epoch cannot be reopened by new registration or attachment',async()=>{
  await journal('bound').fence();await assert.rejects(journal('late').registerSource(binding),{code:'ONLINE_MIGRATION_EPOCH_NOT_ACTIVE'});await assert.rejects(journal('bound').attachSource(binding),{code:'ONLINE_MIGRATION_EPOCH_NOT_ACTIVE'});
 });
});
