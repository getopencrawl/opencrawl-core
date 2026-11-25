import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {memorySessionStore} from './session-store-fixture.mjs';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
import {createCaptureCredentials} from '../dist/src/sessions/credentials.mjs';
import {sessionScope,digest} from '../dist/src/sessions/event-identity.mjs';
import {createCredentialState} from '../dist/src/state/credentials.mjs';

const skip=!postgresUrl,bucket='credential-test',prefix='sessions/test/v1',owner={tenantId:'org_a',userId:'user_a',name:'Member',email:'fixture@example.test'};
const other={...owner,userId:'user_other'},otherTenant={...owner,tenantId:'org_b'};
const path=(family,id)=>prefix+(family==='agent'?'/_agent-access':'')+'/_credentials/'+id+'.json';
async function fixture(t,org=null){
  const store=Object.assign(memorySessionStore(),{bucket});
  const database=await applicationDatabaseFixture(t,{sourceIdentity:{version:1,bucket,prefix,organizationId:org}});
  const open=()=>createCredentialState(database,store,prefix);
  return {store,database,open,ns:database.namespace};
}

test('retained capture and agent records preserve validity, owner and exact outstanding removal CAS across cutover',{skip},async t=>{
  const {store,open,database,ns}=await fixture(t);
  let at=1000;const options={now:()=>at};
  const old=family=>createCaptureCredentials({store,prefix:family==='capture'?prefix:prefix+'/_agent-access',...options});
  const capture=old('capture'),agent=old('agent'),state=open();
  const oldToken=await capture.issue(owner);
  await capture.revokeAll(owner); // The physical owner version already exists.
  const issued=await capture.issue(owner),expired=await capture.issue(other),revoked=await capture.issue(otherTenant);
  await capture.revoke(otherTenant,revoked.id);
  const legacy=await agent.issue(owner),stale=await agent.issue(other);
  await agent.revokeAll(other);
  const legacyKey=path('agent',legacy.id),legacyBody=JSON.parse(await store.get(legacyKey));delete legacyBody.generation;
  await store.put(legacyKey,Buffer.from(JSON.stringify(legacyBody)));
  const expiresKey=path('capture',expired.id),expiredBody=JSON.parse(await store.get(expiresKey));expiredBody.expiresAt=new Date(at).toISOString();
  await store.put(expiresKey,Buffer.from(JSON.stringify(expiredBody)));
  const version=await capture.removalVersion(owner);
  assert.equal(typeof version,'number');assert.equal(await agent.removalVersion(owner),null);
  assert.equal(await capture.authenticate(oldToken.token),null);
  assert.deepEqual(await agent.authenticate(legacy.token),{...owner,captureAccess:'write'});
  const plan=await state.migrate('plan');
  assert.deepEqual(plan.receipt.capture,{records:4,generations:1});assert.deepEqual(plan.receipt.agent,{records:2,generations:1});
  await assert.rejects(state.migrate('activate',async()=>{throw Error('fleet changed');}),/fleet changed/);
  assert.equal((await state.status()).backend,'objects');
  assert.equal((await database.pool.query('SELECT count(*)::int AS n FROM opencrawl_credential_records WHERE namespace=$1',[ns])).rows[0].n,0);
  const activated=await state.migrate('activate');
  assert.deepEqual(activated,{backend:'postgres',receipt:plan.receipt});
  const fresh=open(),sql=fresh.credentials('capture',options),sqlAgent=fresh.credentials('agent',options);
  assert.deepEqual(await fresh.migrate('verify'),activated);
  assert.equal(await sqlAgent.authenticate(issued.token),null);assert.equal(await sql.authenticate(legacy.token),null);
  for(const denied of [oldToken,expired,revoked])assert.equal(await sql.authenticate(denied.token),null);
  assert.equal(await sqlAgent.authenticate(stale.token),null);
  assert.deepEqual(await sql.authenticate(issued.token),{...owner,captureAccess:'write'});
  await assert.rejects(sql.revoke(other,issued.id),{status:403});
  await assert.rejects(sql.revokeAll(await sql.authenticate(issued.token)),{status:403});
  await assert.rejects(sql.revokeVersion(owner,undefined),{status:400});
  // A removal dispatched while S3 was authoritative can retry both its original
  // numeric marker and the other family's original null, once per family.
  assert.equal(await sql.removalVersion(owner),version);
  await Promise.all([sql.revokeVersion(owner,version),sqlAgent.revokeVersion(owner,null)]);
  assert.equal(await sql.authenticate(issued.token),null);assert.equal(await sqlAgent.authenticate(legacy.token),null);
  const rejoined=await sql.issue(owner),rejoinedAgent=await sqlAgent.issue(owner);
  await sql.revokeVersion(owner,version);await sqlAgent.revokeVersion(owner,null);
  assert.ok(await sql.authenticate(rejoined.token));assert.ok(await sqlAgent.authenticate(rejoinedAgent.token));
  const pgVersion=await sql.removalVersion(owner);
  assert.match(pgVersion,/^pg:/);
  await sql.revokeAll(owner);const next=await sql.issue(owner);
  await sql.revokeVersion(owner,pgVersion);assert.ok(await sql.authenticate(next.token));
  await sqlAgent.revoke(owner,rejoinedAgent.id);assert.equal(await sqlAgent.authenticate(rejoinedAgent.token),null);
  await sql.revoke(owner,issued.id); // Source false -> SQL true remains verifiable.
  assert.deepEqual(await state.migrate('verify'),activated);
  for(const k of ['get','put','readVersion','listPage','compareAndSet'])store[k]=()=>{throw Error('S3 fenced');};
  const restarted=open();
  assert.deepEqual(await restarted.migrate('activate'),activated);
  assert.ok(await restarted.credentials('capture',options).authenticate(next.token));
  await restarted.credentials('capture',options).revoke(owner,next.id);
  assert.equal(await restarted.credentials('capture',options).authenticate(next.token),null);
  assert.doesNotMatch(JSON.stringify(activated),/fixture@example|user_a|occ1_/);
  const rows=(await database.pool.query('SELECT record::text FROM opencrawl_credential_records WHERE namespace=$1',[ns])).rows;
  assert.ok(rows.every(r=>!r.record.includes('occ1_') && !r.record.includes('oca1_')));
});

test('an S3 read spanning activation rechecks a SQL revocation and calls after activation never fall back',{skip},async t=>{
  const {store,open}=await fixture(t),state=open(),service=state.credentials('capture');
  const issued=await service.issue(owner),started=Promise.withResolvers(),resume=Promise.withResolvers();
  const get=store.get.bind(store);
  store.get=async(key,options)=>{
    const bytes=await get(key,options);
    if(key===path('capture',issued.id)){started.resolve();await resume.promise;}
    return bytes;
  };
  const inFlight=service.authenticate(issued.token);
  await started.promise;await open().migrate('activate');
  await open().credentials('capture').revoke(owner,issued.id);resume.resolve();
  assert.equal(await inFlight,null);
});

test('an active legacy mutation or uncertain PUT fences activation; pre-dispatch denial clears its intent',{skip},async t=>{
  const {store,open}=await fixture(t),state=open(),capture=state.credentials('capture');
  const issued=await capture.issue(owner);await assert.rejects(capture.revoke(other,issued.id),{status:403});
  assert.equal((await state.status()).pendingSourceWrites,0);
  const put=store.put.bind(store),started=Promise.withResolvers(),finish=Promise.withResolvers();
  store.put=async(...args)=>{started.resolve();await finish.promise;return put(...args);};
  const live=capture.issue(other);await started.promise;
  await assert.rejects(state.migrate('activate'),/in flight or uncertain/);
  finish.resolve();await live;
  store.put=async()=>{throw Object.assign(Error('definite source denial'),{writeOutcome:'not-applied'});};
  await assert.rejects(capture.revokeAll(owner),/Credential source unavailable/);
  assert.equal((await state.status()).pendingSourceWrites,0);
  store.put=async()=>{throw Error('opaque-credential-key-in-transport-exception');};
  await assert.rejects(capture.revokeAll(owner),error=>error.message==='Credential source unavailable');
  assert.equal((await state.status()).pendingSourceWrites,1);
  await assert.rejects(state.migrate('activate'),/in flight or uncertain/);
  assert.ok(await capture.authenticate(issued.token));
});

test('foreign organizations, malformed bodies, changed frozen input, and version substitutions fail closed',{skip},async t=>{
  const {store,database,ns,open}=await fixture(t,'org_a'),state=open(),capture=state.credentials('capture');
  const rogue=createCaptureCredentials({store,prefix});const foreign=await rogue.issue(otherTenant);
  await assert.rejects(state.migrate('activate'),/outside configured organization/);
  assert.equal(await state.active(),false);await store.delete(path('capture',foreign.id));
  await assert.rejects(capture.issue(otherTenant),{status:403});
  const token='occ1_'+randomBytes(32).toString('hex'),id=digest(token),key=path('capture',id);
  const record={schemaVersion:1,id,principal:{tenantId:owner.tenantId,userId:owner.userId},expiresAt:'2090-01-01T01:00:00Z',revoked:false};
  await store.put(key,Buffer.from(JSON.stringify({...record,principal:{...record.principal,captureAccess:'write'}})));
  await assert.rejects(state.migrate('activate'),/Invalid retained/);
  await store.put(key,Buffer.from(JSON.stringify(record)));
  await capture.revokeAll(owner);
  const readVersion=store.readVersion.bind(store);
  store.readVersion=async(...args)=>{const r=await readVersion(...args);return {...r,version:r.version===null?null:'"opaque-'+r.version+'"'};};
  const prior=await capture.removalVersion(owner);assert.equal(typeof prior,'string');
  await state.migrate('activate');
  assert.equal(await capture.removalVersion(owner),prior);
  await database.pool.query('UPDATE opencrawl_credential_generations SET version=$4::jsonb WHERE namespace=$1 AND family=$2 AND owner=$3',
    [ns,'capture',sessionScope(owner),JSON.stringify('unrelated-version')]);
  await assert.rejects(state.migrate('verify'),/generation verification differs/);
  await database.pool.query('UPDATE opencrawl_credential_generations SET version=$4::jsonb WHERE namespace=$1 AND family=$2 AND owner=$3',
    [ns,'capture',sessionScope(owner),JSON.stringify(prior)]);
  await capture.revokeVersion(owner,prior);assert.match(await capture.removalVersion(owner),/^pg:/);
  await store.put(key,Buffer.from(JSON.stringify({...record,revoked:true})));
  await assert.rejects(state.migrate('verify'),/verification differs/);
});

test('recover one proven, drained source intent; unknown outcomes and ineffective revocations stay fenced',{skip},async t=>{
 const {store,database,ns,open}=await fixture(t),state=open(),capture=state.credentials('capture');
 const token=await capture.issue(owner),put=store.put.bind(store);
 const query=async()=>(await database.pool.query('SELECT operation FROM opencrawl_credential_source_writes WHERE namespace=$1',[ns])).rows[0].operation;
 const evidence=async()=>({writersDrained:true,terminal:'not-applied',reference:'fixture-verified-terminal-provider-request'});
 store.put=async()=>{throw Error('lost response');};
 await assert.rejects(capture.revoke(owner,token.id),/source unavailable/);
 const op=await query();
 await assert.rejects(state.reconcile(op,async()=>({writersDrained:false,terminal:'not-applied',reference:'fixture'})),/evidence required/);
 await assert.rejects(state.reconcile(op,evidence),/must be reconciled/);
 assert.equal((await state.status()).pendingSourceWrites,1);
 store.put=put;
 // Reissue the intended single-credential revocation with authorized operator
 // scope after the provider confirms the missing write cannot arrive later.
 await capture.revoke(owner,token.id);
 assert.deepEqual(await state.reconcile(op,evidence),{remaining:0,resolved:true});
 assert.deepEqual(await state.reconcile(op,evidence),{remaining:0,resolved:false});
 assert.equal(await capture.authenticate(token.token),null);
 // A missing conditional generation must still be rotated; unchanged source
 // plus a terminal outcome alone does not satisfy an unconditional revocation.
 store.put=async()=>{throw Error('lost rotation');};
 await assert.rejects(capture.revokeAll(owner),/source unavailable/);
 const rotate=await query();
 await assert.rejects(state.reconcile(rotate,evidence),/must be reconciled/);
 store.put=put;await capture.revokeVersion(owner,null);
 const newToken=await capture.issue(owner);
 assert.deepEqual(await state.reconcile(rotate,evidence),{remaining:0,resolved:true});
 await state.migrate('activate');assert.ok(await capture.authenticate(newToken.token));
});

test('expiration is evaluated after a delayed source or database read',{skip},async t=>{
 const {store,open,database}=await fixture(t),state=open();let at=1000;
 const c=state.credentials('capture',{now:()=>at}),issued=await c.issue(owner),expires=Date.parse(issued.expiresAt);
 const oldGet=store.get.bind(store);store.get=async(...args)=>{const data=await oldGet(...args);at=expires;return data;};
 assert.equal(await c.authenticate(issued.token),null);
 store.get=oldGet;at=expires-1;await state.migrate('activate');
 const query=database.pool.query.bind(database.pool);
 database.pool.query=async(...args)=>{const result=await query(...args);if(String(args[0]).includes('SELECT c.record'))at=expires;return result;};
 assert.equal(await c.authenticate(issued.token),null);database.pool.query=query;
});

test('identical credential IDs in the two namespaces stay bound to different owners and revocations',{skip},async t=>{
 const {store,open}=await fixture(t),state=open(),capture=state.credentials('capture'),agent=state.credentials('agent');
 const issued=await capture.issue(owner);
 const bytes=JSON.parse(await store.get(path('capture',issued.id)));
 await store.put(path('agent',issued.id),Buffer.from(JSON.stringify({...bytes,principal:other})));
 await state.migrate('activate');
 assert.equal((await capture.authenticate(issued.token)).userId,owner.userId);
 assert.equal((await agent.authenticate(issued.token)).userId,other.userId);
 await assert.rejects(agent.revoke(owner,issued.id),{status:403});
 await agent.revoke(other,issued.id);assert.equal(await agent.authenticate(issued.token),null);
 assert.ok(await capture.authenticate(issued.token));
});

test('retains historical display metadata above 64 KiB byte-for-byte',{skip},async t=>{
 const {open}=await fixture(t),state=open(),service=state.credentials('capture');
 const displayName='a'.repeat(70*1024),token=await service.issue({...owner,name:displayName});
 await state.migrate('activate');assert.equal((await service.authenticate(token.token)).name,displayName);
 assert.equal((await state.migrate('verify')).receipt.capture.records,1);
});

test('plan rejects unrepresentable legacy text without exposing display data or sealing authority',{skip},async t=>{
 const {store,open}=await fixture(t);
 await createCaptureCredentials({store,prefix}).issue({...owner,name:'private\0display'});
 const state=open();await assert.rejects(state.migrate('plan'),e=>e.message==='Retained credential text is not representable in PostgreSQL');
 assert.equal(await state.active(),false);
});
