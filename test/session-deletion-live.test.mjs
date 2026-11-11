import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createObjectStore,signRequest} from '../dist/src/sessions/s3-store.mjs';
import {createSessionIngest,digest,sessionScope} from '../dist/src/sessions/ingest.mjs';
import {createSessionSearch} from '../dist/src/sessions/search.mjs';
import {createSessionLibrary} from '../dist/src/sessions/library.mjs';
import {createSessionPipeline} from '../dist/src/sessions/indexer.mjs';
import {createRecentSessions} from '../dist/src/sessions/recent.mjs';
import {realmIndex} from '../dist/src/search/realm.mjs';

const endpoint=process.env.OPENCRAWL_TEST_OPENSEARCH_URL,s3=process.env.OPENCRAWL_TEST_S3_ENDPOINT;
test('versioned S3 and real OpenSearch: erasure removes every raw version and blocks replay after restart',{skip:!endpoint||!s3},async t=>{
  const run=randomUUID(),bucket='delete-'+run,environment='delete-'+run.slice(0,8),prefix='capture/v1';
  const owner={tenantId:'delete-'+run,userId:'user_alice'},peer={...owner,userId:'user_bob'};
  const credentials={accessKeyId:'capture-test',secretAccessKey:'capture-test-secret'};
  async function s3request(method,query={},body){
    const url=new URL(s3+'/'+bucket+'/');for(const [k,v]of Object.entries(query))url.searchParams.set(k,v);
    const res=await fetch(url,{method,body,headers:signRequest({method,url,body,region:'us-east-1',...credentials})});
    assert.ok(res.ok,`${method} ${url}: ${res.status}`);return res;
  }
  await s3request('PUT');
  const store=createObjectStore({endpoint:s3,bucket,credentials}),options={store,prefix,endpoint,environment};
  t.after(async()=>{
    await store.purgePrefix(prefix+'/');
    await fetch(endpoint+'/'+realmIndex(environment,owner.tenantId),{method:'DELETE'});
    await s3request('DELETE');
  });
  await s3request('PUT',{versioning:''},'<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>');
  assert.match(await (await s3request('GET',{versioning:''})).text(),/<Status>Enabled<\/Status>/);
  const ingest=createSessionIngest(options),search=createSessionSearch(options),library=createSessionLibrary(options);
  await search.ensureIndex(owner);
  const pipeline=createSessionPipeline({...options,search,principal:owner});
  const value={schemaVersion:1,owner,harness:'codex',installationId:'device',sessionId:'delete-me',origin:'desktop',events:[{id:'one',kind:'message',data:{role:'user',content:'verifiable erasure '+run}}],attachments:[]};
  const blob=Buffer.from('private attachment '+run),sha=digest(blob);
  value.attachments=[{status:'captured',sha256:sha}];
  await ingest.putAttachment(owner,sha,blob,value);
  const receipt=await ingest.putBatch(owner,value),root=`${prefix}/${sessionScope(owner)}/codex/${digest('device')}/${digest('delete-me')}/`,key=root+receipt.batchId+'.json.gz';
  await store.put(key,await store.get(key)); // a historical raw version
  const recovery=root+'passage-backups/v2/recovery.backup';
  await store.put(recovery,Buffer.from('old derived transcript recovery'));
  await store.put(recovery,Buffer.from('new derived transcript recovery')); // every backup version must also be erased
  await pipeline.processObject({key});await search.refresh(owner);
  const found=await search.search(peer,{query:run});assert.ok(found.hits.length);
  await library.read(peer,{userId:owner.userId,harness:value.harness,sessionId:value.sessionId}); // warm rendered cache
  const result=await library.delete(owner,value);assert.equal(result.deleted,true,JSON.stringify(result));
  assert.equal((await search.search(peer,{query:run})).hits.length,0);
  assert.equal((await search.search(peer,{id:found.hits[0].id})).hits.length,0);
  await assert.rejects(library.read(peer,{userId:owner.userId,harness:value.harness,sessionId:value.sessionId}),{status:404});
  assert.equal(await ingest.getBatch(peer,{...value,...receipt,userId:owner.userId}),null);
  assert.equal((await createRecentSessions(options).read(peer)).length,0);
  assert.deepEqual((await store.listPage(root)).keys,[]);
  const versions=await (await s3request('GET',{versions:'',prefix:root})).text();
  assert.doesNotMatch(versions,/<(?:Version|DeleteMarker)>/);
  const restarted=createSessionIngest(options);
  assert.equal((await restarted.putBatch(owner,{...value,installationId:'new-install',captureMode:'history'})).discarded,'session_deleted');
  assert.equal((await restarted.putAttachment(owner,sha,blob,{...value,installationId:'new-install'})).discarded,'session_deleted');
  assert.equal((await pipeline.processObject({key})).skipped,true);
  assert.equal((await createSessionLibrary(options).delete(owner,value)).deleted,true);
});
