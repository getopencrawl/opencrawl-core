import {test} from 'node:test';
import assert from 'node:assert/strict';
import {boardStateFixture} from './fixtures/board-state.mjs';
import {liveSessionBoard} from '../dist/src/board/live-sessions.mjs';

test('workspace-bound pair delivery rechecks recipients and privacy and delivers one mention to each inbox',async t=>{
  const f=await boardStateFixture(t),api=f.make().agent;
  const owner={tenantId:'alpha',userId:'owner'},other={...owner,tenantId:'beta'};
  for(const p of [owner,other])for(const name of ['reader','writer','third'])
    await api.presence(p,{currentSession:{harness:'codex',sessionId:name},name,announce:false});
  let visibility='team';
  const reads=[];
  const live=liveSessionBoard(owner.tenantId,f.repository,{async read(p,{id,field}){
    assert.equal(field,'context');assert.notEqual(p.userId,owner.userId);assert.equal(p.tenantId,owner.tenantId);
    const [,userId,harness,,sessionId]=JSON.parse(Buffer.from(id.slice(8),'base64url'));
    reads.push(sessionId);
    return [{userId,harness,sessionId,firstUserMessage:{text:'initial '+sessionId},lastUserMessage:{text:'latest'},latestAssistantMessage:{text:'editing'}}];
  }},{async read(){return {visibility};}});
  const roster=await live.list();assert.equal(roster.length,3);
  const pair=await Promise.all(['reader','writer'].map(name=>live.context(roster.find(r=>r.name===name))));
  assert.deepEqual(reads,['reader','writer']);assert.equal(pair[0].firstUserPrompt,'initial reader');
  assert.equal(pair[0].latestUserPrompt,'latest');assert.equal(pair[1].latestAssistantMessage,'editing');
  assert.equal(await live.current(pair),true);
  const body='@reader @writer Please check the overlap.';
  const id=await live.notify(pair,'test',body,'deconfliction');
  assert.equal(await live.notify(pair,'test',body,'deconfliction'),id);
  for(const name of ['reader','writer']){
    const inbox=await api.inbox(owner,{session:name});
    assert.deepEqual(inbox.messages.map(m=>m.id),[id]);
    assert.deepEqual(inbox.messages[0].mentions,['reader','writer']);
    assert.deepEqual((await api.inbox(other,{session:name})).messages,[]);
  }
  assert.deepEqual((await api.inbox(owner,{session:'third'})).messages,[]);
  visibility='private';assert.equal(await live.notify(pair,'private',body,'deconfliction'),null);
  visibility='team';await api.presence(owner,{session:'writer',leave:true});
  assert.equal(await live.current(pair),false);
  assert.equal(await live.notify(pair,'late',body,'deconfliction'),null);
});
