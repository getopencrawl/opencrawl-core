import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {boardStateFixture,boardTenant} from './fixtures/board-state.mjs';
import {createBoardAnnouncementWriter} from '../dist/src/board/announcements.mjs';
import {createBoardHandler} from '../dist/src/board/http.mjs';
import {createOpenCrawlMcp} from '../dist/src/mcp/server.mjs';
import {authorizedBoard} from '../dist/src/application/board.mjs';

const alice={tenantId:'team-a',userId:'alice'},bob={...alice,userId:'bob'},outsider={tenantId:'team-b',userId:'alice'};
async function fixture(t){
 const f=await boardStateFixture(t),board=f.make();
 const writer=createBoardAnnouncementWriter({state:f.state,tenantId:alice.tenantId});
 return {...f,board,writer,announce:(id,text='System announcement')=>writer.publish({id,text})};
}
const register=(board,p=alice,session='s',name='codex:client')=>board.participate(p,'register',{session,name,task:'Testing threads',harness:'codex'});

test('empty channels expose reserved identity; only the internal scoped application writer can announce',async t=>{
 const f=await fixture(t),{board,writer}=f;
 const channels=await board.channels(alice,{});
 assert.deepEqual(channels.channels.map(c=>c.channel),['opencrawl']);assert.equal(channels.channels[0].readOnly,true);assert.equal(channels.channels[0].repliesAllowed,true);
 assert.equal(channels.channels[0].system.agent,'system:opencrawl');
 for(const name of ['opencrawl','OpenCrawl','system','root','SYSTEM:OPENCRAWL']){
  await assert.rejects(register(board,alice,name,name),{status:403});
  await assert.rejects(board.sync(alice,{agent:name}),{status:403});
 }
 await register(board);
 for(const channel of ['opencrawl','OpenCrawl',' OPENCRAWL ']){
  await assert.rejects(board.post({...alice,role:'admin'},{agent:'codex:client',posts:[{id:'forged',channel,text:'Fake'}]}),{status:403});
  await assert.rejects(board.participate(alice,'publish',{session:'s',id:'forged',topic:channel,text:'Fake'}),{status:403});
 }
 for(const forged of [{system:true},{author:'system:opencrawl'},{agent:'system:opencrawl'}])await assert.rejects(board.participate(alice,'publish',{session:'s',id:'x',channel:'opencrawl',text:'Fake',...forged}));
 assert.throws(()=>createBoardAnnouncementWriter({state:f.state,tenantId:''}),{status:503});
 assert.throws(()=>createBoardAnnouncementWriter({tenantId:alice.tenantId}),{status:503});
 for(const forged of [{tenantId:'team-b'},{author:'client'},{system:false}])await assert.rejects(writer.publish({id:'one',text:'bad',...forged}));
 const root=await f.announce('one');assert.equal(root.system,true);assert.equal(root.author,'system:opencrawl');assert.equal(root.threadId,root.id);
 assert.deepEqual(await f.announce('one'),root);await assert.rejects(f.announce('one','Changed'),{status:409});
 assert.equal((await board.read(outsider)).messages.length,0);
 await assert.rejects(board.fetch(outsider,{id:'message:'+root.id}),{status:404});
 assert.equal((await f.repository.exportLegacy(boardTenant(alice.tenantId))).messages.length,1);
});

test('replies stay in a scoped root, preserve retry identity and survive export/import and restart',async t=>{
 const f=await fixture(t),{board}=f;await register(board);
 const root=await f.announce('root');
 const input={session:'s',id:'reply',channel:'opencrawl',threadId:root.id,text:'I can help.'};
 const reply=await board.participate(alice,'publish',input);assert.deepEqual(reply.accepted,[2]);
 assert.deepEqual((await board.post(alice,{agent:'codex:client',posts:[{id:'reply',channel:'opencrawl',threadId:1,text:'I can help.'}]})).accepted,[2]);
 await assert.rejects(board.participate(alice,'publish',{...input,threadId:2}),{status:400});
 await assert.rejects(board.participate(alice,'publish',{...input,channel:'engineering'}),{status:404});
 await assert.rejects(board.participate(alice,'publish',{...input,threadId:777}),{status:404});
 await assert.rejects(board.thread(outsider,{threadId:1}),{status:404});
 await assert.rejects(board.thread(alice,{workspace:'team-b',threadId:1}),{status:403});
 await assert.rejects(board.thread({...alice,captureAccess:'write'},{threadId:1}),{status:403});
 await assert.rejects(board.thread(alice,{threadId:2}),{status:404});
 const thread=await f.make().thread(alice,{threadId:1});assert.equal(thread.root.system,true);assert.deepEqual(thread.replies.map(m=>[m.id,m.threadId,m.channel,m.system]),[[2,1,'opencrawl',undefined]]);
 const stored=await f.repository.exportLegacy(boardTenant(alice.tenantId));await f.repository.importLegacy(boardTenant('restore'),stored);assert.deepEqual(await f.repository.exportLegacy(boardTenant('restore')),stored);
 await board.post(alice,{agent:'codex:client',posts:[{id:'normal',channel:'engineering',text:'Ordinary root'}]});
 await board.post(bob,{agent:'claude:peer',posts:[{id:'reply-normal',channel:'engineering',threadId:3,text:'Ordinary reply'}]});
 assert.deepEqual((await board.read(alice,{channel:'engineering',rootsOnly:true})).messages.map(m=>m.id),[3]);
 const page=await board.read(alice,{channel:'engineering',threadId:3});assert.equal(page.threadRoot.id,3);assert.deepEqual(page.messages.map(m=>m.id),[4]);
 await assert.rejects(board.post(alice,{agent:'codex:client',posts:[{id:'normal',channel:'engineering',threadId:3,text:'Ordinary root'}]}),{status:409});
});

test('system announcements reach unsubscribed native and MCP agents; replies do not broadcast',async t=>{
 const f=await fixture(t),{board}=f;await register(board);
 await register(board,bob,'b','claude:peer');await board.participate(alice,'subscribe',{session:'s',channels:[]});
 await f.announce('root');
 const inbox=await board.participate(alice,'inbox',{session:'s'});assert.equal(inbox.batch.messages[0].system,true);assert.deepEqual(inbox.batch.messages[0].reasons,['announcement']);
 assert.deepEqual((await f.make().participate(alice,'inbox',{session:'s'})).batch,inbox.batch);
 await board.participate(alice,'ack',{session:'s',receipt:inbox.batch.receipt});
 await board.participate(bob,'publish',{session:'b',id:'reply',channel:'opencrawl',threadId:1,text:'Reply'});
 assert.equal((await board.participate(alice,'inbox',{session:'s'})).batch,null);
 const sync=await board.sync(alice,{agent:'codex:client',channels:[],after:0});assert.deepEqual(sync.messages.map(m=>[m.id,m.threadId,m.system]),[[1,1,true]]);
 await board.participate(alice,'subscribe',{session:'s',channels:['opencrawl']});
 const replies=await board.participate(alice,'inbox',{session:'s'});assert.equal(replies.batch.messages[0].id,2);
});

test('thread pagination keeps roots explicit and replies complete across concurrent publication',async t=>{
 const f=await fixture(t),{board}=f;await f.announce('one');
 for(let i=0;i<25;i++)await board.post(bob,{agent:'writer',posts:[{id:String(i),channel:'opencrawl',threadId:1,text:'Reply '+i}]});
 const first=await board.thread(alice,{threadId:1});assert.equal(first.root.id,1);assert.equal(first.replies.length,20);assert.equal(first.next,7);
 await board.post(bob,{agent:'writer',posts:[{id:'new',channel:'opencrawl',threadId:1,text:'New reply'}]});
 const second=await board.thread(alice,{threadId:1,before:first.next});assert.deepEqual([...first.replies,...second.replies].map(m=>m.id),Array.from({length:25},(_,i)=>26-i));assert.equal(second.next,null);
 const search=await board.search(alice,{channels:['opencrawl'],query:'Reply 24'});assert.equal(search.messages[0].threadId,1);assert.equal(search.messages[0].channel,'opencrawl');
 await assert.rejects(board.sync(alice,{agent:'client',channels:['opencrawl'],topics:['engineering']}),{status:400});
});

test('single-tenant HTTP and MCP expose threads and channels but never the system writer',async t=>{
 const f=await fixture(t),{board}=f;const root=await f.announce('root');
 const httpHandler=createBoardHandler({board,authenticate:async()=>alice});
 let mcp;const server=createServer((req,res)=>req.url.startsWith('/api/board/')?httpHandler(req,res):mcp(req,res));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 mcp=createOpenCrawlMcp({origin,board,authenticate:async()=>alice});
 const client=new Client({name:'thread-test',version:'1'});t.after(async()=>{await client.close();await mcp.close();await new Promise(r=>server.close(r));});await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp')));
 const names=(await client.listTools()).tools.map(t=>t.name);assert.ok(names.includes('board_channels'));assert.ok(names.includes('board_thread'));assert.ok(!names.some(n=>/announce|system/.test(n)));
 const call=async(name,args)=>{const result=await client.callTool({name,arguments:args});return {...result,data:JSON.parse(result.content[0].text)};};
 const result=await call('board_post',{agent:'mcp:client',posts:[{id:'mcp-reply',channel:'opencrawl',threadId:root.id,text:'MCP reply'}]});assert.ok(!result.isError);
 assert.equal((await call('board_thread',{threadId:root.id})).data.replies[0].text,'MCP reply');
 const request=async(operation,input)=>fetch(origin+'/api/board/'+operation,{method:'POST',body:JSON.stringify(input)});
 assert.equal((await request('announce',{text:'forged'})).status,404);
 assert.equal((await request('channels',{})).status,200);assert.equal((await request('thread',{threadId:root.id})).status,200);
 await register(board);assert.equal((await request('publish',{session:'s',id:'forged',channel:'opencrawl',text:'forged'})).status,403);
 assert.equal((await request('publish',{session:'s',id:'http-reply',channel:'opencrawl',threadId:root.id,text:'HTTP reply'})).status,200);
});

test('thread and channel reads retain final revocation barriers',async t=>{
 const f=await fixture(t);await f.announce('root');let active=true;
 const board=authorizedBoard({state:f.state,admit:async p=>p,authorize:async p=>{if(!active)throw Object.assign(Error('revoked'),{status:403});return p;}});
 active=false;await assert.rejects(board.thread(alice,{threadId:1}),{status:403});await assert.rejects(board.channels(alice,{}),{status:403});
});
