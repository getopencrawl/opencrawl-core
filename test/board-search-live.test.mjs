import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createBoard} from '../dist/src/board/board.mjs';
import {boardStateFixture,boardTenant} from './fixtures/board-state.mjs';
import {createBoardSearch} from '../dist/src/board/search.mjs';
import {createOpenCrawlMcp} from '../dist/src/mcp/server.mjs';


test('real PostgreSQL and MCP: relevance, phrase boost, facets, scope, full text and stable pagination', async t => {
  const f=await boardStateFixture(t);
  let tick = Date.parse('2026-11-01T00:00:00Z');
  const board = createBoard({state:f.state,now:()=>tick++});
  let handler;
  const http=createServer((req,res)=>handler(req,res));
  await new Promise(r=>http.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+http.address().port;
  handler=createOpenCrawlMcp({origin,board,authenticate:async req=>({tenantId:req.headers.authorization==='Bearer outsider'?'team-b':'team-a',userId:req.headers.authorization==='Bearer outsider'?'mallory':'alice'})});
  t.after(async()=>{await handler.close();await new Promise(r=>http.close(r));});
  const client=new Client({name:'board-search-acceptance',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp')));
  t.after(()=>client.close());
  const call=async(name,args)=>{const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text);};
  assert.ok((await client.listTools()).tools.some(t=>t.name==='board_search'));
  const post=(id,topic,text)=>({id,topic,text});
  await call('board_sync',{workspace:'team-a',agent:'codex',topics:['auth'],posts:[
    post('1','auth','OAuth refresh token rotation fixed; tests pass. Evidence: https://example.test/pr/1'),
    post('2','auth','Investigating a refresh timeout while the cache token expires'),
    post('3','storage','Archive upload verified'),
  ]});
  await board.sync({tenantId:'team-b',userId:'mallory'},{workspace:'team-b',agent:'outsider',posts:[post('1','secret','refresh token confidential')]});
  const args={workspace:'team-a',query:'refresh token',limit:1,facets:['topic','agent','author','day']};
  const first=await call('board_search',args);
  assert.equal(first.total,2);assert.equal(first.messages[0].id,1); // Exact phrase beats the separated terms.
  assert.equal(first.messages[0].text,'OAuth refresh token rotation fixed; tests pass. Evidence: https://example.test/pr/1');
  assert.deepEqual(first.facets.topic.values,[{value:'auth',count:2}]);
  assert.deepEqual(first.facets.day.values,[{value:'2026-11-01',count:2}]);
  assert.equal(first.facets.agent.values[0].name,'codex');
  assert.ok(Buffer.byteLength(JSON.stringify(first))<=8192);
  await call('board_sync',{workspace:'team-a',agent:'claude',posts:[post('4','auth','refresh token refresh token refresh token')]});
  const next=await call('board_search',{...args,cursor:first.next});
  assert.equal(next.total,2);assert.equal(next.messages[0].id,2);assert.equal(next.next,null);
  const filtered=await call('board_search',{workspace:'team-a',query:'refresh',agents:[first.messages[0].agent],topics:['auth'],authors:['alice'],since:'2026-10-31T00:00:00Z',until:'2026-11-02T00:00:00Z',sort:'newest'});
  assert.equal(filtered.total,2);assert.deepEqual(filtered.messages.map(m=>m.id),[2,1]);
  assert.equal((await call('board_search',{workspace:'team-a',query:'refresh',topics:['secret']})).total,0);
  const browsed=await call('board_search',{workspace:'team-a',facetSize:1});
  assert.equal(browsed.total,4);assert.equal(browsed.facets.topic.other,1);
  const bad=await client.callTool({name:'board_search',arguments:{workspace:'team-b',query:'confidential'}});assert.equal(bad.isError,true);
  assert.equal((await call('board_search',{workspace:'team-a',query:'refresh'})).total,3);
});


test('more than 10000 messages remain searchable with exact facets and exhaustive stable pages', async t => {
  const f=await boardStateFixture(t),principal={tenantId:'large-board',userId:'author'},search=createBoardSearch({state:f.state});
  const messages=Array.from({length:10005},(_,i)=>({id:i+1,timestamp:1700000000000+i,topic:'work',agent:'writer',author:'author',name:'System test',text:i>=10000?'marker priority':'marker',requestId:String(i)}));
  await f.repository.importLegacy(boardTenant(principal.tenantId),{schema:1,messages,agents:{},usage:{calls:0,inputBytes:0,outputBytes:0}});
  const args={workspace:principal.tenantId,query:'marker',limit:10,facets:['topic']};
  let page=await search.search(principal,args);
  assert.equal(page.total,10005);assert.deepEqual(page.facets.topic.values,[{value:'work',count:10005}]);
  const seen=new Set();await f.make().sync(principal,{agent:'writer',posts:[{id:'concurrent',topic:'work',text:'marker concurrent'}]});
  for(;;){
    assert.ok(Buffer.byteLength(JSON.stringify(page))<=8192);
    for(const m of page.messages){assert.ok(!seen.has(m.id));seen.add(m.id);assert.equal(m.text,messages[m.id-1].text);}
    if(!page.next)break;
    page=await search.search(principal,{...args,cursor:page.next});assert.equal(page.total,10005);
  }
  assert.equal(seen.size,10005);assert.ok(seen.has(1)&&seen.has(10005));assert.ok(!seen.has(10006));
  const tail=await search.search(principal,{...args,query:'priority'});
  assert.equal(tail.total,5);assert.deepEqual(tail.messages.map(m=>m.id),[10005,10004,10003,10002,10001]);
});

test('real PostgreSQL searches long board posts through their tail and pages complete bodies', async t => {
  const f=await boardStateFixture(t),principal={tenantId:'long-board',userId:'author'};
  const bodies=['marker short',('詳🧪 detail '.repeat(1800))+' marker uniquetail',('more detail '.repeat(2000))+' marker uniquetail'];
  const messages=bodies.map((text,i)=>({id:i+1,timestamp:1700000000000+i,topic:'work',agent:'writer',author:'author',name:'Writer',text,requestId:String(i)}));
  await f.repository.importLegacy(boardTenant(principal.tenantId),{schema:1,messages,agents:{},usage:{calls:0,inputBytes:0,outputBytes:0}});
  const search=createBoardSearch({state:f.state}),args={query:'marker',sort:'newest',limit:10};
  const first=await search.search(principal,args);
  assert.equal(first.total,3);assert.deepEqual(first.messages.map(m=>m.id),[3]);assert.equal(first.messages[0].text,bodies[2]);
  const second=await search.search(principal,{...args,cursor:first.next});
  assert.deepEqual(second.messages.map(m=>m.id),[2]);assert.equal(second.messages[0].text,bodies[1]);
  const third=await search.search(principal,{...args,cursor:second.next});
  assert.deepEqual(third.messages.map(m=>m.id),[1]);assert.equal(third.next,null);
  assert.equal((await search.search(principal,{query:'uniquetail'})).total,2);
});
