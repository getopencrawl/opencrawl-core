import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {capturedEventTokens} from '../dist/src/sessions/token-count.mjs';
import {migrateSessionTokens} from '../dist/src/sessions/token-migration.mjs';
import {createSessionIngest} from '../dist/src/sessions/ingest.mjs';
import {batchDocuments} from '../dist/src/sessions/indexer.mjs';
import {createSessionLibrary} from '../dist/src/sessions/library.mjs';
import {createControls} from '../dist/src/sessions/controls.mjs';
import {createRealm, realmMapping} from '../dist/src/search/realm.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';

test('captured tokens count content, not usage, echoes, metadata or opaque media', () => {
  const count = (kind, data, harness='codex') => capturedEventTokens(harness, {id:'e', kind, data});
  assert.equal(count('message', {role:'user', content:'Hello world', model:'metadata'}), 2);
  assert.equal(count('message', {content:[{type:'text', text:'Hello world'}, {type:'thinking', thinking:'private'}, {type:'image', source:{data:'opaque'}}, {type:'redacted_thinking', data:'opaque'}]}), 2);
  assert.equal(count('message', {content:[{type:'tool_use', id:'opaque', name:'Bash', input:{command:'Hello world'}}]}), 4);
  assert.equal(count('tool_result', {output:'Hello world'}), 2);
  assert.equal(count('exec_command_end', {aggregated_output:'Hello world', stdout:'duplicate'}), 2);
  assert.equal(count('token_count', {info:{tokens:1000000}, text:'bookkeeping'}), 0);
  assert.equal(count('session_title', {title:'Hello world'}), 0);
  assert.equal(count('user_message', {message:'Hello world'}), 0);
  assert.equal(count('compaction', {summary:'repeated context'}), 0);
  assert.equal(count('message', {content:'data:image/png;base64,opaque'}), 0);
  assert.ok(count('message', {content:'你好 🌍 <|endoftext|>'}) > 0);
});

for (const backend of ['sqlite', 'opensearch']) {
  test(`${backend}: session token totals and historical metadata backfill`, {skip:backend==='opensearch'&&!process.env.OPENCRAWL_TEST_OPENSEARCH_URL}, async t => {
    const directory=await mkdtemp(join(tmpdir(),'oc-session-tokens-'));
    const endpoint=backend==='sqlite'?pathToFileURL(join(directory,'search.sqlite')).href.replace('file:','sqlite:'):process.env.OPENCRAWL_TEST_OPENSEARCH_URL;
    const tenantId='tokens-'+randomUUID(), alice={tenantId,userId:'alice'}, bob={tenantId,userId:'bob'};
    const store=memorySessionStore(), prefix='sessions/tokens', options={endpoint,tenantId,environment:'test',store,prefix};
    const realm=createRealm(options), collection=realm.collection('session'), library=createSessionLibrary(options), ingest=createSessionIngest({store,prefix});
    t.after(async()=>{if(backend==='opensearch')await fetch(endpoint+'/'+realm.index,{method:'DELETE'});await rm(directory,{recursive:true,force:true});});
    if(backend==='opensearch') {
      const legacy=structuredClone(realmMapping);delete legacy.properties.session.properties.capturedTokens;
      await fetch(endpoint+'/'+realm.index,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({settings:{number_of_shards:1,number_of_replicas:0},mappings:{...legacy,_meta:{schema:1,tenantId}}})});
    }
    await realm.ensureIndex();
    async function capture(owner, sessionId, installationId='device', historical=false) {
      const events=[{id:'prompt',kind:'message',sequence:1,timestamp:'2026-11-12T10:00:00Z',data:{role:'user',content:'Hello world'}},
        {id:'result',kind:'tool_result',sequence:2,timestamp:'2026-11-12T10:01:00Z',data:{output:'large tool result\n'.repeat(1800)}},
        {id:'usage',kind:'token_count',sequence:3,data:{text:'not transcript content'}}];
      const receipt=await ingest.putBatch(owner,{schemaVersion:1,owner,harness:'codex',sessionId,installationId,origin:'cli',captureMode:'history',events,attachments:[]});
      const key=[...store.data.keys()].find(k=>k.endsWith('/'+receipt.batchId+'.json.gz'));
      const batch=JSON.parse(gunzipSync(store.data.get(key))), docs=batchDocuments({prefix,key,batch,principal:owner});
      const expected=events.reduce((n,e)=>n+capturedEventTokens('codex',e),0);
      assert.ok(docs.length>3,'large tool result spans multiple search passages');
      assert.equal(docs.reduce((n,d)=>n+(d.document.capturedTokens??0),0),expected,'one token count per event');
      if(historical)for(const item of docs)delete item.document.capturedTokens;
      await collection.bulk(owner,docs.map(d=>({...d,policy:historical?undefined:'session'})));
      return {docs,expected,key};
    }
    const current=await capture(alice,'current');
    await capture(alice,'current','second-install');
    const old=await capture(alice,'old','device',true);
    await capture(bob,'current');
    await realm.refresh(alice);
    const mine=await library.list(alice,{scope:'mine'});
    assert.equal(mine.sessions.find(s=>s.sessionId==='current').capturedTokens,current.expected,'retries and multiple installations do not double-count');
    assert.equal(mine.sessions.find(s=>s.sessionId==='old').capturedTokens,null,'missing historical values are not zero');
    const filtered=await library.list(alice,{scope:'mine',query:'Hello'});
    assert.equal(filtered.sessions.find(s=>s.sessionId==='current').capturedTokens,current.expected,'search includes the entire session, including unmatched tools');
    await library.setVisibility(alice,{harness:'codex',sessionId:'old',visibility:'private'});
    assert.ok((await library.list(bob)).sessions.every(s=>s.sessionId!=='old'));
    const before=(await collection.mget(alice,old.docs.map(d=>d.id))).docs;
    const migrate=extra=>migrateSessionTokens({realm,principal:{tenantId},store,prefix,pageSize:2,maxEvents:100,...extra});
    assert.equal((await migrate({})).events,3);
    assert.equal((await library.list(alice,{scope:'mine'})).sessions.find(s=>s.sessionId==='old').capturedTokens,null,'dry run does not write');
    await assert.rejects(migrate({principal:{tenantId:'other'}}),{status:403});
    await assert.rejects(migrate({principal:{tenantId,captureAccess:'write'}}),{status:403});
    const first=await migrate({dryRun:false,maxEvents:1});assert.equal(first.events,1);assert.equal(first.complete,false);
    await realm.refresh(alice);
    assert.equal((await library.list(alice,{scope:'mine'})).sessions.find(s=>s.sessionId==='old').capturedTokens,null,'partial migration never displays a partial sum');
    assert.equal((await migrate({dryRun:false,after:first.after})).complete,true);
    await realm.refresh(alice);
    assert.equal((await migrate({dryRun:false})).events,0,'retry is idempotent');
    assert.equal((await library.list(alice,{scope:'mine'})).sessions.find(s=>s.sessionId==='old').capturedTokens,old.expected);
    const after=(await collection.mget(alice,old.docs.map(d=>d.id))).docs;
    for(let i=0;i<before.length;i++) {delete after[i]._source.capturedTokens;assert.deepEqual(after[i]._source,before[i]._source,'backfill preserves text, passage layout and privacy');}
    const tombstone=await capture(alice,'deleted','device',true);
    await createControls({store,prefix}).update(alice,'sessions','codex','deleted',()=>({visibility:'team',deletedAt:new Date().toISOString()}));
    await realm.refresh(alice);
    assert.equal((await migrate({dryRun:false})).skippedDeleted,3);
    assert.ok((await collection.mget(alice,tombstone.docs.map(d=>d.id))).docs.every(d=>d._source.capturedTokens===undefined));
    await collection.delete(alice,tombstone.docs.map(d=>d.id));
    await collection.bulk(alice,[{...tombstone.docs[0],document:{...tombstone.docs[0].document,capturedTokens:2},policy:'session-tokens'}]);
    assert.equal((await collection.mget(alice,[tombstone.docs[0].id])).docs[0].found,false,'metadata-only writes cannot recreate deleted content');
  });
}
