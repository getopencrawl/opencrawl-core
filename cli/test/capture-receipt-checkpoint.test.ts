import {test,expect} from 'bun:test';
import {mkdtempSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {atomicJson} from '../src/session.ts';
import {finalizeEventIdentity,hash} from '../src/capture/parse.ts';
import {createSessionIngest} from '../../dist/src/sessions/ingest.mjs';
import {createLocalSessionStore} from '../../dist/src/sessions/local-store.mjs';

test('killing a flush after stored receipts preserves acknowledged and unacknowledged events',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'capture-receipt-crash-')),configHome=join(dir,'config'),capture=join(configHome,'opencrawl/capture');
 const owner={tenantId:'team',userId:'owner'},ingest=createSessionIngest({store:createLocalSessionStore(join(dir,'objects'))});
 const stored=new Map<string,any>();let requests=0,release!:()=>void,third!:()=>void;
 const gate=new Promise<void>(r=>release=r),blocked=new Promise<void>(r=>third=r);
 const server=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.url==='/api/sessions/identity'){res.end(JSON.stringify({data:{principal:owner}}));return;}
  try{
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   const batch=JSON.parse(Buffer.concat(chunks).toString()),receipt=await ingest.putBatch(owner,batch);stored.set(receipt.batchId,batch);
   if(++requests===3){third();await gate;}
   res.end(JSON.stringify({data:receipt}));
  }catch(error:any){res.writeHead(error.status??500);res.end(JSON.stringify({error:{code:'FIXTURE_ERROR'}}));}
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const api='http://127.0.0.1:'+(server.address() as any).port,children:ReturnType<typeof Bun.spawn>[]=[];
 const run=()=>{
  const child=Bun.spawn([process.execPath,'--eval',`import {flushCaptures} from ${JSON.stringify(resolve(import.meta.dir,'../src/capture/runtime.ts'))}; console.log(JSON.stringify(await flushCaptures()));`],{env:{...process.env,OPENCRAWL_CONFIG_HOME:configHome,OPENCRAWL_API_URL:api,OPENCRAWL_SESSIONS_TOKEN:'fixture-token'},stdout:'pipe',stderr:'pipe'});
  children.push(child);return child;
 };
 try{
  atomicJson(join(capture,'config.json'),{schemaVersion:1,api,owner,installationId:'device',installedAt:'2026-11-12T00:00:00Z',roots:{codex:join(dir,'codex'),'claude-code':join(dir,'claude')},command:[]});
  for(let i=0;i<3;i++){
   const batch={schemaVersion:1,owner,installationId:'device',harness:'codex',sessionId:'session-'+i,origin:'cli',events:[finalizeEventIdentity({id:'event-'+i,kind:'message',data:{role:'user',content:'durable event '+i}})],attachments:[]};
   atomicJson(join(capture,'queue',hash(JSON.stringify(batch))+'.json'),batch);
  }
  const first=run();
  await Promise.race([blocked,first.exited.then(async code=>{throw new Error('Flush exited before the blocked receipt: '+code+' '+await new Response(first.stderr).text());})]);
  expect(stored.size).toBe(3);expect(readdirSync(join(capture,'queue')).filter(n=>n.endsWith('.json'))).toHaveLength(1);
  first.kill('SIGKILL');await first.exited;release();
  for(const expected of [1,0]){
   const child=run();const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
   expect(stderr).toBe('');expect(code).toBe(0);expect(JSON.parse(stdout).uploaded).toBe(expected);
  }
  expect(stored.size).toBe(3);expect(requests).toBe(4);
  expect(readdirSync(join(capture,'queue')).filter(n=>n.endsWith('.json'))).toHaveLength(0);
  const latest=JSON.parse(readFileSync(join(capture,'last-upload.json'),'utf8'));expect(latest.stored).toBe(true);expect(stored.has(latest.batchId)).toBe(true);
  for(const [batchId,batch] of stored){const saved=await ingest.getBatch(owner,{...batch,batchId});expect(saved?.events).toEqual(batch.events);}
 }finally{
  release();for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');await Promise.all(children.map(child=>child.exited));
  server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});
 }
},20000);
