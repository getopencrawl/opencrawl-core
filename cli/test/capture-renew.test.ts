import {test,expect} from 'bun:test';
import {createServer,type IncomingMessage} from 'node:http';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createSessionIngest,createCaptureHandler} from '../../src/sessions/ingest.mjs';
import {createLocalSessionStore} from '../../src/sessions/local-store.mjs';
import {installCapture} from '../src/capture/install.ts';
import {captureDir,readCaptureConfig,flushCaptures} from '../src/capture/runtime.ts';
import {saveSession,readSession} from '../src/session.ts';

test('a flush that outlives its sign-in token renews it, re-verifies identity and keeps uploading',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'opencrawl-capture-renew-')),saved={...process.env};
 const alice={tenantId:'org_team',userId:'alice',name:'Alice',email:'alice@example.net'};
 // Tokens map to principals; the server expires tokens by removing them.
 const valid=new Map<string,typeof alice>([['token-1',alice]]);
 let issue='token-2',issuedFor=alice,refreshes=0,identities=0,uploads=0,expireAfterUploads=1;
 const store=createLocalSessionStore(join(dir,'objects')),ingest=createSessionIngest({store});
 const handler=createCaptureHandler({ingest,authenticate:async (req:IncomingMessage)=>{
  const principal=valid.get(/^Bearer (.+)$/.exec(req.headers.authorization||'')?.[1]??'');
  if(!principal)throw Object.assign(Error('Capture sign-in required'),{status:401});
  if(req.url==='/api/sessions/identity')identities++;
  return principal;
 }});
 const server=createServer(async(req,res)=>{
  if(req.url==='/token'&&req.method==='POST'){
   refreshes++;valid.set(issue,issuedFor);
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({access_token:issue,refresh_token:'refresh-'+refreshes,expires_in:3600}));return;
  }
  // The first token expires mid-flush, after it has already uploaded a batch.
  if(req.url==='/api/sessions/batches'&&req.method==='POST'&&++uploads===expireAfterUploads+1)valid.delete('token-1');
  return handler(req,res);
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const api='http://127.0.0.1:'+(server.address() as any).port;
 try{
  for(const key of ['OPENCRAWL_SESSIONS_TOKEN','OPENCRAWL_TOKEN'])delete process.env[key];
  Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(dir,'config'),CLAUDE_CONFIG_DIR:join(dir,'claude'),CODEX_HOME:join(dir,'codex')});
  await saveSession(api,{auth:{clientId:'public',deviceAuthorizationEndpoint:api+'/device',tokenEndpoint:api+'/token'},accessToken:'token-1',refreshToken:'refresh-0',expiresAt:Date.now()+3600_000} as any);
  await installCapture(api,{background:false,home:dir,command:[process.execPath,'-e','']});
  const installed=readCaptureConfig()!;
  const batch=(n:number)=>({schemaVersion:1,owner:installed.owner,installationId:installed.installationId,sessionId:'session',harness:'codex',origin:'cli',events:[{id:'event-'+n,kind:'message',data:{role:'user',content:'history '+n}}],attachments:[]});
  for(const n of [1,2,3])writeFileSync(join(captureDir(),'queue',n+'.json'),JSON.stringify(batch(n)));
  identities=0;
  expect(await flushCaptures()).toEqual({uploaded:3});
  expect(refreshes).toBe(1);
  // Once at the start, once for the renewed token.
  expect(identities).toBe(2);
  expect(readSession(api)!.accessToken).toBe('token-2');
  expect(readdirSync(join(captureDir(),'queue'))).toEqual([]);

  // A renewed token for a different human must not upload the queued author's data.
  writeFileSync(join(captureDir(),'queue','4.json'),JSON.stringify(batch(4)));
  writeFileSync(join(captureDir(),'queue','5.json'),JSON.stringify(batch(5)));
  uploads=0;expireAfterUploads=1;valid.set('token-1',alice);
  await saveSession(api,{...readSession(api)!,accessToken:'token-1'});
  issue='token-3';issuedFor={...alice,userId:'bob',name:'Bob'};
  const before=uploads;
  await expect(flushCaptures()).rejects.toMatchObject({code:'CAPTURE_DESTINATION_CHANGED'});
  expect(uploads-before).toBe(2);
  // The batch uploaded before expiry is done; the rejected one is retained unchanged.
  const remaining=readdirSync(join(captureDir(),'queue'));
  expect(remaining).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(captureDir(),'queue',remaining[0]),'utf8'))).toEqual(batch(parseInt(remaining[0])));
 }finally{await new Promise<void>(r=>server.close(()=>r()));for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);rmSync(dir,{recursive:true,force:true});}
});
