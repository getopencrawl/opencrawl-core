import {test} from 'node:test';
import assert from 'node:assert/strict';
import {boardStateFixture,boardTenant} from './fixtures/board-state.mjs';
import {createBoardSearch} from '../dist/src/board/search.mjs';
import {createPostgresBoardState,validateLegacyBoard} from '../dist/src/state/board.mjs';
const principal={tenantId:'team-a',userId:'alice'};
const messages=Array.from({length:8},(_,i)=>({id:i+1,timestamp:1700000000000+i,topic:i<6?'auth':'other',agent:'agent-a',author:'alice',name:'codex',text:'Refresh '+i,requestId:String(i)}));
const legacy=messages=>({schema:1,messages,agents:{},usage:{calls:4,inputBytes:200,outputBytes:500}});
async function fixture(t,rows=messages){const f=await boardStateFixture(t);await f.repository.importLegacy(boardTenant(principal.tenantId),legacy(rows));let time=1;return {...f,search:createBoardSearch({state:f.state,now:()=>time}),advance:()=>{time+=300001;}};}

test('PostgreSQL ranks complete messages with exact facets and durable query-bound keyset pages',async t=>{
  const f=await fixture(t),args={query:'refresh',limit:2},first=await f.search.search(principal,args);
  assert.equal(first.total,8);assert.equal(first.through,8);assert.deepEqual(first.messages.map(m=>m.id),[8,7]);
  assert.deepEqual(first.facets.channel.values,[{value:'auth',count:6},{value:'other',count:2}]);assert.equal(first.facets.agent.values[0].name,'codex');assert.ok(!('requestId'in first.messages[0]));
  await f.make().sync(principal,{agent:'codex',posts:[{id:'growth',topic:'auth',text:'refresh refresh refresh'}]});
  const restarted=createBoardSearch({state:{...f.state,board:createPostgresBoardState(f.database)},now:()=>1});
  let cursor=first.next,all=first.messages.map(m=>m.id);while(cursor){const page=await restarted.search(principal,{...args,cursor});all.push(...page.messages.map(m=>m.id));assert.equal(page.total,8);assert.equal(page.facets,undefined);cursor=page.next;}
  assert.deepEqual(all,[8,7,6,5,4,3,2,1]);
  const replay=await restarted.search(principal,{...args,cursor:first.next});assert.deepEqual(replay.messages.map(m=>m.id),[6,5]);
  for(const [who,query]of [[{...principal,userId:'bob'},args],[{...principal,tenantId:'other'},args],[principal,{...args,query:'changed'}]])await assert.rejects(restarted.search(who,{...query,cursor:first.next}),{status:409});
  f.advance();await assert.rejects(f.search.search(principal,{...args,cursor:first.next}),{status:409});
});

test('scope, date filters and cursor validation fail before releasing data',async t=>{
  const f=await fixture(t);
  for(const who of [{},{userId:'alice'},{...principal,captureAccess:'read'}])await assert.rejects(f.search.search(who,{}),{status:403});
  await assert.rejects(f.search.search(principal,{workspace:'foreign'}),{status:403});
  await assert.rejects(f.search.search(principal,{since:'2024-01-01T00:00:00Z',until:'2023-01-01T00:00:00Z'}),{status:400});
  await assert.rejects(f.search.search(principal,{cursor:'garbage'}),{status:400});
  const args={query:'refresh',topics:['auth'],agents:['agent-a'],authors:['alice'],since:'2023-11-01T00:00:00Z',until:'2024-01-01T00:00:00Z',sort:'newest',limit:10};
  assert.deepEqual((await f.search.search(principal,args)).messages.map(m=>m.id),[6,5,4,3,2,1]);
  assert.equal((await f.search.search(principal,{...args,authors:['foreign']})).total,0);
});

test('long messages search across vector chunks and bounded pages preserve their complete bodies',async t=>{
  const rows=messages.map((m,i)=>({...m,text:'startmarker '+('filler detail '.repeat(6000))+' tailmarker '+i})),f=await fixture(t,rows);
  const first=await f.search.search(principal,{query:'startmarker tailmarker',limit:10});assert.equal(first.total,8);assert.equal(first.messages.length,1);assert.equal(first.messages[0].text,rows[7].text);
  const second=await f.search.search(principal,{query:'startmarker tailmarker',limit:10,cursor:first.next});assert.equal(second.messages[0].text,rows[6].text);assert.ok(second.next);
  const firstOmitted=await f.search.search(principal,{query:'tailmarker',limit:2});
  const explicit=await f.search.search(principal,{workspace:principal.tenantId,query:'tailmarker',limit:2,cursor:firstOmitted.next});assert.equal(explicit.messages[0].id,7);
});

test('legacy import preserves publication aliases, pending deliveries, usage and ordering exactly',async t=>{
  const f=await boardStateFixture(t),board=f.make();
  const owner=await board.participate(principal,'register',{session:'one',name:'codex:owner',task:'Migrate'});
  await board.participate(principal,'subscribe',{session:'one',topics:['auth']});
  await board.sync({...principal,userId:'bob'},{agent:'peer',posts:[{id:'legacy',topic:'auth',text:'@codex:owner complete this'}]});
  const delivery=await board.participate(principal,'inbox',{session:'one'});
  const source=await f.repository.exportLegacy(boardTenant(principal.tenantId));assert.equal(source.participants[owner.agent].pending.receipt,delivery.batch.receipt);
  source.participants[owner.agent].pending.messages[0].reasons.push('legacy-home'); // Retain older delivery explanation strings.
  const destination=await boardStateFixture(t);await destination.repository.importLegacy(boardTenant(principal.tenantId),source);
  assert.deepEqual(await destination.repository.exportLegacy(boardTenant(principal.tenantId)),source);
  await destination.repository.importLegacy(boardTenant(principal.tenantId),source);
  const expected=source.participants[owner.agent].pending;
  assert.deepEqual((await destination.make().participate(principal,'inbox',{session:'one'})).batch,{...expected,messages:expected.messages.map(m=>({...m,channel:m.topic,threadId:m.threadId??m.id}))});
  const conflict=structuredClone(source);conflict.messages[0].text='changed';
  await assert.rejects(destination.repository.importLegacy(boardTenant(principal.tenantId),conflict));
  assert.deepEqual(await destination.repository.exportLegacy(boardTenant(principal.tenantId)),source);
  assert.throws(()=>validateLegacyBoard({...source,unexpected:true}),/legacy/);
  const malformed=structuredClone(source);malformed.participants[owner.agent].pending.messages[0].text='forged';assert.throws(()=>validateLegacyBoard(malformed),/delivery/);
});

test('concurrent schema initialization and live writes do not conflict',async t=>{
  const f=await boardStateFixture(t),board=f.make();
  await Promise.all(Array.from({length:8},(_,i)=>Promise.all([
    createPostgresBoardState(f.database).ready(),
    board.sync(principal,{agent:'writer',posts:[{id:'schema-'+i,topic:'schema',text:'Concurrent startup evidence'}]})
  ])));
  assert.equal((await board.read(principal)).messages.length,8);
});
