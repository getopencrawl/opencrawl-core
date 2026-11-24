import {test} from 'node:test';
import assert from 'node:assert/strict';
import {boardStateFixture} from './fixtures/board-state.mjs';
import {fixture,owner,batch} from './session-deletion-fixture.mjs';
import {createSessionDeletionRequests} from '../dist/src/sessions/deletion-requests.mjs';
import {MockActivityEnvironment} from '@temporalio/testing';
import {sessionDeletionActivities} from '../dist/src/sessions/temporal/deletion.mjs';
import {createSessionLibrary} from '../dist/src/sessions/library.mjs';

test('incognito fences every publication path and erases only the authenticated capture',async t=>{
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

test('the deletion worker recovers a committed incognito request without the original client',async t=>{
  const storage=await boardStateFixture(t), f=fixture(), requests=createSessionDeletionRequests(f.options);
  const unavailable=async()=>{throw new Error('deletion store unavailable');};
  const board=storage.make({requestCaptureErasure:unavailable});
  const session={harness:'codex',sessionId:'native-session'};
  const peer={...owner,userId:'other-owner'}, foreign={...owner,tenantId:'another-organization'};
  const intents=[[owner,session],[owner,{...session,harness:'claude-code'}],[peer,session],[foreign,session]];
  for(const [principal,currentSession] of intents)
    await assert.rejects(board.participate(principal,'incognito',{currentSession}),/deletion store unavailable/);
  await assert.rejects(board.participate(owner,'incognito',{currentSession:session}),/deletion store unavailable/);
  assert.equal((await requests.list()).keys.length,0);

  // The same transaction protects publication while delivery to the erasure worker is outstanding.
  await assert.rejects(board.participate(owner,'bootstrap',{session:session.sessionId,harness:session.harness}),{status:403});
  const scope={tenantId:owner.tenantId,userId:owner.userId};
  const binding={...f.options,...scope,recoverIncognitoErasures:storage.repository.recoverErasures};
  const activities=sessionDeletionActivities(async()=>binding);
  const env=new MockActivityEnvironment();
  const recover=()=>env.run(activities.recoverIncognitoErasures,{sourceId:'local'});
  await recover();await recover();
  assert.equal((await requests.list()).keys.length,2);
  for(const [principal,currentSession] of intents){
    const request=await requests.readFor(principal,currentSession);
    if(principal===owner)assert.equal(request.harness,currentSession.harness);
    else assert.equal(request,null);
  }
  const remaining=[];
  await storage.repository.recoverErasures(async intent=>{remaining.push(intent);});
  assert.deepEqual(remaining.map(i=>[i.tenantId,i.userId]).sort(),[[peer.tenantId,peer.userId],[foreign.tenantId,foreign.userId]].sort());
});

test('an unavailable page of incognito requests cannot strand another tenant behind it',async t=>{
  const {make,repository,database}=await boardStateFixture(t);
  const unavailable=async()=>{throw Error('storage temporarily unavailable');};
  const board=make({requestCaptureErasure:unavailable});
  for(let i=0;i<50;i++){
    await assert.rejects(board.participate(owner,'incognito',{currentSession:{harness:'codex',sessionId:'queued-'+i}}),/storage temporarily unavailable/);
  }
  const other={...owner,tenantId:'org_other'};
  await assert.rejects(board.participate(other,'incognito',{currentSession:{harness:'codex',sessionId:'new'}}),/storage temporarily unavailable/);
  let failed=0;
  await assert.rejects(repository.recoverErasures(async intent=>{assert.equal(intent.tenantId,owner.tenantId);failed++;await unavailable();}),/storage temporarily unavailable/);
  assert.equal(failed,50);
  const delivered=[];
  await repository.recoverErasures(async intent=>{delivered.push(intent);});
  assert.deepEqual(delivered,[{...other,harness:'codex',sessionId:'new'}]);
  // Make the deferred batch due again without waiting for the wall clock.
  await database.pool.query('UPDATE opencrawl_board_erasure_outbox SET next_attempt_at=now() WHERE namespace=$1',[database.namespace]);
  await repository.recoverErasures(async intent=>{delivered.push(intent);});
  assert.equal(new Set(delivered.map(intent=>intent.sessionId)).size,51);
});
