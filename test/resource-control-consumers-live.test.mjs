import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import test from 'node:test';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
import {createResourceControlState} from '../dist/src/state/resource-controls.mjs';
import {createPostgresResourceControls} from '../dist/src/state/postgres-resource-controls.mjs';
import {createObjectStore} from '../dist/src/sessions/s3-store.mjs';
import {createSessionIngest,createCaptureHandler} from '../dist/src/sessions/ingest.mjs';
import {createSessionLibrary} from '../dist/src/sessions/library.mjs';
import {createMemoryLibrary} from '../dist/src/memories/library.mjs';
import {createLibraryApi} from '../dist/src/sessions/library-http.mjs';
import {createRecentSessions} from '../dist/src/sessions/recent.mjs';
import {createSessionPipeline} from '../dist/src/sessions/indexer.mjs';
import {createSessionSearch} from '../dist/src/sessions/search.mjs';
import {createWorkspaceSearch} from '../dist/src/search/workspace.mjs';
import {createRealm,realmIndex} from '../dist/src/search/realm.mjs';
import {sessionDeletionActivities} from '../dist/src/sessions/temporal/deletion.mjs';
import {restoreSessionProjection} from '../dist/src/sessions/projection-migration.mjs';
import {restoreSessionDocumentIds} from '../dist/src/sessions/document-identity.mjs';

const endpoint=process.env.OPENCRAWL_TEST_OPENSEARCH_URL,s3=process.env.OPENCRAWL_TEST_S3_ENDPOINT;
test('warm and restarted API, index, restore and deletion consumers honor PostgreSQL while search still holds shared projections',
  {skip:!postgresUrl||!endpoint||!s3,timeout:300000},async t=>{
  const run=randomUUID(),environment='acl-'+run.slice(0,8),prefix='controls-fixtures/'+run,bucket='capture-test';
  const alice={tenantId:'org_a',userId:'user_a'},bob={...alice,userId:'user_b'},other={...alice,tenantId:'org_b'};
  const database=await applicationDatabaseFixture(t,{sourceIdentity:{version:1,bucket,prefix,organizationId:null}});
  const raw=createObjectStore({endpoint:s3,bucket,credentials:{accessKeyId:'capture-test',secretAccessKey:'capture-test-secret'}});
  t.after(async()=>{
    await raw.purgePrefix(prefix+'/');
    for(const owner of [alice,other])await fetch(endpoint+'/'+realmIndex(environment,owner.tenantId),{method:'DELETE'});
  });
  const store={...raw};
  let retired=false,freezeProjection=false;
  const retiredCalls=[];
  for(const method of ['get','put','readVersion','compareAndSet','delete','listPage']){
    store[method]=async(key,...args)=>{
      if(retired&&/\/controls\/(sessions|memories)(?:\/|$)/.test(key)){
        retiredCalls.push(method);
        throw Object.assign(Error('Retired control path'),{status:403});
      }
      return raw[method](key,...args);
    };
  }
  const base={endpoint,environment,store,prefix,fetch:(url,...args)=>{
    if(freezeProjection&&url.pathname.endsWith('_update_by_query'))throw Error('Synthetic projection outage');
    return fetch(url,...args);
  }};
  const jobs=[];
  const open=(state=createPostgresResourceControls(database))=>{
    const options={...base,controls:state.controls};
    const search=createSessionSearch(options),pipeline=createSessionPipeline({...options,search,resolvePrincipal:async({batch})=>batch.owner});
    const ingest=createSessionIngest({...options,scheduleIndexing:key=>pipeline.processObject({key})});
    const api=createLibraryApi({sessions:createSessionLibrary({...options,scheduleDeletion:async key=>jobs.push(key)}),memories:createMemoryLibrary(options)});
    return {state,options,api,ingest,search,workspace:createWorkspaceSearch({sessions:search}),recent:createRecentSessions(options)};
  };
  const warm=open(createResourceControlState(database,store,prefix));
  await warm.state.ready();
  const harness='codex',installationId='fixture',privateId='private-after-switch',eraseId='pending-at-switch',memoryPath='memory/private.md',retainedId='private-before-switch',retainedPath='memory/retained.md';
  const session=(sessionId)=>({harness,sessionId}),ownerKey=sessionId=>({...session(sessionId),userId:alice.userId});
  const value=(owner,sessionId,text)=>({schemaVersion:1,owner,harness,sessionId,installationId,origin:'cli',attachments:[],
    events:[{id:'msg',kind:'message',timestamp:new Date().toISOString(),sequence:1,data:{role:'user',content:text}}]});
  const toHide=value(alice,privateId,'lighthouse owner chapter'),toErase=value(alice,eraseId,'harbor pending erasure');
  const privateBatch=await warm.ingest.putBatch(alice,toHide);
  const eraseBatch=await warm.ingest.putBatch(alice,toErase);
  await warm.ingest.putBatch(alice,value(alice,retainedId,'retained owner session'));
  await warm.ingest.putBatch(other,value(other,privateId,'orchard other organization'));
  await warm.ingest.putMemorySnapshot(alice,{schemaVersion:1,owner:alice,installationId,host:'fixture',harness:'claude-code',generation:Date.now()-1000,
    files:[{path:memoryPath,project:'fixture',modifiedAt:'2026-01-01T00:00:00.000Z',text:'lighthouse memory chapter'},
      {path:retainedPath,project:'fixture',modifiedAt:'2026-01-01T00:00:00.000Z',text:'retained owner memory'}]});
  await warm.search.refresh(alice);await warm.search.refresh(other);

  const rawKey={...ownerKey(privateId),installationId,batchId:privateBatch.batchId};
  const eraseKey={...ownerKey(eraseId),installationId,batchId:eraseBatch.batchId};
  const memoryKey={userId:alice.userId,harness:'claude-code',path:memoryPath};
  const sharedHits=async(runtime,principal,source,query)=> (await runtime.workspace.search(principal,{source,query})).results;
  const members=new Map([['owner',alice],['peer',bob],['other',other]]);
  const server=createServer(createCaptureHandler({ingest:warm.ingest,authenticate:req=>members.get(req.headers.authorization)}));
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const rawStatus=async(member,key)=>{
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/sessions/batches?'+new URLSearchParams(key),{headers:{authorization:member}});
    const body=await response.json();
    if(response.ok)assert.equal(body.data.sessionId,key.sessionId);
    else assert.equal(body.error.code,'NOT_FOUND');
    return response.status;
  };
  // Warm the raw, rendered transcript, recent-session and workspace fetch paths before the switch.
  assert.equal(await rawStatus('peer',rawKey),200);
  assert.ok(await warm.ingest.getBatch(bob,rawKey));
  assert.ok((await warm.api(bob,'sessions/read',ownerKey(privateId))).events.length);
  assert.equal((await warm.api(bob,'memories/read',memoryKey)).text,'lighthouse memory chapter');
  const sharedSession=(await sharedHits(warm,bob,'sessions','lighthouse'))[0],sharedMemory=(await sharedHits(warm,bob,'memories','lighthouse'))[0];
  const recent=(await warm.recent.read(bob)).find(row=>row.sessionId===privateId);
  assert.ok(sharedSession&&sharedMemory&&recent);
  const realm=createRealm({...base,tenantId:alice.tenantId}),collection=realm.collection('session');
  const before=await collection.search(alice,{size:5,query:{terms:{'session.sessionId':[privateId,eraseId]}}});
  const archived=id=>{
    const row=before.hits.hits.find(hit=>hit._source.sessionId===id);
    assert.ok(row);
    return {id:row._id,document:{...row._source,private:false}};
  };
  const privateCopy=archived(privateId),erasedCopy=archived(eraseId);

  await warm.api(alice,'sessions/visibility',{...session(retainedId),visibility:'private'});
  await warm.api(alice,'memories/visibility',{harness:memoryKey.harness,path:retainedPath,visibility:'private'});
  assert.equal((await warm.api(alice,'sessions/delete',session(eraseId))).pending,true);
  assert.equal(jobs.length,1);
  const receipt=await warm.state.activate(async()=>{});
  assert.deepEqual([receipt.sessions,receipt.memories],[2,1]);
  assert.deepEqual(await warm.state.verify(),receipt);
  retired=true;
  const fresh=open();await fresh.state.ready();

  freezeProjection=true;
  await assert.rejects(fresh.api(alice,'sessions/visibility',{...session(privateId),visibility:'private'}));
  await assert.rejects(fresh.api(alice,'memories/visibility',{harness:memoryKey.harness,path:memoryKey.path,visibility:'private'}));
  freezeProjection=false;
  assert.equal((await fresh.state.controls.read(alice,'sessions',harness,privateId)).visibility,'private');
  assert.equal((await fresh.state.controls.read(alice,'memories',memoryKey.harness,memoryPath)).visibility,'private');
  assert.notEqual((await collection.mget(alice,[privateCopy.id])).docs[0]._source.private,true);
  assert.equal(await rawStatus('owner',rawKey),200);
  assert.equal(await rawStatus('peer',rawKey),404);
  assert.equal(await rawStatus('other',rawKey),404);
  assert.equal(await rawStatus('owner',eraseKey),404);
  for(const runtime of [warm,fresh]){
    assert.ok(await runtime.ingest.getBatch(alice,rawKey));
    assert.equal(await runtime.ingest.getBatch(alice,eraseKey),null);
    await assert.rejects(runtime.api(alice,'sessions/read',ownerKey(eraseId)),{status:404});
    assert.equal(await runtime.ingest.getBatch(bob,rawKey),null);
    assert.equal(await runtime.ingest.getBatch(other,rawKey),null);
    const ownerRead=await runtime.api(alice,'sessions/read',ownerKey(privateId));
    assert.ok(ownerRead.events.length);
    assert.equal(ownerRead.session.private,true);
    assert.equal((await runtime.api(alice,'sessions/list',{})).sessions.find(row=>row.sessionId===privateId).private,true);
    assert.equal((await runtime.api(alice,'sessions/read',ownerKey(retainedId))).session.private,true);
    await assert.rejects(runtime.api(bob,'sessions/read',ownerKey(retainedId)),{status:404});
    await assert.rejects(runtime.api(bob,'sessions/read',ownerKey(privateId)),{status:404});
    const ownerMemory=await runtime.api(alice,'memories/read',memoryKey);
    assert.equal(ownerMemory.text,'lighthouse memory chapter');
    assert.equal(ownerMemory.memory.private,true);
    assert.equal((await runtime.api(alice,'memories/list',{})).memories.find(row=>row.path===memoryPath).private,true);
    assert.equal((await runtime.api(alice,'memories/read',{...memoryKey,path:retainedPath})).memory.private,true);
    await assert.rejects(runtime.api(bob,'memories/read',{...memoryKey,path:retainedPath}),{status:404});
    await assert.rejects(runtime.api(bob,'memories/read',memoryKey),{status:404});
    assert.ok(!(await runtime.api(bob,'sessions/list',{})).sessions.some(row=>row.sessionId===privateId||row.sessionId===eraseId));
    assert.equal((await runtime.api(bob,'memories/list',{})).memories.length,0);
    await assert.rejects(runtime.recent.fetch(bob,recent.id),{status:404});
    assert.equal((await runtime.recent.fetch(alice,recent.id)).sessionId,privateId);
    for(const [source,hit] of [['sessions',sharedSession],['memories',sharedMemory]]){
      assert.equal((await sharedHits(runtime,bob,source,'lighthouse')).length,0);
      assert.equal((await sharedHits(runtime,other,source,'lighthouse')).length,0);
      await assert.rejects(runtime.workspace.fetch(bob,{id:hit.id}),{status:404});
      await assert.rejects(runtime.workspace.fetch(other,{id:hit.id}),{status:404});
      assert.ok(await runtime.workspace.fetch(alice,{id:hit.id}));
    }
    assert.equal((await sharedHits(runtime,other,'sessions','orchard')).length,1);
    assert.equal((await sharedHits(runtime,alice,'sessions','orchard')).length,0);
    await assert.rejects(runtime.api({...alice,captureAccess:'write'},'sessions/read',ownerKey(privateId)),{status:403});
  }

  // Rebuilding a projection from pre-switch data must honor the current SQL decision, including the tombstone.
  for(const restore of [
    item=>restoreSessionProjection({...fresh.options,realm,principal:alice,steps:[{previous:[item]}]}),
    item=>restoreSessionDocumentIds({...fresh.options,realm,principal:alice,steps:[{removed:[item],written:[]}]}),
  ]){
    await restore(privateCopy);
    assert.equal((await collection.mget(alice,[privateCopy.id])).docs[0]._source.private,true);
    await assert.rejects(restore(erasedCopy),{status:403});
  }
  // Exercise the same activity entry points as Temporal, with a fresh binding at each stage.
  const {MockActivityEnvironment}=await import('@temporalio/testing');
  const activity=new MockActivityEnvironment();
  const worker=()=>sessionDeletionActivities(async()=>open().options);
  const input={sourceId:'synthetic-control-test',key:jobs[0]};
  assert.deepEqual((await activity.run(worker().listSessionDeletionRequests,{sourceId:input.sourceId})).keys,[input.key]);
  for(const stage of ['prepareSessionDeletion','purgeSessionDeletionArchives','finishSessionDeletion']){
    assert.deepEqual(await activity.run(worker()[stage],input),{skipped:false});
  }
  assert.deepEqual(await activity.run(worker().finishSessionDeletion,input),{skipped:true});
  assert.equal((await warm.state.controls.read(alice,'sessions',harness,eraseId)).deletion.state,'complete');
  assert.equal(await warm.ingest.getBatch(alice,eraseKey),null);
  assert.equal((await warm.ingest.putBatch(alice,toErase)).discarded,'session_deleted');
  assert.equal((await sharedHits(warm,alice,'sessions','harbor')).length,0);
  assert.deepEqual(retiredCalls,[]);
  const predecessor=createSessionIngest({store,prefix});
  await assert.rejects(predecessor.getBatch(bob,rawKey),{status:403});
  assert.deepEqual(retiredCalls,['readVersion']);
});
