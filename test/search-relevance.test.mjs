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
 assert.deepEqual(body._source,{excludes:['text']});
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
