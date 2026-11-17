import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {createSessionIngest} from '../dist/src/sessions/ingest.mjs';
import {batchDocuments,sessionDocumentId} from '../dist/src/sessions/indexer.mjs';
import {sessionScope} from '../dist/src/sessions/event-identity.mjs';
import {createControls} from '../dist/src/sessions/controls.mjs';
import {migrateSessionPassages,restoreSessionPassages} from '../dist/src/sessions/passage-migration.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';
const owner={tenantId:'migration-team',userId:'owner'},prefix='capture';
async function fixture(){
  const store=memorySessionStore(),text=('A useful paragraph with deployment evidence.\n\n').repeat(450)+'Unique original tail.';
  const ingest=createSessionIngest({store,prefix});
  await ingest.putBatch(owner,{schemaVersion:1,owner,harness:'codex',origin:'cli',installationId:'machine',sessionId:'session',title:'Release decision',attachments:[],events:[{id:'event',kind:'message',timestamp:'2026-11-01T00:00:00Z',data:{role:'assistant',content:text,status:'completed'}}]});
  const key=[...store.data.keys()].find(k=>k.endsWith('.json.gz'));
  const batch=JSON.parse(gunzipSync(store.data.get(key))),projected=batchDocuments({prefix,key,batch,principal:owner});
  const documents=new Map();
  for(const [chunk,part]of [...('completed\n'+text).matchAll(/[\s\S]{1,16000}/gu)].entries()){
    const d={...projected[0].document,chunk,text:part[0]};for(const field of ['passageVersion','chunkCount','textStart','textEnd'])delete d[field];
    const id=sessionDocumentId({scope:sessionScope(owner),harness:'codex',sessionId:'session',eventId:'event',chunk});documents.set(id,d);
  }
  const collection={field:k=>'session.'+k,search:async(p,body)=>{
    let entries=[...documents].filter(([,d])=>body.size===1000||!(d.passageVersion>=2));
    entries.sort(([a],[b])=>a.localeCompare(b));if(body.search_after)entries=entries.filter(([id])=>id>body.search_after[0]);
    return {timed_out:false,_shards:{failed:0},hits:{total:{value:entries.length,relation:'eq'},hits:entries.slice(0,body.size).map(([id,d])=>({_id:id,_source:structuredClone(d),sort:[id]}))}};
  },mget:async(p,ids)=>({docs:ids.map(id=>({_id:id,found:documents.has(id),_source:structuredClone(documents.get(id))}))}),bulk:async(p,items)=>{for(const i of items)documents.set(i.id,structuredClone(i.document));},delete:async(p,ids)=>{for(const id of ids)documents.delete(id);}};
  const realm={tenantId:owner.tenantId,collection:()=>collection,ensureIndex:async()=>{}};
  return {store,key,text,projected,documents,realm};
}
test('dry run, checkpoint replay and rollback preserve originals and current privacy',async()=>{
  const f=await fixture(),backups=[],original=structuredClone([...f.documents]);
  const args={...f,principal:owner,prefix,backup:async step=>{backups.push(structuredClone(step));}};
  const dry=await migrateSessionPassages(args);assert.equal(dry.events,1);assert.deepEqual([...f.documents],original);assert.equal(backups.length,0);
  await createControls({store:f.store,prefix}).update(owner,'sessions','codex','session',()=>({visibility:'private',deletedAt:null}));
  const done=await migrateSessionPassages({...args,dryRun:false});assert.equal(done.complete,true);assert.equal(backups.length,1);
  const sorted=[...f.documents.values()].sort((a,b)=>a.chunk-b.chunk);
  assert.equal(sorted.map(d=>d.text).join(''),f.text);assert.ok(sorted.every(d=>d.private&&d.passageVersion===2));
  assert.equal((await migrateSessionPassages({...args,dryRun:false})).events,0);
  await restoreSessionPassages({...args,steps:backups});
  assert.deepEqual([...f.documents].map(([id,d])=>[id,{...d,private:false}]),original);
  assert.ok([...f.documents.values()].every(d=>d.private));assert.ok(f.store.data.has(f.key));
});
test('missing sources, foreign scope, deleted sessions and failed backups cannot mutate the projection',async()=>{
  for(const scenario of ['missing','foreign','backup']){
    const f=await fixture(),before=structuredClone([...f.documents]);if(scenario==='missing')await f.store.delete(f.key);
    await assert.rejects(migrateSessionPassages({...f,prefix,principal:scenario==='foreign'?{...owner,tenantId:'other'}:owner,dryRun:false,backup:async()=>{if(scenario==='backup')throw new Error('backup failed');}}));
    assert.deepEqual([...f.documents],before);
  }
  const f=await fixture(),backups=[];await migrateSessionPassages({...f,prefix,principal:owner,dryRun:false,backup:async s=>{backups.push(s);}});
  await createControls({store:f.store,prefix}).update(owner,'sessions','codex','session',()=>({visibility:'team',deletedAt:'2026-11-02T00:00:00Z'}));
  await assert.rejects(restoreSessionPassages({...f,prefix,principal:owner,steps:backups}),/Deleted/);
});


test('restart finds remaining legacy chunks even after chunk zero was replaced',async()=>{
  const f=await fixture();
  const zero=f.projected.find(x=>x.document.chunk===0);f.documents.set(zero.id,zero.document);
  assert.ok([...f.documents.values()].some(d=>d.chunk>0&&!d.passageVersion));
  await migrateSessionPassages({...f,prefix,principal:owner,dryRun:false,backup:async()=>{}});
  assert.ok([...f.documents.values()].every(d=>d.passageVersion===2));
  assert.equal([...f.documents.values()].sort((a,b)=>a.chunk-b.chunk).map(d=>d.text).join(''),f.text);
});
