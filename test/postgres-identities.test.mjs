import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Pool} from 'pg';
import {createPostgresEventIdentities} from '../dist/src/sessions/postgres-identities.mjs';
import {createSessionIngest,digest} from '../dist/src/sessions/ingest.mjs';
import {eventIdentityLocation,eventFingerprints} from '../dist/src/sessions/event-identity.mjs';
import {migrateEventIdentitySource} from '../dist/src/sessions/identity-migration.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';

const connectionString=process.env.OPENCRAWL_TEST_POSTGRES_URL;
const owner={tenantId:'tenant-a',userId:'owner'},prefix='sessions/postgres-test/v1';
const event=(id,text=id)=>({id,kind:'message',data:{text}});
const batch=(events,extra={})=>({schemaVersion:1,owner,harness:'codex',origin:'cli',installationId:'machine',sessionId:'session',attachments:[],events,...extra});
const identity={prefix,principal:owner,harness:'codex',installationId:'machine',sessionId:'session'};
async function fixture(t){
 const namespace='test-'+randomUUID(),store=memorySessionStore();
 const identities=createPostgresEventIdentities({connectionString,namespace});
 const pool=new Pool({connectionString});
 await identities.ready();
 t.after(async()=>{await identities.close();await pool.query('DELETE FROM opencrawl_event_identity_sessions WHERE namespace=$1',[namespace]);await pool.query('DELETE FROM opencrawl_event_identity_deletions WHERE namespace=$1',[namespace]);await pool.end();});
 return {namespace,store,identities,pool,ingest:createSessionIngest({store,prefix,eventIdentities:identities}),reserve:events=>identities.reserve({...identity,store,events})};
}
const live=(name,fn)=>test(name,{skip:!connectionString},fn);

test('the migration executable starts and reports storage failure without a circular top-level await',()=>{
 const result=spawnSync(process.execPath,[new URL('../dist/src/sessions/identity-migration.mjs',import.meta.url).pathname,'migrate'],{
  encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH,OPENCRAWL_DATABASE_URL:'postgres://test:test@127.0.0.1:1/test',
   OPENCRAWL_LANDING_S3_BUCKET:'migration-test',OPENCRAWL_LANDING_S3_ENDPOINT:'http://127.0.0.1:1',
   OPENCRAWL_LANDING_S3_ACCESS_KEY_ID:'test',OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY:'test'},
 });
 assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/migration incomplete/);assert.doesNotMatch(result.stderr,/unsettled top-level await/i);
});

live('Postgres reservations are atomic across concurrent clients and preserve tenant boundaries',async t=>{
 const f=await fixture(t),other=createPostgresEventIdentities({connectionString,namespace:f.namespace});t.after(()=>other.close());
 const results=await Promise.allSettled([
  f.reserve([event('same','first'),event('only-first')]),
  other.reserve({...identity,store:f.store,events:[event('same','second'),event('only-second')]}),
 ]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.find(r=>r.status==='rejected').reason.code,'SESSION_EVENT_ID_CONFLICT');
 const winner=results[0].status==='fulfilled'?'first':'second',loser=winner==='first'?'second':'first';
 assert.equal((await f.reserve([event('same',winner)])).reservedEvents,2);
 assert.equal((await f.reserve([event('only-'+loser,'different')])).reservedEvents,3);
 await f.ingest.putBatch({...owner,tenantId:'other'},batch([event('same','foreign')],{owner:{...owner,tenantId:'other'}}));
 await assert.rejects(f.ingest.putBatch(owner,batch([event('same',winner)],{owner:{...owner,tenantId:'other'}})),{status:403});
});

live('migration imports reservations with no raw batch and fences every legacy writer',async t=>{
 const f=await fixture(t),legacy=createSessionIngest({store:f.store,prefix});
 const put=f.store.put;f.store.put=async(key,...args)=>{if(key.endsWith('.json.gz'))throw new Error('source write failed');return put(key,...args);};
 await assert.rejects(legacy.putBatch(owner,batch([event('reserved')])),/uncertain/);f.store.put=put;
 await f.reserve([event('new')]);
 await assert.rejects(f.reserve([event('reserved','changed')]),{status:409});
 const marker=JSON.parse(f.store.data.get(eventIdentityLocation(identity).key));assert.equal(marker.schemaVersion,2);assert.equal(marker.events,undefined);
 await assert.rejects(legacy.putBatch(owner,batch([event('old-writer')])),{status:409});
});

live('an authoritative legacy ledger migrates without re-reading raw history',async t=>{
 const f=await fixture(t),legacy=createSessionIngest({store:f.store,prefix});
 await legacy.putBatch(owner,batch([event('historical')]));
 f.store.listPage=async()=>{throw Error('raw history must not be listed');};
 f.store.get=async()=>{throw Error('raw history must not be downloaded');};
 assert.equal((await f.reserve([event('new')])).reservedEvents,2);
 await assert.rejects(f.reserve([event('historical','changed')]),{status:409});
});

live('pre-ledger history is still scanned and corrupt owner paths are rejected',async t=>{
 const f=await fixture(t),legacy=createSessionIngest({store:f.store,prefix});
 const receipt=await legacy.putBatch(owner,batch([event('historical')])),where=eventIdentityLocation(identity);
 f.store.data.delete(where.key);
 assert.equal((await f.reserve([event('new')])).reservedEvents,2);
 await assert.rejects(f.reserve([event('historical','changed')]),{status:409});
 const foreign={...identity,sessionId:'foreign'},other=eventIdentityLocation(foreign);
 await f.store.put(other.source+receipt.batchId+'.json.gz',await f.store.get(where.source+receipt.batchId+'.json.gz'));
 await assert.rejects(f.identities.reserve({...foreign,store:f.store,events:[event('new')]}),{status:409});
});

live('a concurrent legacy CAS is incorporated before the migration fence wins',async t=>{
 const f=await fixture(t),where=eventIdentityLocation(identity),cas=f.store.compareAndSet;let raced=false;
 f.store.compareAndSet=async(key,version,bytes)=>{
  if(key===where.key&&!raced){raced=true;await f.store.put(key,Buffer.from(JSON.stringify({schemaVersion:1,identity:where.identity,events:Object.fromEntries(eventFingerprints([event('raced')]))})));return false;}
  return cas(key,version,bytes);
 };
 assert.equal((await f.reserve([event('new')])).reservedEvents,2);
 await assert.rejects(f.reserve([event('raced','conflict')]),{status:409});
});

live('crash after fencing and before marking ready resumes without losing reservations',async t=>{
 const f=await fixture(t),where=eventIdentityLocation(identity),cas=f.store.compareAndSet;let once=true;
 f.store.compareAndSet=async(...args)=>{const ok=await cas(...args);if(ok&&once){once=false;throw new Error('lost fence response');}return ok;};
 await assert.rejects(f.reserve([event('not-yet-claimed')]),{status:503});
 assert.equal(JSON.parse(f.store.data.get(where.key)).schemaVersion,2);
 assert.equal((await f.reserve([event('retry')])).reservedEvents,1);
 assert.equal((await f.reserve([event('not-yet-claimed','allowed')])).reservedEvents,2);
});

live('migrated source rejects a different or lost database instead of falling back to JSON',async t=>{
 const f=await fixture(t);await f.reserve([event('reserved')]);
 const wrong=createPostgresEventIdentities({connectionString,namespace:f.namespace+'-wrong'});t.after(()=>wrong.close());
 await assert.rejects(wrong.reserve({...identity,store:f.store,events:[event('new')]}),{status:503});
 await f.pool.query('DELETE FROM opencrawl_event_identity_sessions WHERE namespace=$1',[f.namespace]);
 await assert.rejects(f.reserve([event('new')]),{status:503});
});

live('session growth beyond the old JSON ceiling retains constant-size storage requests',async t=>{
 const f=await fixture(t),where=eventIdentityLocation(identity),events={};
 // Fill a real legacy ledger near its 16 MiB ceiling, including reservations
 // whose raw upload failed. Import those exact hashes, then grow past the limit.
 for(let n=0;n<125000;n++)events[digest('old-'+n)]=digest('content-'+n);
 const ledger=Buffer.from(JSON.stringify({schemaVersion:1,identity:where.identity,events}));assert.ok(ledger.length<16*1024*1024);
 await f.store.put(where.key,ledger);
 assert.equal((await f.reserve(Array.from({length:1000},(_,n)=>event('new-'+n)))).reservedEvents,126000);
 let reads=0;const read=f.store.readVersion;f.store.readVersion=async(...args)=>{reads++;return read(...args);};
 assert.equal((await f.reserve([event('one-more')])).reservedEvents,126001);assert.equal(reads,0);
 assert.ok(f.store.data.get(where.key).length<512);
});

live('permanent deletion removes fingerprints from all installations and fences late reservations',async t=>{
 const f=await fixture(t);await f.reserve([event('same')]);
 await f.identities.reserve({...identity,installationId:'other-machine',store:f.store,events:[event('same')]});
 await f.identities.reserve({...identity,principal:{...owner,tenantId:'other'},store:f.store,events:[event('same')]});
 await f.identities.purgeSession(identity);
 assert.equal((await f.pool.query('SELECT count(*) FROM opencrawl_event_identities e JOIN opencrawl_event_identity_sessions s ON s.id=e.session_id WHERE s.namespace=$1',[f.namespace])).rows[0].count,'1');
 await assert.rejects(f.reserve([event('late')]),{status:410});
 await assert.rejects(f.identities.reserve({...identity,installationId:'new-machine',store:f.store,events:[event('late')]}),{status:410});
});

live('whole-source migration discovers ledger-only sessions, validates raw owners, and can restart',async t=>{
 const f=await fixture(t),legacy=createSessionIngest({store:f.store,prefix});
 await legacy.putBatch(owner,batch([event('stored')]));
 const other={...identity,sessionId:'ledger-only'},where=eventIdentityLocation(other);
 await f.store.put(where.key,Buffer.from(JSON.stringify({schemaVersion:1,identity:where.identity,events:Object.fromEntries(eventFingerprints([event('reserved-only')]))})));
 const report=await migrateEventIdentitySource({store:f.store,prefix,eventIdentities:f.identities});assert.equal(report.complete,true);
 await assert.rejects(f.identities.reserve({...other,store:f.store,events:[event('reserved-only','changed')]}),{status:409});
 assert.equal((await migrateEventIdentitySource({store:f.store,prefix,eventIdentities:f.identities})).complete,true);
 // A damaged old ledger cannot be adopted under a different source identity.
 const corrupt={...identity,sessionId:'corrupt'},location=eventIdentityLocation(corrupt);
 await f.store.put(location.key,Buffer.from(JSON.stringify({schemaVersion:1,identity:'a'.repeat(64),events:{}})));
 await assert.rejects(f.identities.reserve({...corrupt,store:f.store,events:[event('new')]}),{status:409});
});
