import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {createBoard} from '../dist/src/board/board.mjs';
import {createLocalBoardStore} from '../dist/src/board/local-store.mjs';
import {standaloneMcp} from '../dist/src/mcp/standalone.mjs';

const alice = {tenantId:'a', userId:'alice'}, bob = {tenantId:'a', userId:'bob'}, other = {tenantId:'b', userId:'alice'};
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'board-participation-'));
  let store = createLocalBoardStore(join(dir, 'board.sqlite')), time = 1_000_000;
  t.after(async () => {store.close(); await rm(dir, {recursive:true, force:true});});
  const make = () => createBoard({store, prefix:'test', now:() => time});
  return {make, advance:(ms = 60_000) => {time += ms;}, restart:() => {store.close(); store = createLocalBoardStore(join(dir, 'board.sqlite')); return make();}};
}
const register = (board, principal, session='one', name='codex:one') => board.participate(principal, 'register', {session, name, task:'Test work', harness:'codex'});
const post = (board, id, text='Useful change', topic='build') => board.participate(bob, 'publish', {session:'two', id:String(id), text, topic});
const inbox = board => board.participate(alice, 'inbox', {session:'one'});
const ack = (board, receipt) => board.participate(alice, 'ack', {session:'one', receipt});

test('participation fails closed; same session IDs remain tenant- and user-scoped', async t => {
  const f=await fixture(t), board=f.make();
  for (const principal of [null, {}, {tenantId:'a'}, {...alice,captureAccess:'read'}]) {
    for (const operation of ['register','directory','inbox','publish','ack','subscribe','leave']) await assert.rejects(board.participate(principal,operation,{}), {status:403});
  }
  const a=await register(board,alice), b=await register(board,other);
  assert.equal(a.name,b.name);
  await assert.rejects(register(board,bob,'one'),{status:409});
  await assert.rejects(board.participate(bob,'inbox',{session:'one'}),{status:404});
  await assert.rejects(board.participate(alice,'directory',{tenantId:'b'}));
  await assert.rejects(board.participate(alice,'inbox',{session:'one',workspace:'b'}),{status:403});
  await assert.rejects(board.participate(alice,'register',{session:'one',name:'codex:changed',task:'x'}),{status:409});
  await register(board,bob,'two','claude:two');
  await post(board,1,'@codex:one useful cross-agent change');
  assert.equal((await inbox(board)).batch.messages[0].text,'@codex:one useful cross-agent change');
  f.advance();
  assert.equal((await board.participate(other,'inbox',{session:'one'})).batch,null);
  const agents=(await board.participate(alice,'directory')).agents;
  assert.equal(agents.length,2); assert.ok(agents.some(p=>p.agent===a.agent));
});

test('homepage is batched and quiet, mentions immediate, delivery survives restart until explicit acknowledgment', async t => {
  const f=await fixture(t); let board=f.make();
  const registration=await register(board,alice); await register(board,bob,'two','claude:two');
  assert.deepEqual(registration.subscriptions,{homepage:true,mentions:true,topics:[]});
  await post(board,1); assert.equal((await inbox(board)).batch,null);
  f.advance();
  const first=(await inbox(board)).batch;
  assert.deepEqual(first.messages.map(m=>m.id),[1]);
  assert.deepEqual(first.messages[0].reasons,['homepage']);
  board=f.restart();
  assert.deepEqual((await inbox(board)).batch,first);
  assert.equal((await register(board,alice)).resumed,true);
  await assert.rejects(ack(board,'0'.repeat(64)),{status:409});
  await ack(board,first.receipt); await ack(board,first.receipt);
  assert.equal((await inbox(board)).batch,null);
  await post(board,2,'@codex:one please check the dependency');
  const mention=(await inbox(board)).batch;
  assert.deepEqual(mention.messages.map(m=>m.id),[2]);
  assert.deepEqual(mention.messages[0].reasons,['mention','homepage']);
  await ack(board,mention.receipt);
  const stats=(await board.participate(alice,'directory')).agents.find(a=>a.agent===registration.agent);
  assert.equal(stats.acknowledgedBatches,2); assert.equal(stats.batches,2); assert.equal(stats.pending,null);
  assert.equal(stats.listening,true); f.advance(180_000);
  assert.equal((await board.participate(alice,'directory')).agents.find(a=>a.agent===registration.agent).listening,false);
});

test('all subscribed messages arrive in bounded batches without losing overlap or echoing own posts', async t => {
  const f=await fixture(t), board=f.make();
  await register(board,alice); await register(board,bob,'two','claude:two');
  await board.participate(alice,'subscribe',{session:'one',homepage:false,topics:['deploy']});
  await post(board,'skip','Unrelated','other');
  for(let i=1;i<=20;i++)await post(board,i,`@codex:one update ${i} ${'x'.repeat(350)}`,'deploy');
  const found=[];
  while(found.length<20) {
    const batch=(await inbox(board)).batch;
    assert.ok(batch.messages.length<=8); assert.ok(Buffer.byteLength(JSON.stringify(batch.messages))<8192);
    assert.ok(batch.messages.every(m=>m.reasons.join(',')==='mention,topic'));
    found.push(...batch.messages.map(m=>m.id)); await ack(board,batch.receipt);
  }
  assert.deepEqual(found,Array.from({length:20},(_,i)=>i+2));
  await board.participate(alice,'publish',{session:'one',id:'self',topic:'deploy',text:'@codex:one own post'});
  assert.equal((await inbox(board)).batch,null);
  await board.participate(alice,'subscribe',{session:'one',topics:[]});
  await post(board,'back','Homepage resumes','other'); f.advance();
  assert.equal((await inbox(board)).batch.messages[0].text,'Homepage resumes');
});

test('concurrent registration, publishing, polling and ack retries preserve identities and log', async t => {
  const f=await fixture(t), boards=[f.make(),f.make(),f.make()];
  const registered=await Promise.all(boards.map(board=>register(board,alice)));
  assert.equal(new Set(registered.map(r=>r.agent)).size,1);
  await register(boards[0],bob,'two','claude:two');
  const published=await Promise.all(boards.map(board=>post(board,'same','@codex:one dependency')));
  assert.deepEqual(published.map(r=>r.accepted),[[1],[1],[1]]);
  await assert.rejects(post(boards[0],'same','Changed'),{status:409});
  const batches=await Promise.all(boards.map(board=>inbox(board)));
  assert.equal(new Set(batches.map(b=>b.batch.receipt)).size,1);
  await Promise.all(boards.map(board=>ack(board,batches[0].batch.receipt)));
  assert.equal((await inbox(boards[0])).batch,null);
  await boards[0].participate(alice,'leave',{session:'one'});
  assert.equal((await inbox(boards[0])).left,true);
  await register(boards[0],alice); assert.equal((await inbox(boards[0])).batch,null);
});

test('legacy MCP posts resolve registered mentions without changing board_sync contract', async t => {
  const f=await fixture(t),board=f.make(); await register(board,alice);
  const result=await board.sync(bob,{workspace:'a',agent:'legacy',posts:[{id:'one',topic:'other',text:'@codex:one coordinate here'}]});
  assert.deepEqual(result.accepted,[1]); assert.deepEqual(result.recentSessions,[]);
  const batch=(await inbox(board)).batch; assert.equal(batch.messages[0].reasons[0],'mention');
  assert.equal(batch.messages[0].name,'legacy');
});

test('MCP and CLI suppress their own cross-transport posts without suppressing peers', async t => {
  const f=await fixture(t); let board=f.make();
  await register(board,alice); await register(board,alice,'another','codex:another');
  await board.participate(alice,'subscribe',{session:'one',homepage:false,topics:['build']});
  const sync=(principal,agent,posts=[])=>board.sync(principal,{workspace:'a',agent,topics:['build'],after:0,posts});
  const own=await sync(alice,'codex:one',[{id:'mcp',topic:'build',text:'Own MCP update'}]);
  assert.deepEqual(own.accepted,[1]); assert.deepEqual(own.messages,[]);
  f.advance(); assert.equal((await inbox(board)).batch,null);
  await board.participate(alice,'publish',{session:'one',id:'cli',topic:'build',text:'Own CLI update'});
  assert.deepEqual((await sync(alice,'CODEX:ONE')).messages,[]);
  // Display-name equality from another account is never ownership evidence.
  await sync(bob,'codex:one',[{id:'spoof',topic:'build',text:'Other account, same label'}]);
  await board.participate(alice,'publish',{session:'another',id:'peer',topic:'build',text:'Same account, other session'});
  board=f.restart();
  const batch=(await inbox(board)).batch;
  assert.deepEqual(batch.messages.map(m=>m.id),[3,4]);
  assert.ok(batch.messages.every(m=>!('publication' in m)));
  await ack(board,batch.receipt);
  assert.equal((await inbox(board)).batch,null);
  const bobsView=await sync(bob,'codex:one');
  assert.deepEqual(bobsView.messages.map(m=>m.id),[1,2,4]);
  assert.deepEqual((await sync(alice,'codex:one',[{id:'mcp',topic:'build',text:'Own MCP update'}])).accepted,[1]);
  assert.equal((await board.read(alice)).messages.length,4);
});

test('unknown inline tags warn once per response and retries retain original routing', async t => {
  const f=await fixture(t),board=f.make();
  await register(board,alice); await register(board,bob,'two','claude:two');
  const args={session:'one',id:'tag',topic:'build',text:'@missing @missing @claude:two coordinate'};
  const first=await board.participate(alice,'publish',args);
  assert.equal(first.warning,'Tags not notified (unregistered): @missing.');
  assert.equal(first.mentions.length,1);
  await register(board,bob,'later','missing');
  assert.deepEqual(await board.participate(alice,'publish',args),first);
  await assert.rejects(board.participate(alice,'publish',{...args,mentions:['missing']}),{status:409});
  const newTarget=await board.participate(bob,'inbox',{session:'later'});
  assert.equal(newTarget.batch,null); // No retroactive tag on the retry.
  await assert.rejects(board.participate(alice,'publish',{...args,id:'explicit',mentions:['unknown']}),{status:404});
  const mcpArgs={workspace:'a',agent:'legacy',posts:[{id:'tag',topic:'build',text:'@notjoined dependency'}]};
  const mcp=await board.sync(alice,mcpArgs);
  assert.equal(mcp.warning,'Tags not notified (unregistered): @notjoined.');
  await register(board,bob,'third','notjoined');
  const retry=await board.sync(alice,mcpArgs);
  assert.deepEqual(retry.accepted,mcp.accepted); assert.equal(retry.warning,mcp.warning);
  assert.ok((await board.read(alice)).messages.every(m=>!('publication' in m)));
});

test('single-tenant HTTP registration and inbox persist without hosted credentials', async t => {
  const dir=await mkdtemp(join(tmpdir(),'board-http-')); const token='local-test-only-token-'.repeat(3);
  let server;
  t.after(async()=>{if(server?.listening)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
  const start=async()=>{
    // Bind once to select a port, then use the same origin for strict Host validation.
    server=standaloneMcp({token,origin:'http://127.0.0.1:8093',boardPath:join(dir,'board.sqlite'),principal:alice});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
  };
  await start();
  const request=(op,input={},authorization=`Bearer ${token}`)=>new Promise((resolve,reject)=>{
    const req=httpRequest(`http://127.0.0.1:${server.address().port}/api/board/${op}`,{method:'POST',headers:{host:'127.0.0.1:8093',authorization,'content-type':'application/json'}},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,json:()=>JSON.parse(Buffer.concat(chunks).toString())}));
    });req.on('error',reject);req.end(JSON.stringify(input));
  });
  assert.equal((await request('directory',{},'')).status,401);
  const response=await request('register',{session:'one',name:'codex:one',task:'Self hosted proof'});
  assert.equal(response.status,200);const first=(await response.json()).data;
  await new Promise(r=>server.close(r)); await start();
  assert.equal((await (await request('directory')).json()).data.agents[0].agent,first.agent);
  assert.equal((await request('inbox',{session:'one',tenantId:'b'})).status,400);
  const published=await request('publish',{session:'one',id:'warn',topic:'test',text:'@unknown dependency'});
  assert.equal(published.status,200);
  assert.equal(published.json().data.warning,'Tags not notified (unregistered): @unknown.');
});
