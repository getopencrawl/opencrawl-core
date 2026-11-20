import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
import {initializeApplicationState} from '../dist/src/state/initialize.mjs';
import {requireScopedState} from '../dist/src/state/scoped.mjs';
const organizationId='org_scoped',prefix='sessions/scoped/v1',bucket='scoped-test',skip=!postgresUrl;
async function fixture(t){
 const sourceIdentity={version:1,bucket,prefix,organizationId},database=await applicationDatabaseFixture(t,{sourceIdentity});
 const input={database,bucket,prefix,organizationId,url:'http://localhost:3000',secret:'scoped-test-secret-longer-than-thirty-two'};
 return {database,run:(command,options={})=>initializeApplicationState({...input,...options,command})};
}
const retiredTables=['opencrawl_application_migrations','opencrawl_application_migration_sources','opencrawl_application_installations'];
async function retiredTablesIn(database){
 const {rows}=await database.pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1::text[])`,[retiredTables]);
 return rows.map(row=>row.table_name).sort();
}
test('a fresh database is not ready until initialized, and initialization is idempotent',{skip},async t=>{
 const f=await fixture(t);
 await assert.rejects(f.run('verify'),/not been initialized/);
 await assert.rejects(requireScopedState(f.database),/initialization/);
 assert.deepEqual(await f.run('initialize'),{command:'initialize',ready:true,created:true});await requireScopedState(f.database);
 assert.deepEqual(await f.run('verify'),{command:'verify',ready:true,created:false});
 assert.deepEqual(await f.run('initialize'),{command:'initialize',ready:true,created:false});
 assert.deepEqual(await f.run('verify'),{command:'verify',ready:true,created:false});
});
test('a fresh scoped install never creates the retired whole-application migration schema',{skip},async t=>{
 const f=await fixture(t);
 // A previous run of the legacy-install case may have left the tombstone table
 // in the shared test database; clear it so this assertion reflects only the
 // schema that this installation's ready() creates.
 await f.database.pool.query(`DROP TABLE IF EXISTS ${retiredTables.join(', ')}`);
 assert.deepEqual(await f.run('initialize'),{command:'initialize',ready:true,created:true});
 assert.deepEqual(await retiredTablesIn(f.database),[]);
 await requireScopedState(f.database);
 assert.deepEqual(await f.run('verify'),{command:'verify',ready:true,created:false});
});
test('initialization admits only the exact configured binding and known commands',{skip},async t=>{
 const f=await fixture(t);
 await assert.rejects(f.run('initialize',{organizationId:'org_foreign'}),/binding/);
 await assert.rejects(f.run('initialize',{bucket:'another-bucket'}),/binding/);
 await assert.rejects(f.run('migrate'),/binding/);
 await assert.rejects(requireScopedState(f.database),/initialization/);
});
test('an interrupted initialization resumes and an unsupported earlier installation is refused',{skip},async t=>{
 const f=await fixture(t);await f.run('initialize');
 await f.database.pool.query("UPDATE opencrawl_scoped_installations SET state='importing',verified_at=NULL WHERE namespace=$1",[f.database.namespace]);
 await assert.rejects(f.run('verify'),/not been initialized/);
 assert.equal((await f.run('initialize')).created,true);await requireScopedState(f.database);
 const other=await fixture(t);
 // A legacy installation carries the retired table from its own release. Fresh
 // installs no longer create it, so recreate that shape to test the guard.
 await other.database.pool.query(`CREATE TABLE opencrawl_application_installations (
   namespace text PRIMARY KEY, source_identity jsonb NOT NULL, migration_id uuid NOT NULL,
   state text NOT NULL, verified_at timestamptz)`);
 await other.database.pool.query("INSERT INTO opencrawl_application_installations(namespace,source_identity,migration_id,state,verified_at) VALUES($1,$2::jsonb,$3,'ready',now())",[other.database.namespace,JSON.stringify(other.database.sourceIdentity),randomUUID()]);
 await assert.rejects(other.run('initialize'),/unsupported earlier installation/);
 await assert.rejects(requireScopedState(other.database),/retired whole-application/);
});
