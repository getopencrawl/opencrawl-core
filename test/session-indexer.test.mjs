import {gunzipSync} from 'node:zlib';
import {realmIndex} from '../src/search/realm.mjs';
import {realmResponse} from './realm-fixture.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createSessionIngest,digest,sessionScope} from '../src/sessions/ingest.mjs';
import {createSessionPipeline,batchDocuments} from '../src/sessions/indexer.mjs';
import {createSessionSearch} from '../src/sessions/search.mjs';
import {runConnectorSegment} from '../src/connectors/workflow.mjs';
import {standaloneStorage} from '../src/sessions/standalone.mjs';

function memoryStore(){
 const data=new Map();return {data,put:async(k,v)=>{data.set(k,Buffer.from(v));},get:async k=>data.get(k)||null,delete:async k=>{data.delete(k);},
 listPage:async(prefix,{continuationToken,maxKeys})=>{const keys=[...data.keys()].filter(k=>k.startsWith(prefix)&&(!continuationToken||k>continuationToken)).sort();return {keys:keys.slice(0,maxKeys),nextToken:keys.length>maxKeys?keys[maxKeys-1]:null};}};
}
async function sweep(pipeline) {
 return runConnectorSegment({}, {listPage:input=>pipeline.listPage(input),processObject:async input=>{
  const result=await pipeline.processObject(input);return {records:result.skipped?0:1};
 }});
}
const owner={tenantId:'tenant-a',userId:'same-user'};
function batch(principal,text='unique transcript words') {return {schemaVersion:1,owner:principal,harness:'codex',origin:'desktop',installationId:'same-device',sessionId:'same-session',events:[{id:'same-event',kind:'message',data:{role:'user',content:[{type:'input_text',text}]}}],attachments:[]};}

test('fixed-scope indexing, checkpoints, crash replay and poison records cannot cross tenant/user scope',async()=>{
 const store=memoryStore(),prefix='sessions/test/v1',ingest=createSessionIngest({store,prefix});
 const otherTenant={...owner,tenantId:'tenant-b'},otherUser={...owner,userId:'other-user'};
 for(const principal of [owner,otherTenant,otherUser])await ingest.putBatch(principal,batch(principal));
 const docs=new Map();let fail=true;const search={identity:'test-index',ensureIndex:async()=>{},putDocuments:async items=>{for(const d of items)docs.set(d.id,d.document);if(fail)throw new Error('Interrupted after write');}};
 let time=0;const options={store,prefix,search,principal:owner,now:()=>time};
 let worker=createSessionPipeline(options);
 assert.equal((await sweep(worker)).failed,1);assert.equal(docs.size,1);
 fail=false;time=10000;worker=createSessionPipeline(options);
 assert.equal((await sweep(worker)).indexed,1);assert.equal(docs.size,1);
 assert.equal((await sweep(worker)).indexed,0);
 assert.ok([...docs.values()].every(d=>d.tenantId===owner.tenantId&&d.userId===owner.userId));
 const hosted=createSessionPipeline({store,prefix,search,resolvePrincipal:async({batch})=>batch.owner});
 assert.equal((await sweep(hosted)).indexed,3);assert.equal(docs.size,3);
 const key=[...store.data.keys()].find(k=>k.startsWith(prefix+'/'+sessionScope(owner))&&k.endsWith('.json.gz'));
 const forged={...batch(otherTenant),receivedAt:new Date().toISOString()};
 assert.throws(()=>batchDocuments({prefix,key,batch:forged,principal:otherTenant}),/authorized scope/);
 // Long events become line-aware passages of at most 8000 characters, losing nothing.
 const stored=JSON.parse(gunzipSync(store.data.get(key)));
 const long=Array.from({length:900},(_,i)=>`row ${i}: `+'tool output '.repeat(i%12)).join('\n');
 stored.events[0].data.content[0].text=long;
 const parts=batchDocuments({prefix,key,batch:stored,principal:owner}).filter(d=>d.document.eventId==='same-event');
 assert.ok(parts.length>1&&parts.every(d=>d.document.text.length<=8000));
 assert.equal(parts.map(d=>d.document.text).join('\n'),long);
 assert.deepEqual(parts.map(d=>d.document.chunk),parts.map((_,i)=>i));
 assert.throws(()=>createSessionPipeline({store,prefix,search}),/fixed single-tenant principal/);
});

test('bulk item errors are failures even with HTTP 200; search binds the team and retains human attribution',async()=>{
 const requests=[];
 const search=createSessionSearch({endpoint:'http://localhost:9200',index:'sessions-test',fetch:async(url,options)=>{
  requests.push(JSON.parse(options.body));
  if(url.pathname.endsWith('_bulk'))return realmResponse('session',{errors:true,items:[{index:{status:429}}]});
  return realmResponse('session',{hits:{total:{value:0},hits:[]}});
 }});
 // Replace the fake parser for NDJSON, then retain the observed search body.
 const failing=createSessionSearch({endpoint:'http://localhost:9200',index:'sessions-test',fetch:async()=>realmResponse('session',{errors:true,items:[{index:{status:429}}]})});
 await assert.rejects(failing.putDocuments([{id:'id',document:{tenantId:owner.tenantId,harness:'codex',receivedAt:'2026-11-01T00:00:00Z',text:'retry me'}}],owner),/failed or missing items/);
 await search.search(owner,{query:'tenant-b OR *'});
 assert.deepEqual(requests[0].query.bool.filter,[{term:{tenantId:'tenant-a'}},{term:{corpus:'session'}}]);
 await assert.rejects(search.search(null,{query:'anything'}),/Authentication/);
 await assert.rejects(search.search(owner,{limit:501}),/Invalid search/);
 const leaking=createSessionSearch({endpoint:'http://localhost:9200',index:'sessions-test',fetch:async()=>realmResponse('session',{hits:{total:{value:1},hits:[{_id:'foreign',_source:{tenantId:'tenant-b',userId:'same-user'}}]}})});
 await assert.rejects(leaking.search(owner),/ownership scope/);
});

test('real S3 to OpenSearch pipeline: incremental replay, text/tool retrieval, team visibility and tenant isolation',{
 skip:!process.env.OPENCRAWL_TEST_S3_ENDPOINT||!process.env.OPENCRAWL_TEST_OPENSEARCH_URL,
},async t=>{
 const environment='test-'+randomUUID().slice(0,8),index=realmIndex(environment,owner.tenantId),prefix='sessions/index-test/'+randomUUID();
 const {store}=standaloneStorage({OPENCRAWL_LANDING_S3_ENDPOINT:process.env.OPENCRAWL_TEST_S3_ENDPOINT,OPENCRAWL_LANDING_S3_BUCKET:'capture-test',OPENCRAWL_LANDING_S3_ACCESS_KEY_ID:'capture-test',OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY:'capture-test-secret'});
 const search=createSessionSearch({endpoint:process.env.OPENCRAWL_TEST_OPENSEARCH_URL,environment});
 for(let attempt=0;;attempt++){try{await store.checkAccess();await search.ensureIndex(owner);break;}catch(e){if(attempt>=60)throw e;await new Promise(r=>setTimeout(r,1000));}}
 t.after(async()=>{for(const key of (await store.list(prefix+'/')).keys)await store.delete(key);for(const tenantId of [owner.tenantId,'tenant-b'])await fetch(process.env.OPENCRAWL_TEST_OPENSEARCH_URL+'/'+realmIndex(environment,tenantId),{method:'DELETE'});});
 const ingest=createSessionIngest({store,prefix});
 const owners=[owner,{...owner,tenantId:'tenant-b'},{...owner,userId:'other-user'}];
 for(const principal of owners)await search.ensureIndex(principal);
 for(const principal of owners){
  const bytes=Buffer.from('attachment fixture'),sha=digest(bytes);await ingest.putAttachment(principal,sha,bytes);
  for(const harness of ['claude-code','codex'])for(const origin of ['cli','desktop']){
  const b=batch(principal,'searchable violet attachment workflow');b.harness=harness;b.origin=origin;b.sessionId+='-'+origin;
  b.events[0].data.content.push({type:'opencrawl_attachment',sha256:sha,size:bytes.length});b.attachments=[{status:'captured',sha256:sha,size:bytes.length}];
  b.events.push({id:'tool-event',kind:'tool_result',data:{call_id:'tool-1',output:'Build completed successfully'}});
  await ingest.putBatch(principal,b);
 }}
 const single=createSessionPipeline({store,prefix,search,principal:owner});
 assert.equal((await sweep(single)).indexed,4);for(const principal of owners)await search.refresh(principal);
 assert.equal((await search.search(owner,{query:'violet'})).total,4);
 assert.equal((await search.search(owners[1],{query:'violet'})).total,0);
 const hosted=createSessionPipeline({store,prefix,search,resolvePrincipal:async({batch})=>batch.owner});
 assert.equal((await sweep(hosted)).indexed,12);for(const principal of owners)await search.refresh(principal);
 for(const principal of owners){
  const expected=principal.tenantId===owner.tenantId?8:4;
  const result=await search.search(principal,{query:'violet'});assert.equal(result.total,expected);
  assert.ok(result.hits.every(hit=>hit.attachments.every(a=>a.objectKey.startsWith(prefix+'/'+sessionScope(hit)+'/attachments/'))));
  assert.ok(result.hits.every(hit=>hit.tenantId===principal.tenantId));
  assert.deepEqual(new Set(result.hits.map(hit=>hit.userId)),new Set(owners.filter(p=>p.tenantId===principal.tenantId).map(p=>p.userId)));
  assert.equal((await search.search(principal,{query:'Build completed'})).total,expected);
 }
 const restarted=createSessionPipeline({store,prefix,search,resolvePrincipal:async({batch})=>batch.owner});
 assert.equal((await sweep(restarted)).indexed,0);
 assert.equal((await search.search(owner)).total,16);
 const later=batch(owner,'new incremental indigo message');later.events[0].id='later-event';
 await ingest.putBatch(owner,later);assert.equal((await sweep(restarted)).indexed,1);for(const principal of owners)await search.refresh(principal);
 assert.equal((await search.search(owner,{query:'indigo'})).total,1);
 // Exercise S3 continuation tokens while successful work items are deleted.
 for(let i=0;i<55;i++){const value=batch(owner,'paginated receipt item');value.sessionId='page-'+i;await ingest.putBatch(owner,value);}
 assert.equal((await sweep(restarted)).indexed,55);
 for(const principal of owners)await search.refresh(principal);assert.equal((await search.search(owner,{query:'paginated'})).total,55);
 assert.equal((await search.search(owners[1],{query:'paginated'})).total,0);
});

test('capture only lands immutable data and succeeds without any processing service',async()=>{
 const store=memoryStore(),prefix='sessions/simple/v1';
 const put=store.put;store.put=async(k,v)=>{if(!k.endsWith('.json.gz'))throw new Error('Processing storage unavailable');await put(k,v);};
 const ingest=createSessionIngest({store,prefix}),value=batch(owner);
 assert.equal((await ingest.putBatch(owner,value)).stored,true);
 assert.equal((await ingest.putBatch(owner,value)).stored,true);
 assert.equal(store.data.size,1);
});

test('worker rejects forged source keys and checkpoints only after all indexing writes succeed',async()=>{
 const store=memoryStore(),prefix='sessions/boundary/v1',ingest=createSessionIngest({store,prefix});
 await ingest.putBatch(owner,batch(owner));
 const key=[...store.data.keys()][0];let fail=true;
 const search={identity:'target',ensureIndex:async()=>{},putDocuments:async()=>{if(fail)throw new Error('Partial bulk failure');}};
 const pipeline=createSessionPipeline({store,prefix,search,principal:owner});
 await assert.rejects(pipeline.processObject({key:key.replace('tenants/','tenants/foreign/')}),/authorized source/);
 await assert.rejects(pipeline.processObject({key}),/Partial bulk/);
 assert.equal(store.data.size,1);
 fail=false;assert.equal((await pipeline.processObject({key})).records,1);
 assert.equal((await pipeline.processObject({key})).skipped,true);
 assert.equal([...store.data.keys()].filter(k=>k.includes('/_index/')).length,1);
});

test('OpenSearch SigV4 signs temporary credentials for the es service and index-scoped endpoint',async()=>{
 let captured;
 const search=createSessionSearch({endpoint:'https://search.example.com',index:'session-test',region:'us-west-2',
  credentials:async()=>({accessKeyId:'test-key',secretAccessKey:'test-secret',sessionToken:'temporary-token'}),
  fetch:async(url,options)=>{captured={url,options};return realmResponse('session',{hits:{total:{value:0},hits:[]}});}});
 await search.search(owner,{query:'hello'});
 assert.equal(captured.url.pathname,'/session-test/_search');
 assert.equal(captured.options.headers['x-amz-security-token'],'temporary-token');
 assert.match(captured.options.headers.authorization,/us-west-2\/es\/aws4_request/);
});


test('search returns another teammate with attribution and rejects foreign tenant results',async()=>{
 const teammate={tenantId:owner.tenantId,userId:'teammate',text:'shared knowledge'};
 let source=teammate;
 const search=createSessionSearch({endpoint:'http://localhost:9200',index:'sessions-test',fetch:async()=>realmResponse('session',{hits:{total:{value:1},hits:[{_id:'event',_source:source}]}})});
 assert.equal((await search.search(owner)).hits[0].userId,'teammate');
 source={...teammate,tenantId:'another-team'};
 await assert.rejects(search.search(owner),/ownership scope/);
 await assert.rejects(search.search(owner,{raw:true}),/ownership scope/);
});
