import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
import {createBoundObjectMigration} from '../dist/src/state/object-migration.mjs';
import {createRetiredSessionReceipts,retiredSessionLocations} from '../dist/src/state/retired-session-receipts.mjs';
import {createPostgresIndexingReceipts} from '../dist/src/state/indexing-receipts.mjs';
import {digest} from '../dist/src/sessions/event-identity.mjs';
const date='2026-11-16T00:00:00.000Z',prefix='sessions/selfhost/v1',bucket='fixture-retired-sessions';
const proof={tenantId:'temporal-deletion-canary-fixture',userId:'fixture-user',harness:'codex',sessionId:'fixture-deleted-session',proof:'original synthetic canary receipt'};
const scope=retiredSessionLocations(prefix,proof),sourceKey=prefix+'/tenants/'+scope.tenantHash+'/users/'+scope.userHash+'/codex/'+digest('installation')+'/'+scope.sessionHash+'/'+digest('batch')+'.json.gz';
const encode=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
async function fixture(t){
 const database=await applicationDatabaseFixture(t),objects=new Map(),control={schemaVersion:1,visibility:'private',deletedAt:date,updatedAt:date,deletion:{sessionId:proof.sessionId,state:'complete'}},fence={version:1,namespace:'sessions',tenantId:scope.tenantHash,connectionId:scope.connectionId,closedAt:123,writers:[]};
 objects.set(scope.controlKey,encode(control));objects.set(scope.fenceKey,encode(fence));
 const store={bucket,get:async key=>objects.get(key)??null,listPage:async start=>({keys:[...objects.keys()].filter(key=>key.startsWith(start)).sort(),nextToken:null}),put:async()=>assert.fail('Legacy source write'),compareAndSet:async()=>assert.fail('Legacy source write')};
 const options={database,prefix,store,tenantIds:['org_active'],retiredTenantHashes:[scope.tenantHash],retiredSessionProofs:[proof],registryRecords:[],eventIdentities:{}};
 const importer=(extra={})=>createBoundObjectMigration({...options,...extra});
 const receipt=(status='indexed')=>{const key=prefix+'/_index/'+digest(status)+'/'.concat(digest('job'))+'/batches/'+digest(sourceKey)+'.json',value=status==='indexed'?{status,sourceKey,documents:3,indexedAt:date,deleted:false}:{status,sourceKey,attempts:2,lastAttempt:date,nextAttempt:123,error:'INDEXING_FAILED'};return {key,value,bytes:encode(value)};};
 return {database,objects,control,fence,options,importer,receipt,audit:createRetiredSessionReceipts(database)};
}
test('reviewed retired completed/failed receipts preserve exact bytes and proof across restart without live skip authority',{skip:!postgresUrl},async t=>{
 const f=await fixture(t),runtime=createPostgresIndexingReceipts(f.database);await runtime.ready();
 for(const status of ['indexed','failed']){const {key,value,bytes}=f.receipt(status);f.objects.set(key,bytes);assert.equal(f.importer().sessionReceipt(key,bytes),null);const before=await f.importer().process(key,bytes,{write:false});assert.equal(before.target,null);assert.equal(await f.audit.exportRetirement(bucket,key),null);
  const written=await f.importer().process(key,bytes,{write:true});assert.deepEqual(written.target,written.source);assert.deepEqual(written.target.receipt,value);assert.deepEqual(Buffer.from(written.target.sourceBytesBase64,'base64'),bytes);assert.equal(written.target.sourceHash,digest(bytes));assert.equal(written.target.evidence.controlHash,digest(f.objects.get(scope.controlKey)));assert.equal(written.target.evidence.fenceHash,digest(f.objects.get(scope.fenceKey)));
  assert.deepEqual((await f.importer().process(key,bytes,{write:true})).target,written.target);assert.deepEqual((await f.importer().process(key,bytes,{write:false})).target,written.target);assert.equal(await runtime.read(key),null);assert.deepEqual(f.objects.get(key),bytes);
 }
 const other=await applicationDatabaseFixture(t);assert.equal(await createRetiredSessionReceipts(other).exportRetirement(bucket,f.receipt().key),null);
});
test('retired receipt proof rejects missing, unrelated, open, unsettled and live-source cases before importing',{skip:!postgresUrl},async t=>{
 const cases=[['missing owner',f=>f.importer({retiredSessionProofs:[]})],['wrong user',f=>f.importer({retiredSessionProofs:[{...proof,userId:'another-user'}]})],['missing control',f=>{f.objects.delete(scope.controlKey);return f.importer();}],['not deleted',f=>{f.objects.set(scope.controlKey,encode({...f.control,deletedAt:null}));return f.importer();}],['pending deletion',f=>{f.objects.set(scope.controlKey,encode({...f.control,deletion:{sessionId:proof.sessionId,state:'pending'}}));return f.importer();}],['wrong resource',f=>{f.objects.set(scope.controlKey,encode({...f.control,deletion:{sessionId:'another-session',state:'complete'}}));return f.importer();}],['missing fence',f=>{f.objects.delete(scope.fenceKey);return f.importer();}],['open fence',f=>{f.objects.set(scope.fenceKey,encode({...f.fence,closedAt:null}));return f.importer();}],['wrong fence scope',f=>{f.objects.set(scope.fenceKey,encode({...f.fence,connectionId:digest('other')}));return f.importer();}],['retained writer',f=>{f.objects.set(scope.fenceKey,encode({...f.fence,writers:[{id:'w',operation:'search-write',phase:'settled',startedAt:1,settledAt:2,instance:'old',target:'old'}]}));return f.importer();}],['raw source exists',f=>{f.objects.set(sourceKey,Buffer.alloc(0));return f.importer();}]];
 for(const [name,change]of cases)await t.test(name,async t=>{const f=await fixture(t),{key,bytes}=f.receipt();await assert.rejects(change(f).process(key,bytes,{write:true}));assert.equal(await f.audit.exportRetirement(bucket,key),null);});
});
test('proof list validation and active/unknown receipt semantics remain strict',{skip:!postgresUrl},async t=>{
 const f=await fixture(t),{key,value,bytes}=f.receipt();assert.throws(()=>f.importer({retiredSessionProofs:[proof,proof]}),/duplicated/);assert.throws(()=>f.importer({retiredSessionProofs:[{...proof,tenantId:'org_active'}]}),/unknown, active/);assert.throws(()=>f.importer({retiredTenantHashes:[]}),/unknown, active/);
 const unknown=value.sourceKey.replace(scope.tenantHash,digest('org_unknown')),unknownKey=key.replace(digest(sourceKey),digest(unknown));assert.throws(()=>f.importer().sessionReceipt(unknownKey,encode({...value,sourceKey:unknown})),/owner hash/);await assert.rejects(f.importer().process(key,encode({...value,sourceKey:unknown}),{write:true}),/identity mismatch/);
 const active=value.sourceKey.replace(scope.tenantHash,digest('org_active')),activeKey=key.replace(digest(sourceKey),digest(active)),activeBytes=encode({...value,sourceKey:active});assert.ok(f.importer().sessionReceipt(activeKey,activeBytes));const imported=await f.importer().process(activeKey,activeBytes,{write:true});assert.deepEqual(imported.target,JSON.parse(activeBytes));assert.equal(await f.audit.exportRetirement(bucket,activeKey),null);
 await assert.rejects(f.importer().process(key,encode({...value,extra:true}),{write:true}));
});
test('retirement resume rejects changed original bytes, changed proof and target corruption without overwriting',{skip:!postgresUrl},async t=>{
 const f=await fixture(t),{key,value,bytes}=f.receipt(),original=await f.importer().process(key,bytes,{write:true});
 await assert.rejects(f.importer().process(key,Buffer.from(JSON.stringify(value)),{write:true}),/differs/);assert.deepEqual(await f.audit.exportRetirement(bucket,key),original.target);
 f.objects.set(scope.controlKey,encode({...f.control,updatedAt:'2026-11-16T00:00:01.000Z'}));await assert.rejects(f.importer().process(key,bytes,{write:true}),/differs/);assert.deepEqual(await f.audit.exportRetirement(bucket,key),original.target);
 await assert.rejects(f.audit.importRetirement({...original.target,key:key+'bad'}),/binding differs/);assert.deepEqual(await f.audit.exportRetirement(bucket,key),original.target);
 await f.database.pool.query('UPDATE opencrawl_retired_session_receipts SET documents=documents+1 WHERE namespace=$1',[f.database.namespace]);await assert.rejects(f.audit.exportRetirement(bucket,key),/binding differs/);
});
