import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPostgresBoardState,inventoryBoardTargetsIn} from '../dist/src/state/board.mjs';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
import {createBoard} from '../dist/src/board/board.mjs';
import {boardTenant} from './fixtures/board-state.mjs';
import {createApplicationDatabase} from '../dist/src/state/postgres.mjs';

const tenant='a'.repeat(64);
function snapshot(count=500){
 return {schema:1,messages:Array.from({length:count},(_,i)=>({id:i+1,timestamp:i+1,agent:'agent',author:'user',name:'Agent',topic:'build',text:'Retained publication '+i,requestId:String(i)})),agents:{},usage:{calls:1,inputBytes:2,outputBytes:3},participants:{}};
}
async function fixture(t){
 const database=await applicationDatabaseFixture(t),repo=createPostgresBoardState(database);await repo.ready();
 const measure=async run=>{let calls=0,changed=0,maxParameters=0;await database.transaction(async client=>{
  const query=client.query.bind(client);
  client.query=async(sql,values)=>{calls++;maxParameters=Math.max(maxParameters,Buffer.byteLength(JSON.stringify(values??[])));const result=await query(sql,values);if(/^\s*(?:INSERT|UPDATE|DELETE)/i.test(sql))changed+=result.rowCount??0;return result;};
  try{await run(client);}finally{client.query=query;}
 });return {calls,changed,maxParameters};};
 return {database,repo,measure};
}
test('board import and heartbeat use bounded SQL batches instead of rewriting history',{skip:!postgresUrl},async t=>{
 const f=await fixture(t),state=snapshot();
 const initial=await f.measure(c=>f.repo.projectIn(c,tenant,state));
 const heartbeat=structuredClone(state);heartbeat.usage.calls++; 
 const update=await f.measure(c=>f.repo.projectIn(c,tenant,heartbeat));
 t.diagnostic(JSON.stringify({initial,update}));
 assert.deepEqual(await f.repo.exportLegacy(tenant),heartbeat);
 assert.ok(initial.calls<50,JSON.stringify(initial));
 assert.ok(update.calls<=22,JSON.stringify(update));
 assert.ok(update.changed<=2,JSON.stringify(update));
 assert.ok(initial.maxParameters<300000,JSON.stringify(initial));
});

test('incremental projection preserves deliveries, retry identity and isolation across connection restart',{skip:!postgresUrl},async t=>{
 const f=await fixture(t),source=await fixture(t),alice={tenantId:'org_board',userId:'alice'},bob={...alice,userId:'bob'},key=boardTenant(alice.tenantId);
 let time=1000;
 const legacy=createBoard({state:{board:source.repo},now:()=>time++});
 for(const [principal,session,name] of [[alice,'receiver','codex:receiver'],[bob,'sender','codex:sender']])await legacy.participate(principal,'register',{session,name,task:'Migration test',harness:'codex'});
 await legacy.participate(alice,'subscribe',{session:'receiver',topics:['build']});
 const publication={session:'sender',id:'retry',topic:'build',text:'@codex:receiver retained message'};
 const published=await legacy.participate(bob,'publish',publication);
 const pending=(await legacy.participate(alice,'inbox',{session:'receiver'})).batch;
 const initial=await source.repo.exportLegacy(key);
 await f.repo.importLegacy(key,initial);await f.repo.importLegacy(key,initial);
 const foreign=snapshot(2);await f.repo.importLegacy(tenant,foreign);
 await legacy.participate(bob,'publish',{...publication,id:'later',text:'Later publication'});
 await legacy.participate(alice,'profile',{session:'receiver',name:'codex:receiver',task:'Updated task'});
 const next=await source.repo.exportLegacy(key);
 const update=await f.measure(c=>f.repo.projectIn(c,key,next));assert.ok(update.changed<15,JSON.stringify(update));
 assert.deepEqual(await f.repo.exportLegacy(key),next);assert.deepEqual(await f.repo.exportLegacy(tenant),foreign);
 await assert.rejects(f.database.transaction(async c=>{await f.repo.projectIn(c,key,initial);throw Error('interrupted');}),/interrupted/);
 assert.deepEqual(await f.repo.exportLegacy(key),next);
 const restored=createApplicationDatabase({connectionString:postgresUrl,namespace:f.database.namespace});
 const repository=createPostgresBoardState(restored);await repository.ready();
 try{
  const target=createBoard({state:{board:repository},now:()=>time++});
  assert.deepEqual((await target.participate(alice,'inbox',{session:'receiver'})).batch,pending);
  assert.deepEqual(await target.participate(bob,'publish',publication),published);
  await assert.rejects(target.participate(bob,'publish',{...publication,text:'Changed retry'}),{status:409});
  await target.participate(alice,'ack',{session:'receiver',receipt:pending.receipt});
  const second=(await target.participate(alice,'inbox',{session:'receiver'})).batch;
  assert.deepEqual(second.messages.map(m=>m.id),[2]);
  await assert.rejects(target.read({...alice,tenantId:undefined}),{status:403});
  await assert.rejects(repository.importLegacy(key,initial),{status:409});
 }finally{await restored.close();}
});

test('replacement, deletion, empty participant presence and failed import remain exact and atomic',{skip:!postgresUrl},async t=>{
 const f=await fixture(t),state=snapshot(3);
 await f.repo.importLegacy(tenant,state);
 for(const next of [{...state,messages:state.messages.slice(0,2)},{...state,messages:state.messages.map(m=>({...m,text:'Changed '+m.id}))},null,{schema:1,messages:[],agents:{},usage:state.usage}]){
  await f.database.transaction(c=>f.repo.projectIn(c,tenant,next));assert.deepEqual(await f.repo.exportLegacy(tenant),next);
 }
 const before=await f.repo.exportLegacy(tenant),invalid={...state,unexpected:true};
 await assert.rejects(f.database.transaction(c=>f.repo.projectIn(c,tenant,invalid)),/unsupported/);
 assert.deepEqual(await f.repo.exportLegacy(tenant),before);
 // A failure inside a bulk insert must roll back all previously inserted rows.
 const broken=snapshot(300);broken.messages[299].text='Postgres rejects a null byte\u0000';
 await assert.rejects(f.database.transaction(c=>f.repo.projectIn(c,tenant,broken)));
 assert.deepEqual(await f.repo.exportLegacy(tenant),before);
});

test('large imports bound batch bytes while preserving Unicode and search chunks',{skip:!postgresUrl},async t=>{
 const f=await fixture(t),state=snapshot(140);
 for(const m of state.messages)m.text='migration migración 東京 '.repeat(800);
 const result=await f.measure(c=>f.repo.projectIn(c,tenant,state));
 assert.ok(result.maxParameters<350000,JSON.stringify(result));
 assert.deepEqual(await f.repo.exportLegacy(tenant),state);
 const found=await f.repo.search(tenant,'user',{query:'migration',topics:[],agents:[],authors:[],sort:'newest',facets:[],facetSize:5,limit:1},Date.now());
 assert.equal(found.total,140);assert.equal(found.messages[0].id,140);
});

test('final board inventory verifies all search vectors with a bounded query budget',{skip:!postgresUrl},async t=>{
 const f=await fixture(t);await f.repo.importLegacy(tenant,snapshot());
 const result=await f.measure(async c=>{await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');let count=0;for await(const item of inventoryBoardTargetsIn(f.database,c)){assert.deepEqual(item.identity,[tenant]);count++;}assert.equal(count,1);});
 t.diagnostic(JSON.stringify({inventory:result}));assert.ok(result.calls<80,JSON.stringify(result));
});
