import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {betterAuth} from 'better-auth';
import {getSchema} from 'better-auth/db';
import {getMigrations} from 'better-auth/db/migration';
import {identityOptions,createLocalIdentity} from '../dist/src/identity/better-auth.mjs';
import {migrateIdentitySqlite} from '../dist/src/state/identity-migration.mjs';
import {migrateRegistrySqlite} from '../dist/src/state/registry-migration.mjs';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
const live=(name,run)=>test(name,{skip:!postgresUrl},run);
const organizationId='org_migration',url='http://localhost:3000',secret='test-only-long-auth-secret-for-migration',password='unchanged-existing-password';
const quote=value=>'"'+value.replaceAll('"','""')+'"';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function scratch(t){const root=await mkdtemp(join(tmpdir(),'opencrawl-sqlite-import-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function legacyIdentity(t,database){
  const path=join(await scratch(t),'identity.sqlite'),sqlite=new DatabaseSync(path);
  const options={url,secret,database,organizationId},config={...await identityOptions(options),database:sqlite};
  await (await getMigrations(config)).runMigrations();const auth=betterAuth(config);
  const response=await auth.api.signUpEmail({body:{email:'existing@example.test',name:'Existing Owner',password},asResponse:true});
  assert.equal(response.status,200);const account=await response.json(),cookie=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  const keys=await auth.api.getJwks(),schema=getSchema(config),pending=Object.keys(schema),now=Date.now(),ids={};
  // Populate every provider table, not only the happy-path user/password rows.
  // The source uses the actual pinned Better Auth SQLite schema and adapter.
  while(pending.length){
    const index=pending.findIndex(name=>Object.values(schema[name].fields).every(field=>!field.references||!pending.includes(field.references.model)));
    assert.notEqual(index,-1);const name=pending.splice(index,1)[0],existing=sqlite.prepare(`SELECT * FROM ${quote(name)} LIMIT 1`).get();
    if(existing){ids[name]=existing;continue;}
    const row={id:name==='organization'?organizationId:'legacy-'+name};
    for(const [field,attr] of Object.entries(schema[name].fields)){
      if(attr.references){row[field]=ids[attr.references.model][attr.references.field];continue;}
      row[field]=attr.type==='date'?now+86400_000:attr.type==='boolean'?0:attr.type==='number'?2:attr.type==='json'?JSON.stringify({preserved:true,nested:['original']}):attr.type==='string[]'?JSON.stringify(['openid','offline_access']):attr.type==='number[]'?JSON.stringify([1,2]):name+'-'+field;
    }
    if(name==='organization')Object.assign(row,{name:'Existing workspace',slug:'existing-workspace',createdAt:now});
    if(name==='member')row.role='admin';
    if(name==='invitation')Object.assign(row,{email:'invited@example.test',role:'member',status:'pending'});
    if(name==='oauthClient')Object.assign(row,{clientId:'opencrawl-cli',redirectUris:'[]',grantTypes:JSON.stringify(['refresh_token','urn:ietf:params:oauth:grant-type:device_code']),tokenEndpointAuthMethod:'none'});
    if(name==='deviceCode')Object.assign(row,{userId:account.user.id,status:'approved'});
    if(name==='verification')row.value=JSON.stringify({type:'authorization_code',userId:account.user.id});
    if(name==='rateLimit')row.lastRequest=now;
    const fields=Object.keys(row);sqlite.prepare(`INSERT INTO ${quote(name)} (${fields.map(quote).join(',')}) VALUES(${fields.map(()=>'?').join(',')})`).run(...Object.values(row));ids[name]=row;
  }
  sqlite.exec('CREATE TABLE opencrawlIdentityBinding(singleton INTEGER PRIMARY KEY CHECK(singleton=1),organizationId TEXT NOT NULL);CREATE TABLE opencrawlIdentityState(organizationId TEXT PRIMARY KEY,initialized INTEGER NOT NULL);CREATE TABLE opencrawlAccountEpoch(userId TEXT PRIMARY KEY,notBefore INTEGER NOT NULL)');
  sqlite.prepare('INSERT INTO opencrawlIdentityBinding VALUES(1,?)').run(organizationId);
  sqlite.prepare('INSERT INTO opencrawlIdentityState VALUES(?,1)').run(organizationId);
  const epoch=Math.floor(now/1000)-10;sqlite.prepare('INSERT INTO opencrawlAccountEpoch VALUES(?,?)').run(account.user.id,epoch);
  sqlite.close();return {path,options,cookie,keys,account,epoch};
}
live('offline identity migration preserves all provider tables, keys, cookie, passwords and revocation epoch',async t=>{
  const database=await applicationDatabaseFixture(t),f=await legacyIdentity(t,database),before=hash(await readFile(f.path));
  const checked=await migrateIdentitySqlite({...f.options,path:f.path,mode:'check'});
  assert.equal(checked.verified,false);assert.ok(checked.tables.every(table=>table.target===null));
  const migrated=await migrateIdentitySqlite({...f.options,path:f.path,mode:'migrate'});
  assert.ok(migrated.verified);assert.ok(migrated.tables.length>=20);assert.ok(migrated.tables.every(table=>table.source.rows>0&&table.matches));
  assert.deepEqual((await migrateIdentitySqlite({...f.options,path:f.path,mode:'migrate'})).tables,migrated.tables);
  assert.equal((await migrateIdentitySqlite({...f.options,path:f.path,mode:'verify'})).verified,true);
  assert.equal(hash(await readFile(f.path)),before,'read-only source remains byte-identical');
  const identity=await createLocalIdentity(f.options);await identity.ready();
  assert.equal(await identity.setupRequired(),false);assert.deepEqual(await identity.auth.api.getJwks(),f.keys);
  const session=await identity.auth.api.getSession({headers:new Headers({cookie:f.cookie})});assert.equal(session.user.id,f.account.user.id);
  assert.equal(await identity.tokenCurrent(f.account.user.id,f.epoch-1),false);assert.equal(await identity.tokenCurrent(f.account.user.id,f.epoch),true);
  const signed=await identity.auth.api.signInEmail({body:{email:'existing@example.test',password}});assert.equal(signed.user.id,f.account.user.id);
  assert.equal((await identity.directory.userManagement.listOrganizationMemberships({organizationId,userId:f.account.user.id})).data[0].role.slug,'admin');
  await identity.recoverPassword('existing@example.test','new-password-after-migration');
  assert.equal(await identity.auth.api.getSession({headers:new Headers({cookie:f.cookie})}),null);
  assert.equal(await identity.tokenCurrent(f.account.user.id,f.epoch),false);
});
live('identity import detects a conflicting target and rolls back every newly copied row',async t=>{
  const database=await applicationDatabaseFixture(t),f=await legacyIdentity(t,database);
  await migrateIdentitySqlite({...f.options,path:f.path,mode:'migrate'});
  await database.identityPool.query('UPDATE "user" SET name=$1 WHERE id=$2',['Conflicting target',f.account.user.id]);
  await database.identityPool.query('DELETE FROM "opencrawlAccountEpoch"');
  await assert.rejects(migrateIdentitySqlite({...f.options,path:f.path,mode:'migrate'}),/verification failed/);
  assert.equal((await database.identityPool.query('SELECT count(*)::int AS n FROM "opencrawlAccountEpoch"')).rows[0].n,0);
  await assert.rejects(migrateIdentitySqlite({...f.options,path:f.path,mode:'verify'}),/verification failed/);
});
live('unknown legacy identity tables and foreign binding fail before target schema creation',async t=>{
  const database=await applicationDatabaseFixture(t),f=await legacyIdentity(t,database),sqlite=new DatabaseSync(f.path);
  await assert.rejects(migrateIdentitySqlite({...f.options,path:f.path,organizationId:'org_foreign',mode:'check'}),/different organization/);
  sqlite.exec('CREATE TABLE future_tokens(id TEXT PRIMARY KEY)');sqlite.close();
  await assert.rejects(migrateIdentitySqlite({...f.options,path:f.path,mode:'migrate'}),/unknown tables/);
  assert.equal((await database.identityPool.query('SELECT to_regclass($1) AS name',[database.identitySchema+'.user'])).rows[0].name,null);
});
live('registry importer preserves pending intents and every original field with exact scoped hashes',async t=>{
  const database=await applicationDatabaseFixture(t),path=join(await scratch(t),'registry.sqlite'),source=new DatabaseSync(path);
  source.exec('CREATE TABLE integration_binding(id INTEGER PRIMARY KEY,organization TEXT NOT NULL,environment TEXT NOT NULL);CREATE TABLE integrations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,record TEXT NOT NULL)');
  source.prepare('INSERT INTO integration_binding VALUES(1,?,?)').run(organizationId,'selfhost');
  const record={tenantId:organizationId,userId:'user_owner',integrationId:'int_'+'a'.repeat(26),environment:'selfhost',provider:'slack',scope:'team',status:'disconnecting',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-02-01T00:00:00Z',resourceVersion:'original-version',provisionIntent:{resource:'sourceId',workspaceId:'workspace',name:'source',attemptId:'attempt',requestedAt:'2026-02-01T00:00:00Z'},airbyte:{connectionId:'existing-connection'}};
  source.prepare('INSERT INTO integrations VALUES(?,?,?)').run(record.integrationId,record.userId,JSON.stringify(record));source.close();
  const input={database,path,organizationId},before=hash(await readFile(path));
  assert.equal((await migrateRegistrySqlite({...input,mode:'check'})).verified,false);
  const migrated=await migrateRegistrySqlite({...input,mode:'migrate'});assert.ok(migrated.verified);
  assert.deepEqual((await migrateRegistrySqlite({...input,mode:'migrate'})).tables,migrated.tables);
  assert.equal((await migrateRegistrySqlite({...input,mode:'verify'})).verified,true);
  assert.deepEqual((await database.pool.query('SELECT record FROM opencrawl_integrations WHERE namespace=$1',[database.namespace])).rows[0].record,record);
  assert.equal(hash(await readFile(path)),before);
  await assert.rejects(migrateRegistrySqlite({...input,organizationId:'org_foreign',mode:'check'}),/another organization/);
  await database.pool.query("UPDATE opencrawl_integrations SET record=jsonb_set(record,'{resourceVersion}','\"changed\"') WHERE namespace=$1",[database.namespace]);
  await assert.rejects(migrateRegistrySqlite({...input,mode:'migrate'}),/verification failed/);
});
