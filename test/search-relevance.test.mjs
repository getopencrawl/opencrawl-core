import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fuseRankings,passages,quotedPhrases,relevanceQuery} from '../src/search/relevance.mjs';
import {createSessionSearch} from '../src/sessions/search.mjs';

const owner={tenantId:'tenant-a',userId:'same-user'};

test('relevance query matches any term, adds stemming and boosts quoted phrases',()=>{
 const q=relevanceQuery(`On the customer page, what is between 'Delete Customer' and "Back"?`);
 assert.equal(q.bool.minimum_should_match,1);
 assert.deepEqual(q.bool.should[0],{match:{text:{query:`On the customer page, what is between 'Delete Customer' and "Back"?`}}});
 assert.ok(q.bool.should.some(c=>c.match?.['text.en']));
 assert.deepEqual(q.bool.should.filter(c=>c.match_phrase).map(c=>c.match_phrase.text.query),['Delete Customer','Back']);
 assert.ok(!JSON.stringify(q).includes('"operator":"and"'));
 assert.deepEqual(relevanceQuery('violet',{stemmed:false}).bool.should,[{match:{text:{query:'violet'}}}]);
 assert.deepEqual(quotedPhrases(`it's "--" and 'ok', the users' "Login as Customer" link`),['ok','Login as Customer']);
 assert.deepEqual(quotedPhrases(`don't click 'Back'`),['Back']);
});

test('passages split on lines, cap size and keep every character of short text',()=>{
 assert.deepEqual(passages('a\nb\nc',3),['a\nb','c']);
 assert.deepEqual(passages('x'.repeat(7),3),['xxx','xxx','x']);
 assert.deepEqual(passages('',8000),['']);
 const text=Array.from({length:500},(_,i)=>`line ${i} `+'y'.repeat(i%40)).join('\n');
 const parts=passages(text,1000);
 assert.ok(parts.every(p=>p.length<=1000));
 assert.equal(parts.join('\n'),text);
});

test('reciprocal rank fusion rewards agreement between rankings',()=>{
 const fused=fuseRankings([{hits:[{id:'a'},{id:'b'},{id:'c'}]},{hits:[{id:'b'}]}]);
 assert.deepEqual(fused.map(h=>h.id),['b','a','c']);
 assert.deepEqual(fuseRankings([{hits:[{id:'a'}]},{hits:[{id:'b'}],weight:2}]).map(h=>h.id),['b','a']);
});

test('search sends the relevance query inside both ownership filters and fuses vector hits',async()=>{
 const bodies=[];
 const hit=(id,tenantId='tenant-a')=>({_id:id,_score:1,_source:{tenantId,userId:'same-user',text:id}});
 const search=createSessionSearch({endpoint:'http://localhost:9200',index:'sessions-test',vectors:{dimensions:2,exact:true},
  embed:async texts=>texts.map(()=>[1,0]),fetch:async(url,options)=>{
   const body=JSON.parse(options.body);bodies.push(body);
   return Response.json(body.query.script_score?{hits:{hits:[hit('v1'),hit('l2')]}}:{hits:{total:{value:2},hits:[hit('l1'),hit('l2')]}});
  }});
 const result=await search.search(owner,{query:'which buttons are in the toolbar',limit:5,text:false});
 assert.deepEqual(result.hits.map(h=>h.id),['l2','l1','v1']);
 const [lexical,dense]=bodies;
 assert.deepEqual(lexical.query.bool.filter,[{term:{tenantId:'tenant-a'}},{term:{userId:'same-user'}}]);
 assert.deepEqual(dense.query.script_score.query.bool.filter,lexical.query.bool.filter);
 assert.deepEqual(lexical._source.excludes,['embedding','text']);
 const leaking=createSessionSearch({endpoint:'http://localhost:9200',index:'sessions-test',vectors:{dimensions:2,exact:true},
  embed:async texts=>texts.map(()=>[1,0]),fetch:async(url,options)=>Response.json(JSON.parse(options.body).query.script_score?{hits:{hits:[hit('x','tenant-b')]}}:{hits:{total:{value:0},hits:[]}})});
 await assert.rejects(leaking.search(owner,{query:'anything'}),/ownership scope/);
 assert.throws(()=>createSessionSearch({endpoint:'http://localhost:9200',index:'x',embed:async()=>[]}),/vectors.dimensions/);
});

test('real OpenSearch: natural-language questions find passages; hybrid stays inside the owner scope',{
 skip:!process.env.OPENCRAWL_TEST_OPENSEARCH_URL,
},async t=>{
 const endpoint=process.env.OPENCRAWL_TEST_OPENSEARCH_URL;
 const words=['customer','toolbar','login','delete','back','invoice','forum','subscribe'];
 const embed=async texts=>texts.map(text=>{const v=words.map(w=>text.toLowerCase().includes(w)?1:0);const n=Math.hypot(...v)||1;return v.map(x=>x/n||1e-6);});
 for(const exact of [true,false]){
  const index='relevance-test-'+randomUUID();
  t.after(()=>fetch(`${endpoint}/${index}`,{method:'DELETE'}));
  const search=createSessionSearch({endpoint,index,embed,vectors:{dimensions:words.length,exact}});
  await search.ensureIndex();
  const doc=(id,principal,text)=>({id,document:{tenantId:principal.tenantId,userId:principal.userId,sessionId:'s',eventId:id,kind:'state',receivedAt:new Date().toISOString(),sequence:0,chunk:0,text}});
  const other={tenantId:'tenant-b',userId:'same-user'};
  await search.putDocuments([
   doc('toolbar',owner,"Customer detail toolbar: Delete Customer | Login as Customer | Back"),
   doc('forum',owner,'Forum subscribe button and invoice list'),
   doc('leak',other,"Customer detail toolbar: Delete Customer | Login as Customer | Back"),
  ]);
  await search.refresh();
  const question=`I am using the shop admin. On customer detail pages, what is the action between 'Delete Customer' and 'Back' in the top toolbar? Mark your final answer in \\boxed{}.`;
  const {hits}=await search.search(owner,{query:question});
  assert.equal(hits[0].id,'toolbar',`exact=${exact}`);
  assert.ok(hits.every(h=>h.tenantId==='tenant-a'),`exact=${exact}`);
  // Vector search returns the nearest passages even without shared terms, still only the owner's.
  assert.ok((await search.search(owner,{query:'violet'})).hits.every(h=>h.tenantId==='tenant-a'));
 }
});
