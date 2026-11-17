import {test,expect} from 'bun:test';
import {Client,InMemoryTransport,StreamableHTTPClientTransport,type JSONRPCMessage} from '@modelcontextprotocol/client';
import {createServer,type Server} from 'node:http';
import {PassThrough} from 'node:stream';
import {StdioServerTransport} from '@modelcontextprotocol/server/stdio';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {join} from 'node:path';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createOpenCrawlMcp} from '../../dist/src/mcp/server.mjs';
import {authenticatedMcpFetch,bridgeMcp} from '../src/mcp.ts';
import {createWorkspaceTokenProvider} from '../src/workspace-identity.ts';
import {withEnvironmentTokenOrigin} from '../src/environment-token.ts';
import {createPostgresBoardState} from '../../dist/src/state/board.mjs';
import {createBoard} from '../../dist/src/board/board.mjs';
import {applicationDatabaseFixture,postgresUrl} from '../../test/fixtures/application-database.mjs';

async function listen(server:Server){await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return 'http://127.0.0.1:'+(server.address() as {port:number}).port;}
async function stop(server:Server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
const bounded=<T>(p:Promise<T>)=>Promise.race([p,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('Timed out')),3000);timer.unref();})]);

test('MCP rechecks plugin binding before credentials, after renewal and before releasing a response',async()=>{
 for(const changed of ['before','credential','response']){
  let valid=changed!=='before',mints=0,sent=0,cancelled=false;
  const request=authenticatedMcpFetch('https://mcp.example',{
   validateBinding:()=>{if(!valid)throw Error('binding changed');},
   credential:async()=>{mints++;if(changed==='credential')valid=false;return {token:'synthetic',refreshable:true};},
   fetcher:(async()=>{sent++;valid=false;return new Response(new ReadableStream({cancel(){cancelled=true;}}));}) as unknown as typeof fetch,
  });
  await expect(request('https://mcp.example/mcp')).rejects.toThrow('binding changed');
  expect(mints).toBe(changed==='before'?0:1);expect(sent).toBe(changed==='response'?1:0);expect(cancelled).toBe(changed==='response');
 }
});

test('MCP credentials renew once per rejected exchange, keep static tokens static and never follow redirects',async()=>{
 const api='https://mcp.example',seen:string[]=[],minted:(string|undefined)[]=[];
 const request=authenticatedMcpFetch(api,{credential:async rejected=>{minted.push(rejected);return {token:rejected?'new':'old',refreshable:true};},fetcher:(async(url,init)=>{
  expect(String(url)).toBe(api+'/mcp');expect(init?.redirect).toBe('error');seen.push(new Headers(init?.headers).get('authorization')!);
  return new Response('',{status:seen.length===1?401:200});
 }) as typeof fetch});
 expect((await request(api+'/mcp',{method:'POST',body:'{}'})).status).toBe(200);
 expect(minted).toEqual([undefined,'old']);expect(seen).toEqual(['Bearer old','Bearer new']);
 await expect(request('https://elsewhere.example/mcp')).rejects.toMatchObject({code:'TOKEN_DESTINATION_MISMATCH'});expect(seen.length).toBe(2);
 let calls=0;
 for(const refreshable of [false,true]){
  calls=0;
  const denied=authenticatedMcpFetch(api,{credential:async()=>({token:'secret',refreshable}),fetcher:(async()=>{calls++;return new Response('',{status:401});}) as unknown as typeof fetch});
  expect((await denied(api+'/mcp')).status).toBe(401);expect(calls).toBe(refreshable?2:1);
 }
 const redirect=authenticatedMcpFetch(api,{credential:async()=>({token:'secret',refreshable:true}),fetcher:(async()=>new Response('',{status:307,headers:{location:'https://elsewhere.example/'}})) as unknown as typeof fetch});
 await expect(redirect(api+'/mcp')).rejects.toThrow('redirect refused');
});

for(const mode of ['legacy',{pin:'2026-07-28'}] as const)test('native MCP transports preserve core tools and identity refresh: '+JSON.stringify(mode),async()=>{
 let handler:ReturnType<typeof createOpenCrawlMcp>,time=1000000,mints=0,rejected:string|undefined;
 const accepted:string[]=[],clients:unknown[]=[];
 const server=createServer((req,res)=>handler(req,res)),api=await listen(server);
 const token=createWorkspaceTokenProvider({provider:'devin',now:()=>time,mint:async()=>
  'header.'+Buffer.from(JSON.stringify({iss:'https://app.devin.ai',aud:api,exp:time/1000+60,nonce:++mints})).toString('base64url')+'.signature'});
 handler=createOpenCrawlMcp({origin:api,revision:'fixture-revision',authenticate:(req,res)=>{
  const value=req.headers.authorization;
  if(!value||value===rejected){res.writeHead(401);res.end();return null;}
  accepted.push(value);return {tenantId:'fixture-tenant',userId:'fixture-workload'};
 },onAuthenticated:(_principal,info)=>{clients.push(info);}});
 const [caller,bridge]=InMemoryTransport.createLinkedPair(),client=new Client({name:'devin-native-fixture',version:'1'},{versionNegotiation:{mode}});
 const abort=new AbortController();
 let running:Promise<void>|undefined;
 try{await withEnvironmentTokenOrigin(api,async()=>{
  running=bridgeMcp({input:bridge,remote:new StreamableHTTPClientTransport(new URL(api+'/mcp'),{fetch:authenticatedMcpFetch(api,{credential:async(old,signal)=>({token:await token(api,old,signal),refreshable:true})}),requestInit:{redirect:'error'}}),signal:abort.signal});
  await bounded(client.connect(caller));
  const listed=await bounded(client.listTools());
  expect(listed.tools.map(tool=>tool.name)).toEqual(['opencrawl','test_connection']);
  const connection=listed.tools.find(tool=>tool.name==='test_connection')!;
  expect(connection.outputSchema).toBeDefined();expect(connection.annotations?.readOnlyHint).toBe(true);
  expect((await client.callTool({name:'test_connection',arguments:{}})).structuredContent).toMatchObject({connected:true,revision:'fixture-revision'});
  expect(mints).toBe(1);time+=45000;
  expect((await client.callTool({name:'test_connection',arguments:{}})).isError).not.toBe(true);expect(mints).toBe(2);
  rejected=accepted.at(-1);
  expect((await client.callTool({name:'test_connection',arguments:{}})).isError).not.toBe(true);expect(mints).toBe(3);
  expect(clients.some(info=>(info as {name?:string})?.name==='devin-native-fixture')).toBe(true);
  expect((await client.callTool({name:'test_connection',arguments:{unexpected:true}})).isError).toBe(true);
 });}finally{await client.close();abort.abort();await running;await handler.close();await stop(server);}
});

test('stdio EOF cancels an active HTTP request; errors stay redacted and pending calls are bounded',async()=>{
 const input=new PassThrough(),output=new PassThrough(),messages:JSONRPCMessage[]=[];
 output.on('data',chunk=>{for(const line of String(chunk).trim().split('\n'))messages.push(JSON.parse(line));});
 let started!:()=>void,aborted!:()=>void;
 const begun=new Promise<void>(resolve=>{started=resolve;}),cancelled=new Promise<void>(resolve=>{aborted=resolve;});
 const remote=new StreamableHTTPClientTransport(new URL('https://mcp.example/mcp'),{fetch:async(_url,init)=>{
  started();return await new Promise<Response>((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>{aborted();reject(Error('NEVER_PRINT_SECRET'));},{once:true}));
 }});
 const running=bridgeMcp({input:new StdioServerTransport(input,output,{maxBufferSize:65536}),remote,maxPending:1,timeoutMs:1000});
 await Bun.sleep(1);input.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})+'\n');await bounded(begun);
 input.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})+'\n');await Bun.sleep(1);
 expect(messages).toMatchObject([{id:2,error:{code:-32603}}]);input.end();await bounded(running);await bounded(cancelled);
 expect(JSON.stringify(messages)).not.toContain('NEVER_PRINT_SECRET');
});

test('request cancellation and stream failure retire pending work without replaying a call or leaking HTTP errors',async()=>{
 const [caller,input]=InMemoryTransport.createLinkedPair(),messages:JSONRPCMessage[]=[];
 caller.onmessage=m=>messages.push(m);await caller.start();
 let requests=0,cancellations=0;
 const remote=new StreamableHTTPClientTransport(new URL('https://mcp.example/mcp'),{fetch:async(_url,init)=>{
  requests++;const value=JSON.parse(String(init?.body));
  if(value.id===1)return await new Promise<Response>((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>{cancellations++;reject(Error('PRIVATE_RESPONSE'));},{once:true}));
  if(value.id===3)return new Response('PRIVATE_RESPONSE',{status:503});
  if(value.id===4)return new Response('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"fixture","progress":1}}\n\n',{headers:{'content-type':'text/event-stream'}});
  return new Response(null,{status:202});
 }});
 const abort=new AbortController(),running=bridgeMcp({input,remote,signal:abort.signal,timeoutMs:100,maxPending:1});
 try{
  await Bun.sleep(1);await caller.send({jsonrpc:'2.0',id:1,method:'tools/list'});await Bun.sleep(1);
  await caller.send({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:1}});await Bun.sleep(1);
  await caller.send({jsonrpc:'2.0',id:3,method:'tools/list'});await Bun.sleep(10);
  await caller.send({jsonrpc:'2.0',id:4,method:'tools/list'});await Bun.sleep(20);
  expect(cancellations).toBe(1);expect(requests).toBe(4);
  expect(messages.some(m=>'id' in m&&m.id===1)).toBe(false);
  expect(messages.filter(m=>'error' in m).map(m=>'id' in m?m.id:undefined)).toEqual([3,4]);
  expect(JSON.stringify(messages)).not.toContain('PRIVATE_RESPONSE');
 }finally{abort.abort();await running;await caller.close();}
});

test('MCP entry reserves stdout for protocol and creates no configuration on invalid arguments or EOF',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'opencrawl-mcp-entry-'));
 try{for(const args of [['--json'],[]]){
  const env={...process.env,OPENCRAWL_CONFIG_HOME:directory,OPENCRAWL_NO_UPDATE:'1'};
  const child=Bun.spawn([process.execPath,join(import.meta.dir,'../src/cli.ts'),'mcp',...args],{env,stdin:'pipe',stdout:'pipe',stderr:'pipe'});child.stdin.end();
  const [status,stdout]=await Promise.all([bounded(child.exited),new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(status).toBe(args.length?1:0);expect(stdout).toBe('');expect(readdirSync(directory)).toEqual([]);
 }}finally{rmSync(directory,{recursive:true,force:true});}
});

test.skipIf(!postgresUrl)('MCP bridge preserves real board publications, retry IDs, fetch results and workspace denials',async()=>{
 const cleanup:(()=>Promise<void>)[]=[];
 const database=await applicationDatabaseFixture({after:(run:()=>Promise<void>)=>cleanup.push(run)}),repository=createPostgresBoardState(database);await repository.ready();
 const board=createBoard({state:{board:repository}});
 let handler:ReturnType<typeof createOpenCrawlMcp>;
 const server=createServer((req,res)=>handler(req,res)),api=await listen(server);
 handler=createOpenCrawlMcp({origin:api,authenticate:()=>({tenantId:'bridge-fixture',userId:'devin-fixture'}),board});
 const [caller,input]=InMemoryTransport.createLinkedPair(),client=new Client({name:'devin-board-fixture',version:'1'}),abort=new AbortController();
 const running=bridgeMcp({input,remote:new StreamableHTTPClientTransport(new URL(api+'/mcp')),signal:abort.signal});
 try{
  await client.connect(caller);
  expect((await client.listTools()).tools.map(tool=>tool.name)).toContain('board_sync');
  const post={agent:'devin:bridge',topics:['fixture'],posts:[{id:'one',topic:'fixture',text:'Synthetic native MCP board evidence'}]};
  const result=await client.callTool({name:'board_sync',arguments:post});
  expect(result.isError).not.toBe(true);
  const text=(result.content[0] as {text:string}).text,accepted=JSON.parse(text).accepted;
  expect(accepted).toHaveLength(1);
  const retried=await client.callTool({name:'board_sync',arguments:post});expect(JSON.parse((retried.content[0] as {text:string}).text).accepted).toEqual(accepted);
  const fetched=await client.callTool({name:'board_fetch',arguments:{id:'message:'+accepted[0]}});
  expect(JSON.parse((fetched.content[0] as {text:string}).text).text).toBe(post.posts[0]!.text);
  const denied=await client.callTool({name:'board_fetch',arguments:{id:'message:'+accepted[0],workspace:'foreign'}});expect(denied.isError).toBe(true);
 }finally{await client.close();abort.abort();await running;await handler.close();await stop(server);for(const run of cleanup.reverse())await run();}
});

test('packaged application bundle runs MCP over actual stdio without Node on PATH',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'opencrawl-mcp-bundle-'));
 let handler:ReturnType<typeof createOpenCrawlMcp>;
 const server=createServer((req,res)=>handler(req,res)),api=await listen(server);
 handler=createOpenCrawlMcp({origin:api,revision:'bundled-stdio',authenticate:req=>req.headers.authorization==='Bearer synthetic-bundle-token'?{tenantId:'fixture',userId:'fixture'}:null});
 const client=new Client({name:'devin-bundle-fixture',version:'1'});
 try{
  const build=await Bun.build({entrypoints:[join(import.meta.dir,'../src/cli.ts')],outdir:directory,target:'bun'});expect(build.success).toBe(true);
  const transport=new StdioClientTransport({command:process.execPath,args:[join(directory,'cli.js'),'mcp','--api',api],stderr:'pipe',
    env:{PATH:directory,OPENCRAWL_CONFIG_HOME:join(directory,'config'),OPENCRAWL_NO_UPDATE:'1',OPENCRAWL_TOKEN:'synthetic-bundle-token'}});
  let errors='';transport.stderr?.on('data',chunk=>{errors+=String(chunk);});
  await bounded(client.connect(transport));
  expect((await client.callTool({name:'test_connection',arguments:{}})).structuredContent).toMatchObject({connected:true,revision:'bundled-stdio'});
  await client.close();expect(errors).toBe('');expect(readdirSync(directory).sort()).toEqual(['cli.js']);
 }finally{await client.close();await handler.close();await stop(server);rmSync(directory,{recursive:true,force:true});}
});
