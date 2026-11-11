import {memorySessionStore as deletionTestStore} from './session-store-fixture.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync,gzipSync} from 'node:zlib';
import {createSessionIngest,sessionScope,digest} from '../dist/src/sessions/ingest.mjs';
import {batchDocuments,createSessionPipeline} from '../dist/src/sessions/indexer.mjs';
import {migrateSessionProjection,restoreSessionProjection} from '../dist/src/sessions/projection-migration.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';
import {createRealm,realmIndex} from '../dist/src/search/realm.mjs';
import {createSessionSearch} from '../dist/src/sessions/search.mjs';
import {randomUUID} from 'node:crypto';

const owner={tenantId:'team-a',userId:'author'},prefix='sessions/projection/v1';
async function fixture(harness='codex') {
 const store=memorySessionStore(),ingest=createSessionIngest({store,prefix});
 const value={schemaVersion:1,owner,installationId:'device',sessionId:'session',harness,origin:'desktop',attachments:[],events:[
  {id:'native',kind:'message',sequence:1,data:{role:'user',content:[{type:'input_text',text:'unique original request'}]}},
  {id:'compact',kind:'compaction',sequence:2,data:harness==='codex'?{message:'useful compact summary',replacement_history:[
   {type:'message',role:'developer',content:[{type:'input_text',text:'excluded developer secret'}]},
   {type:'message',role:'user',content:[{type:'input_text',text:'unique original request'}]},
   {type:'message',role:'assistant',content:[{type:'output_text',text:'copied history '.repeat(4000)}]},
  ],guardian_history:['guardian secret'],retained_context:{text:'retained secret'},replacement_history_metadata:{text:'metadata secret'}}:
   {type:'summary',summary:'useful compact summary',sessionId:'metadata secret',compactMetadata:{text:'copied history'}}},
  {id:'hook',kind:'hook',sequence:0,data:{prompt:'unique original request',tool_response:'copied hook output'}},
  {id:'notification',kind:'user_message',sequence:3,data:{message:'unique original request'}},
  {id:'tool',kind:'tool_result',sequence:4,data:{output:{replacement_history:'legitimate tool evidence'}}},
 ]};
 await ingest.putBatch(owner,value);
 const key=[...store.data.keys()].find(key=>key.endsWith('.json.gz'));
 const batch=JSON.parse(gunzipSync(store.data.get(key)));
 return {store,key,batch,docs:batchDocuments({prefix,key,batch,principal:owner})};
}

test('compaction snapshots and hook/notification echoes do not become transcript copies; raw capture stays intact',async()=>{
 const f=await fixture(),docs=new Map(),worker=createSessionPipeline({store:f.store,prefix,principal:owner,
  search:{identity:'projection-test',ensureIndex:async()=>{},putDocuments:async items=>items.forEach(item=>docs.set(item.id,item.document))}});
 assert.equal((await worker.processObject({key:f.key})).records,3);
 assert.equal((await worker.processObject({key:f.key})).skipped,true);
 const all=[...docs.values()];
 assert.equal(all.filter(doc=>doc.text.includes('unique original request')).length,1);
 assert.equal(all.find(doc=>doc.kind==='compaction').text,'useful compact summary');
 assert.equal(all.find(doc=>doc.kind==='tool_result').text,'legitimate tool evidence');
 assert.ok(all.every(doc=>!doc.text.includes('secret')&&!doc.text.includes('copied')));
 assert.equal(f.batch.events.length,5);
 assert.ok(f.batch.events[1].data.replacement_history.length);
 assert.equal(f.batch.events[2].kind,'hook');
 const empty=structuredClone(f.batch);empty.events[1].data.message='';
 assert.equal(batchDocuments({prefix,key:f.key,batch:empty,principal:owner}).find(item=>item.document.kind==='compaction').document.text,'');
});

test('Claude summaries remain searchable without recursively indexing compaction metadata',async()=>{
 const f=await fixture('claude-code');
 assert.equal(f.docs.find(item=>item.document.kind==='compaction').document.text,'useful compact summary');
 assert.ok(f.docs.every(item=>!item.document.text.includes('metadata secret')));
 // Only Codex user_message notifications have the known transcript mirror contract.
 assert.ok(f.docs.some(item=>item.document.kind==='user_message'));
 const b=structuredClone(f.batch);b.events[1].data={type:'system',subtype:'compact_boundary',content:'Conversation compacted',compactMetadata:{text:'exclude'}};
 assert.equal(batchDocuments({prefix,key:f.key,batch:b,principal:owner}).find(item=>item.document.kind==='compaction').document.text,'Conversation compacted');
});

test('search strips recognized transport wrappers while retaining unknown tool payloads',async()=>{
 const f=await fixture(),batch=structuredClone(f.batch);
 batch.events=[
  {id:'message',kind:'message',data:{role:'assistant',content:'release evidence',transportNote:'irrelevant routing metadata'}},
  {id:'known-tool',kind:'tool_call',data:{name:'exec_command',arguments:{cmd:'verify release'},transportNote:'irrelevant routing metadata'}},
  {id:'unknown-tool',kind:'tool_call',data:{vendorPayload:{command:'custom tool evidence'}}},
 ];
 const docs=batchDocuments({prefix,key:f.key,batch,principal:owner}).map(x=>x.document);
 assert.equal(docs.find(d=>d.eventId==='message').text,'release evidence');
 assert.ok(docs.every(d=>!d.text.includes('routing metadata')));
 assert.ok(docs.find(d=>d.eventId==='known-tool').text.includes('verify release'));
 assert.deepEqual(docs.find(d=>d.eventId==='known-tool').toolNames,['exec_command']);
 assert.equal(docs.find(d=>d.eventId==='unknown-tool').text,'custom tool evidence');
 assert.equal(batch.events[0].data.transportNote,'irrelevant routing metadata');
});

function indexFixture(f) {
 const template=f.docs[0].document,rows=new Map(f.docs.map(item=>[item.id,item.document]));
 const compaction=f.docs.find(item=>item.document.kind==='compaction');
 rows.set(compaction.id,{...compaction.document,text:'old copied history',private:true});
 for(const [id,event,chunk] of [['tail','compact',1],['hook-copy','hook',0],['echo-copy','notification',0]])rows.set(id,{...template,eventId:event,kind:f.batch.events.find(x=>x.id===event).kind,chunk,text:'old copied history'});
 let fail=false;const writes=[];
 const collection={field:name=>'session.'+name,search:async(principal,input)=>{
  const hits=[...rows].filter(([id,doc])=>['compaction','hook','user_message'].includes(doc.kind)&&(!input.search_after||id>input.search_after[0]))
   .sort(([a],[b])=>a.localeCompare(b)).slice(0,input.size).map(([id,doc])=>({_id:id,_source:structuredClone(doc),sort:[id]}));
  return {hits:{hits},_shards:{failed:0}};
 },bulk:async(principal,items)=>{if(fail)throw new Error('interrupted');for(const item of items){writes.push(item);rows.set(item.id,item.document);}},
 delete:async(principal,ids)=>ids.forEach(id=>rows.delete(id))};
 return {rows,writes,realm:{tenantId:owner.tenantId,collection:()=>collection},interrupt:value=>{fail=value;}};
}

test('historical projection repair is scoped, dry-runnable, restartable, idempotent and exactly reversible',async()=>{
 const f=await fixture(),index=indexFixture(f),before=structuredClone(index.rows),steps=[],progress=[];
 const options={...f,...index,prefix,principal:{tenantId:owner.tenantId},pageSize:1,backup:async step=>steps.push(structuredClone(step)),onPage:async report=>progress.push(report)};
 const dry=await migrateSessionProjection({...options,dryRun:true});
 assert.equal(dry.rewritten,1);assert.equal(dry.removed,3);assert.deepEqual(index.rows,before);assert.equal(steps.length,0);
 index.interrupt(true);await assert.rejects(migrateSessionProjection(options),/write outcome is uncertain/);index.interrupt(false);
 assert.equal(steps.length,1);assert.deepEqual(index.rows,before);
 const repaired=await migrateSessionProjection(options);
 assert.equal(repaired.rewritten,1);assert.equal(repaired.removed,3);assert.equal(repaired.complete,true);
 assert.equal([...index.rows.values()].find(doc=>doc.kind==='compaction').private,true);
 const again=await migrateSessionProjection(options);assert.equal(again.rewritten+again.removed,0);
 await restoreSessionProjection({...options,steps});assert.deepEqual(index.rows,before);
 await assert.rejects(migrateSessionProjection({...options,principal:{tenantId:'foreign'}}),/scope/);
 await assert.rejects(migrateSessionProjection({...options,principal:{tenantId:owner.tenantId,captureAccess:'write'}}),/scope/);
 const old=index.rows.get('tail');index.rows.set('tail',{...old,sourceKey:old.sourceKey.replace(digest(owner.tenantId),digest('foreign'))});
 await assert.rejects(migrateSessionProjection(options),/source scope/);
 index.rows.set('tail',old);f.store.data.delete(f.key);
 await assert.rejects(migrateSessionProjection(options),/unavailable/);
});

test('real OpenSearch: projection repair removes copied chunks, preserves privacy and tenant isolation, and restores backups',{
 skip:!process.env.OPENCRAWL_TEST_OPENSEARCH_URL,
},async t=>{
 const endpoint=process.env.OPENCRAWL_TEST_OPENSEARCH_URL,environment='projection-'+randomUUID().slice(0,8),foreign={...owner,tenantId:'team-b'};
 const f=await fixture(),search=createSessionSearch({store:deletionTestStore(),prefix:"capture-v1",endpoint,environment}),realm=createRealm({endpoint,environment,tenantId:owner.tenantId});
 t.after(async()=>{for(const who of [owner,foreign])await fetch(endpoint+'/'+realmIndex(environment,who.tenantId),{method:'DELETE'});});
 await search.ensureIndex(owner);await search.ensureIndex(foreign);
 const old=indexFixture(f).rows,steps=[];
 await realm.collection('session').bulk(owner,[...old].map(([id,document])=>({id,document})));
 await search.putDocuments([{id:'foreign',document:{...f.docs[0].document,...foreign,text:'foreign untouched'}}],foreign);
 await search.refresh(owner);await search.refresh(foreign);
 const options={realm,store:f.store,prefix,principal:{tenantId:owner.tenantId},backup:async step=>steps.push(step),pageSize:1};
 assert.equal((await migrateSessionProjection({...options,dryRun:true})).removed,3);
 const result=await migrateSessionProjection(options);assert.equal(result.rewritten,1);assert.equal(result.removed,3);
 await search.refresh(owner);
 assert.equal((await search.search(owner,{query:'copied history'})).total,0);
 const summary=await search.search(owner,{query:'useful compact summary'});assert.equal(summary.total,1);assert.equal(summary.hits[0].private,true);
 assert.equal((await search.search({...owner,userId:'teammate'},{query:'useful compact summary'})).total,0);
 assert.equal((await search.search(foreign,{query:'foreign untouched'})).total,1);
 assert.equal((await migrateSessionProjection(options)).rewritten,0);
 await restoreSessionProjection({...options,steps});await search.refresh(owner);
 assert.equal((await search.search(owner,{query:'copied history'})).total,4);
});

test('repair overlaps at most eight scoped source reads and settles failed reads before any page mutation',async()=>{
 const f=await fixture(),rows=[];
 for(let i=0;i<17;i++) {
  const source=await fixture();
  const key=source.key.replace(digest('device'),digest('device-'+i));
  const b={...source.batch,installationId:'device-'+i};
  f.store.data.set(key,gzipSync(JSON.stringify(b)));
  rows.push({_id:'row-'+i,_source:{...f.docs[0].document,installationId:b.installationId,sourceKey:key,eventId:'hook',kind:'hook'},sort:[i]});
 }
 let active=0,peak=0,reads=0,mutations=0,fail=false;
 const get=f.store.get;
 const store={get:async(...args)=>{active++;reads++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,1));active--;if(fail&&reads===8)throw new Error('source read failed');return get(...args);}};
 const realm={tenantId:owner.tenantId,collection:()=>({field:x=>x,search:async(_,input)=>({hits:{hits:input.search_after?[]:rows},_shards:{failed:0}}),bulk:async()=>mutations++,delete:async()=>mutations++})};
 const options={realm,store,prefix,principal:{tenantId:owner.tenantId},backup:async()=>mutations++};
 const report=await migrateSessionProjection({...options,dryRun:true});assert.equal(report.removed,17);assert.equal(peak,8);assert.equal(reads,17);assert.equal(active,0);
 reads=0;fail=true;await assert.rejects(migrateSessionProjection(options),/source read failed/);assert.equal(active,0);assert.equal(mutations,0);
 // A source held from the prior page may recur after another source in the group.
 let page=0;
 const repeat={...realm,collection:()=>({...realm.collection(),search:async()=>({hits:{hits:page++===0?[rows[0]]:page===2?[{...rows[0],sort:[1]},{...rows[1],sort:[2]},{...rows[0],_id:'recur',sort:[3]}]:[]},_shards:{failed:0}})})};
 fail=false;assert.equal((await migrateSessionProjection({...options,realm:repeat,dryRun:true})).removed,4);
});
