import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createBoard} from '../dist/src/board/board.mjs';
import {realmIndex} from '../dist/src/search/realm.mjs';
import {createBoardSearch} from '../dist/src/board/search.mjs';
import {createOpenCrawlMcp} from '../dist/src/mcp/server.mjs';

const endpoint = process.env.OPENCRAWL_TEST_OPENSEARCH_URL;
test('real OpenSearch and MCP: relevance, phrase boost, facets, scope, full text and stable pagination', {skip: !endpoint}, async t => {
  const environment='test-'+randomUUID().slice(0,8),index=realmIndex(environment,'team-a');
  for (let attempt = 0; ; attempt++) {
    try {const response = await fetch(endpoint + '/_cluster/health?wait_for_status=yellow&timeout=1s'); if (!response.ok || !['green','yellow'].includes((await response.json()).status)) throw new Error('not ready'); break;}
    catch(e) {if (attempt >= 60) throw e; await new Promise(r => setTimeout(r,1000));}
  }
  t.after(async () => {const response=await fetch(endpoint+'/'+index,{method:'DELETE'}); assert.ok(response.ok || response.status===404);});
  const objects = new Map();
  const store = {async readVersion(k) {return objects.get(k)||{version:null,data:null};}, async compareAndSet(k,v,data) {
    if ((objects.get(k)?.version??null)!==v) return false; objects.set(k,{version:(v||0)+1,data});return true;
  }};
  const search = createBoardSearch({endpoint,environment});
  let tick = Date.parse('2026-11-01T00:00:00Z');
  const board = createBoard({store,prefix:'pilot',search,now:()=>tick++});
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
  // Replaying a lost index repairs projection directly from the unchanged source.
  assert.equal((await fetch(endpoint+'/'+index,{method:'DELETE'})).ok,true);
  assert.equal((await call('board_search',{workspace:'team-a',query:'refresh'})).total,3);
});


test('more than 10000 messages remain searchable with exact facets and exhaustive stable pages', {skip:!endpoint}, async t => {
  const environment='test-'+randomUUID().slice(0,8),principal={tenantId:'large-board',userId:'author'},index=realmIndex(environment,principal.tenantId);
  t.after(async()=>{const r=await fetch(endpoint+'/'+index,{method:'DELETE'});assert.ok(r.ok||r.status===404);});
  const search=createBoardSearch({endpoint,environment});
  const messages=Array.from({length:10005},(_,i)=>({id:i+1,timestamp:1700000000000+i,topic:'work',agent:'writer',author:'author',name:'System test',text:i>=10000?'marker priority':'marker',requestId:String(i)}));
  const key='test/large-board.json',args={workspace:principal.tenantId,query:'marker',limit:10,facets:['topic']};
  let page=await search.search(principal,messages,key,args);
  assert.equal(page.total,10005);assert.deepEqual(page.facets.topic.values,[{value:'work',count:10005}]);
  const seen=new Set(),grown=[...messages,{...messages[0],id:10006,text:'marker concurrent'}];
  for(;;){
    assert.ok(Buffer.byteLength(JSON.stringify(page))<=8192);
    for(const m of page.messages){assert.ok(!seen.has(m.id));seen.add(m.id);assert.equal(m.text,messages[m.id-1].text);}
    if(!page.next)break;
    page=await search.search(principal,grown,key,{...args,cursor:page.next});assert.equal(page.total,10005);
  }
  assert.equal(seen.size,10005);assert.ok(seen.has(1)&&seen.has(10005));assert.ok(!seen.has(10006));
  const tail=await search.search(principal,messages,key,{...args,query:'priority'});
  assert.equal(tail.total,5);assert.deepEqual(tail.messages.map(m=>m.id),[10005,10004,10003,10002,10001]);
});
