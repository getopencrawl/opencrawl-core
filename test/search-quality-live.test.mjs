import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRealm} from '../dist/src/search/realm.mjs';
import {createSessionSearch} from '../dist/src/sessions/search.mjs';
import {createWorkspaceSearch} from '../dist/src/search/workspace.mjs';
import {createSessionIngest} from '../dist/src/sessions/ingest.mjs';
import {batchDocuments,sessionDocumentId} from '../dist/src/sessions/indexer.mjs';
import {sessionScope} from '../dist/src/sessions/event-identity.mjs';
import {createControls} from '../dist/src/sessions/controls.mjs';
import {migrateSessionPassages,restoreSessionPassages} from '../dist/src/sessions/passage-migration.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';

const endpoint=process.env.OPENCRAWL_TEST_OPENSEARCH_URL;
for(const backend of ['sqlite','opensearch'])test(`${backend}: multi-session discovery intersects filters and preserves current access`,{skip:backend==='opensearch'&&!endpoint},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'opencrawl-session-scope-'));
  const target=backend==='sqlite'?pathToFileURL(join(directory,'search.sqlite')).href.replace('file:','sqlite:'):endpoint;
  const run=randomUUID(),principal={tenantId:'session-scope-'+run,userId:'alice'},peer={...principal,userId:'bob'},outsider={tenantId:'session-scope-outside-'+run,userId:'bob'};
  const store=memorySessionStore(),prefix='capture-session-scope',sessions=createSessionSearch({endpoint:target,store,prefix}),workspace=createWorkspaceSearch({sessions});
  const ingest=createSessionIngest({store,prefix});
  t.after(async()=>{try{if(backend==='opensearch')for(const p of [principal,outsider])await fetch(target+'/'+createRealm({endpoint:target,tenantId:p.tenantId}).index,{method:'DELETE'});}finally{await rm(directory,{recursive:true,force:true});}});
  for(const [owner,sessionId,text] of [[peer,'chat-a','scope evidence first'],[peer,'chat-b','scope evidence second'],[peer,'chat-c','scope evidence outside selection'],[outsider,'chat-a','scope evidence foreign marker']]){
    const events=[{id:'same-event',kind:'message',timestamp:'2026-11-01T00:00:00Z',data:{role:'assistant',content:text}}];
    if(owner===peer&&sessionId==='chat-a')events.push({id:'detail-event',kind:'message',timestamp:'2026-11-01T00:00:01Z',data:{role:'assistant',content:'detail needle'}});
    const receipt=await ingest.putBatch(owner,{schemaVersion:1,owner,harness:'codex',origin:'desktop',installationId:'fixture',sessionId,attachments:[],events});
    const key=[...store.data.keys()].find(k=>k.endsWith(receipt.batchId+'.json.gz')),batch=JSON.parse(gunzipSync(store.data.get(key)));
    await sessions.ensureIndex(owner);await sessions.putDocuments(batchDocuments({prefix,key,batch,principal:owner}),owner);await sessions.refresh(owner);
  }
  const input={query:'scope evidence',match:'all',source:'sessions',filters:{sessionIds:['chat-a','chat-b']},facets:['sessionId']};
  const selected=await workspace.search(principal,input);
  assert.deepEqual(selected.results.map(h=>h.provenance.sessionId).sort(),['chat-a','chat-b']);
  assert.ok(selected.results.every(h=>!h.text.includes('foreign marker')&&!h.text.includes('outside selection')));
  assert.deepEqual(selected.facets.sessionId.values,[{value:'chat-a',count:1},{value:'chat-b',count:1}]);
  assert.equal((await workspace.search(principal,{...input,sessionId:'chat-a'})).results.length,1);
  assert.equal((await workspace.search(principal,{...input,sessionId:'chat-c'})).results.length,0);
  // Terms in different messages never combine; scope supplies context while the
  // follow-up query names the detail that actually occurs in a passage.
  assert.equal((await workspace.search(principal,{...input,query:'scope needle',groupBy:'session'})).results.length,0);
  assert.equal((await workspace.search(principal,{...input,query:'needle'})).results[0].provenance.sessionId,'chat-a');
  assert.equal((await workspace.search(principal,{...input,filters:{...input.filters,roles:['user']}})).results.length,0);
  await createControls({store,prefix}).update(peer,'sessions','codex','chat-b',()=>({visibility:'private',deletedAt:null}));
  const hidden=await workspace.search(principal,input);
  assert.deepEqual(hidden.results.map(h=>h.provenance.sessionId),['chat-a']);
  assert.deepEqual(hidden.facets.sessionId.values,[{value:'chat-a',count:1}]);
  await assert.rejects(workspace.fetch(principal,{id:selected.results.find(h=>h.provenance.sessionId==='chat-b').id}),{status:404});
  assert.equal((await workspace.search(peer,input)).results.length,2);
  const foreign=await workspace.search(outsider,input);assert.equal(foreign.results.length,1);assert.match(foreign.results[0].text,/foreign marker/);
});
for(const backend of ['sqlite','opensearch'])test(`${backend}: origin filters and facets preserve tenant and current privacy boundaries`,{skip:backend==='opensearch'&&!endpoint},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'opencrawl-origin-filter-'));
  const target=backend==='sqlite'?pathToFileURL(join(directory,'search.sqlite')).href.replace('file:','sqlite:'):endpoint;
  const run=randomUUID(),principal={tenantId:'origin-'+run,userId:'alice'},peer={...principal,userId:'bob'},outsider={tenantId:'origin-outside-'+run,userId:'bob'};
  const store=memorySessionStore(),prefix='capture-origins',sessions=createSessionSearch({endpoint:target,store,prefix}),workspace=createWorkspaceSearch({sessions});
  const ingest=createSessionIngest({store,prefix});
  t.after(async()=>{try{if(backend==='opensearch')for(const p of [principal,outsider])await fetch(target+'/'+createRealm({endpoint:target,tenantId:p.tenantId}).index,{method:'DELETE'});}finally{await rm(directory,{recursive:true,force:true});}});
  for(const [owner,sessionId,origin,text] of [[peer,'discussion','desktop','origin evidence from the conversation'],[peer,'worker','subagent','origin evidence from a useful worker'],[outsider,'discussion','desktop','origin evidence foreign marker']]){
    const receipt=await ingest.putBatch(owner,{schemaVersion:1,owner,harness:'codex',origin,installationId:'fixture',sessionId,attachments:[],events:[{id:'same-event',kind:'message',timestamp:'2026-11-01T00:00:00Z',data:{role:'assistant',content:text}}]});
    const key=[...store.data.keys()].find(k=>k.endsWith(receipt.batchId+'.json.gz')),batch=JSON.parse(gunzipSync(store.data.get(key)));
    await sessions.ensureIndex(owner);await sessions.putDocuments(batchDocuments({prefix,key,batch,principal:owner}),owner);await sessions.refresh(owner);
  }
  const input={query:'origin evidence',match:'all',source:'sessions',facets:['origin']};
  const unfiltered=await workspace.search(principal,input);
  assert.equal(unfiltered.results.length,2);assert.ok(unfiltered.results.every(h=>!h.text.includes('foreign marker')));
  assert.deepEqual(unfiltered.facets.origin.values,[{value:'desktop',count:1},{value:'subagent',count:1}]);
  const filtered=await workspace.search(principal,{...input,filters:{origins:['desktop']}});
  assert.equal(filtered.results.length,1);assert.equal(filtered.results[0].provenance.sessionId,'discussion');
  assert.deepEqual(filtered.facets.origin.values,[{value:'desktop',count:1}]);
  assert.equal((await workspace.fetch(principal,{id:filtered.results[0].id})).provenance.origin,'desktop');
  assert.equal((await workspace.search(principal,{...input,filters:{origins:['desktop','subagent']}})).results.length,2);
  assert.equal((await workspace.search(principal,{...input,filters:{origins:['cloud']}})).results.length,0);
  await createControls({store,prefix}).update(peer,'sessions','codex','worker',()=>({visibility:'private',deletedAt:null}));
  const hidden=await workspace.search(principal,{...input,filters:{origins:['subagent']}});
  assert.equal(hidden.results.length,0);assert.deepEqual(hidden.facets.origin.values,[]);
  await assert.rejects(workspace.fetch(principal,{id:unfiltered.results.find(h=>h.provenance.origin==='subagent').id}),{status:404});
  assert.equal((await workspace.search(peer,{...input,filters:{origins:['subagent']}})).results.length,1);
  const other=await workspace.search(outsider,{...input,filters:{origins:['desktop']}});
  assert.equal(other.results.length,1);assert.match(other.results[0].text,/foreign marker/);
});
test('real engine migration preserves evidence, replaces stale chunks, supports filters/facets/navigation and rolls back', {skip:!endpoint},async t=>{
  const principal={tenantId:'quality-'+randomUUID(),userId:'alice'},peer={...principal,userId:'bob'};
  const realm=createRealm({endpoint,tenantId:principal.tenantId}),store=memorySessionStore(),prefix='capture-quality';
  t.after(()=>fetch(endpoint+'/'+realm.index,{method:'DELETE'}));
  await realm.ensureIndex();
  const sessions=createSessionSearch({endpoint,store,prefix}),workspace=createWorkspaceSearch({sessions});
  const text=('The release uses immutable captures and verifies deployment receipts.\n\n').repeat(500)+'Exact final conclusion: rollback succeeded.';
  const ingest=createSessionIngest({store,prefix});
  await ingest.putBatch(peer,{schemaVersion:1,owner:peer,harness:'codex',origin:'cli',installationId:'fixture',sessionId:'quality-session',title:'Deployment receipts',attachments:[],events:[
    {id:'wire1:0evidence',kind:'message',timestamp:'2026-11-01T00:00:00Z',data:{role:'assistant',content:text,status:'completed'}},
    {id:'wire1:9question',kind:'message',timestamp:'2026-11-02T00:00:00Z',data:{role:'user',content:'Please verify deployment receipts.'}},
  ]});
  const key=[...store.data.keys()].find(k=>k.endsWith('.json.gz')),batch=JSON.parse(gunzipSync(store.data.get(key)));
  const projected=batchDocuments({prefix,key,batch,principal:peer}),legacy=[];
  for(const event of batch.events)for(const [chunk,part] of [...('completed\n'+event.data.content).matchAll(/[\s\S]{1,16000}/gu)].entries()){
    const d={...projected.find(x=>x.document.eventId===event.id).document,chunk,text:part[0]};
    for(const field of ['passageVersion','chunkCount','textStart','textEnd'])delete d[field];
    legacy.push({id:sessionDocumentId({scope:sessionScope(peer),harness:'codex',sessionId:'quality-session',eventId:event.id,chunk}),document:d});
  }
  // An abandoned chunk beyond the new count must also disappear on restart.
  const stale={...legacy[0],id:'stale-passage',document:{...legacy[0].document,chunk:999,text:'obsolete stale evidence'}};
  await realm.collection('session').bulk(principal,[...legacy,stale],{refresh:true});
  const steps=[],args={realm,principal,store,prefix,backup:async s=>{steps.push(structuredClone(s));}};
  assert.equal((await migrateSessionPassages(args)).events,2);
  const reports=[];
  for(const eventIdRange of [{lt:'wire1:4'},{gte:'wire1:4',lt:'wire1:8'},{gte:'wire1:8',lt:'wire1:c'},{gte:'wire1:c'}])reports.push(await migrateSessionPassages({...args,eventIdRange,dryRun:false}));
  assert.equal(reports.reduce((n,r)=>n+r.events,0),2);assert.ok(reports.every(r=>r.complete));
  await realm.refresh(principal);
  assert.equal((await migrateSessionPassages({...args,dryRun:false})).events,0);
  const result=await workspace.search(principal,{query:'deployment receipts',match:'all',source:'sessions',filters:{roles:['assistant'],before:'2026-11-01T23:59:59Z'},facets:['role','author'],limit:40});
  assert.equal(result.partial,false);assert.equal(result.results.length,1);assert.ok(result.grouped>0);
  assert.equal(result.facets.role.values[0].value,'assistant');
  assert.equal((await workspace.search(principal,{query:'obsolete',source:'sessions'})).results.length,0);
  assert.equal((await workspace.search(principal,{query:'deployment',filters:{providers:['github']}})).results.length,0);
  const discovery=await workspace.search(principal,{query:'',source:'sessions',order:'newest',select:['title','provenance'],groupBy:'none'});
  assert.equal(discovery.results[0].provenance.eventId,'wire1:9question');assert.ok(discovery.results.every(r=>!('text'in r)&&!('excerpt'in r)));
  // Fetch follows the exact source partition from chunk zero, with reauthorization.
  let id='sessions:'+projected.find(x=>x.document.eventId==='wire1:0evidence'&&x.document.chunk===0).id,whole='',seen=new Set();
  while(id){assert.ok(!seen.has(id));seen.add(id);const part=await workspace.fetch(principal,{id,length:16000});whole+=part.text;id=part.nextId;}
  assert.equal(whole,text);
  await createControls({store,prefix}).update(peer,'sessions','codex','quality-session',()=>({visibility:'private',deletedAt:null}));
  assert.equal((await workspace.search(principal,{query:'deployment',facets:['author']})).results.length,0);
  await assert.rejects(workspace.fetch(principal,{id:result.results[0].id}),{status:404});
  await restoreSessionPassages({...args,steps});await realm.refresh(principal);
  const restored=await realm.collection('session').search(peer,{size:100,track_total_hits:true});
  assert.equal(restored.hits.total.value,legacy.length+1);assert.ok(restored.hits.hits.every(h=>h._source.private));
  assert.ok(store.data.has(key));
});
