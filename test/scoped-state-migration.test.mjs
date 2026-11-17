import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applicationDatabaseFixture} from './fixtures/application-database.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';
import {migrateScopedState} from '../dist/src/state/migrate.mjs';
import {requireScopedState} from '../dist/src/state/scoped.mjs';
import {createPostgresBoardState} from '../dist/src/state/board.mjs';
import {createBoard} from '../dist/src/board/board.mjs';
const organizationId='org_scoped',prefix='sessions/scoped/v1',bucket='scoped-test';
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'scoped-state-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const sourceIdentity={version:1,bucket,prefix,organizationId},database=await applicationDatabaseFixture(t,{sourceIdentity});
 const store=Object.assign(memorySessionStore(),{bucket});
 const input={database,store,prefix,organizationId,url:'http://localhost:3000',secret:'scoped-test-secret-longer-than-thirty-two',identityPath:join(dir,'identity.sqlite'),registryPath:join(dir,'registry.sqlite')};
 return {...input,run:options=>migrateScopedState({...input,...options})};
}
test('fresh scoped initialization admits only the exact source and completed import',async t=>{
 const f=await fixture(t);
 assert.equal((await f.run({mode:'check'})).ready,false);
 await assert.rejects(requireScopedState(f.database),/initialization/);
 assert.equal((await f.run({mode:'migrate'})).ready,true);await requireScopedState(f.database);
 assert.equal((await f.run({mode:'verify'})).reused,true);
 await assert.rejects(f.run({mode:'verify',organizationId:'org_foreign'}),/binding/);
});
test('scoped upgrade imports board history, preserves unrelated controls and never replays stale sources',async t=>{
 const f=await fixture(t),tenant=createHash('sha256').update(organizationId).digest('hex');
 const original={schema:1,messages:[],agents:{},usage:{calls:0,inputBytes:0,outputBytes:0}};
 const key=prefix+'/board/tenants/'+tenant+'.json';await f.store.put(key,JSON.stringify(original));
 const control=prefix+'/retained-control.json';await f.store.put(control,'{"deleted":true}');
 await assert.rejects(f.run({mode:'migrate'}),/Stop application/);
 await f.run({mode:'migrate',writersStopped:true});
 const repository=createPostgresBoardState(f.database);await repository.ready();
 assert.deepEqual(await repository.exportLegacy(tenant),original);
 const board=createBoard({state:{namespace:f.database.namespace,board:repository}});
 await board.sync({tenantId:organizationId,userId:'user_owner'},{workspace:organizationId,agent:'test',posts:[{id:'new',topic:'work',text:'New PostgreSQL write'}]});
 await f.run({mode:'migrate',writersStopped:true,expectExisting:true});
 assert.equal((await repository.exportLegacy(tenant)).messages.length,1);
 assert.equal((await f.store.readVersion(control)).data.toString(),'{"deleted":true}');
 assert.equal((await f.store.readVersion(key)).data.toString(),JSON.stringify(original));
});
test('a whole-application migration cannot silently fall back to older object controls',async t=>{
 const f=await fixture(t);
 await f.database.pool.query("INSERT INTO opencrawl_application_installations(namespace,source_identity,migration_id,state,verified_at) VALUES($1,$2::jsonb,$3,'ready',now())",[f.database.namespace,JSON.stringify(f.database.sourceIdentity),randomUUID()]);
 await assert.rejects(f.run({mode:'migrate'}),/Whole-application/);
 await assert.rejects(requireScopedState(f.database),/retired whole-application/);
});
test('existing installs missing identity and changed partially imported sources fail closed',async t=>{
 const f=await fixture(t);await assert.rejects(f.run({mode:'migrate',writersStopped:true,expectExisting:true}),/no legacy identity/);
 await f.database.pool.query("INSERT INTO opencrawl_scoped_installations(namespace,source_identity,source_hash,state) VALUES($1,$2::jsonb,$3,'importing')",[f.database.namespace,JSON.stringify(f.database.sourceIdentity),'0'.repeat(64)]);
 await assert.rejects(f.run({mode:'migrate',writersStopped:true}),/Source changed/);
 await assert.rejects(requireScopedState(f.database),/initialization/);
});
