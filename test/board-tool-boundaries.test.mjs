import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBoard, syncSchema, postSchema, presenceSchema} from '../dist/src/board/board.mjs';
import {authorizedBoard} from '../dist/src/application/board.mjs';
import {boardStateFixture,boardTenant} from './fixtures/board-state.mjs';

const principal={tenantId:'local',userId:'alice'};
test('sync rejects mutations and leaves even expired presence, usage and an empty tenant unchanged',async t=>{
 const f=await boardStateFixture(t),board=f.make({now:()=>1000});
 await board.presence(principal,{agent:'reader',channels:['work']});
 await board.post({...principal,userId:'bob'},{agent:'writer',posts:[{id:'one',channel:'work',text:'Read this'}]});
 const before=await f.repository.exportLegacy(boardTenant('local'));
 let writes=0;
 const reader=createBoard({state:{board:{...f.repository,transaction(){writes++;throw Error('Read tool attempted a write');}}},now:()=>1000+3600_000});
 for(const mutation of [{posts:[]},{posts:[{id:'bad',text:'Must not write'}]},{leave:true}])await assert.rejects(reader.sync(principal,{agent:'reader',...mutation}));
 const result=await reader.sync(principal,{agent:'reader',channels:['work'],after:0});
 assert.deepEqual(result.messages.map(m=>m.id),[1]);assert.equal('accepted' in result,false);
 assert.deepEqual(await f.repository.exportLegacy(boardTenant('local')),before);
 assert.equal(await f.repository.exportLegacy(boardTenant('fresh')),null);
 await reader.sync({...principal,tenantId:'fresh'},{agent:'reader'});
 assert.equal(await f.repository.exportLegacy(boardTenant('fresh')),null);assert.equal(writes,0);
 assert.equal('posts' in syncSchema.shape,false);assert.equal('leave' in syncSchema.shape,false);
 assert.equal('after' in postSchema.shape,false);assert.equal('posts' in presenceSchema.shape,false);
});

test('publication only returns receipts, never touches presence or session discovery, and remains atomic',async t=>{
 const f=await boardStateFixture(t),board=f.make({recentSessions:{list(){throw Error('Posting must not discover sessions');}}});
 const registration=await board.participate(principal,'register',{session:'native',name:'codex:writer',task:'Test split tools'});
 const before=await f.repository.exportLegacy(boardTenant('local'));
 const output=await board.post(principal,{agent:'CODEX:WRITER',posts:[{id:'one',channel:'work',text:'Publication'}]});
 assert.deepEqual(output,{agent:registration.agent,accepted:[1]});
 const after=await f.repository.exportLegacy(boardTenant('local'));
 assert.deepEqual(after.agents,before.agents);assert.deepEqual(after.participants,before.participants);assert.deepEqual(after.usage,before.usage);
 await assert.rejects(board.post(principal,{agent:'codex:writer',posts:[{id:'rollback',channel:'work',text:'Rolled back'},{id:'forbidden',channel:'opencrawl',text:'Forged announcement'}]}),{status:403});
 assert.deepEqual(await f.repository.exportLegacy(boardTenant('local')),after);
 await assert.rejects(board.post(principal,{agent:'codex:writer',posts:[]}));
});

test('post and presence retain admission and final revocation checks',async t=>{
 const f=await boardStateFixture(t);let active=true,writes=0;
 const board=authorizedBoard({state:{board:{...f.repository,async transaction(...args){writes++;const result=await f.repository.transaction(...args);active=false;return result;}}},
  admit:async p=>{if(!active)throw Object.assign(Error('Revoked'),{status:403});return p;},
  authorize:async p=>{if(!active)throw Object.assign(Error('Revoked'),{status:403});return p;}});
 for(const [operation,input]of [['post',{agent:'writer',posts:[{id:'one',channel:'work',text:'Write'}]}],['presence',{agent:'writer',channels:['work']}]]){
  active=true;await assert.rejects(board[operation](principal,input),{status:403});const count=writes;
  await assert.rejects(board[operation](principal,input),{status:403});assert.equal(writes,count);
 }
});

test('reply totals are scoped bulk reads and include replies outside the displayed page',async t=>{
 const f=await boardStateFixture(t),board=f.make();
 for(const tenantId of ['local','other']){
  const p={...principal,tenantId};await board.post(p,{agent:'writer',posts:[{id:'root',channel:'work',text:'Root'},{id:'empty',channel:'work',text:'No replies'}]});
  for(let i=0;i<(tenantId==='local'?25:3);i++)await board.post(p,{agent:'writer',posts:[{id:'reply'+i,channel:'work',threadId:1,text:'Reply'}]});
 }
 const queries=[],pool=f.database.pool,connect=pool.connect.bind(pool);
 pool.connect=async()=>{const client=await connect(),query=client.query;client.query=function(sql,...args){queries.push(sql);return query.call(this,sql,...args);};const release=client.release;client.release=function(...args){client.query=query;client.release=release;return release.apply(this,args);};return client;};
 try{
  const roots=await board.read(principal,{rootsOnly:true});assert.deepEqual(roots.messages.map(m=>[m.id,m.replyCount]),[[2,0],[1,25]]);
  assert.equal(queries.filter(sql=>typeof sql==='string'&&sql.includes('AS replies')).length,1);
  const thread=await board.read(principal,{threadId:1});assert.equal(thread.messages.length,20);assert.equal(thread.threadRoot.replyCount,25);
  assert.equal((await board.read({...principal,tenantId:'other'},{threadId:1})).threadRoot.replyCount,3);
 }finally{pool.connect=connect;}
});

test('console board search includes reply text and names, scoped to the authorized workspace',async t=>{
 const f=await boardStateFixture(t), board=f.make();
 await board.post(principal,{agent:'cedar',posts:[{id:'root',channel:'general',text:'Release planning'}]});
 await board.post(principal,{agent:'birch',posts:[{id:'reply',channel:'general',threadId:1,text:'Rollback ready'}]});
 await board.post({...principal,tenantId:'other'},{agent:'birch',posts:[{id:'elsewhere',channel:'general',text:'Rollback elsewhere'}]});
 for(const query of ['rollback','birch']){
   const page=await board.searchConsole(principal,{query});
   assert.deepEqual(page.messages.map(m=>[m.id,m.threadId]),[[2,1]]);
   assert.deepEqual(page.searchPage,{total:1,cursor:null});
 }
 assert.deepEqual((await board.read(principal,{rootsOnly:true})).messages[0].replyNames,['birch']);
});
