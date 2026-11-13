import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync,gzipSync} from 'node:zlib';
import {memorySessionStore} from './session-store-fixture.mjs';
import {createSessionIngest} from '../dist/src/sessions/ingest.mjs';
import {createSessionPipeline} from '../dist/src/sessions/indexer.mjs';
import {memorySourceIdentity,memorySnapshotId} from '../dist/src/memories/snapshot.mjs';
import {createWorkspaceSearch} from '../dist/src/search/workspace.mjs';
import {createServer} from 'node:http';
import {standaloneCapture} from '../dist/tools/test-fixtures/capture.mjs';
const owner={tenantId:'tenant-a',userId:'alice'};
const snapshot=(harness='codex')=>({schemaVersion:1,owner,installationId:'machine',host:'fixture',harness,generation:Date.now(),
  files:[{path:'memories/MEMORY.md',project:'',modifiedAt:'2026-11-07T00:00:00Z',text:'violet lighthouse current memory'}]});
test('self-host receiver exposes authenticated memory snapshots without hosted credentials',async t=>{
  const store=memorySessionStore(),token='memory-fixture-'.repeat(3),server=createServer(standaloneCapture({store,principal:owner,token}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
  const url='http://127.0.0.1:'+server.address().port+'/api/sessions/memories';
  const post=(headers={},body=snapshot())=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await post()).status,401);
  assert.equal((await post({authorization:'Bearer '+token,origin:'https://foreign.test'})).status,403);
  const ok=await post({authorization:'Bearer '+token});assert.equal(ok.status,200);assert.equal((await ok.json()).data.stored,true);
  assert.equal((await post({authorization:'Bearer '+token},{...snapshot(),owner:{...owner,userId:'other'}})).status,403);
});
test('native memory snapshots authenticate, land immutably, retry and share the existing indexing workflow',async()=>{
  const store=memorySessionStore(),prefix='sessions/test/v1',ingest=createSessionIngest({store,prefix});
  const calls=[],search={identity:'test',memories:{putSnapshot:async(...args)=>{calls.push(args);return 1;}}};
  const pipeline=createSessionPipeline({store,prefix,search,principal:owner});
  for(const harness of ['codex','claude-code']) {
    const s=snapshot(harness),receipt=await ingest.putMemorySnapshot(owner,s);
    assert.deepEqual(await ingest.putMemorySnapshot(owner,s),receipt);
    assert.equal(receipt.snapshotId,memorySnapshotId(s));
    const key=[...store.data.keys()].find(k=>memorySourceIdentity(prefix,k)?.harness===harness);
    assert.equal((await pipeline.processObject({key})).records,1);
    assert.equal((await pipeline.processObject({key})).skipped,true);
    assert.equal(calls.at(-1)[0].files[0].text,s.files[0].text);
    await assert.rejects(ingest.putMemorySnapshot({...owner,tenantId:'tenant-b'},s),/owner/);
    await assert.rejects(createSessionPipeline({store,prefix,search,principal:{...owner,userId:'bob'}}).processObject({key}),/outside/);
  }
  // Both snapshots are discoverable as memory objects, then filtered once indexed.
  assert.equal((await createSessionPipeline({store,prefix,search:{...search,identity:'fresh-index'},principal:owner}).listPage()).keys.length,2);
  assert.equal((await pipeline.listPage()).keys.length,0);
  assert.equal(calls.length,2);
});
test('malformed paths, duplicate files, false owners and changed stored content fail before indexing',async()=>{
  const store=memorySessionStore(),prefix='sessions/test/v1',ingest=createSessionIngest({store,prefix}),s=snapshot();
  for(const bad of [{...s,files:[{...s.files[0],path:'../secret.md'}]},{...s,files:[...s.files,...s.files]},
    {...s,generation:-1},{...s,harness:'unknown'}])await assert.rejects(ingest.putMemorySnapshot(owner,bad));
  await assert.rejects(ingest.putMemorySnapshot(null,s));
  await ingest.putMemorySnapshot(owner,s);
  const key=[...store.data.keys()][0],stored=JSON.parse(gunzipSync(await store.get(key)));stored.files[0].text='tampered';
  await store.put(key,gzipSync(JSON.stringify(stored)));
  let writes=0;const search={identity:'test',memories:{putSnapshot:async()=>writes++}};
  await assert.rejects(createSessionPipeline({store,prefix,search,principal:owner}).processObject({key}),/content mismatch/);
  assert.equal(writes,0);
});
test('memory search and fetch use current authorized source; stale file IDs cannot be fetched',async()=>{
  let current=true;const id='a'.repeat(64),text='current memory';
  const memories={search:async(p,q)=>({hits:current?[{...owner,id,text,harness:'codex',installationId:'machine',path:'memories/MEMORY.md'}]:[],truncated:false})};
  const workspace=createWorkspaceSearch({memories});
  const result=await workspace.search(owner,{query:'memory',source:'memories'});
  assert.equal(result.results[0].id,'memories:'+id);assert.equal(result.results[0].provenance.path,'memories/MEMORY.md');
  assert.equal((await workspace.fetch(owner,{id:'memories:'+id})).text,text);
  current=false;await assert.rejects(workspace.fetch(owner,{id:'memories:'+id}),/no longer available/);
  await assert.rejects(workspace.search({...owner,captureAccess:'write'},{query:'memory',source:'memories'}),/cannot search/);
});
