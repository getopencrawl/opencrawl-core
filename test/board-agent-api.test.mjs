import {test} from 'node:test';
import assert from 'node:assert/strict';
import {boardStateFixture,boardTenant} from './fixtures/board-state.mjs';
import {authorizedBoard} from '../dist/src/application/board.mjs';
const alice={tenantId:'team-a',userId:'alice'},bob={...alice,userId:'bob'},other={tenantId:'team-b',userId:'alice'};
const user=(principal)=>({session:principal.userId});
async function fixture(t){const f=await boardStateFixture(t),board=f.make({recentSessions:{list(){throw Error('Board messages must not discover sessions');}}});
 for(const principal of [alice,bob,other])await board.agent.presence(principal,{session:principal.userId,name:'codex:'+principal.userId,task:'Agent contract test',announce:false});
 return {...f,board,api:board.agent};}
const post=(api,principal,id,text,extra={})=>api.post(principal,{...user(principal),posts:[{id,text,...extra}]});

test('post receipts omit sender text while read, list, search, thread and sync return the full message',async t=>{
 const {api}=await fixture(t),body='First line\n\n'+('complete evidence '.repeat(1600));
 const sent=await post(api,alice,'root',body,{channel:'work'});
 assert.deepEqual(sent,{messages:[{id:1,thread:1}]});
 const [message]=(await api.read(alice,{ids:[1]})).messages;
 assert.deepEqual(Object.keys(message),['id','from','channel','thread','replyTo','time','text','mentions']);assert.equal(message.text,body);
 for(const result of [await api.read(bob,{ids:[message.id]}),await api.list(bob,{channels:['work']}),await api.search(bob,{query:'evidence'}),await api.thread(bob,{threadId:message.id}),await api.sync(bob,{...user(bob),channels:['work'],after:0})])assert.deepEqual(result.messages,[message]);
 const empty=await api.sync(bob,{...user(bob),after:message.id});assert.deepEqual(empty,{messages:[],next:1,more:false});assert.ok(JSON.stringify(empty).length<60);
 assert.deepEqual((await api.read(bob,{ids:[message.id],select:['text']})).messages,[{id:1,text:body}]);
});

test('threads accept any message, preserve the reply target, page oldest first and read incrementally',async t=>{
 const {api}=await fixture(t);await post(api,alice,'root','Root',{channel:'work'});
 await post(api,bob,'reply','First reply',{replyTo:1});await post(api,alice,'nested','Reply to first reply',{replyTo:2});
 const first=await api.thread(bob,{threadId:2,limit:2});assert.deepEqual(first.messages.map(m=>[m.id,m.thread,m.replyTo]),[[1,1,null],[2,1,1]]);
 await post(api,bob,'later','Concurrent reply',{replyTo:3});
 const second=await api.thread(bob,{threadId:2,limit:2,cursor:first.next});assert.deepEqual(second.messages.map(m=>m.id),[3]);assert.equal(second.next,null);
 const delta=await api.thread(bob,{threadId:3,after:3});assert.deepEqual(delta.messages.map(m=>[m.id,m.replyTo]),[[4,3]]);
 assert.deepEqual((await api.thread(bob,{threadId:4,order:'newest',limit:2})).messages.map(m=>m.id),[4,3]);
 await assert.rejects(post(api,alice,'wrong-channel','Wrong',{replyTo:2,channel:'elsewhere'}),{status:404});
});

test('list/search support sender handles, IDs, roots, ordering and stable whole-record pages',async t=>{
 const {api}=await fixture(t);await post(api,alice,'one','Needle '.repeat(2200),{channel:'work'});await post(api,bob,'two','Needle two',{channel:'work'});await post(api,alice,'three','Needle three',{replyTo:2});
 const byName=await api.search(bob,{query:'Needle',from:['@CODEX:ALICE'],order:'oldest'});assert.equal(byName.messages.length,1);assert.equal(byName.messages[0].text,'Needle '.repeat(2200));
 const next=await api.search(bob,{query:'Needle',from:['@CODEX:ALICE'],order:'oldest',cursor:byName.next});assert.deepEqual(next.messages.map(m=>m.id),[3]);
 assert.deepEqual((await api.list(bob,{after:1,before:3,rootsOnly:true})).messages.map(m=>m.id),[2]);
 assert.deepEqual((await api.list(bob,{order:'oldest',select:['from'],limit:1})).messages,[{id:1,from:'codex:alice'}]);
 await assert.rejects(api.list(other,{cursor:byName.next}),{status:409});
});

test('explicit mentions resolve handles and reject unknown targets atomically',async t=>{
 const {api}=await fixture(t);const message=(await post(api,alice,'tag','Hello',{channel:'work',mentions:['@codex:bob']})).messages[0];assert.deepEqual(message,{id:1,thread:1});
 assert.deepEqual((await api.sync(bob,{...user(bob),after:0})).messages[0].mentions,['codex:bob']);
 await assert.rejects(api.post(alice,{...user(alice),posts:[{id:'rolled-back',text:'One',channel:'work'},{id:'invalid',text:'Two',channel:'work',mentions:['missing']}]}),{status:404});
 assert.deepEqual((await api.list(alice,{})).messages.map(m=>m.id),[1]);
 await assert.rejects(post(api,alice,'tag','Changed',{channel:'work',mentions:['codex:bob']}),{status:409});
 assert.deepEqual((await post(api,alice,'tag','Hello',{channel:'work',mentions:['@codex:bob']})).messages,[message]);
 const inline=await post(api,alice,'inline','An unknown @package can be literal text',{channel:'work'});assert.match(inline.warning,/unregistered/);assert.deepEqual(inline.messages,[{id:2,thread:2}]);
});

test('starting and joining a thread follows its replies through both MCP-style sync and native delivery',async t=>{
 const {api,board}=await fixture(t);await post(api,alice,'root','Root',{channel:'work'});await post(api,bob,'reply','Reply',{replyTo:1});
 assert.deepEqual((await api.sync(alice,{...user(alice),after:1})).messages.map(m=>m.id),[2]);
 const delivery=await board.participate(alice,'inbox',user(alice));assert.deepEqual(delivery.batch.messages.map(m=>m.id),[2]);
 await board.participate(alice,'ack',{...user(alice),receipt:delivery.batch.receipt});
 await api.follow(alice,{...user(alice),threadId:2,following:false});await post(api,bob,'next','Next',{replyTo:2});
 assert.deepEqual((await api.sync(alice,{...user(alice),after:2})).messages,[]);
 await post(api,alice,'muted-response','Still unfollowed',{replyTo:3});await post(api,bob,'after-mute','No automatic refollow',{replyTo:4});
 assert.deepEqual((await api.sync(alice,{...user(alice),after:4})).messages,[]);
 await api.follow(alice,{...user(alice),threadId:3,following:true});assert.deepEqual((await api.sync(alice,{...user(alice),after:4})).messages.map(m=>m.id),[5]);
});

test('session identity, scope, lifecycle and final authorization remain explicit',async t=>{
 const {api,state,board}=await fixture(t);await post(api,alice,'root','Private tenant',{channel:'work'});
 for(const method of ['read','thread'])await assert.rejects(api[method](other,method==='read'?{ids:[1]}:{threadId:1}),{status:404});
 await assert.rejects(api.read(bob,{workspace:'team-b',ids:[1]}),{status:403});
 await assert.rejects(api.post(bob,{session:'alice',posts:[{id:'forged',channel:'work',text:'Bad'}]}),{status:409});
 await assert.rejects(api.post(alice,{session:'alice',agent:'codex:bob',posts:[{id:'forged',channel:'work',text:'Bad'}]}),{status:409});
 await assert.rejects(api.presence(alice,{session:'new',name:'opencrawl'}),{status:403});
 for(const channel of ['opencrawl','OpenCrawl',' OPENCRAWL '])await assert.rejects(post(api,alice,'system-forgery','Cannot announce',{channel}),{status:403});
 await api.presence(alice,{session:'alice',leave:true});assert.deepEqual((await api.agents(bob,{})).agents.map(p=>p.name),['codex:bob']);
 await assert.rejects(post(api,alice,'left','Gone',{channel:'work'}),{status:409});
 await api.presence(alice,{session:'alice'});
 assert.deepEqual((await api.agents(bob,{limit:1})).agents.length,1);
 assert.deepEqual((await api.agents(bob,{query:'ALICE'})).agents.map(p=>p.name),['codex:alice']);
 assert.equal((await api.post(alice,{agent:'@CODEX:ALICE',full:true,posts:[{id:'handle',channel:'work',text:'By handle'}]})).messages[0].from,'codex:alice');
 await assert.rejects(api.presence(alice,{session:'alice',agent:'codex:bob'}),{status:409});
 await post(api,alice,'back','Back',{channel:'work'});
 assert.equal((await board.participate(alice,'inbox',{session:'alice'})).left,undefined);
 const denied=authorizedBoard({state,admit:async p=>p,authorize:async()=>{throw Object.assign(Error('Revoked'),{status:403});}});
 await assert.rejects(denied.agent.read(alice,{ids:[1]}),{status:403});
});

test('reply targets, mention names and following survive backup/restore',async t=>{
 const {api,repository}=await fixture(t);await post(api,alice,'root','Root',{channel:'work'});await post(api,bob,'reply','Reply',{replyTo:1,mentions:['codex:alice']});
 const state=await repository.exportLegacy(boardTenant('team-a'));
 const badReply=structuredClone(state);badReply.messages[1].replyTo=2;await assert.rejects(repository.importLegacy(boardTenant('bad-reply'),badReply),/Invalid board reply target/);
 const badFollow=structuredClone(state);Object.values(badFollow.participants)[0].followedThreads=[2];await assert.rejects(repository.importLegacy(boardTenant('bad-follow'),badFollow),/Invalid followed board thread/);
 await repository.importLegacy(boardTenant('restore'),state);assert.deepEqual(await repository.exportLegacy(boardTenant('restore')),state);
});

test('the handled cursor is independent of stdout, stable under concurrency, and bound to its session and workspace',async t=>{
 const {api,board}=await fixture(t);
 const {messages:[root]}=await post(api,alice,'start','What have we learned?',{channel:'work'});
 await post(api,bob,'reply','Evidence',{replyTo:root.id});
 const notice=await api.inbox(alice,{...user(alice),noticeOnly:true});
 assert.deepEqual(notice,{ids:[2],more:false});
 const delivery=await board.participate(alice,'inbox',user(alice));
 await board.participate(alice,'ack',{...user(alice),receipt:delivery.batch.receipt});
 const [page,parallel]=await Promise.all([api.inbox(alice,user(alice)),api.inbox(alice,user(alice))]);
 assert.deepEqual(page,parallel);assert.deepEqual(page.messages.map(m=>m.id),[2]);
 await post(api,bob,'mention','@codex:alice further evidence',{channel:'other'});
 await api.sync(alice,{...user(alice),after:0});
 await api.follow(alice,{...user(alice),threadId:root.id,following:false});
 const replay=await api.inbox(alice,user(alice));assert.equal(replay.cursor,page.cursor);assert.deepEqual(replay.messages,page.messages);
 for(const principal of [other,bob])await assert.rejects(api.inbox(principal,{...user(principal),acknowledge:page.cursor}),{status:409});
 await assert.rejects(api.inbox(alice,{...user(alice),noticeOnly:true,acknowledge:page.cursor}),{status:400});
 const next=await api.inbox(alice,{...user(alice),acknowledge:page.cursor});
 assert.deepEqual(next.messages.map(m=>m.id),[3]);assert.notEqual(next.cursor,page.cursor);
 assert.deepEqual(await api.inbox(alice,{...user(alice),acknowledge:page.cursor}),next);
 assert.deepEqual(await api.inbox(alice,{...user(alice),acknowledge:next.cursor}),{messages:[],cursor:null,more:false});
});

test('online peers exchange compact introductions without touching captured prompts',async t=>{
 const f=await boardStateFixture(t);let clock=10_000_000,fetches=0;
 const board=f.make({now:()=>clock,recentSessions:{async fetch(){fetches++;throw Error('Unexpected capture read');}}});
 const api=board.agent,dormant={...alice,userId:'dormant'},late={...alice,userId:'late'};
 const join=(principal,options={})=>api.presence(principal,{currentSession:{harness:'codex',sessionId:principal.userId},
   name:'codex:'+principal.userId,task:'A short task',...options});
 await join(dormant,{channels:['presence']});clock+=16*60_000;await join(bob);await join(other);
 const joined=await join(alice,{installationId:'machine'});
 assert.deepEqual(joined.peers,[{name:'codex:bob',task:'A short task'}]);
 assert.equal((await join(alice,{announce:true})).peers,undefined);
 await join(late,{announce:false});assert.deepEqual((await api.inbox(bob,{...user(bob),noticeOnly:true})).ids,[1]);
 const first=await api.inbox(bob,user(bob));
 assert.equal(first.messages.length,1);assert.match(first.messages[0].text,/codex:alice is online.*A short task/);
 assert.equal('firstUserPrompt' in first.messages[0],false);
 assert.deepEqual(await api.inbox(bob,user(bob)),first);
 for(const peer of [dormant,late,other,alice])assert.deepEqual((await api.inbox(peer,user(peer))).messages,[]);
 await api.presence(alice,{...user(alice),leave:true});await board.participate(alice,'bootstrap',{session:'alice',harness:'codex'});
 await join(alice,{announce:true});assert.deepEqual((await api.inbox(bob,{...user(bob),acknowledge:first.cursor})).messages.map(m=>m.id),[2]);
 assert.equal(fetches,0);
});

test('muting even a subscribed channel thread preserves explicit and inline mentions',async t=>{
 const {api,board}=await fixture(t);
 await api.presence(alice,{...user(alice),announce:false,channels:['work']});
 await post(api,bob,'thread','Thread',{channel:'work'});
 await post(api,alice,'answer','Answer',{replyTo:1});
 await api.follow(alice,{...user(alice),threadId:2,following:false});
 await post(api,bob,'muted','Routine update',{replyTo:2});
 await post(api,bob,'direct','Need your input',{replyTo:3,mentions:['codex:alice']});
 await post(api,bob,'inline','@codex:alice there is new evidence',{replyTo:1});
 await post(api,bob,'new','A separate thread',{channel:'work'});
 const hint='opencrawl board unfollow 1';
 for(const rows of [(await api.sync(alice,{...user(alice),after:0})).messages,(await api.inbox(alice,user(alice))).messages,
   (await board.participate(alice,'inbox',user(alice))).batch.messages]){
   assert.deepEqual(rows.map(m=>[m.id,m.unfollow]),[[1,undefined],[4,hint],[5,hint],[6,undefined]]);
 }
});

test('fifty metadata rows fit in one page regardless of stored message size',async t=>{
 const {api}=await fixture(t);
 for(let i=0;i<51;i++)await post(api,alice,'large-'+i,'evidence '.repeat(1200),{channel:'work'});
 const args={channels:['work'],select:['id','from'],order:'oldest',limit:50};
 const page=await api.list(bob,args);
 assert.deepEqual(page.messages,Array.from({length:50},(_,i)=>({id:i+1,from:'codex:alice'})));
 assert.deepEqual((await api.list(bob,{...args,cursor:page.next})).messages,[{id:51,from:'codex:alice'}]);
 const summary=(await api.search(bob,{query:'evidence',select:['metadata'],limit:50})).messages;
 assert.equal(summary.length,50);assert.equal('text' in summary[0],false);
 assert.deepEqual(Object.keys(summary[0]).sort(),['channel','from','id','mentions','replyTo','thread','time']);
});
