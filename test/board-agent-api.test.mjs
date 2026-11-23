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
 assert.deepEqual((await api.sync(alice,user(alice))).messages.map(message=>message.id),[2,3]);
 await api.follow(alice,{...user(alice),threadId:root.id,following:false});
 const replay=await api.inbox(alice,user(alice));assert.equal(replay.cursor,page.cursor);assert.deepEqual(replay.messages,page.messages);
 for(const principal of [other,bob])await assert.rejects(api.inbox(principal,{...user(principal),acknowledge:page.cursor}),{status:409});
 await assert.rejects(api.inbox(alice,{...user(alice),noticeOnly:true,acknowledge:page.cursor}),{status:400});
 const next=await api.inbox(alice,{...user(alice),acknowledge:page.cursor});
 assert.deepEqual(next.messages.map(m=>m.id),[3]);assert.notEqual(next.cursor,page.cursor);
 assert.deepEqual(await api.inbox(alice,{...user(alice),acknowledge:page.cursor}),next);
 assert.deepEqual(await api.inbox(alice,{...user(alice),acknowledge:next.cursor}),{messages:[],cursor:null,more:false});
});

test('online introductions show the visible opening prompt on the first delivery in both directions',async t=>{
 const f=await boardStateFixture(t);let clock=10_000_000,visible=true,reads=0;
 const recentSessions={async list(){return [];},async read(reader,{id,openingPrompt,field}){
   const [tenant,owner,harness,installation,session]=JSON.parse(Buffer.from(id.slice(8),'base64url'));
   assert.equal(reader.tenantId,tenant);assert.equal(owner,session);assert.equal(harness,'codex');
   assert.equal(installation,owner==='alice'?'machine':null);
   assert.equal(field,'firstUserMessage');assert.equal(openingPrompt,true);
   reads++;
   if(!visible)return [];
   return [{firstUserMessage:{text:'The first request for '+owner}}];
 }};
 const board=f.make({now:()=>clock,recentSessions});
 const api=board.agent,dormant={...alice,userId:'dormant'},late={...alice,userId:'late'};
 const join=(principal,options={})=>api.presence(principal,{currentSession:{harness:'codex',sessionId:principal.userId},
   name:'codex:'+principal.userId,task:'A short task',...options});
 await join(dormant,{channels:['presence']});clock+=16*60_000;
 await board.participate(bob,'bootstrap',{session:'bob',harness:'codex'});
 await board.participate(bob,'profile',{session:'bob',name:'codex:bob',task:'A short task',announce:true});
 await join(other);
 const joined=await join(alice,{installationId:'machine'});
 assert.deepEqual(joined.peers,[{name:'codex:bob',task:'A short task',firstUserPrompt:'The first request for bob'}]);
 assert.equal((await join(alice,{announce:true})).peers,undefined);
 await join(late,{announce:false});
 assert.deepEqual((await api.inbox(bob,{...user(bob),noticeOnly:true})).ids,[1]);
 const metadata=await api.sync(bob,{...user(bob),after:0,select:['metadata']});
 assert.equal(metadata.messages.length,1);assert.equal('text' in metadata.messages[0],false);
 assert.equal(reads,1);
 const first=await api.inbox(bob,user(bob)), native=await board.participate(bob,'inbox',user(bob));
 const text='codex:alice is online (codex). A short task\n\nOpening user prompt\nThe first request for alice';
 assert.equal(first.messages.length,1);assert.equal(first.messages[0].text,text);
 assert.equal(native.batch.messages[0].text,text);
 assert.equal((await api.sync(bob,{...user(bob),after:0})).messages[0].text,text);
 assert.equal((await board.sync(bob,{agent:'codex:bob',after:0})).messages[0].preview,text);
 assert.deepEqual(await api.inbox(bob,user(bob)),first);
 for(const peer of [dormant,late,other,alice])assert.deepEqual((await api.inbox(peer,user(peer))).messages,[]);
 assert.doesNotMatch(JSON.stringify(await f.repository.exportLegacy(boardTenant(alice.tenantId))),/The first request/);
 assert.doesNotMatch(JSON.stringify([joined,first,native]),/captureRef/);
 visible=false;
 const replay=await api.inbox(bob,user(bob)), nativeReplay=await board.participate(bob,'inbox',user(bob));
 assert.equal(replay.cursor,first.cursor);assert.equal(nativeReplay.batch.receipt,native.batch.receipt);
 assert.equal(replay.messages[0].text,'codex:alice is online (codex). A short task');assert.equal(nativeReplay.batch.messages[0].text,replay.messages[0].text);
 await api.presence(alice,{...user(alice),leave:true});const resumed=await board.participate(alice,'bootstrap',{session:'alice',harness:'codex'});
 assert.ok(resumed.peers.length>0 && resumed.peers.every(peer=>!peer.firstUserPrompt));
 assert.equal((await join(alice,{announce:true})).peers,undefined);
 assert.deepEqual((await api.inbox(bob,{...user(bob),acknowledge:first.cursor})).messages.map(m=>m.id),[2]);
});

test('incognito during an introduction suppresses the in-flight prompt and subsequent replay',async t=>{
 const f=await boardStateFixture(t),board=f.make({requestCaptureErasure:async()=>({deleted:true,pending:false})});
 await board.agent.presence(bob,{session:'bob',name:'codex:bob',task:'Read introductions',announce:false});
 await board.participate(alice,'bootstrap',{session:'alice',harness:'codex'});
 await board.participate(alice,'profile',{session:'alice',name:'codex:alice',task:'Declared task',announce:true});
 const fetchStarted=Promise.withResolvers(),release=Promise.withResolvers();
 const pendingBoard=f.make({recentSessions:{async read(){fetchStarted.resolve();await release.promise;return [{firstUserMessage:{text:'Hidden request'}}];}}});
 const pending=pendingBoard.agent.inbox(bob,user(bob));await fetchStarted.promise;
 await board.participate(alice,'incognito',{currentSession:{sessionId:'alice',harness:'codex'}});release.resolve();
 for(const delivery of [await pending,await pendingBoard.agent.inbox(bob,user(bob))]){
   assert.equal(delivery.messages[0].text,'codex:alice is online (codex). Declared task');
 }
});

test('a slow source leaves its task visible and other peers keep their ready prompts',async t=>{
 const f=await boardStateFixture(t),base=f.make({});
 const join=(api,principal,announce)=>api.presence(principal,{session:principal.userId,name:'codex:'+principal.userId,task:'Declared task',announce});
 await join(base.agent,alice,false);await join(base.agent,bob,false);
 const late=Promise.withResolvers();
 const board=f.make({sessionTimeoutMs:100,recentSessions:{async read(_,{id}){
   const [,owner]=JSON.parse(Buffer.from(id.slice(8),'base64url'));
   if(owner==='alice')await late.promise;
   return [{firstUserMessage:{text:'Opening request from '+owner}}];
 }}});
 const {peers}=await join(board.agent,{...alice,userId:'new'},true);
 late.resolve();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(peers.sort((a,b)=>a.name.localeCompare(b.name)),[
   {name:'codex:alice',task:'Declared task'},
   {name:'codex:bob',task:'Declared task',firstUserPrompt:'Opening request from bob'},
 ]);
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

test('channels, subscriptions and filters work beyond former count limits',async t=>{
 const {api,board}=await fixture(t);
 const channels=Array.from({length:129},(_,i)=>'project-'+i);
 // Exercise channel creation through both publication paths.
 for(let i=0;i<128;i+=20){
  await api.post(alice,{...user(alice),posts:channels.slice(i,Math.min(i+20,128)).map(channel=>({id:channel,channel,text:'Update',follow:false}))});
 }
 const channel=channels[128];
 const {accepted:[last]}=await board.post(alice,{agent:'codex:alice',posts:[{id:'last',channel,text:'Final update'}]});
 assert.equal((await api.list(bob,{channels,after:last-1})).messages[0].channel,channel);
 assert.equal((await api.search(bob,{channels,query:'Final update'})).messages[0].id,last);
 assert.equal((await board.search(bob,{topics:channels,query:'Final update'})).messages[0].id,last);

 const presence=await api.presence(bob,{...user(bob),channels,announce:false});
 assert.deepEqual(presence.channels,channels);
 const subscribed=await board.participate(bob,'subscribe',{...user(bob),topics:channels});
 assert.deepEqual(subscribed.channels,[...channels].sort());
 assert.deepEqual((await api.sync(bob,{...user(bob),after:last-1})).messages.map(m=>m.id),[last]);
 assert.deepEqual((await api.sync(bob,{...user(bob),after:last-1,channels})).messages.map(m=>m.id),[last]);
 assert.deepEqual((await board.sync(bob,{agent:'codex:bob',topics:channels,after:last-1})).messages.map(m=>m.id),[last]);
 assert.deepEqual((await api.list(other,{channels})).messages,[]);
 // Each batch fits the transport envelope. Their combined set exceeds it.
 const batch=start=>Array.from({length:500},(_,i)=>('subscription-'+(start+i)).padEnd(78,'x'));
 const left=batch(0),right=batch(500);
 assert.ok(Buffer.byteLength(JSON.stringify([...left,...right]))>65536);
 await Promise.all([
  api.presence(bob,{...user(bob),channelMode:'add',channels:left,announce:false}),
  board.participate(bob,'subscribe',{...user(bob),channelMode:'add',channels:right}),
 ]);
 const current=await api.presence(bob,{...user(bob),announce:false});
 assert.deepEqual(new Set(current.channels),new Set([...channels,...left,...right]));
 const removed=await api.presence(bob,{...user(bob),channelMode:'remove',channels:right,announce:false});
 assert.deepEqual(new Set(removed.channels),new Set([...channels,...left]));
});

test('direct sync bypasses a pending ordinary page and wakes on a committed mention or followed reply', {timeout:12000}, async t=>{
  const {api,make}=await fixture(t);
  const reader={...user(alice),delivery:'direct'};
  await api.presence(alice,{...user(alice),channels:['chatter'],announce:false});
  const routine=await post(api,bob,'routine','Background channel update',{channel:'chatter'});
  const pending=await api.inbox(alice,user(alice));
  assert.deepEqual(pending.messages.map(m=>m.id),[routine.messages[0].id]);
  const root=(await post(api,alice,'root','Follow this thread',{channel:'work'})).messages[0];
  const unrelated=(await post(api,bob,'other','Other thread',{channel:'chatter'})).messages[0];
  const idle=await api.sync(alice,reader);
  assert.deepEqual(idle.messages,[]);
  // Use another board instance for notifications to exercise PostgreSQL,
  // including the subscribe/recheck window across independent connections.
  const sender=make().agent;
  const live=api.sync(alice,{...reader,after:idle.next,waitMs:4500});
  await sender.post(bob,{...user(bob),posts:[{id:'unrelated',replyTo:unrelated.id,text:'Ordinary reply'}]});
  const urgent=(await post(sender,bob,'mention','Need attention',{channel:'work',mentions:['codex:alice']})).messages[0];
  const first=await live;
  assert.deepEqual(first.messages.map(m=>m.id),[urgent.id]);
  const next=api.sync(alice,{...reader,after:first.next,waitMs:4500});
  // Wait for a real LISTEN session to be established before posting.
  await new Promise(resolve=>setTimeout(resolve,150));
  const reply=(await post(sender,bob,'reply','Followed reply',{replyTo:root.id})).messages[0];
  assert.deepEqual((await next).messages.map(m=>m.id),[reply.id]);
  assert.deepEqual(await api.inbox(alice,user(alice)),{...pending,more:true});
  await api.follow(alice,{...user(alice),threadId:root.id,following:false});
  await post(sender,bob,'muted','Muted reply',{replyTo:root.id});
  const mentioned=(await post(sender,bob,'override','Explicit mention',{replyTo:root.id,mentions:['codex:alice']})).messages[0];
  assert.deepEqual((await api.sync(alice,{...reader,after:reply.id})).messages.map(m=>m.id),[mentioned.id]);
  assert.deepEqual((await api.sync(other,{...reader,after:0})).messages,[]);
  await assert.rejects(api.sync(alice,{session:'unregistered',delivery:'direct'}),{status:409});
  await assert.rejects(api.sync(alice,{...reader,workspace:'team-b'}),{status:403});
  await api.presence(alice,{...user(alice),leave:true});
  assert.deepEqual((await api.sync(alice,{...reader,after:0})).messages,[]);
});

test('routine notification batches exclude direct mail and the inbox can replay the exact bounded read',async t=>{
  const {api}=await fixture(t),target=user(alice);
  await api.presence(alice,{...target,channels:['digest'],announce:false});
  const postTo=async(id,extra={})=>(await post(api,bob,id,id,{channel:'digest',...extra})).messages[0].id;
  const first=await postTo('routine-a'), direct=await postTo('direct',{mentions:['codex:alice']}), last=await postTo('routine-b');
  const preview=await api.sync(alice,{...target,delivery:'routine',after:0,select:['id']});
  assert.deepEqual(preview.messages,[{id:first},{id:last}]);
  await postTo('later');
  const args={...target,delivery:'routine',after:0,through:last};
  const page=await api.inbox(alice,args);
  assert.deepEqual(page.messages.map(m=>m.id),[first,last]);
  assert.equal(page.notificationReceipt,preview.notificationReceipt);
  assert.deepEqual(await api.inbox(alice,args),page);
  const urgent=await api.inbox(alice,{...args,delivery:'direct'});
  assert.deepEqual(urgent.messages.map(m=>m.id),[direct]);
  assert.notEqual(urgent.notificationReceipt,page.notificationReceipt);
  await assert.rejects(api.inbox(alice,{...args,acknowledge:'f'.repeat(64)}),{status:400});
  await assert.rejects(api.sync(alice,{...target,delivery:'routine',waitMs:1}),{status:400});
});

test('an unavailable PostgreSQL listener leaves direct mail readable at the next check', async t => {
  const {api,repository}=await fixture(t);
  repository.watchDirect=async()=>{throw Error('Listener unavailable');};
  const args={...user(alice),delivery:'direct',waitMs:200};
  const empty=await api.sync(alice,args);
  const urgent=await post(api,bob,'direct-after-outage','Please review',{channel:'work',mentions:['codex:alice']});
  assert.deepEqual((await api.sync(alice,{...args,after:empty.next})).messages.map(m=>m.id),[urgent.messages[0].id]);
});

test('a tracked read confirms only the full records returned to that native session and lane',async t=>{
  const {api}=await fixture(t);
  const currentSession={harness:'antigravity',sessionId:'native-track'};
  await api.presence(alice,{currentSession,name:'tracked-agent',task:'Verify delivery',announce:false});
  const mention={channel:'work',mentions:['tracked-agent']};
  const first=(await post(api,bob,'tracked-1','x'.repeat(15500),mention)).messages[0].id;
  const last=(await post(api,bob,'tracked-2','y'.repeat(8000),mention)).messages[0].id;
  const args={currentSession,after:first-1,through:last,delivery:'direct',readId:'c4a16c5d-1c5d-42b7-962b-6e3c81e41a32'};
  const check=extra=>api.inbox(alice,{...args,noticeOnly:true,...extra});
  assert.deepEqual(await check({}),{served:null});
  const page=await api.inbox(alice,args);
  assert.deepEqual(page.messages.map(m=>m.id),[first]);
  assert.deepEqual((await check({})).served,{readId:args.readId,after:first-1,through:last,first,next:first,proof:page.notificationReceipt});
  for(const extra of [{through:first},{delivery:'routine'},{readId:'917bc879-5cc9-4a8b-9825-caa77c318810'}])assert.deepEqual(await check(extra),{served:null});
  await assert.rejects(check({workspace:other.tenantId}),{status:403});
  const next=await api.inbox(alice,{...args,after:first});
  assert.deepEqual(next.messages.map(m=>m.id),[last]);
  assert.deepEqual(await check({}),{served:null});
  await api.presence(alice,{currentSession,leave:true});
  assert.deepEqual(await check({after:first}),{served:null});
});

test('an urgent mention bypasses a pending ordinary page and 260 subscribed posts',async t=>{
  const {api}=await fixture(t),target=user(alice);
  await api.presence(alice,{...target,channels:['busy-board'],announce:false});
  for(let offset=0;offset<260;offset+=20){
    await api.post(bob,{...user(bob),posts:Array.from({length:20},(_,i)=>({
      id:'backlog-'+(offset+i),text:'Ordinary '+(offset+i),channel:'busy-board',follow:false
    }))});
  }
  const pending=await api.inbox(alice,target);
  const urgent=(await post(api,bob,'after-backlog','Urgent',{channel:'busy-board',mentions:['codex:alice']})).messages[0].id;
  const page=await api.sync(alice,{...target,delivery:'direct',select:['id']});
  assert.deepEqual(page.messages,[{id:urgent}]);
  assert.deepEqual((await api.inbox(alice,target)).cursor,pending.cursor);
});
