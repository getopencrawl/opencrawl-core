import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {groundIntentCorpus} from '../dist/src/intents/corpus.mjs';
import {createIntentCorpusStore} from '../dist/src/intents/postgres.mjs';
import {applicationDatabaseFixture, postgresUrl} from './fixtures/application-database.mjs';

const origin = 'https://workspace.example';
const url = '/sessions/oc_' + 'x'.repeat(32) + '#event=message-7&installation=laptop';
const passage = {id:'sessions:7', tenantId:'alpha', owner:'alice', sessionId:'chat-1', harness:'codex', role:'user',
  timestamp:'2026-03-14T11:10:00Z', url, text:'A Lantern retains the color chosen by its owner.'};
const citation = {id:passage.id, quote:passage.text};
const draft = {
  intents:[{id:'82ac71be',path:['Lanterns','Appearance'],statement:passage.text,sources:[citation],terms:['lamp.lantern']}],
  terms:[{name:'lamp.lantern',label:'Lantern',definition:'An owner-configurable light.',aliases:[],sources:[citation]}],
};
const publication = {runId:randomUUID(),from:'2026-03-10T00:00:00Z',until:'2026-03-17T00:00:00Z'};

test('references resolve to original session events and exact dialogue', () => {
  assert.equal(groundIntentCorpus(draft,[passage],origin).sources[0].url,url);
  for(const bad of [{...passage,url:origin+'/intents?intent=82ac71be'}, {...passage,url:'https://elsewhere.example'+url},
    {...passage,text:'Different words'}, {...passage,role:'assistant'}]){
    assert.throws(()=>groundIntentCorpus(draft,[bad],origin));
  }
  assert.throws(()=>groundIntentCorpus({...draft,terms:[]},[passage],origin));
});

test('initial publication is atomic, retryable, tenant-scoped and follows source visibility', {skip:!postgresUrl}, async t => {
  const db=await applicationDatabaseFixture(t), a={tenantId:'alpha',userId:'alice'}, b={tenantId:'beta',userId:'bob'};
  let visible=true;
  const store=createIntentCorpusStore(db,origin,async (tenant,sources)=>new Set(visible && tenant==='alpha'?sources.map(s=>s.id):[]));
  await assert.rejects(store.publishInitial(b,publication,draft,[passage]),{status:403});
  assert.equal(await store.read(b),null);
  await Promise.all([1,2].map(()=>store.publishInitial(a,publication,draft,[passage])));
  assert.deepEqual((await store.read(a)).intents[0],draft.intents[0]);
  await assert.rejects(store.publishInitial(a,{...publication,runId:randomUUID()},draft,[passage]),{status:409});
  assert.equal(await store.read(b),null);
  await assert.rejects(store.read({...a,captureAccess:'write'}),{status:403});
  visible=false;
  assert.deepEqual(await store.read(a),{intents:[],sources:[],terms:[],conflicts:[]});
});

test('history pagination crosses private sessions without returning them even to the owner', async () => {
  const {intentHistoryPage}=await import('../dist/src/intents/history.mjs');
  const a={tenantId:'alpha',userId:'alice'};
  const window={from:publication.from,until:publication.until,after:null};
  const rows=Array.from({length:48},(_,i)=>({_id:String(i),sort:['alice','codex','chat',0,i,'x',0,String(i)],
    _source:{tenantId:'alpha',userId:'alice',sessionId:i<47?'hidden':'shared',harness:'codex',eventId:'event-'+i,
      kind:'message',role:i===47?'assistant':'user',timestamp:passage.timestamp,text:'evidence'}}));
  let reads=0;
  const controls={read:async(owner,kind,harness,name)=>{
    assert.deepEqual(owner,a);assert.equal(kind,'sessions');assert.equal(harness,'codex');reads++;
    return name==='hidden'?{visibility:'private',deletedAt:null}:null;
  }};
  const links={register:async(tenant,_kind,keys)=>{
    assert.equal(tenant,'alpha');return keys.map(k=>{assert.equal(k.name,'shared');return 'oc_'+'x'.repeat(32);});
  }};
  const collected=[];
  const realm={tenantId:'alpha',collection:()=>({field:k=>'session.'+k,search:async(_principal,body)=>{
    collected.push(body);return {hits:{hits:body.search_after?[]:rows},_shards:{failed:0}};
  }})};
  const first=await intentHistoryPage(realm,controls,links,a,window);
  assert.equal(first.passages.length,1);assert.match(first.passages[0].url,/#event=event-47$/);
  assert.equal(reads,2);
  const last=await intentHistoryPage(realm,controls,links,a,{...window,after:first.after});
  assert.equal(last.after,null);assert.deepEqual(collected[1].search_after,rows.at(-1).sort);
  assert.match(JSON.stringify(collected[0].query),/session\.containsToolOutput/);
  await assert.rejects(intentHistoryPage(realm,controls,links,{...a,tenantId:'beta'},window),{status:403});
});
