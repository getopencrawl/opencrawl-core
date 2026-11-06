import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {passages,quotedPhrases,relevanceQuery} from '../src/search/relevance.mjs';
import {createSessionSearch} from '../src/sessions/search.mjs';
import {realmResponse} from './realm-fixture.mjs';

const owner={tenantId:'tenant-a',userId:'same-user'};
const question=`I am using the shop admin. On customer detail pages, what is the action between 'Delete Customer' and 'Back' in the top toolbar? Mark your final answer in \\boxed{}.`;

test('relevance query matches any term and boosts quoted phrases on every field',()=>{
 const q=relevanceQuery(`On the customer page, what is between 'Delete Customer' and "Back"?`);
 assert.equal(q.bool.minimum_should_match,1);
 assert.deepEqual(q.bool.should[0],{match:{text:{query:`On the customer page, what is between 'Delete Customer' and "Back"?`}}});
 assert.deepEqual(q.bool.should.slice(1).map(c=>c.match_phrase.text.query),['Delete Customer','Back']);
 assert.ok(!JSON.stringify(q).includes('"operator":"and"'));
 const multi=relevanceQuery(`find "Q3 plan"`,{fields:['title^2','text']});
 assert.deepEqual(multi.bool.should[0],{multi_match:{query:'find "Q3 plan"',fields:['title^2','text'],type:'most_fields'}});
 assert.deepEqual(multi.bool.should.slice(1).map(c=>[Object.keys(c.match_phrase)[0],Object.values(c.match_phrase)[0].boost]),[['title',6],['text',3]]);
 assert.deepEqual(quotedPhrases(`it's "--" and 'ok', the users' "Login as Customer" link`),['ok','Login as Customer']);
 assert.deepEqual(quotedPhrases(`don't click 'Back'`),['Back']);
});

test('passages split on lines, cap size and keep every character',()=>{
 assert.deepEqual(passages('a\nb\nc',3),['a\nb','c']);
 assert.deepEqual(passages('x'.repeat(7),3),['xxx','xxx','x']);
 assert.deepEqual(passages('',8000),['']);
 const text=Array.from({length:500},(_,i)=>`line ${i} `+'y'.repeat(i%40)).join('\n');
 const parts=passages(text,1000);
 assert.ok(parts.every(p=>p.length<=1000));
 assert.equal(parts.join('\n'),text);
});

test('session search scores with the relevance query inside the tenant filter and can omit text',async()=>{
 const bodies=[];
 const search=createSessionSearch({endpoint:'http://localhost:9200',tenantId:'tenant-a',index:'sessions-test',fetch:async(url,options)=>{
  bodies.push(JSON.parse(options.body));
  return realmResponse('session',{hits:{total:{value:0},hits:[]}});
 }});
 await search.search(owner,{query:question,limit:300,text:false});
 const body=bodies.at(-1);
 assert.deepEqual(body.query.bool.filter,[{term:{tenantId:'tenant-a'}},{term:{corpus:'session'}}]);
 assert.deepEqual(body.query.bool.must[0].bool.filter,[{term:{tenantId:'tenant-a'}}]);
 assert.ok(JSON.stringify(body.query).includes('Delete Customer'));
 assert.deepEqual(body._source,{excludes:['embedding','text']});
 assert.equal(body.size,300);
});

test('real OpenSearch: a natural-language question finds the passage, only in the owner realm',{
 skip:!process.env.OPENCRAWL_TEST_OPENSEARCH_URL,
},async t=>{
 const endpoint=process.env.OPENCRAWL_TEST_OPENSEARCH_URL,environment='t'+randomUUID().slice(0,8);
 const search=createSessionSearch({endpoint,environment});
 const other={tenantId:'tenant-b',userId:'same-user'};
 const doc=(id,principal,text)=>({id,document:{tenantId:principal.tenantId,userId:principal.userId,sessionId:'s',eventId:id,kind:'message',harness:'codex',receivedAt:new Date().toISOString(),sequence:0,chunk:0,text}});
 for(const [principal,docs] of [[owner,[doc('toolbar',owner,'Customer detail toolbar: Delete Customer | Login as Customer | Back'),doc('forum',owner,'Forum subscribe button and invoice list')]],[other,[doc('leak',other,'Customer detail toolbar: Delete Customer | Login as Customer | Back')]]]){
  await search.ensureIndex(principal);await search.putDocuments(docs,principal);
 }
 t.after(()=>fetch(`${endpoint}/opencrawl-${environment}-realm-*`,{method:'DELETE'}));
 await fetch(`${endpoint}/opencrawl-${environment}-realm-*/_refresh`,{method:'POST'});
 const {hits}=await search.search(owner,{query:question});
 assert.equal(hits[0]?.eventId,'toolbar');
 assert.ok(hits.every(h=>h.tenantId==='tenant-a'));
 assert.equal((await search.search(owner,{query:'Customer AND toolbar'})).hits[0].eventId,'toolbar');
});

test('hybrid session search embeds on write, scopes both queries and fuses rankings',async()=>{
 const bodies=[],bulks=[];
 const hit=id=>({_id:id,_score:1,_source:{tenantId:'tenant-a',userId:'same-user',text:id}});
 const search=createSessionSearch({endpoint:'http://localhost:9200',tenantId:'tenant-a',index:'sessions-test',vectors:{dimensions:2},
  embed:async texts=>texts.map(()=>[1,0]),fetch:async(url,options)=>{
   if(url.pathname.endsWith('_bulk')){bulks.push(options.body);const n=options.body.trim().split('\n').length/2;return Response.json({errors:false,items:Array.from({length:n},()=>({update:{status:201}}))});}
   const body=JSON.parse(options.body);bodies.push(body);
   return realmResponse('session',body.query.bool.must[0].knn?{hits:{hits:[hit('v1'),hit('l2')]}}:{hits:{total:{value:2},hits:[hit('l1'),hit('l2')]}});
  }});
 await search.putDocuments([{id:'e1',document:{tenantId:'tenant-a',userId:'same-user',sessionId:'s',eventId:'e1',kind:'message',receivedAt:new Date().toISOString(),text:'hello'}}],owner);
 assert.match(bulks[0],/"embedding":\[1,0\]/);
 const result=await search.search(owner,{query:'which buttons are in the toolbar',limit:5,text:false});
 assert.deepEqual(result.hits.map(h=>h.id),['l2','l1','v1']);
 for(const body of bodies)assert.deepEqual(body.query.bool.filter,[{term:{tenantId:'tenant-a'}},{term:{corpus:'session'}}]);
 assert.ok(bodies.some(b=>b.query.bool.must[0].knn?.embedding?.k===5));
 assert.throws(()=>createSessionSearch({endpoint:'http://localhost:9200',embed:async()=>[]}),/vectors.dimensions/);
});

test('real OpenSearch: vector realms store embeddings, reject a mapping without them and stay scoped',{
 skip:!process.env.OPENCRAWL_TEST_OPENSEARCH_URL,
},async t=>{
 const endpoint=process.env.OPENCRAWL_TEST_OPENSEARCH_URL,environment='h'+randomUUID().slice(0,8);
 const words=['customer','toolbar','login','delete','back','invoice','forum','subscribe'];
 const embed=async texts=>texts.map(text=>{const v=words.map(w=>text.toLowerCase().includes(w)?1:0);const n=Math.hypot(...v)||1;return v.map(x=>x/n||1e-6);});
 t.after(()=>fetch(`${endpoint}/opencrawl-${environment}-realm-*`,{method:'DELETE'}));
 const search=createSessionSearch({endpoint,environment,embed,vectors:{dimensions:words.length}});
 const other={tenantId:'tenant-b',userId:'same-user'};
 const doc=(id,principal,text)=>({id,document:{tenantId:principal.tenantId,userId:principal.userId,sessionId:'s',eventId:id,kind:'message',harness:'codex',receivedAt:new Date().toISOString(),sequence:0,chunk:0,text}});
 for(const [principal,docs] of [[owner,[doc('toolbar',owner,'Customer detail toolbar: Delete Customer | Login as Customer | Back'),doc('forum',owner,'Forum subscribe button and invoice list')]],[other,[doc('leak',other,'Customer detail toolbar: Delete Customer | Login as Customer | Back')]]]){
  await search.ensureIndex(principal);await search.putDocuments(docs,principal);
 }
 await fetch(`${endpoint}/opencrawl-${environment}-realm-*/_refresh`,{method:'POST'});
 const {hits}=await search.search(owner,{query:question});
 assert.equal(hits[0]?.eventId,'toolbar');
 assert.ok(hits.every(h=>h.tenantId==='tenant-a'&&!('embedding' in h)));
 // A realm created without vectors cannot be opened as a vector realm (needs a new generation).
 const plainEnv='p'+randomUUID().slice(0,8);
 t.after(()=>fetch(`${endpoint}/opencrawl-${plainEnv}-realm-*`,{method:'DELETE'}));
 await createSessionSearch({endpoint,environment:plainEnv}).ensureIndex(owner);
 await assert.rejects(createSessionSearch({endpoint,environment:plainEnv,embed,vectors:{dimensions:words.length}}).ensureIndex(owner),/migrate to a new generation/);
});

test('real OpenSearch: exact vector realms score every passage in scope',{skip:!process.env.OPENCRAWL_TEST_OPENSEARCH_URL},async t=>{
 const endpoint=process.env.OPENCRAWL_TEST_OPENSEARCH_URL,environment='x'+randomUUID().slice(0,8);
 const embed=async texts=>texts.map(text=>/toolbar/i.test(text)?[1,0]:[0,1]);
 t.after(()=>fetch(`${endpoint}/opencrawl-${environment}-realm-*`,{method:'DELETE'}));
 const search=createSessionSearch({endpoint,environment,embed,vectors:{dimensions:2,exact:true}});
 await search.ensureIndex(owner);
 const doc=(id,text)=>({id,document:{tenantId:'tenant-a',userId:'same-user',sessionId:'s',eventId:id,kind:'message',harness:'codex',receivedAt:new Date().toISOString(),sequence:0,chunk:0,text}});
 await search.putDocuments([doc('toolbar','Toolbar: Delete Customer | Back'),doc('forum','Forum subscribe')],owner);
 await fetch(`${endpoint}/opencrawl-${environment}-realm-*/_refresh`,{method:'POST'});
 const {hits}=await search.search(owner,{query:'what is in the toolbar'});
 assert.equal(hits[0].eventId,'toolbar');
 const mapping=Object.values(await (await fetch(`${endpoint}/opencrawl-${environment}-realm-*/_mapping`)).json())[0].mappings;
 assert.equal(mapping.properties.embedding.method,undefined);
});
