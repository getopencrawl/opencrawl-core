import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
export {delay,randomUUID};
export async function setup(client, onBootstrap) {
 const core=process.env.PROBE_CORE, plugin=process.env.TEST_PLUGIN, raw=JSON.parse(readFileSync(join(plugin,'.opencrawl-binding.json')));
 const api=raw.api,owner=raw.owner,token='disposable-board-test-token', tmp=mkdtempSync(join(tmpdir(),'board-native-'));
 const {createBoard}=await import(join(core,'dist/src/board/board.mjs'));
 const {createApplicationDatabase}=await import(join(core,'dist/src/state/postgres.mjs'));
 const {createPostgresBoardState}=await import(join(core,'dist/src/state/board.mjs'));
 const dbURL=new URL(process.env.OPENCRAWL_TEST_POSTGRES_URL);
 assert.equal(dbURL.hostname,'127.0.0.1');
 const database=createApplicationDatabase({namespace:'priority-test-'+randomUUID(), connectionString:dbURL.href});
 const repository=createPostgresBoardState(database);await database.ready();await repository.ready();
 const {createBoardHandler}=await import(join(core,'dist/src/board/http.mjs'));
 const {createOpenCrawlMcp}=await import(join(core,'dist/src/mcp/server.mjs'));
 const board=createBoard({state:{namespace:database.namespace,board:repository}}),events=[];
 const origSync=board.agent.sync;
 board.agent.sync=async(p,args)=>{const start=Date.now();const result=await origSync(p,args);
   events.push({op:'sync',start,at:Date.now(),lane:args.delivery,wait:args.waitMs,ids:result.messages.map(m=>m.id)});return result;};
 const realInbox=board.agent.inbox;
 board.agent.inbox=async (p,args)=>{
   const page=await realInbox.call(board.agent,p,args);
   events.push({at:Date.now(),op:args.acknowledge?'ack':'poll',lane:args.delivery,ids:page.messages?.map(m=>m.id)??page.ids,cursor:args.acknowledge||page.cursor,session:args.currentSession?.sessionId??args.session});return page;
 };
 const participate=board.participate;
 board.participate=async (principal,operation,input)=>{
   if(operation==='bootstrap')await onBootstrap?.(input.session);
   return participate.call(board,principal,operation,input);
 };
 const authenticate=async req=>req.headers.authorization==='Bearer '+token?owner:null;
 const mcp=createOpenCrawlMcp({origin:api,board,authenticate}),handler=createBoardHandler({board,authenticate});
 const server=createServer(async(req,res)=>{
  if(req.url==='/api/sessions/identity'){res.writeHead((await authenticate(req))?200:401,{'content-type':'application/json'});res.end(JSON.stringify({data:{principal:owner}}));}
  else if(req.url.startsWith('/api/board/')){res.on('finish',()=>events.push({op:req.url,status:res.statusCode}));await handler(req,res);}
  else if(req.url.startsWith('/mcp'))await mcp(req,res);else{res.writeHead(404);res.end();}
 });
 await new Promise((resolve,reject)=>server.once('error',reject).listen(Number(new URL(api).port),'127.0.0.1',resolve));
 const save=(file,obj)=>{mkdirSync(dirname(file),{recursive:true,mode:0o700});writeFileSync(file,JSON.stringify(obj),{mode:0o600});};
 const profile=join(raw.configHome,'opencrawl');
 save(join(profile,'capture','config.json'),{schemaVersion:1,api,installationId:raw.installationId,owner,disabled:true,roots:{},harnesses:[]});
 save(join(profile,createHash('sha256').update(api).digest('hex')+'.json'),{accessToken:token,expiresAt:Date.now()+3600000});
 await board.agent.presence(owner,{session:'sender',name:'fixture-sender',task:'Send synthetic test mail',announce:false});
 async function bind(sessionId){await board.agent.presence(owner,{currentSession:{harness:client,sessionId},name:'fixture-receiver',task:'Receive synthetic test mail',announce:false});}
 async function send(label){
  const r=await board.agent.post(owner,{session:'sender',posts:[{id:label,channel:'validation',text:'Synthetic mail '+label,mentions:['fixture-receiver'],follow:false}]});
  assert(!r.unresolvedMentions?.length);events.push({op:'sent',at:Date.now(),id:r.messages[0].id});
 }
 const config={url:api+'/mcp',headers:{Authorization:'Bearer '+token},type:'http'};
 return {api,plugin,token,config,tmp,events,bind,send,board,owner,close:async()=>{await mcp.close();server.closeAllConnections();await new Promise(r=>server.close(r));await database.close();}};
}
export async function until(pred,ms=45000){const end=Date.now()+ms;while(!pred()){if(Date.now()>end)throw Error('Timed out waiting for native receipt');await delay(80);}}
