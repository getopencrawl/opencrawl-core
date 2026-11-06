import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRealm,realmIndex} from '../src/search/realm.mjs';
import {createSessionSearch} from '../src/sessions/search.mjs';
import {createConnectorSearch} from '../src/connectors/search.mjs';
import {documentId} from '../src/connectors/scope.mjs';
import {createBoardSearch} from '../src/board/search.mjs';
const endpoint=process.env.OPENCRAWL_TEST_OPENSEARCH_URL;
test('one physical organization realm holds all corpora with collision-safe identity, scoped retrieval and shared schema',{skip:!endpoint},async t=>{
  const environment='test-'+randomUUID().slice(0,8),owners=['a','b'].map(s=>({tenantId:'org-'+s,userId:'author'}));
  const sessions=createSessionSearch({endpoint,environment}),board=createBoardSearch({endpoint,environment});
  t.after(async()=>{for(const p of owners)await fetch(endpoint+'/'+realmIndex(environment,p.tenantId),{method:'DELETE'});});
  for(const p of owners){
    const index=realmIndex(environment,p.tenantId),realm=createRealm({endpoint,index,tenantId:p.tenantId});
    for(let i=0;;i++){try{await realm.ensureIndex();break;}catch(e){if(i>=60)throw e;await new Promise(r=>setTimeout(r,1000));}}
    const connectionId='same-connection',binding={tenantId:p.tenantId,connectionId,provider:'github',workspaceId:'same-workspace',access:'workspace-global',rawPrefix:'raw/v1/source=github/workspace=same-workspace/connection=same-connection/'};
    const connectors=createConnectorSearch({endpoint,index,tenantId:p.tenantId});await connectors.ensureIndex();
    const connector={tenantId:p.tenantId,connectionId,provider:'github',workspaceId:binding.workspaceId,kind:'issue',sourceId:'same-id',text:'pineapple connector '+p.tenantId,deleted:false,extractedAt:1700000000000,contentHash:'a'.repeat(64)};
    const sharedId=documentId(binding,'issue','same-id');
    await connectors.putDocuments(p,binding,[{id:sharedId,document:connector}]);
    await sessions.putDocuments([{id:sharedId,document:{...p,harness:'codex',sessionId:'same-session',kind:'message',text:'pineapple session '+p.tenantId,receivedAt:'2026-11-01T00:00:00Z',sequence:1}}],p);
    const message={id:1,timestamp:1700000000000,topic:'coordination',agent:'agent',author:'author',name:'agent',text:'pineapple board '+p.tenantId};
    const result=await board.search(p,[message],'same-board-key',{workspace:p.tenantId,query:'pineapple'});assert.equal(result.total,1);
    await realm.refresh(p);
    assert.equal((await sessions.search(p,{query:'pineapple'})).total,1);
    assert.equal((await connectors.search(p,[binding],{query:'pineapple'})).hits.length,1);
    const response=await fetch(endpoint+'/'+index+'/_search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:{match:{text:'pineapple'}},aggs:{corpora:{terms:{field:'corpus'}}}})});
    const all=await response.json();assert.equal(all.hits.total.value,3);assert.deepEqual(new Set(all.hits.hits.map(h=>h._source.corpus)),new Set(['board','session','connector']));
    assert.ok(all.hits.hits.every(h=>h._source.tenantId===p.tenantId&&h._source.schema===1));assert.equal(new Set(all.hits.hits.map(h=>h._id)).size,3);
    await assert.rejects(createRealm({endpoint,index,tenantId:'foreign'}).ensureIndex(),/tenant mismatch/);
    await assert.rejects(connectors.search(owners.find(o=>o!==p),[binding],{query:'pineapple'}),/scope/);
  }
});

test('real migration freezes legacy writes, copies complete native data, verifies it and detects changed restart sources',{skip:!endpoint},async t=>{
 const {createIndexTransport}=await import('../src/search/realm.mjs');
 const {legacyRealmSource,migrateRealmCorpus}=await import('../src/search/migration.mjs');
 const {sessionIndexMapping}=await import('../src/search/mapping.mjs');
 const environment='test-'+randomUUID().slice(0,8),principal={tenantId:'migrated-org',userId:'author'},legacy='legacy-'+randomUUID(),target=realmIndex(environment,principal.tenantId);
 const request=createIndexTransport({endpoint,index:legacy});
 const realm=createRealm({endpoint,environment,tenantId:principal.tenantId});
 t.after(async()=>{for(const i of [legacy,target])await fetch(endpoint+'/'+i,{method:'DELETE'});});
 await request('',{settings:{number_of_shards:1,number_of_replicas:0},mappings:sessionIndexMapping},'PUT');
 const doc={tenantId:principal.tenantId,userId:principal.userId,harness:'codex',installationId:'machine',sessionId:'session',eventId:'event',chunk:0,kind:'message',text:'exact complete body',receivedAt:'2026-11-01T00:00:00.000Z'};
 await request('/_doc/event?refresh=true',doc,'PUT');
 const source=legacyRealmSource({endpoint,index:legacy,corpus:'session',tenantId:principal.tenantId});let checkpoint=null;
 const options={principal,corpus:'session',source,realm,load:async()=>checkpoint,save:async value=>{checkpoint=value;}};
 await assert.rejects(migrateRealmCorpus(options),/write-blocked/);
 await request('/_settings',{index:{blocks:{write:true}}},'PUT');
 assert.equal((await migrateRealmCorpus(options)).copied,1);assert.equal(checkpoint.complete,true);
 await assert.rejects(request('/_doc/blocked',doc,'PUT'),/403/);
 assert.deepEqual((await realm.collection('session').mget(principal,['event'])).docs[0]._source,doc);
 await request('/_settings',{index:{blocks:{write:false}}},'PUT');await request('/_doc/event?refresh=true',{...doc,text:'changed'},'PUT');await request('/_settings',{index:{blocks:{write:true}}},'PUT');
 await assert.rejects(migrateRealmCorpus(options),/version changed/);
});

test('session replay cannot overwrite a newer captured event in the realm',{skip:!endpoint},async t=>{
 const environment='test-'+randomUUID().slice(0,8),owner={tenantId:'org-replay',userId:'author'},index=realmIndex(environment,owner.tenantId);
 const sessions=createSessionSearch({endpoint,environment});await sessions.ensureIndex(owner);
 t.after(()=>fetch(endpoint+'/'+index,{method:'DELETE'}));
 const base={...owner,harness:'codex',sessionId:'session',kind:'message',sequence:1};
 await sessions.putDocuments([{id:'event',document:{...base,receivedAt:'2026-11-02T00:00:00Z',text:'newer version'}}],owner);
 await sessions.putDocuments([{id:'event',document:{...base,receivedAt:'2026-11-01T00:00:00Z',text:'old replay'}}],owner);
 await sessions.refresh(owner);const result=await sessions.search(owner);assert.equal(result.total,1);assert.equal(result.hits[0].text,'newer version');
});
