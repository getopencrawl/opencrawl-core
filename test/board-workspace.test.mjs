import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createBoard} from '../dist/src/board/board.mjs';
import {authorizedBoard} from '../dist/src/application/board.mjs';
import {createOpenCrawlMcp} from '../dist/src/mcp/server.mjs';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';

const alice={tenantId:'team-a',userId:'alice'},bob={tenantId:'team-b',userId:'bob'};
const post=text=>({id:'same-retry-id',topic:'work',text});
function storeFixture(){
  const rows=new Map();let sequence=0,reads=0,writes=0;
  return {get reads(){return reads;},get writes(){return writes;},
    store:{
      async readVersion(key){reads++;return rows.get(key)??{data:null,version:null};},
      async compareAndSet(key,version,data){
        if((rows.get(key)?.version??null)!==version)return false;
        writes++;rows.set(key,{data:Buffer.from(data),version:String(++sequence)});return true;
      },
    }};
}
const scopedSearch={async search(_principal,messages){return {messages};}};

test('board operations derive scope from authentication and reject foreign or absent authority',async()=>{
  const f=storeFixture(),board=createBoard({store:f.store,prefix:'board',search:scopedSearch});
  for(const [principal,text]of [[alice,'Team A content'],[bob,'Team B content']]){
    await board.sync(principal,{agent:'same-agent',posts:[post(text)]});
    assert.equal((await board.fetch(principal,{id:'message:1'})).text,text);
    assert.equal((await board.search(principal,{query:'content'})).messages[0].text,text);
    assert.equal((await board.topics(principal,{})).workspace,principal.tenantId);
  }
  const before={reads:f.reads,writes:f.writes};
  for(const operation of ['sync','fetch','search','topics']){
    const input={sync:{agent:'same-agent',posts:[post('forged')]},fetch:{id:'message:1'},search:{},topics:{}}[operation];
    await assert.rejects(board[operation](alice,{...input,workspace:bob.tenantId}),{status:403});
    for(const principal of [null,{}, {userId:'alice'}, {...alice,captureAccess:'write'}]){
      await assert.rejects(board[operation](principal,input),{status:403});
    }
  }
  assert.deepEqual({reads:f.reads,writes:f.writes},before);
});

test('deployment-authorized workspace selection remains available alongside authenticated defaults',async()=>{
  const f=storeFixture(),memberships=new Set(['team-a','team-b']),finalScopes=[];
  const board=authorizedBoard({store:f.store,prefix:'board',search:scopedSearch,
    admit:async(principal,requested)=>{
      const tenantId=requested??principal.tenantId;
      if(principal.userId!=='alice'||!memberships.has(tenantId))throw Object.assign(Error('Membership required'),{status:403});
      return {...principal,tenantId};
    },
    authorize:async(principal,requested)=>{
      assert.equal(requested,principal.tenantId);
      if(!memberships.has(principal.tenantId))throw Object.assign(Error('Membership revoked'),{status:403});
      finalScopes.push(principal.tenantId);return principal;
    },
  });
  await board.sync(alice,{agent:'writer',posts:[post('Default workspace content')]});
  await board.sync(alice,{workspace:'team-b',agent:'writer',posts:[post('Selected workspace content')]});
  assert.equal((await board.fetch(alice,{id:'message:1'})).text,'Default workspace content');
  assert.equal((await board.fetch(alice,{workspace:'team-b',id:'message:1'})).text,'Selected workspace content');
  assert.equal((await board.search(alice,{workspace:'team-b'})).messages[0].text,'Selected workspace content');
  assert.equal((await board.topics(alice,{workspace:'team-b'})).workspace,'team-b');
  assert.deepEqual(finalScopes,['team-a','team-b','team-a','team-b','team-b','team-b']);
  const before={reads:f.reads,writes:f.writes};
  await assert.rejects(board.fetch(alice,{workspace:'foreign',id:'message:1'}),{status:403});
  memberships.delete('team-b');
  await assert.rejects(board.fetch(alice,{workspace:'team-b',id:'message:1'}),{status:403});
  assert.deepEqual({reads:f.reads,writes:f.writes},before);
});

test('omitting workspace still rechecks revocation after reading content',async()=>{
  const f=storeFixture();let active=true,revokeOnRead=false;
  const board=authorizedBoard({prefix:'board',store:{...f.store,async readVersion(key){const value=await f.store.readVersion(key);if(revokeOnRead)active=false;return value;}},
    admit:async principal=>principal,
    authorize:async principal=>{if(!active)throw Object.assign(Error('Membership revoked'),{status:403});return principal;},
  });
  await board.sync(alice,{agent:'author',posts:[post('Do not disclose after revocation')]});
  revokeOnRead=true;
  await assert.rejects(board.fetch(alice,{id:'message:1'}),{status:403});
});

test('real MCP tools omit workspace, isolate identical references and reject revoked tokens',async t=>{
  const f=storeFixture(),board=createBoard({store:f.store,prefix:'board',search:scopedSearch});
  let handler,revoked=false;
  const server=createServer((req,res)=>handler(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  handler=createOpenCrawlMcp({origin,board,authenticate:async req=>revoked?null:req.headers.authorization==='Bearer alice'?alice:bob});
  const clients=[];
  t.after(async()=>{await Promise.all(clients.map(client=>client.close()));await handler.close();await new Promise(resolve=>server.close(resolve));});
  for(const user of ['alice','bob']){
    const client=new Client({name:'workspace-omission',version:'1'});
    await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+user}}}));clients.push(client);
  }
  const call=async(client,name,input)=>{const result=await client.callTool({name,arguments:input});assert.ok(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text);};
  const tools=(await clients[0].listTools()).tools;
  for(const name of ['board_sync','board_fetch','board_search','board_topics'])assert.ok(!tools.find(tool=>tool.name===name).inputSchema.required?.includes('workspace'));
  for(const [index,client]of clients.entries()){
    const text=`Tenant ${index} evidence`;
    await call(client,'board_sync',{agent:'same-agent',posts:[post(text)]});
    assert.equal((await call(client,'board_fetch',{id:'message:1'})).text,text);
    assert.equal((await call(client,'board_search',{})).messages[0].text,text);
  }
  const mismatch=await clients[0].callTool({name:'board_fetch',arguments:{workspace:bob.tenantId,id:'message:1'}});
  assert.equal(mismatch.isError,true);assert.ok(!JSON.stringify(mismatch).includes('Tenant 1 evidence'));
  revoked=true;await assert.rejects(call(clients[0],'board_fetch',{id:'message:1'}));
});

