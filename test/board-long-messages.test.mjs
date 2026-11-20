import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createBoard} from '../dist/src/board/board.mjs';
import {createBoardHandler} from '../dist/src/board/http.mjs';
import {boardStateFixture,boardTenant,postgresUrl} from './fixtures/board-state.mjs';
import {createBoardSearch} from '../dist/src/board/search.mjs';
import {createOpenCrawlMcp} from '../dist/src/mcp/server.mjs';
const live=(name,fn)=>test(name,{skip:!postgresUrl},fn);

const reader = {tenantId:'local', userId:'reader'}, writer = {tenantId:'local', userId:'writer'};
const longText = '@codex:reader ' + '詳🧪\n"\\ detail '.repeat(1800) + 'terminalmarker';
async function fixture(t){const f=await boardStateFixture(t);let time=1700000000000;const make=()=>createBoard({state:f.state,now:()=>time++});return {...f,make,restart:make};}
const register = (board, principal, session) => board.participate(principal,'register',{session,name:'codex:'+session,task:'Long message regression'});

live('long publications survive retries and restart, then deliver intact without blocking the next post', async t => {
  const f=await fixture(t);let board=f.make();
  await register(board,reader,'reader');await register(board,writer,'writer');
  await board.participate(reader,'subscribe',{session:'reader',topics:['work']});
  const post={id:'long',topic:'work',text:longText};
  assert.ok(Buffer.byteLength(longText)>16384);
  await board.participate(writer,'publish',{session:'writer',id:'before',topic:'work',text:'Before marker'});
  assert.deepEqual((await board.post(writer,{workspace:'local',agent:'codex:writer',posts:[post]})).accepted,[2]);
  await board.participate(writer,'publish',{session:'writer',id:'next',topic:'work',text:'Next marker'});
  board=f.restart();
  assert.deepEqual((await board.participate(writer,'publish',{session:'writer',...post})).accepted,[2]);
  await assert.rejects(board.participate(writer,'publish',{session:'writer',...post,text:longText+'changed'}),{status:409});
  const before=(await board.participate(reader,'inbox',{session:'reader'})).batch;
  assert.deepEqual(before.messages.map(m=>m.id),[1]);assert.equal(before.messages[0].text,'Before marker');assert.equal(before.more,true);
  await board.participate(reader,'ack',{session:'reader',receipt:before.receipt});
  const first=(await board.participate(reader,'inbox',{session:'reader'})).batch;
  assert.deepEqual(first.messages.map(m=>m.id),[2]);assert.equal(first.messages[0].text,longText);assert.equal(first.more,true);
  board=f.restart();
  assert.deepEqual((await board.participate(reader,'inbox',{session:'reader'})).batch,first);
  const acknowledgment=await board.participate(reader,'ack',{session:'reader',receipt:first.receipt});
  const next=(await board.participate(reader,'inbox',{session:'reader'})).batch;
  assert.deepEqual(next.messages.map(m=>m.id),[3]);assert.equal(next.messages[0].text,'Next marker');
  // A lost ACK reply may be retried after the next batch has become pending.
  assert.deepEqual(await board.participate(reader,'ack',{session:'reader',receipt:first.receipt}),acknowledgment);
  assert.deepEqual((await board.participate(reader,'inbox',{session:'reader'})).batch,next);
  await board.participate(reader,'ack',{session:'reader',receipt:next.receipt});
  assert.equal((await board.participate(reader,'inbox',{session:'reader'})).batch,null);
  const readerStats=(await board.participate(reader,'directory')).agents.find(agent=>agent.name==='codex:reader');
  assert.equal(readerStats.acknowledgedBatches,3);assert.equal(readerStats.acknowledgedMessages,3);
  let text='',offset=0,version;
  do {
    const page=await board.fetch(reader,{workspace:'local',id:'message:2',offset,length:997,...(version?{version}:{})});
    text+=page.text;version=page.version;offset=page.nextOffset;
  } while(offset!==null);
  assert.equal(text,longText);
  assert.equal((await board.read(reader)).messages.find(m=>m.id===2).text,longText);
});

live('real PostgreSQL search returns complete oversized messages and advances stable pages', async t => {
  const board=(await fixture(t)).make();
  const bodies=['marker first',longText+' marker',longText+' marker last'];
  for(const [i,text] of bodies.entries())await board.post(writer,{workspace:'local',agent:'writer',posts:[{id:String(i),topic:'work',text}]});
  const args={workspace:'local',query:'marker',sort:'newest',limit:10};
  let page=await board.search(reader,args),first=page,seen=[];
  assert.equal(page.total,3);assert.deepEqual(page.messages.map(m=>m.id),[3]);assert.ok(page.next);
  // Appending after the first page must not change the frozen result set.
  await board.post(writer,{workspace:'local',agent:'writer',posts:[{id:'later',topic:'work',text:'marker concurrent'}]});
  for(;;){
    for(const message of page.messages){assert.equal(message.text,bodies[message.id-1]);seen.push(message.id);}
    if(!page.next)break;
    page=await board.search(reader,{...args,cursor:page.next});
  }
  assert.deepEqual(seen,[3,2,1]);
  assert.deepEqual((await board.search(reader,{...args,cursor:first.next})).messages.map(m=>m.id),[2]);
  assert.equal((await board.search(reader,{workspace:'local',query:'terminalmarker'})).total,2);
});

live('authenticated HTTP and MCP accept long posts while retaining the shared request envelope', async t => {
  const board=(await fixture(t)).make();let route;
  const server=createServer((req,res)=>route(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const authenticate=async req=>req.headers.authorization==='Bearer member'?writer:null;
  const mcp=createOpenCrawlMcp({origin,board,authenticate}),http=createBoardHandler({board,authenticate});
  route=(req,res)=>req.url.startsWith('/api/board/')?http(req,res):mcp(req,res);
  const client=new Client({name:'long-board-test',version:'1'});
  t.after(async()=>{await client.close();await mcp.close();await new Promise(resolve=>server.close(resolve));});
  const request=(operation,input,authorized=true)=>fetch(origin+'/api/board/'+operation,{method:'POST',headers:{'content-type':'application/json',...(authorized?{authorization:'Bearer member'}:{})},body:JSON.stringify(input)});
  assert.equal((await request('publish',{},false)).status,401);
  assert.equal((await request('register',{session:'writer',name:'codex:writer',task:'Long post'})).status,200);
  await register(board,reader,'reader');
  const post={id:'http',topic:'work',text:longText};
  const published=await request('publish',{session:'writer',...post});
  assert.equal(published.status,200,await published.text());
  await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{authorization:'Bearer member'}}}));
  const reply=await client.callTool({name:'board_post',arguments:{workspace:'local',agent:'codex:writer',posts:[{id:'mcp',channel:post.topic,text:post.text}]}});
  assert.ok(!reply.isError,JSON.stringify(reply));
  assert.deepEqual((await board.read(reader)).messages.map(m=>m.text),[longText,longText]);
  assert.equal((await request('publish',{session:'writer',...post,id:'oversized-envelope',text:'x'.repeat(65536)})).status,413);
  assert.equal((await board.read(reader)).messages.length,2);
});
