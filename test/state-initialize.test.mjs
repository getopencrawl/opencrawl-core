import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
import {allocatedCredentialPrefix,initializeApplicationState} from '../dist/src/state/initialize.mjs';
import {requireScopedState} from '../dist/src/state/scoped.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';
import {createCaptureCredentials} from '../dist/src/sessions/credentials.mjs';
import {createCredentialState} from '../dist/src/state/credentials.mjs';
import {main as credentialCommand} from '../dist/src/selfhost/credential-state.mjs';
const organizationId='org_scoped',prefix='sessions/scoped/v1',bucket='scoped-test',skip=!postgresUrl;
test('bundled storage allocation applies only to the exact default Compose source',()=>{
 const env={OPENCRAWL_LANDING_S3_BUCKET:'opencrawl',OPENCRAWL_LANDING_S3_ENDPOINT:'http://s3:8333',OPENCRAWL_BUNDLED_CREDENTIAL_VOLUME_NEW:'1'};
 const bundled='sessions/self-hosted/v1';
 assert.equal(allocatedCredentialPrefix(env,bundled),bundled);
 assert.equal(allocatedCredentialPrefix({...env,OPENCRAWL_BUNDLED_CREDENTIAL_VOLUME_NEW:''},bundled),undefined);
 assert.equal(allocatedCredentialPrefix({...env,OPENCRAWL_LANDING_S3_ENDPOINT:'https://retained.example'},bundled),undefined);
 assert.equal(allocatedCredentialPrefix({...env,OPENCRAWL_LANDING_S3_BUCKET:'retained'},bundled),undefined);
 assert.equal(allocatedCredentialPrefix(env,'custom/retained'),undefined);
});
async function fixture(t){
 const sourceIdentity={version:1,bucket,prefix,organizationId},database=await applicationDatabaseFixture(t,{sourceIdentity});
 const input={database,bucket,prefix,organizationId,url:'http://localhost:3000',secret:'scoped-test-secret-longer-than-thirty-two'};
 return {database,run:(command,options={})=>initializeApplicationState({...input,...options,command})};
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
test('initialization admits only the exact configured binding and known commands',{skip},async t=>{
 const f=await fixture(t);
 await assert.rejects(f.run('initialize',{organizationId:'org_foreign'}),/binding/);
 await assert.rejects(f.run('initialize',{bucket:'another-bucket'}),/binding/);
 await assert.rejects(f.run('migrate'),/binding/);
 await assert.rejects(requireScopedState(f.database),/initialization/);
});
test('self-host initializes credential authority once and leaves ready installations on their existing backend',{skip},async t=>{
 const objects=memorySessionStore(),owner={tenantId:organizationId,userId:'user_operator'};
 const store={...objects,bucket,async listPage(key,options){
   const page=await objects.listPage(key,options);
   if(!options.delimiter)return page;
   assert.equal(page.keys.length,0,'No onboarding owner directories in this fixture');
   return {...page,prefixes:[]};
 }};
 const previouslyReady=await fixture(t),empty=await fixture(t),allocated=await fixture(t);
 const open=f=>createCredentialState(f.database,store,prefix);
 await previouslyReady.run('initialize'); // Ready installation from before the credential migration.
 assert.equal((await previouslyReady.run('initialize',{store,allocatedLandingPrefix:prefix})).created,false);
 assert.equal(await open(previouslyReady).active(),false);
 await empty.run('initialize',{store,allocatedLandingPrefix:'different/prefix'});
 assert.equal(await open(empty).active(),false);
 await allocated.run('initialize',{store,allocatedLandingPrefix:prefix});
 assert.equal(await open(allocated).active(),true);
 const legacy=createCaptureCredentials({store,prefix}),retained=await legacy.issue(owner);
 const reused=await fixture(t);
 await reused.run('initialize',{store,allocatedLandingPrefix:prefix});
 assert.equal((await reused.run('verify',{store,allocatedLandingPrefix:prefix})).ready,true);
 const bridge=open(reused);
 assert.equal(await bridge.active(),false);
 assert.equal((await bridge.credentials('capture').authenticate(retained.token)).userId,owner.userId);
 assert.equal((await bridge.migrate('activate')).backend,'postgres');
 await assert.rejects(credentialCommand(['activate'],{}),/--legacy-writers-drained/);
});
test('an interrupted initialization resumes and an unsupported earlier installation is refused',{skip},async t=>{
 const f=await fixture(t);await f.run('initialize');
 await f.database.pool.query("UPDATE opencrawl_scoped_installations SET state='importing',verified_at=NULL WHERE namespace=$1",[f.database.namespace]);
 await assert.rejects(f.run('verify'),/not been initialized/);
 assert.equal((await f.run('initialize')).created,true);await requireScopedState(f.database);
 const other=await fixture(t);
 await other.database.pool.query("INSERT INTO opencrawl_application_installations(namespace,source_identity,migration_id,state,verified_at) VALUES($1,$2::jsonb,$3,'ready',now())",[other.database.namespace,JSON.stringify(other.database.sourceIdentity),randomUUID()]);
 await assert.rejects(other.run('initialize'),/unsupported earlier installation/);
 await assert.rejects(requireScopedState(other.database),/retired whole-application/);
});
