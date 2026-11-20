import {test} from 'node:test';
import assert from 'node:assert/strict';
import {boardStateFixture,boardTenant,postgresUrl} from './fixtures/board-state.mjs';
const live=(name,fn)=>test(name,{skip:!postgresUrl},fn);

const owner={tenantId:'repair-team',userId:'workspace-a'};
const peer={...owner,userId:'workspace-b'};

live('cursorless session sync reads from the inbox checkpoint and leaves pending delivery intact',async t=>{
  const {make}=await boardStateFixture(t),api=make().agent;
  await api.presence(owner,{session:'writer',name:'writer',announce:false});
  const post=(id,channel)=>api.post(owner,{session:'writer',posts:[{id,text:id,channel}]});
  await post('before-registration','work');
  const currentSession={sessionId:'reader',harness:'codex'};
  await api.presence(peer,{currentSession,name:'reader',channels:['work'],announce:false});
  await post('first-update','work');
  await post('unsubscribed','elsewhere');
  await post('second-update','work');

  const pending=await api.inbox(peer,{currentSession});
  assert.deepEqual(pending.messages.map(message=>message.id),[2,4]);
  const first=await api.sync(peer,{currentSession,limit:1,select:['id']});
  assert.deepEqual(first,{messages:[{id:2}],next:2,more:true});
  const second=await api.sync(peer,{agent:'reader',after:first.next,select:['id']});
  assert.deepEqual(second,{messages:[{id:4}],next:4,more:false});
  assert.deepEqual(await api.inbox(peer,{currentSession}),pending);
  await api.inbox(peer,{currentSession,acknowledge:pending.cursor});
  await post('third-update','work');
  assert.deepEqual((await api.sync(peer,{currentSession,select:['id']})).messages,[{id:5}]);
  assert.deepEqual((await api.sync(peer,{currentSession,after:0,select:['id']})).messages,
    [{id:1},{id:2},{id:4},{id:5}]);
  await api.presence(peer,{currentSession,leave:true});
  assert.deepEqual(await api.sync(peer,{currentSession}),{messages:[],next:5,more:false});
  await api.presence(peer,{currentSession,announce:false});
  assert.deepEqual((await api.sync(peer,{currentSession,select:['id']})).messages,[{id:5}]);
});

live('cursorless sync reconstructs the registration boundary for older participants',async t=>{
  const {make,database}=await boardStateFixture(t);
  let time=1000;
  const api=make({now:()=>time++}).agent;
  await api.presence(owner,{session:'writer',name:'writer',announce:false});
  const post=id=>api.post(owner,{session:'writer',posts:[{id,text:id,channel:'work'}]});
  await post('before-registration');
  await api.presence(peer,{session:'reader',name:'reader',channels:['work'],announce:false});
  await post('after-registration');
  await database.pool.query(`UPDATE opencrawl_board_participants SET record=record-'inboxAfter'
    WHERE namespace=$1 AND tenant_hash=$2 AND name=$3`,[database.namespace,boardTenant(peer.tenantId),'reader']);
  assert.deepEqual(await api.sync(peer,{session:'reader',select:['id']}),{messages:[{id:2}],next:2,more:false});
});

live('bootstrap, named presence and legacy presence admit new sessions above the former limits',async t=>{
  const {database,make}=await boardStateFixture(t),board=make(),scope=boardTenant(owner.tenantId);
  await board.participate(owner,'bootstrap',{session:'seed',harness:'codex'});
  await database.pool.query(`INSERT INTO opencrawl_board_participants(namespace,tenant_hash,agent,user_id,name,seen,record)
    SELECT p.namespace,p.tenant_hash,'seed-'||i,p.user_id,'seed-'||i,p.seen,p.record||jsonb_build_object('name','seed-'||i)
    FROM opencrawl_board_participants p CROSS JOIN generate_series(1,2048) i WHERE namespace=$1 AND tenant_hash=$2`,[database.namespace,scope]);
  const fresh=await board.participate(peer,'bootstrap',{session:'new',harness:'codex'});
  assert.equal(fresh.resumed,false);
  assert.equal((await board.participate(peer,'register',{session:'new',name:'codex:new',task:'test'})).resumed,true);
  await board.agent.presence(peer,{session:'second',name:'codex:second',announce:false});
  await assert.rejects(board.agent.presence(owner,{session:'third',name:'CODEX:SECOND'}),{status:409});
  await database.pool.query(`INSERT INTO opencrawl_board_agents(namespace,tenant_hash,agent,record,position)
    SELECT $1,$2,'legacy-'||i,jsonb_build_object('name','legacy-'||i,'topics','[]'::jsonb,'seen',$3::bigint),i
    FROM generate_series(1,128) i`,[database.namespace,scope,Date.now()]);
  assert.ok((await board.presence(peer,{agent:'legacy:new',channels:[]})).agent);
});

live('startup sync offers actual shared updates until a native session can receive personal delivery',async t=>{
  const {make,repository}=await boardStateFixture(t),board=make(),api=board.agent;
  const join=(p,session,name)=>api.presence(p,{session,name,task:'Regression test',announce:false});
  await join(owner,'a','alpha');await join(peer,'b','bravo');
  const post=(id,text,channel)=>api.post(owner,{session:'a',posts:[{id,text,channel}]});
  await post('handoff','Shared handoff','work');
  await api.presence(peer,{session:'b',task:'Online peer',announce:true});
  const expected={id:1,text:'Shared handoff'};
  for(const identity of [{},{session:'fresh'},{agent:'unregistered'},{agent:'bravo'}]){
    const result=await api.sync(owner,{...identity,after:0,select:['text']});
    assert.equal(result.scope,'workspace');assert.deepEqual(result.messages,[expected]);
    assert.deepEqual((await api.sync(owner,{...identity,after:result.next})).messages,[]);
  }
  assert.deepEqual((await api.sync(owner,{})).messages.map(m=>m.id),[1]);
  assert.deepEqual((await api.sync(owner,{channels:['elsewhere'],after:0})).messages,[]);
  assert.deepEqual((await api.sync({...owner,tenantId:'other-team'},{after:0})).messages,[]);
  await assert.rejects(api.sync(owner,{workspace:'other-team'}),{status:403});
  await assert.rejects(api.sync(owner,{session:'a',agent:'bravo'}),{status:409});
  await assert.rejects(api.post(owner,{agent:'bravo',posts:[{id:'invalid',text:'test',channel:'work'}]}),{status:409});
  assert.equal(Object.keys((await repository.exportLegacy(boardTenant(owner.tenantId))).participants).length,2);
  await board.participate(owner,'bootstrap',{session:'fresh',harness:'claude-code'});
  const unnamed=await api.sync(owner,{currentSession:{sessionId:'fresh',harness:'claude-code'},after:0,channels:['work'],select:['text']});
  assert.deepEqual(unnamed.messages,[expected]);assert.equal(unnamed.scope,undefined);
  assert.deepEqual((await api.sync(owner,{session:'a',after:0})).messages.map(m=>m.id),[2]);
});
