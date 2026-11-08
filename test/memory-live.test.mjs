import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createObjectStore} from '../src/sessions/s3-store.mjs';
import {createSessionIngest} from '../src/sessions/ingest.mjs';
import {createSessionPipeline} from '../src/sessions/indexer.mjs';
import {createSessionSearch} from '../src/sessions/search.mjs';
import {createWorkspaceSearch} from '../src/search/workspace.mjs';
import {createIndexTransport,realmIndex,realmMapping,createRealm} from '../src/search/realm.mjs';
const endpoint=process.env.OPENCRAWL_TEST_OPENSEARCH_URL,s3=process.env.OPENCRAWL_TEST_S3_ENDPOINT;
test('real memory rebuild: two harnesses, immutable S3, additive mapping, atomic publish, deletion, replay and tenant isolation',{skip:!endpoint||!s3},async t=>{
  const run=randomUUID(),environment='mem-'+run.slice(0,8),owner={tenantId:'memory-'+run,userId:'alice'},other={tenantId:'other-'+run,userId:'alice'};
  const index=realmIndex(environment,owner.tenantId),transport=createIndexTransport({endpoint,index});
  for(let attempt=0;;attempt++) {
    try{const ready=await fetch(endpoint+'/_cluster/health');if(ready.ok)break;}catch{}
    if(attempt>=60)throw new Error('OpenSearch did not become ready');
    await new Promise(r=>setTimeout(r,1000));
  }
  const objects=[],underlying=createObjectStore({endpoint:s3,bucket:'capture-test',credentials:{accessKeyId:'capture-test',secretAccessKey:'capture-test-secret'}});
  const store={...underlying,put:async(k,b,m)=>{objects.push(k);return underlying.put(k,b,m);}};
  t.after(async()=>{for(const key of objects)await store.delete(key);for(const p of [owner,other])await fetch(endpoint+'/'+realmIndex(environment,p.tenantId),{method:'DELETE'});});
  const old=structuredClone(realmMapping);delete old.properties.memory;
  await transport('',{settings:{number_of_shards:1,number_of_replicas:0},mappings:{...old,_meta:{schema:1,tenantId:owner.tenantId}}},'PUT');
  await transport('/_doc/session:retained?refresh=true',{schema:1,tenantId:owner.tenantId,corpus:'session',id:'retained',text:'retained session',session:{userId:'alice'}},'PUT');
  const search=createSessionSearch({endpoint,environment}),workspace=createWorkspaceSearch({sessions:search});
  const prefix='sessions/memory-test/'+run,ingest=createSessionIngest({store,prefix});
  const pipeline=createSessionPipeline({store,prefix,search,resolvePrincipal:async({batch})=>batch.owner});
  const snapshots=[];
  const file=(path,text)=>({path,project:'fixture',modifiedAt:'2026-11-07T00:00:00Z',text});
  async function send(harness,generation,files,principal=owner) {
    const snapshot={schemaVersion:1,owner:principal,installationId:'same-machine',host:'fixture',harness,generation,files};
    const receipt=await ingest.putMemorySnapshot(principal,snapshot);const key=objects.find(k=>k.endsWith(receipt.snapshotId+'.json.gz'));
    await pipeline.processObject({key});snapshots.push({snapshot,key,receipt});return receipt;
  }
  const gen=Date.now()-10000;
  await send('codex',gen,[file('memories/MEMORY.md','violet lighthouse oldmemory'),file('memories/deleted.md','deletewitness')]);
  await send('claude-code',gen,[file('projects/repo/memory/MEMORY.md','violet lighthouse Claude memory')]);
  await send('codex',gen,[file('memories/MEMORY.md','violet foreign memory')],other);
  const initial=await workspace.search(owner,{query:'violet',source:'memories'});assert.equal(initial.results.length,2);
  assert.deepEqual(new Set(initial.results.map(h=>h.provenance.harness)),new Set(['codex','claude-code']));
  const oldId=initial.results.find(h=>h.provenance.harness==='codex').id;
  // Inject a shard refresh failure after writing passages, before publishing
  // the head. A retry must then activate the complete replacement.
  const interrupted={...snapshots[0].snapshot,generation:gen+1,files:[file('memories/MEMORY.md','violet lighthouse newmemory')]};
  const {memorySnapshotId}=await import('../src/memories/snapshot.mjs');
  const broken=createSessionSearch({endpoint,environment,fetch:async(url,options)=>String(url).endsWith('/_refresh')?
    new Response(JSON.stringify({_shards:{total:1,successful:0,failed:1}}),{status:200,headers:{'content-type':'application/json'}}):fetch(url,options)});
  await assert.rejects(broken.memories.putSnapshot({...interrupted,snapshotId:memorySnapshotId(interrupted),receivedAt:new Date().toISOString()},owner,'fixture'),/refresh incomplete/);
  assert.equal((await workspace.search(owner,{query:'oldmemory',source:'memories'})).results.length,1);
  assert.equal((await workspace.search(owner,{query:'newmemory',source:'memories'})).results.length,0);
  await send('codex',gen+1,[file('memories/MEMORY.md','violet lighthouse newmemory')]);
  for(const query of ['oldmemory','deletewitness'])assert.equal((await workspace.search(owner,{query,source:'memories'})).results.length,0);
  await assert.rejects(workspace.fetch(owner,{id:oldId}),/no longer available/);
  const first=snapshots[0];await search.memories.putSnapshot({...first.snapshot,snapshotId:first.receipt.snapshotId,receivedAt:new Date().toISOString()},owner,first.key);
  assert.equal((await workspace.search(owner,{query:'oldmemory',source:'memories'})).results.length,0);
  assert.equal((await workspace.search(owner,{query:'newmemory',source:'memories'})).results.length,1);
  const current=(await workspace.search(owner,{query:'newmemory',source:'memories'})).results[0];
  assert.equal((await workspace.fetch({...owner,userId:'bob'},{id:current.id})).text,'violet lighthouse newmemory');
  await assert.rejects(workspace.fetch(other,{id:current.id}),/no longer available/);
  await send('codex',gen+2,[]);assert.equal((await workspace.search(owner,{query:'newmemory',source:'memories'})).results.length,0);
  const raw=await transport('/_search',{query:{bool:{filter:[{term:{corpus:'memory'}},{term:{'memory.kind':'snapshot'}}]}}});assert.equal(raw.hits.total.value,2);
  assert.equal((await transport('/_doc/session:retained',undefined,'GET'))._source.text,'retained session');
  const mapping=(await transport('/_mapping',undefined,'GET'))[index].mappings;assert.ok(mapping.properties.memory);
  await assert.rejects(createRealm({endpoint,index,tenantId:other.tenantId}).ensureIndex(),/mismatch/);
});
