import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync,gunzipSync} from 'node:zlib';
import {purgeSessionArchives} from '../dist/src/sessions/deletion-archives.mjs';
import {createSessionIngest, digest, sessionScope} from '../dist/src/sessions/ingest.mjs';
import {createSessionLibrary} from '../dist/src/sessions/library.mjs';
import {createSessionPipeline} from '../dist/src/sessions/indexer.mjs';
import {createSessionSearch} from '../dist/src/sessions/search.mjs';
import {createControls} from '../dist/src/sessions/controls.mjs';
import {sessionWriteBarrier} from '../dist/src/sessions/write-barrier.mjs';
import {createObjectStore} from '../dist/src/sessions/s3-store.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';
import {realmResponse} from './realm-fixture.mjs';

const owner={tenantId:'org_test',userId:'user_alice'}, peer={...owner,userId:'user_bob'}, prefix='sessions/test/v1';
const batch=(overrides={})=>({schemaVersion:1,owner,harness:'codex',installationId:'laptop',sessionId:'native-session',origin:'desktop',
  events:[{id:'event',kind:'message',data:{role:'user',content:'erase-this-transcript'}}],attachments:[],...overrides});
const pause=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture() {
  const store=memorySessionStore(), docs=new Map();let searchFailure=false;
  const match=(query,doc)=>{
    if(!query||typeof query!=='object')return true;
    if(query.term)return Object.entries(query.term).every(([key,value])=>key==='corpus'?value==='session':doc[key.replace(/^session\./,'')]===value);
    if(query.bool)return [...query.bool.filter??[],...query.bool.must??[]].every(q=>match(q,doc));
    return true;
  };
  const options={store,prefix,endpoint:'http://search.test',environment:'deletion',fetch:async(url,init)=>{
    const body=init.body?JSON.parse(init.body):{};
    const hits=[...docs].filter(([,doc])=>match(body.query,doc)).map(([id,doc])=>({_id:id,_score:1,_source:doc}));
    if(url.pathname.endsWith('_search'))return realmResponse('session',{hits:{total:{value:hits.length,relation:'eq'},hits:body.size===0?[]:hits},...(body.aggs?{aggregations:{sessions:{buckets:[]}}}:{})});
    if(url.pathname.endsWith('_delete_by_query')){
      if(searchFailure)return Response.json({failures:[{reason:'unavailable'}],deleted:0});
      for(const hit of hits)docs.delete(hit._id);
      return Response.json({failures:[],deleted:hits.length,version_conflicts:0});
    }
    if(url.pathname.endsWith('_refresh'))return Response.json({_shards:{failed:0}});
    throw Error('Unexpected request: '+url);
  }};
  const ingest=createSessionIngest({store,prefix}), library=()=>createSessionLibrary(options), search=createSessionSearch(options);
  const projection={identity:'deletion-test',ensureIndex:async()=>{},putDocuments:async items=>{for(const item of items)docs.set(item.id,item.document);},
    applySessionControl:async(p,key)=>{for(const [id,doc]of docs)if(doc.tenantId===p.tenantId&&doc.userId===p.userId&&doc.harness===key.harness&&doc.sessionId===key.sessionId)docs.delete(id);}};
  const pipeline=()=>createSessionPipeline({store,prefix,search:projection,resolvePrincipal:async({batch})=>batch.owner});
  const upload=async value=>{const receipt=await ingest.putBatch(value.owner,value);const key=`${prefix}/${sessionScope(value.owner)}/${value.harness}/${digest(value.installationId)}/${digest(value.sessionId)}/${receipt.batchId}.json.gz`;await pipeline().processObject({key});return {key,receipt};};
  return {store,docs,ingest,library,search,projection,pipeline,upload,setSearchFailure:value=>searchFailure=value};
}

test('permanent deletion covers installations, attachments, stale search IDs and replay while preserving other owners',async()=>{
  const f=fixture(), value=batch(), bytes=Buffer.from('erase-this-attachment'), sha=digest(bytes);
  value.attachments=[{status:'captured',sha256:sha}];
  await f.ingest.putAttachment(owner,sha,bytes,value);
  const first=await f.upload(value);
  await f.upload(batch({installationId:'second-install',events:[{id:'second',kind:'message',data:{role:'user',content:'erase-second-install'}}]}));
  await f.upload(batch({owner:peer}));
  await f.upload(batch({owner:{...owner,tenantId:'org_other'}}));
  const stale=[...f.docs].filter(([,d])=>d.tenantId===owner.tenantId&&d.userId===owner.userId);
  assert.equal((await f.search.search(peer)).hits.length,3);
  await assert.rejects(f.library().delete({...owner,userId:'user_stranger'},value),{status:404});
  await assert.rejects(f.library().delete({...owner,captureAccess:'write'},value),{status:403});
  const result=await f.library().delete(owner,value);
  assert.equal(result.deleted,true);
  assert.equal((await f.search.search(peer)).hits.length,1);
  assert.equal(await f.ingest.getBatch(peer,{...value,...first.receipt,userId:owner.userId}),null);
  assert.ok(![...f.store.data.entries()].filter(([k])=>k.startsWith(`${prefix}/${sessionScope(owner)}/`)).some(([,v])=>v.includes(bytes)));
  for(const [id,doc]of stale)f.docs.set(id,doc); // stale replica / restored index
  assert.equal((await f.search.search(peer)).hits.length,1);
  assert.equal((await f.search.search(owner,{id:stale[0][0],raw:true})).hits.hits.length,0);
  const restarted=createSessionIngest({store:f.store,prefix});
  assert.equal((await restarted.putBatch(owner,{...value,installationId:'brand-new',captureMode:'history'})).discarded,'session_deleted');
  assert.equal((await restarted.putAttachment(owner,sha,bytes,{...value,installationId:'brand-new'})).discarded,'session_deleted');
  await assert.rejects(restarted.putAttachment(owner,sha,bytes),{status:409});
  assert.equal((await f.pipeline().processObject({key:first.key})).skipped,true);
  assert.equal((await f.library().delete(owner,value)).deleted,true,'delete retry no longer requires a search document');
  assert.equal((await sessionWriteBarrier(f.store,prefix,owner,value.harness,value.sessionId).inspect()).closed,true);
});

test('an upload already in flight cannot outlive successful erasure',async()=>{
  const f=fixture(), value=batch();await f.upload(value);
  const started=pause(), resume=pause(), put=f.store.put;
  f.store.put=async(key,bytes,type)=>{if(key.endsWith('.json.gz')){started.resolve();await resume.promise;}return put(key,bytes,type);};
  const late=batch({installationId:'late',events:[{id:'late',kind:'message',data:{content:'late secret'}}]});
  const uploading=createSessionIngest({store:f.store,prefix}).putBatch(owner,late);await started.promise;
  assert.equal((await f.library().delete(owner,value)).pending,true);
  assert.equal((await f.search.search(peer)).hits.length,0);
  resume.resolve();await uploading;
  assert.equal((await f.library().delete(owner,value)).deleted,true);
  assert.equal([...f.store.data.keys()].filter(k=>k.endsWith('.json.gz')).length,0);
});

test('index writers are fenced, and failed raw/search cleanup stays revoked and retryable after restart',async()=>{
  const f=fixture(), value=batch();await f.upload(value);
  const started=pause(), resume=pause(), put=f.projection.putDocuments;
  f.projection.putDocuments=async items=>{started.resolve();await resume.promise;return put(items);};
  const late=batch({installationId:'late',events:[{id:'late',kind:'message',data:{content:'late index secret'}}]});
  const indexing=f.upload(late);await started.promise;
  assert.equal((await f.library().delete(owner,value)).pending,true);
  resume.resolve();await indexing;
  const purge=f.store.purgePrefix;f.store.purgePrefix=async()=>{throw Error('AccessDenied');};
  assert.equal((await f.library().delete(owner,value)).pending,true);
  const control=await createControls({store:f.store,prefix}).read(owner,'sessions','codex',value.sessionId);
  assert.equal(control.deletion.state,'pending');
  assert.equal((await f.search.search(peer)).hits.length,0);
  assert.deepEqual((await f.library().list(owner)).deletions,[{harness:'codex',sessionId:value.sessionId}]);
  f.store.purgePrefix=purge;f.setSearchFailure(true);
  assert.equal((await f.library().delete(owner,value)).pending,true);
  f.setSearchFailure(false);
  assert.equal((await f.library().delete(owner,value)).deleted,true);
  assert.equal((await f.library().list(owner)).deletions.length,0);
});

test('uncertain writes never expire into a false successful deletion',async()=>{
  const f=fixture(), value=batch();await f.upload(value);
  const fence=sessionWriteBarrier(f.store,prefix,owner,value.harness,value.sessionId);
  await assert.rejects(fence.run('object-put',async()=>{throw Error('Lost remote response');}),/uncertain/);
  assert.equal((await f.library().delete(owner,value)).pending,true);
  assert.equal((await f.library().delete(owner,value)).pending,true);
  assert.equal((await f.search.search(peer)).hits.length,0);
});

test('legacy owner-scoped attachment bytes are purged before deleting their last manifest',async()=>{
  const f=fixture(), value=batch(), sha=digest('legacy bytes');value.attachments=[{status:'captured',sha256:sha}];
  await f.store.put(`${prefix}/${sessionScope(owner)}/attachments/${sha}`,Buffer.from('legacy bytes'));
  await f.upload(value);
  assert.equal((await f.library().delete(owner,value)).deleted,true);
  assert.equal(await f.store.get(`${prefix}/${sessionScope(owner)}/attachments/${sha}`),null);
});

test('S3 erasure enumerates old versions and delete markers, paginates and verifies absence',async()=>{
  const versions=new Map([['raw/a:001',{key:'raw/a',id:'001',body:'old text'}],['raw/a:002',{key:'raw/a',id:'002',body:'new text'}],['raw/a:003',{key:'raw/a',id:'003',marker:true}],['raw/b:001',{key:'raw/b',id:'001',body:'keep'}]]);
  const reads=[],deleted=[];
  const store=createObjectStore({bucket:'test',endpoint:'https://s3.test',credentials:{accessKeyId:'test',secretAccessKey:'test'},fetch:async(url,init)=>{
    const key=decodeURIComponent(url.pathname.replace('/test/','')), version=url.searchParams.get('versionId');
    if(url.searchParams.has('versions')){
      const marker=url.searchParams.get('key-marker'),vid=url.searchParams.get('version-id-marker');
      const remaining=[...versions].filter(([id,item])=>item.key.startsWith(url.searchParams.get('prefix'))&&(!marker||id>marker+':'+vid));
      const selected=remaining.slice(0,1), truncated=remaining.length>1,last=selected.at(-1)?.[1];
      return new Response(`<ListVersionsResult><IsTruncated>${truncated}</IsTruncated>${selected.map(([,v])=>`<${v.marker?'DeleteMarker':'Version'}><Key>${v.key}</Key><VersionId>${v.id}</VersionId></${v.marker?'DeleteMarker':'Version'}>`).join('')}${truncated?`<NextKeyMarker>${last.key}</NextKeyMarker><NextVersionIdMarker>${last.id}</NextVersionIdMarker>`:''}</ListVersionsResult>`);
    }
    if(init.method==='DELETE'){deleted.push([key,version]);versions.delete(key+':'+version);return new Response(null,{status:204});}
    if(version){reads.push(version);return new Response(versions.get(key+':'+version).body);}
    if(url.searchParams.has('list-type'))return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>');
    throw Error('Unexpected S3 operation');
  }});
  assert.equal(await store.purgePrefix('raw/',{select:key=>key==='raw/a',beforeDelete:async(_,read)=>{assert.match((await read()).toString(),/text/);}}),3);
  assert.deepEqual(reads,['001','002']);assert.equal(deleted.length,3);assert.equal(versions.size,1);assert.ok(versions.has('raw/b:001'));
});

test('search cannot bypass deletion controls when storage is absent or unavailable',async()=>{
  await assert.rejects(createSessionSearch({endpoint:'http://unused'}).search(owner),{status:503});
  const f=fixture();await f.upload(batch());f.store.readVersion=async()=>{throw Error('Storage down');};
  await assert.rejects(f.search.search(peer),/Storage down/);
});

test('migration archives lose only the deleted session and preserve unrelated records durably',async()=>{
  const store=memorySessionStore(),root='capture/_index/backups/',key=root+'page.json.gz';
  const deleted={id:'deleted',document:{...owner,harness:'codex',sessionId:'native-session',text:'erase-this-copy'}};
  const kept={id:'kept',document:{...peer,harness:'codex',sessionId:'native-session',text:'preserve-other-owner'}};
  await store.put(key,gzipSync(JSON.stringify({previous:[deleted,kept]})));
  const options={store,roots:[root],principal:owner,harness:'codex',sessionId:'native-session'};
  const put=store.put;store.put=async()=>{throw Error('Cannot preserve backup');};
  await assert.rejects(purgeSessionArchives(options),/preserve/);assert.ok(await store.get(key));
  store.put=put;assert.equal(await purgeSessionArchives(options),1);assert.equal(await store.get(key),null);
  const remaining=[...store.data.values()].map(v=>JSON.parse(gunzipSync(v)));
  assert.deepEqual(remaining,[{previous:[kept]}]);
  assert.equal(await purgeSessionArchives(options),0);
});
