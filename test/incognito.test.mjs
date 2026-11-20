import {test} from 'node:test';
import assert from 'node:assert/strict';
import {boardStateFixture,postgresUrl} from './fixtures/board-state.mjs';
import {fixture,owner,batch} from './session-deletion-fixture.mjs';
import {createSessionLibrary} from '../dist/src/sessions/library.mjs';

test('incognito fences every publication path and erases only the authenticated capture',{skip:!postgresUrl},async t=>{
  const f=fixture(),storage=await boardStateFixture(t);
  const library=createSessionLibrary({...f.options,scheduleDeletion:async()=>{}});
  const board=storage.make({requestCaptureErasure:(p,s)=>library.requestDeletion(p,s,{beforeFirstCapture:true})});
  const currentSession={harness:'codex',sessionId:'native-session'},other={...owner,userId:'second-owner'};
  for(const p of [owner,other]){
    await board.participate(p,'register',{session:currentSession.sessionId,harness:'codex',name:'agent-'+p.userId,task:'test'});
    await f.upload(batch({owner:p}));
  }
  const foreign={...owner,tenantId:'other-tenant'};
  await f.upload(batch({owner:foreign}));
  const samePrefix=batch({sessionId:'native-session-next'});
  await f.upload(samePrefix);
  for(const input of [{currentSession,workspace:foreign.tenantId},{currentSession,userId:other.userId}]){
    await assert.rejects(board.participate(owner,'incognito',input));
  }
  await assert.rejects(board.participate({...owner,captureAccess:'write'},'incognito',{currentSession}),{status:403});
  const receipt=await board.participate(owner,'incognito',{currentSession});
  assert.equal(receipt.boardBlocked,true);assert.equal(receipt.pending,true);
  assert.equal((await f.ingest.putBatch(owner,batch())).discarded,'session_deleted');
  const post={channel:'work',id:'post',text:'private'};
  for(const send of [
    ()=>board.participate(owner,'bootstrap',{session:currentSession.sessionId,harness:'codex'}),
    ()=>board.agent.presence(owner,{currentSession,name:'agent-'+owner.userId}),
    ()=>board.presence(owner,{agent:'agent-'+owner.userId}),
    ()=>board.agent.post(owner,{currentSession,posts:[post]}),
    ()=>board.post(owner,{agent:'agent-'+owner.userId,posts:[post]}),
    ()=>board.participate(owner,'publish',{session:currentSession.sessionId,...post}),
  ])await assert.rejects(send,{status:403});
  assert.equal((await board.participate(owner,'inbox',{session:currentSession.sessionId})).left,true);
  await board.agent.post(other,{currentSession,posts:[post]});
  assert.equal((await library.delete(owner,currentSession)).deleted,true);
  assert.equal((await board.participate(owner,'incognito',{currentSession})).pending,false);
  assert.equal((await f.search.search(owner)).hits.some(hit=>hit.userId===owner.userId&&hit.sessionId===currentSession.sessionId),false);
  for(const [p,item] of [[other,batch({owner:other})],[foreign,batch({owner:foreign})],[owner,samePrefix]])
    assert.equal((await f.ingest.putBatch(p,item)).discarded,undefined);
});
test('a tombstone can precede the first capture and survives replay after erasure',async()=>{
  const f=fixture(),library=createSessionLibrary({...f.options,scheduleDeletion:async()=>{}});
  const key={harness:'codex',sessionId:'native-session'};
  await assert.rejects(library.requestDeletion(owner,key),{status:404});
  assert.equal((await library.requestDeletion(owner,key,{beforeFirstCapture:true})).pending,true);
  assert.equal((await library.delete(owner,key)).deleted,true);
  assert.equal((await f.ingest.putBatch(owner,batch())).discarded,'session_deleted');
  assert.equal((await f.ingest.putBatch(owner,batch({harness:'claude-code'}))).discarded,undefined);
});
