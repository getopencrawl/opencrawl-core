import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {getMigrations} from 'better-auth/db/migration';
import {identityOptions} from '../dist/src/identity/better-auth.mjs';
import {createLocalSessionStore} from '../dist/src/sessions/local-store.mjs';
import {createPostgresEventIdentities} from '../dist/src/sessions/postgres-identities.mjs';
import {migrateApplicationState} from '../dist/src/state/migrate.mjs';
import {createApplicationState} from '../dist/src/state/application.mjs';
import {requireApplicationStateReady} from '../dist/src/state/postgres.mjs';
import {sessionScope,digest} from '../dist/src/sessions/event-identity.mjs';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
const live=(name,fn)=>test(name,{skip:!postgresUrl},fn);
const org='org_upgrade',owner={tenantId:org,userId:'user_retained'},prefix='sessions/test/v1';
const url='http://localhost:8092',secret='coordinator-test-only-secret-at-least-32';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t,{legacy=false}={}){
  const directory=await mkdtemp(join(tmpdir(),'opencrawl-app-migration-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const database=await applicationDatabaseFixture(t),source={version:1,bucket:'migration-source',prefix,organizationId:org};
  const raw=createLocalSessionStore(join(directory,'objects')),store={...raw,bucket:source.bucket,async checkAccess(){}};
  const eventIdentities=createPostgresEventIdentities({connectionString:postgresUrl,namespace:database.namespace});t.after(()=>eventIdentities.close());
  const identityPath=join(directory,'identity.sqlite'),registryPath=join(directory,'integrations.sqlite');
  if(legacy){
    const sqlite=new DatabaseSync(identityPath),config={...await identityOptions({url,secret,database,organizationId:org}),database:sqlite};
    await (await getMigrations(config)).runMigrations();
    sqlite.exec('CREATE TABLE opencrawlIdentityBinding(singleton INTEGER PRIMARY KEY,organizationId TEXT NOT NULL);CREATE TABLE opencrawlIdentityState(organizationId TEXT PRIMARY KEY,initialized INTEGER NOT NULL);CREATE TABLE opencrawlAccountEpoch(userId TEXT PRIMARY KEY,notBefore INTEGER NOT NULL)');
    sqlite.prepare('INSERT INTO opencrawlIdentityBinding VALUES(1,?)').run(org);sqlite.prepare('INSERT INTO opencrawlIdentityState VALUES(?,0)').run(org);sqlite.close();
  }
  const options={database,store,source,eventIdentities,organizationId:org,url,secret,identityPath,registryPath};
  const run=(mode,extra={})=>migrateApplicationState({...options,mode,...extra});
  return {...options,run,raw,directory};
}
async function retained(f){
  const controlKey=`${prefix}/${sessionScope(owner)}/controls/sessions/codex/${digest('retained-private')}.json`;
  const onboardingKey=`${prefix}/${sessionScope(owner)}/onboarding/cli.json`;
  const control={schemaVersion:1,visibility:'private',deletedAt:null,updatedAt:'2026-11-01T00:00:00.000Z'};
  await f.store.put(controlKey,Buffer.from(JSON.stringify(control)));await f.store.put(onboardingKey,Buffer.from(JSON.stringify({observedAt:'2026-11-01T01:00:00.000Z'})));
  return {controlKey,onboardingKey,control};
}

live('fresh concurrent initialization serializes and startup verifies its completed binding',async t=>{
  const f=await fixture(t);assert.equal((await f.run('check')).fresh,true);await assert.rejects(requireApplicationStateReady(f.database));
  await assert.rejects(f.run('migrate',{writersStopped:true,expectExisting:true}),/Expected an existing installation/);
  await assert.rejects(requireApplicationStateReady(f.database));
  const results=await Promise.all([f.run('migrate'),f.run('migrate')]);assert.equal(results.filter(r=>r.alreadyReady).length,1);
  assert.equal(new Set(results.map(r=>r.migrationId)).size,1);await requireApplicationStateReady(f.database);
  const verified=await f.run('verify');assert.equal(verified.ready,true);assert.equal(verified.sources,2);
  const bad={...f.source,prefix:'another/source'};await assert.rejects(f.run('migrate',{source:bad}),/bound to another/);
});

live('existing installation requires stopped writers and preserves source bytes and private state',async t=>{
  const f=await fixture(t,{legacy:true}),r=await retained(f),sqliteBefore=hash(await readFile(f.identityPath)),rawBefore=await f.store.get(r.controlKey);
  assert.equal((await f.run('check')).requiresStoppedWriters,true);
  await assert.rejects(f.run('migrate'),/writers-stopped/);await assert.rejects(requireApplicationStateReady(f.database));
  const result=await f.run('migrate',{writersStopped:true});assert.equal(result.mutableObjects,2);assert.equal(result.ready,true);
  const state=await createApplicationState({database:f.database});assert.deepEqual(await state.controls.read(owner,'sessions','codex','retained-private'),r.control);
  assert.equal(hash(await readFile(f.identityPath)),sqliteBefore);assert.deepEqual(await f.store.get(r.controlKey),rawBefore);
  const receipt=(await f.database.pool.query('SELECT source_hash FROM opencrawl_application_migrations WHERE namespace=$1 AND source_key=$2',[f.database.namespace,r.controlKey])).rows[0];assert.equal(receipt.source_hash,hash(rawBefore));
  // New app writes must never be overwritten by retained legacy objects on restart.
  await state.accounts.onboarding.write(sessionScope(owner),'cli',{observedAt:'2026-11-15T00:00:00.000Z'});
  assert.equal((await f.run('migrate')).alreadyReady,true);assert.equal((await state.accounts.onboarding.read(sessionScope(owner),'cli')).observedAt,'2026-11-15T00:00:00.000Z');
});

live('interrupted import resumes its inventory; altered or missing old objects fail closed',async t=>{
  const f=await fixture(t,{legacy:true}),r=await retained(f),original=await f.store.get(r.onboardingKey);let calls=0,failed=false;
  const store={...f.store,async readVersion(key,options){if(key===r.onboardingKey&&++calls===2&&!failed){failed=true;throw new Error('Injected storage interruption');}return f.store.readVersion(key,options);}};
  await assert.rejects(f.run('migrate',{store,writersStopped:true}),/Injected storage/);
  const installation=(await f.database.pool.query('SELECT migration_id,state,inventory_complete FROM opencrawl_application_installations WHERE namespace=$1',[f.database.namespace])).rows[0];assert.equal(installation.state,'importing');assert.equal(installation.inventory_complete,true);
  await assert.rejects(requireApplicationStateReady(f.database));
  await f.store.put(r.onboardingKey,Buffer.from(JSON.stringify({observedAt:'2026-11-02T00:00:00.000Z'})));
  await assert.rejects(f.run('migrate',{writersStopped:true}),/source changed/);
  await f.store.put(r.onboardingKey,original);
  const resumed=await f.run('migrate',{writersStopped:true});assert.equal(resumed.migrationId,installation.migration_id);assert.equal(resumed.ready,true);
});

live('unknown state and conflicting PostgreSQL records never get silently replaced',async t=>{
  const f=await fixture(t,{legacy:true}),r=await retained(f);
  const state=await createApplicationState({database:f.database});await state.controls.update(owner,'sessions','codex','retained-private',()=>({visibility:'team',deletedAt:null}));
  await assert.rejects(f.run('migrate',{writersStopped:true}),/conflicts/);await assert.rejects(requireApplicationStateReady(f.database));
  assert.equal((await state.controls.read(owner,'sessions','codex','retained-private')).visibility,'team');
  const other=await fixture(t,{legacy:true});await other.store.put(prefix+'/unknown-runtime-state.json',Buffer.from('{}'));
  await assert.rejects(other.run('check'),{code:'APPLICATION_MIGRATION_UNSAFE'});
});

live('post-import source mutation blocks readiness and retained receipt damage blocks restart verification',async t=>{
  const f=await fixture(t,{legacy:true}),r=await retained(f);let calls=0;
  const store={...f.store,async listPage(path,options){const page=await f.store.listPage(path,options);if(path===prefix+'/'&&++calls===2){await f.store.put(r.onboardingKey,Buffer.from(JSON.stringify({observedAt:'2026-11-03T00:00:00.000Z'})));}return page;}};
  await assert.rejects(f.run('migrate',{store,writersStopped:true}),/changed/);await assert.rejects(requireApplicationStateReady(f.database));
  const fresh=await fixture(t);await fresh.run('migrate');
  await fresh.database.pool.query('DELETE FROM opencrawl_application_migrations WHERE namespace=$1 AND source_key=$2',[fresh.database.namespace,'sqlite:registry']);
  await assert.rejects(fresh.run('verify'),/receipts/);
});
