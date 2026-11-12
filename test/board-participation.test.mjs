import {test} from 'node:test';
import {createHash} from 'node:crypto';
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
  return {make, get store() {return store;}, advance:(ms = 60_000) => {time += ms;}, restart:() => {store.close(); store = createLocalBoardStore(join(dir, 'board.sqlite')); return make();}};
}
const register = (board, principal, session='one', name='codex:one') => board.participate(principal, 'register', {session, name, task:'Test work', harness:'codex'});
const post = (board, id, text='Useful change', topic='build') => board.participate(bob, 'publish', {session:'two', id:String(id), text, topic});
const inbox = board => board.participate(alice, 'inbox', {session:'one'});
const ack = (board, receipt) => board.participate(alice, 'ack', {session:'one', receipt});

test('bootstrap is unnamed and idempotent, then profile preserves identity and delivery on resume', async t => {
  const f = await fixture(t); let board = f.make();
  const bootstrap = () => board.participate(alice, 'bootstrap', {session:'one', harness:'codex'});
  const [first, concurrent] = await Promise.all([bootstrap(), bootstrap()]);
  assert.equal(first.agent, concurrent.agent);
  assert.equal(first.name, null); assert.equal(first.task, null);
  assert.equal(first.home, undefined); assert.equal(first.agents, undefined);
  assert.deepEqual(first.subscriptions, {mentions:false, topics:[]});
  await assert.rejects(board.participate(alice,'publish',{session:'one',id:'unnamed',topic:'build',text:'No profile'}), {status:409});
  const profile = await board.participate(alice,'profile',{session:'one',name:'codex:chosen-by-agent',task:'Review build'});
  assert.equal(profile.agent, first.agent); assert.equal(profile.name, 'codex:chosen-by-agent');
  await board.participate(alice,'subscribe',{session:'one',topics:['build']});
  await register(board,bob,'two','claude:peer');
  await post(board,'pending','@codex:chosen-by-agent review this');
  const pending = (await inbox(board)).batch;
  await board.participate(alice,'leave',{session:'one'});
  board = f.restart(); f.advance();
  const resumed = await bootstrap();
  assert.equal(resumed.resumed,true); assert.equal(resumed.agent,first.agent);
  assert.equal(resumed.name,'codex:chosen-by-agent'); assert.equal(resumed.task,'Review build');
  assert.deepEqual(resumed.subscriptions,{mentions:true,topics:['build']});
  assert.deepEqual((await inbox(board)).batch,pending);
  await ack(board,pending.receipt); await bootstrap();
  assert.equal((await inbox(board)).batch,null);
  const fork = await board.participate(alice,'bootstrap',{session:'fork',harness:'codex'});
  assert.notEqual(fork.agent, first.agent); assert.equal(fork.name,null);
  assert.deepEqual(fork.subscriptions,{mentions:false,topics:[]});
  const publication={id:'same-retry',topic:'build',text:'Stable route'};
  const published=await board.participate(alice,'publish',{session:'one',...publication});
  assert.deepEqual((await board.sync(alice,{workspace:'a',agent:'codex:chosen-by-agent',posts:[publication]})).accepted,published.accepted);
});

test('bootstrap and profile scope colliding sessions to the authenticated user and tenant', async t => {
  const f=await fixture(t), board=f.make();
  const boot=(p,extra={})=>board.participate(p,'bootstrap',{session:'same',harness:'codex',...extra});
  const a=await boot(alice), b=await boot(bob), c=await boot(other);
  assert.notEqual(a.agent,b.agent);
  assert.equal(a.agent,c.agent); // Same opaque ID, separate tenant state.
  await board.participate(alice,'profile',{session:'same',name:'codex:my-choice',task:'Private work'});
  assert.equal((await boot(bob)).name,null); assert.equal((await boot(other)).name,null);
  await assert.rejects(boot(alice,{workspace:'b'}),{status:403});
  await assert.rejects(board.participate(bob,'profile',{session:'same',name:'codex:my-choice',task:'Steal'}),{status:409});
  await assert.rejects(board.participate(other,'profile',{session:'missing',name:'codex:other',task:'Missing'}),{status:404});
  await assert.rejects(board.participate(alice,'profile',{session:'same',name:'codex:renamed',task:'Change'}),{status:409});
  assert.equal((await board.participate(alice,'profile',{session:'same',name:'codex:my-choice',task:'Updated task'})).agent,a.agent);
});

test('MCP reuses the account-owned CLI identity, canonical name and retry IDs across restarts', async t => {
  const f=await fixture(t); let board=f.make();
  const registered=await register(board,alice);
  await board.participate(alice,'subscribe',{session:'one',topics:['build']});
  const post={id:'shared',topic:'build',text:'One logical publication'};
  const args={workspace:'a',agent:'CODEX:ONE',topics:['build'],posts:[post]};
  const synced=await board.sync(alice,args);
  assert.equal(synced.agent,registered.agent);
  assert.deepEqual(synced.accepted,[1]);
  assert.equal((await board.read(alice)).messages[0].name,'codex:one');
  assert.equal((await board.read(alice)).messages[0].agent,registered.agent);
  board=f.restart();
  assert.deepEqual((await board.participate(alice,'publish',{session:'one',...post})).accepted,[1]);
  const cliPost={...post,id:'from-cli',text:'CLI publication reused by MCP'};
  await board.participate(alice,'publish',{session:'one',...cliPost});
  assert.deepEqual((await board.sync(alice,{...args,posts:[cliPost]})).accepted,[2]);
  assert.deepEqual((await board.sync(alice,args)).accepted,[1]);
  await assert.rejects(board.sync(alice,{...args,posts:[{...post,text:'Different content'}]}),{status:409});
  await assert.rejects(board.participate(alice,'publish',{session:'one',...post,text:'Different content'}),{status:409});
  assert.deepEqual((await board.topics(alice)).topics[0].active.map(p=>p.id),[registered.agent]);
  assert.equal((await board.sync(alice,{workspace:'a',agent:'codex:one',leave:true})).agent,registered.agent);
  assert.deepEqual((await board.topics(alice)).topics[0].active,[]);
  const participant=(await board.participate(alice,'directory')).agents[0];
  assert.deepEqual(participant.topics,['build']);
  assert.equal(participant.left,false);
});

test('existing listeners establish ownership without guessing from names or changing receipts and history', async t => {
  const f=await fixture(t); let board=f.make();
  const registered=await register(board,alice);
  await register(board,bob,'two','claude:two');
  await post(board,'peer','@codex:one review this change');
  const pending=(await inbox(board)).batch;
  const key='test/tenants/'+createHash('sha256').update('a').digest('hex')+'.json';
  const before=await f.store.readVersion(key), state=JSON.parse(before.data);
  delete state.participants[registered.agent].userId; // Persisted pre-upgrade registration.
  assert.equal(await f.store.compareAndSet(key,before.version,Buffer.from(JSON.stringify(state))),true);
  const publication={id:'legacy',topic:'build',text:'Legacy publication remains immutable'};
  const args={workspace:'a',agent:'codex:one',topics:['build'],posts:[publication]};
  const legacy=await board.sync(alice,args);
  assert.notEqual(legacy.agent,registered.agent); // An unverified name cannot select a session.
  const historical=await board.fetch(alice,{workspace:'a',id:'message:2'});
  const foreign=await board.sync(bob,{...args,posts:[]});
  assert.notEqual(foreign.agent,registered.agent);
  assert.notEqual(foreign.agent,legacy.agent);
  // lastPoll is still fresh: owner backfill must commit even during an idle poll.
  assert.deepEqual((await inbox(board)).batch,pending);
  board=f.restart();
  const synced=await board.sync(alice,args);
  assert.equal(synced.agent,registered.agent);
  assert.deepEqual(synced.accepted,[2]);
  assert.deepEqual((await board.participate(alice,'publish',{session:'one',...publication})).accepted,[2]);
  assert.deepEqual(await board.fetch(alice,{workspace:'a',id:'message:2'}),historical);
  assert.deepEqual((await inbox(board)).batch,pending);
  const ids=(await board.topics(alice)).topics.find(p=>p.topic==='build').active.map(p=>p.id).sort();
  assert.deepEqual(ids,[registered.agent,foreign.agent].sort());
  await ack(board,pending.receipt);
  assert.equal((await inbox(board)).batch,null);
  const next=await board.sync(alice,{...args,posts:[{...publication,id:'new'}]});
  assert.deepEqual(next.accepted,[3]);
  assert.equal((await board.read(alice)).messages[0].agent,registered.agent);
  await assert.rejects(board.sync(alice,{...args,posts:[{...publication,text:'Changed'}]}),{status:409});
});

test('name resolution stays account- and tenant-scoped and cannot overwrite another registration', async t => {
  const f=await fixture(t), board=f.make();
  const owner=await register(board,alice), tenantOwner=await register(board,other,'different');
  const args={workspace:'a',agent:'codex:one',posts:[{id:'one',topic:'build',text:'Useful update'}]};
  const own=await board.sync(alice,args), foreign=await board.sync(bob,args);
  assert.equal(own.agent,owner.agent);
  assert.notEqual(foreign.agent,owner.agent);
  assert.equal((await board.sync(other,{...args,workspace:'b'})).agent,tenantOwner.agent);
  assert.deepEqual((await board.read(alice)).messages.map(m=>m.author),['bob','alice']);
  assert.equal((await board.read(other)).messages.length,1);
  assert.equal((await board.participate(alice,'directory')).agents[0].agent,owner.agent);
  await assert.rejects(board.sync(bob,{...args,workspace:'b'}),{status:403});
});

test('sync resolves a registration committed during its CAS retry', async t => {
  const f=await fixture(t); let first=true, registered;
  const board=createBoard({prefix:'test',store:{...f.store,compareAndSet:async(...args)=>{
    if(first) {first=false; registered=await register(f.make(),alice);}
    return f.store.compareAndSet(...args);
  }}});
  const synced=await board.sync(alice,{workspace:'a',agent:'codex:one',topics:['build'],posts:[{id:'race',topic:'build',text:'Concurrent update'}]});
  assert.equal(synced.agent,registered.agent);
  assert.deepEqual(synced.accepted,[1]);
  assert.equal((await board.read(alice)).messages[0].agent,registered.agent);
  assert.deepEqual((await board.topics(alice)).topics[0].active.map(p=>p.id),[registered.agent]);
});

test('MCP-only names retain their separate retry namespaces until registration', async t => {
  const board=(await fixture(t)).make();
  const args={workspace:'a',agent:'codex:one',posts:[{id:'same',topic:'build',text:'Lowercase session'}]};
  const lower=await board.sync(alice,args);
  const upper=await board.sync(alice,{...args,agent:'CODEX:ONE',posts:[{...args.posts[0],text:'Uppercase session'}]});
  assert.notEqual(lower.agent,upper.agent);
  assert.deepEqual(lower.accepted,[1]); assert.deepEqual(upper.accepted,[2]);
});

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

test('only mentions and subscribed topics are delivered, and delivery survives restart until acknowledgment', async t => {
  const f=await fixture(t); let board=f.make();
  const registration=await register(board,alice); await register(board,bob,'two','claude:two');
  assert.deepEqual(registration.subscriptions,{mentions:true,topics:[]});
  // An unrelated post never wakes this agent, including after the periodic pass.
  await post(board,1); assert.equal((await inbox(board)).batch,null);
  f.advance(); assert.equal((await inbox(board)).batch,null);
  await post(board,2,'@codex:one please check the dependency');
  const first=(await inbox(board)).batch;
  assert.deepEqual(first.messages.map(m=>m.id),[2]);
  assert.deepEqual(first.messages[0].reasons,['mention']);
  board=f.restart();
  assert.deepEqual((await inbox(board)).batch,first);
  assert.equal((await register(board,alice)).resumed,true);
  await assert.rejects(ack(board,'0'.repeat(64)),{status:409});
  await ack(board,first.receipt); await ack(board,first.receipt);
  assert.equal((await inbox(board)).batch,null);
  await post(board,3); f.advance(); assert.equal((await inbox(board)).batch,null);
  const stats=(await board.participate(alice,'directory')).agents.find(a=>a.agent===registration.agent);
  assert.equal(stats.acknowledgedBatches,1); assert.equal(stats.batches,1); assert.equal(stats.pending,null);
  assert.equal('homepage' in stats,false);
  assert.equal(stats.listening,true); f.advance(180_000);
  assert.equal((await board.participate(alice,'directory')).agents.find(a=>a.agent===registration.agent).listening,false);
});

test('all subscribed messages arrive in bounded batches without losing overlap or echoing own posts', async t => {
  const f=await fixture(t), board=f.make();
  await register(board,alice); await register(board,bob,'two','claude:two');
  // Older CLIs still send homepage:true; it is accepted and has no effect.
  await board.participate(alice,'subscribe',{session:'one',homepage:true,topics:['deploy']});
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
  await post(board,'back','Unrelated after unsubscribing','other'); f.advance();
  assert.equal((await inbox(board)).batch,null);
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
  await board.participate(alice,'subscribe',{session:'one',topics:['build']});
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

test('inline mentions accept sentence punctuation through CLI and MCP without crossing scope', async t => {
  const f=await fixture(t),board=f.make();
  const target=await register(board,alice); await register(board,bob,'two','claude:two');
  await register(board,other,'foreign','foreign:peer');
  const texts=['@codex:one: check this','@CODEX:ONE...: check this','@codex:one, check this','@codex:one; check this','@codex:one! check this'];
  for(const [i,text] of texts.entries()) {
    for(const transport of ['cli','mcp']) {
      const id=`${transport}-${i}`;
      const result=transport==='cli' ? await post(board,id,text) : await board.sync(bob,{workspace:'a',agent:'legacy',posts:[{id,topic:'build',text}]});
      assert.equal(result.warning,undefined);
      const batch=(await inbox(board)).batch;
      assert.equal(batch.messages.length,1);
      assert.deepEqual(batch.messages[0].mentions,[target.agent]);
      assert.deepEqual(batch.messages[0].reasons,['mention']);
      await ack(board,batch.receipt);
    }
  }
  const result=await post(board,'scope','@foreign:peer: @codex:one-other: please check');
  assert.deepEqual(result.mentions,[]);
  assert.equal(result.warning,'Tags not notified (unregistered): @foreign:peer, @codex:one-other.');
  assert.equal((await inbox(board)).batch,null);
  await assert.rejects(board.participate(bob,'publish',{session:'two',id:'explicit',topic:'build',text:'Explicit names stay exact',mentions:['codex:one:']}),{status:404});
});

test('punctuated registered names take precedence and publication retries keep their original recipients', async t => {
  const f=await fixture(t);let board=f.make();
  const plain=await register(board,alice); await register(board,bob,'two','claude:two');
  const first=await post(board,'retry','@codex:one: dependency');
  assert.deepEqual(first.mentions,[plain.agent]);
  const colon=await register(board,alice,'colon','codex:one:');
  const dot=await register(board,alice,'dot','codex:one.');
  board=f.restart();
  assert.deepEqual(await post(board,'retry','@codex:one: dependency'),first);
  assert.deepEqual((await post(board,'exact','@codex:one: @codex:one. dependency')).mentions,[colon.agent,dot.agent]);
  assert.deepEqual((await post(board,'mixed','@codex:one:. dependency')).mentions,[colon.agent]);
  const mcp=await board.sync(bob,{workspace:'a',agent:'legacy',posts:[{id:'exact',topic:'build',text:'@codex:one: dependency'}]});
  assert.equal(mcp.warning,undefined);
  const batch=(await board.participate(alice,'inbox',{session:'colon'})).batch;
  assert.deepEqual(batch.messages.map(m=>m.id),[2,3,4]);
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
