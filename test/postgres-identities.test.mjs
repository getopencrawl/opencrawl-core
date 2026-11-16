import {withTestState} from './fixtures/memory-application-state.mjs';
import {reserveSessionEvents as legacyReserve} from './fixtures/legacy-event-identities.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Pool} from 'pg';
import {createPostgresEventIdentities} from '../dist/src/sessions/postgres-identities.mjs';
import {createSessionIngest,digest} from '../dist/src/sessions/ingest.mjs';
import {eventIdentityLocation,eventFingerprints,reserveSessionEvents} from '../dist/src/sessions/event-identity.mjs';
import {migrateEventIdentitySource} from '../dist/src/sessions/identity-migration.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';
const connectionString=process.env.OPENCRAWL_TEST_POSTGRES_URL;
const owner={tenantId:'tenant-a',userId:'owner'},prefix='sessions/postgres-test/v1';
const event=(id,text=id)=>({id,kind:'message',data:{text}});
const batch=(events,extra={})=>({schemaVersion:1,owner,harness:'codex',origin:'cli',installationId:'machine',sessionId:'session',attachments:[],events,...extra});
const identity={prefix,principal:owner,harness:'codex',installationId:'machine',sessionId:'session'};
const legacyIdentities={reserve:({eventIdentities,...options})=>legacyReserve(options),purgeSession:async()=>{}};
async function fixture(t){
 const namespace='test-'+randomUUID(),store=memorySessionStore(),identities=createPostgresEventIdentities({connectionString,namespace}),pool=new Pool({connectionString});await identities.ready();
 t.after(async()=>{await identities.close();await pool.query('DELETE FROM opencrawl_event_identity_sessions WHERE namespace=$1',[namespace]);await pool.query('DELETE FROM opencrawl_event_identity_deletions WHERE namespace=$1',[namespace]);await pool.end();});
 return {namespace,store,identities,pool,ingest:createSessionIngest(withTestState({store,prefix,eventIdentities:identities})),legacy:createSessionIngest(withTestState({store,prefix,eventIdentities:legacyIdentities})),reserve:events=>identities.reserve({...identity,store,events}),migrate:()=>identities.migrateSession({store,prefix,source:eventIdentityLocation(identity).source})};
}
const live=(name,fn)=>test(name,{skip:!connectionString},fn);
test('runtime requires an explicit event identity repository and cannot create an object ledger',async()=>{
 const store=memorySessionStore();await assert.rejects(reserveSessionEvents({...identity,store,events:[event('new')]}),{status:503});assert.equal(store.data.size,0);
});
test('the migration executable reports storage failure without a circular top-level await',()=>{
 const result=spawnSync(process.execPath,[new URL('../dist/src/sessions/identity-migration.mjs',import.meta.url).pathname,'migrate'],{encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH,OPENCRAWL_DATABASE_URL:'postgres://test:test@127.0.0.1:1/test',OPENCRAWL_LANDING_S3_BUCKET:'migration-test',OPENCRAWL_LANDING_S3_ENDPOINT:'http://127.0.0.1:1',OPENCRAWL_LANDING_S3_ACCESS_KEY_ID:'test',OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY:'test'}});
 assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/migration incomplete/);assert.doesNotMatch(result.stderr,/unsettled top-level await/i);
});
live('Postgres reservations are atomic across clients and never read or write object metadata',async t=>{
 const f=await fixture(t),other=createPostgresEventIdentities({connectionString,namespace:f.namespace});t.after(()=>other.close());
 for(const name of ['readVersion','compareAndSet','listPage'])f.store[name]=async()=>assert.fail('Runtime identity touched object state');
 const results=await Promise.allSettled([f.reserve([event('same','first'),event('only-first')]),other.reserve({...identity,store:f.store,events:[event('same','second'),event('only-second')]})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'SESSION_EVENT_ID_CONFLICT');
 const winner=results[0].status==='fulfilled'?'first':'second',loser=winner==='first'?'second':'first';
 assert.equal((await f.reserve([event('same',winner)])).reservedEvents,2);assert.equal((await f.reserve([event('only-'+loser,'different')])).reservedEvents,3);
 await f.ingest.putBatch({...owner,tenantId:'other'},batch([event('same','foreign')],{owner:{...owner,tenantId:'other'}}));
 assert.equal([...f.store.data.keys()].filter(key=>!key.endsWith('.json.gz')).length,0);
});
live('offline migration imports failed-upload reservations without modifying the source',async t=>{
 const f=await fixture(t),put=f.store.put;f.store.put=async(key,...args)=>{if(key.endsWith('.json.gz'))throw new Error('source write failed');return put(key,...args);};
 await assert.rejects(f.legacy.putBatch(owner,batch([event('reserved')])),/uncertain/);f.store.put=put;
 const key=eventIdentityLocation(identity).key,before=Buffer.from(f.store.data.get(key));await f.migrate();
 await assert.rejects(f.reserve([event('reserved','changed')]),{status:409});assert.equal((await f.reserve([event('new')])).reservedEvents,2);assert.deepEqual(f.store.data.get(key),before);
});
live('authoritative old ledgers import without downloading raw history; later reservations never access source state',async t=>{
 const f=await fixture(t);await f.legacy.putBatch(owner,batch([event('historical')]));let reads=0;const read=f.store.readVersion;f.store.readVersion=async(...args)=>{reads++;return read(...args);};
 f.store.listPage=async()=>assert.fail('raw history must not be listed');f.store.get=async()=>assert.fail('raw history must not be downloaded');
 assert.equal((await f.migrate()).reservedEvents,1);assert.equal(reads,2);reads=0;
 assert.equal((await f.reserve([event('new')])).reservedEvents,2);assert.equal(reads,0);await assert.rejects(f.reserve([event('historical','changed')]),{status:409});
});
live('pre-ledger history is imported explicitly and corrupt owner paths are rejected',async t=>{
 const f=await fixture(t),receipt=await f.legacy.putBatch(owner,batch([event('historical')])),where=eventIdentityLocation(identity);f.store.data.delete(where.key);
 assert.equal((await f.migrate()).reservedEvents,1);assert.equal((await f.reserve([event('new')])).reservedEvents,2);
 const foreign=eventIdentityLocation({...identity,sessionId:'foreign'});await f.store.put(foreign.source+receipt.batchId+'.json.gz',await f.store.get(where.source+receipt.batchId+'.json.gz'));
 await assert.rejects(f.identities.migrateSession({store:f.store,prefix,source:foreign.source}),{status:409});
});
live('a changing legacy source fails migration, blocks runtime admission, and resumes after writers stop',async t=>{
 const f=await fixture(t),where=eventIdentityLocation(identity);await f.legacy.putBatch(owner,batch([event('old')]));let reads=0;const read=f.store.readVersion;
 f.store.readVersion=async(...args)=>{if(++reads===2)await f.store.put(where.key,Buffer.from(JSON.stringify({schemaVersion:1,identity:where.identity,events:Object.fromEntries(eventFingerprints([event('old'),event('raced')]))})));return read(...args);};
 await assert.rejects(f.migrate(),{status:503});await assert.rejects(f.reserve([event('new')]),{status:503});
 f.store.readVersion=read;assert.equal((await f.migrate()).reservedEvents,2);await assert.rejects(f.reserve([event('raced','changed')]),{status:409});
});
live('old schema-v2 markers require their matching database identity and reservations during migration',async t=>{
 const f=await fixture(t);await f.reserve([event('reserved')]);const where=eventIdentityLocation(identity),database=(await f.pool.query('SELECT database_id FROM opencrawl_event_identity_schema WHERE singleton')).rows[0].database_id;
 await f.store.put(where.key,Buffer.from(JSON.stringify({schemaVersion:2,identity:where.identity,database,namespace:digest(f.namespace)})));assert.equal((await f.migrate()).reservedEvents,1);
 const wrong=createPostgresEventIdentities({connectionString,namespace:f.namespace+'-wrong'});t.after(()=>wrong.close());await assert.rejects(wrong.migrateSession({store:f.store,prefix,source:where.source}),{status:503});
 await f.pool.query('DELETE FROM opencrawl_event_identity_sessions WHERE namespace=$1',[f.namespace]);await assert.rejects(f.migrate(),{status:503});
});
live('session growth beyond the old JSON ceiling preserves all legacy hashes and source bytes',async t=>{
 const f=await fixture(t),where=eventIdentityLocation(identity),events={};for(let n=0;n<125000;n++)events[digest('old-'+n)]=digest('content-'+n);
 const ledger=Buffer.from(JSON.stringify({schemaVersion:1,identity:where.identity,events}));assert.ok(ledger.length<16*1024*1024);await f.store.put(where.key,ledger);
 assert.equal((await f.migrate()).reservedEvents,125000);assert.equal((await f.reserve(Array.from({length:1000},(_,n)=>event('new-'+n)))).reservedEvents,126000);
 f.store.readVersion=async()=>assert.fail('runtime must not read old ledger');assert.equal((await f.reserve([event('one-more')])).reservedEvents,126001);assert.deepEqual(f.store.data.get(where.key),ledger);
});
live('permanent deletion removes fingerprints from every installation and fences late reservations',async t=>{
 const f=await fixture(t);await f.reserve([event('same')]);await f.identities.reserve({...identity,installationId:'other-machine',store:f.store,events:[event('same')]});await f.identities.reserve({...identity,principal:{...owner,tenantId:'other'},store:f.store,events:[event('same')]});
 await f.identities.purgeSession(identity);assert.equal((await f.pool.query('SELECT count(*) FROM opencrawl_event_identities e JOIN opencrawl_event_identity_sessions s ON s.id=e.session_id WHERE s.namespace=$1',[f.namespace])).rows[0].count,'1');await assert.rejects(f.reserve([event('late')]),{status:410});await assert.rejects(f.identities.reserve({...identity,installationId:'new-machine',store:f.store,events:[event('late')]}),{status:410});
});
live('whole-source migration discovers ledger-only sessions and safely repeats',async t=>{
 const f=await fixture(t);await f.legacy.putBatch(owner,batch([event('stored')]));const other={...identity,sessionId:'ledger-only'},where=eventIdentityLocation(other);
 await f.store.put(where.key,Buffer.from(JSON.stringify({schemaVersion:1,identity:where.identity,events:Object.fromEntries(eventFingerprints([event('reserved-only')]))})));
 const before=new Map([...f.store.data].map(([key,bytes])=>[key,Buffer.from(bytes)]));assert.equal((await migrateEventIdentitySource({store:f.store,prefix,eventIdentities:f.identities})).complete,true);assert.equal((await migrateEventIdentitySource({store:f.store,prefix,eventIdentities:f.identities})).complete,true);
 await assert.rejects(f.identities.reserve({...other,store:f.store,events:[event('reserved-only','changed')]}),{status:409});assert.deepEqual(f.store.data,before);
});
