import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Run inside the dedicated test VM. The expected org is taken from the
// provider's organization settings and the session from its own chat URL.
const [core,org,session,privateDir]=process.argv.slice(2);
assert(/^org-[a-f0-9]{32}$/.test(org));
assert(/^devin-[a-zA-Z0-9_-]{1,194}$/.test(session));
const pg=new URL(process.env.OPENCRAWL_TEST_POSTGRES_URL);
assert.equal(pg.hostname,'127.0.0.1');
const host='127.0.0.1', port=19278, api='http://'+host+':'+port, tenantId='org_fixture';
const load=name=>import(pathToFileURL(join(resolve(core),'dist/src',name+'.mjs')));
const [{createDevinWorkloads},{createApplicationDatabase},{createPostgresBoardState},{createSetupState},
 {createBoard},{createBoardHandler},{createSetupStatus},{createSetupHandler},{createOpenCrawlMcp}]=await Promise.all([
 'identity/devin','state/postgres','state/board','state/setup','board/board','board/http','setup/status','setup/http','mcp/server',
].map(load));
const db=createApplicationDatabase({connectionString:pg.href,namespace:'priority-test-'+randomUUID()});
const store=createPostgresBoardState(db),statusStore=createSetupState(db);
await Promise.all([store.ready(),statusStore.ready()]);
const board=createBoard({state:{namespace:db.namespace,board:store}});
const identities=createDevinWorkloads({audience:api,resolveOrganization:async id=>id===org?tenantId:null,tenantId});
const authenticate=async req=>{
 const bearer=req.headers.authorization;
 if(!bearer?.startsWith('Bearer '))return null;
 const result=await identities.identify(bearer.slice(7));
 return result.status===200&&result.workload.sessionId===session?result.principal:null;
};
const status=createSetupStatus({state:{setup:statusStore},search:{async search(){throw Error('No search fixture')},async fetch(){throw Error('No search fixture')}}});
const setup=createSetupHandler({setup:status,authenticate}),routes=createBoardHandler({board,authenticate});
const mcp=createOpenCrawlMcp({origin:api,board,authenticate});
const sender={tenantId,userId:'fixture-sender'};
const currentSession={harness:'devin',sessionId:session};
const word='ELM'+randomBytes(8).toString('hex').toUpperCase();
const summary={session,wordSha256:createHash('sha256').update(word).digest('hex'),verifiedIdentity:false,offered:false,reads:0,modelAckCalls:0};
await mkdir(privateDir,{recursive:true,mode:0o700});
let writes=Promise.resolve();
function save(){
 const snapshot=JSON.stringify(summary,null,2)+'\n',file=join(privateDir,'board-result.json');
 writes=writes.then(async()=>{await writeFile(file+'.tmp',snapshot,{mode:0o600});await rename(file+'.tmp',file)});
 return writes;
}
await board.agent.presence(sender,{session:'fixture-sender',name:'fixture-sender',task:'Send a private synthetic receipt',announce:false});
const participate=board.participate;
let seeded;
board.participate=async(principal,operation,args)=>{
 const result=await participate(principal,operation,args);
 if(operation==='bootstrap'&&args.session===session){
  seeded??=(async()=>{
   await board.agent.presence(principal,{currentSession,name:'fixture-receiver',task:'Verify this one trial',announce:false});
   const sent=await board.agent.post(sender,{session:'fixture-sender',posts:[{id:'challenge',channel:'verification',mentions:['fixture-receiver'],text:'Return the exact test word '+word}]});
   assert.equal(sent.unresolvedMentions?.length??0,0);
  })();
  await seeded;
 }
 return result;
};
const sync=board.agent.sync,inbox=board.agent.inbox;
board.agent.sync=async(p,args)=>{const result=await sync(p,args);if(args.delivery==='direct'&&result.messages.length){summary.offered=true;await save()}return result};
board.agent.inbox=async(p,args)=>{
 const result=await inbox(p,args);
 if(args.acknowledge)summary.modelAckCalls++;
 if(!args.noticeOnly&&args.delivery==='direct'&&result.messages?.length)summary.reads++;
 if(args.noticeOnly&&result.served)summary.serverConfirmedRead=true;
 await save();return result;
};
const http=createServer(async(req,res)=>{
 try{
  if(req.url==='/api/sessions/identity'){
   const principal=await authenticate(req);
   res.writeHead(principal?200:401,{'content-type':'application/json'});
   if(principal){summary.verifiedIdentity=true;await save()}
   return res.end(JSON.stringify(principal?{data:{principal,capabilities:{harnesses:['devin']}}}:{error:{code:'AUTH_REQUIRED'}}));
  }
  if(req.url.startsWith('/api/board/'))return await routes(req,res);
  if(req.url.startsWith('/api/setup'))return await setup(req,res);
  if(req.url==='/mcp')return await mcp(req,res);
  res.writeHead(404);res.end();
 }catch{if(!res.headersSent)res.writeHead(500);res.end()}
});
await save();
await new Promise((ok,fail)=>http.once('error',fail).listen(port,host,ok));
console.log('Disposable Devin verification receiver is ready on VM loopback.');
let stop;const done=new Promise(r=>{stop=r});
process.once('SIGTERM',stop);process.once('SIGINT',stop);
const cap=setTimeout(stop,20*60000);
await done;clearTimeout(cap);
await mcp.close();http.closeAllConnections();await new Promise(r=>http.close(r));await db.close();
