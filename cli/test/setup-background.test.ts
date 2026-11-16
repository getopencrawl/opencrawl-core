import {test,expect} from 'bun:test';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,readFileSync,readdirSync,rmSync,existsSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as pause} from 'node:timers/promises';
import {scopeKey} from '../src/setup/state.ts';
import type {CaptureConfig} from '../src/capture/runtime.ts';
import type {SetupState} from '../src/setup/state.ts';
test('setup returns before a durable background history import finishes, without enabling future capture',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'opencrawl-setup-background-')),batches:unknown[]=[];let installations:unknown[]=[],releaseUpload!:()=>void,workerPid:number|undefined;
 const uploadGate=new Promise<void>(resolve=>{releaseUpload=resolve;});
 const server=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks),body=bytes.length?JSON.parse(bytes.toString()):{};let data:unknown;
  if(req.url==='/api/setup')data={schemaVersion:1,scope:{tenantId:'fixture-team',userId:'fixture-user'},firstWin:null,installations};
  else if(req.url==='/api/setup/installation'){installations=[{...body,clients:body.clients.map((client:Record<string,unknown>)=>({...client,humanTasks:[]}))}];data=installations[0];}
  else if(req.url==='/api/sessions/identity')data={principal:{tenantId:'fixture-team',userId:'fixture-user'},capabilities:{harnesses:['codex']}};
  else if(req.url==='/api/sessions/batches'){batches.push(body);await uploadGate;data={stored:true,batchId:createHash('sha256').update(bytes).digest('hex')};}
  else {res.writeHead(404);res.end();return;}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({schemaVersion:1,data}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const api='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const config=join(dir,'config'),state=():SetupState|undefined=>{const root=join(config,'opencrawl','setup');if(!existsSync(root))return;const name=readdirSync(root).find(name=>name.endsWith('.json'));const value:SetupState|undefined=name?JSON.parse(readFileSync(join(root,name),'utf8')):undefined;if(value?.historyJob?.pid)workerPid=value.historyJob.pid;return value;};
 try{
  const codex=join(dir,'codex'),file=join(codex,'sessions','history.jsonl');mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id:'fixture-history',source:'cli'}})+'\n'+JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:'CONSENTED HISTORY'}})+'\n');
  // This existing approved history-only installation exercises continuation
  // on every OS, including platforms deferred for new setup.
  const scope={api,tenantId:'fixture-team',userId:'fixture-user'},installationId='fixture-history-installation',acceptedAt=new Date().toISOString();
  const initial:CaptureConfig={schemaVersion:1,api,installationId,owner:{tenantId:scope.tenantId,userId:scope.userId},installedAt:acceptedAt,hookOwnership:'plugin',harnesses:[],historyHarnesses:['codex'],roots:{'claude-code':join(dir,'claude'),codex,cursor:join(dir,'cursor'),antigravity:join(dir,'agy')},command:[process.execPath,resolve(import.meta.dir,'../src/cli.ts')]};
  const saved:SetupState={schemaVersion:1,scope,installationId,acceptedAt,selections:{plugins:{codex:false},forward:{codex:false},history:{codex:true}},historyJob:{id:'fixture-approved-history',clients:['codex'],files:[{harness:'codex',path:file,bytes:Buffer.byteLength(readFileSync(file)),ino:0,mtimeMs:0}],state:'queued',completedClients:[],createdAt:acceptedAt,updatedAt:acceptedAt}};
  // Use real immutable snapshot metadata for the already approved file.
  const metadata=statSync(file);saved.historyJob!.files[0]!.ino=metadata.ino;saved.historyJob!.files[0]!.mtimeMs=metadata.mtimeMs;
  for(const [path,value] of [[join(config,'opencrawl','capture','config.json'),initial],[join(config,'opencrawl','setup',scopeKey(scope)+'.json'),saved]] as const){mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,JSON.stringify(value));}
  const child=Bun.spawn([process.execPath,resolve(import.meta.dir,'../src/cli.ts'),'setup','apply','--plugins','none','--forward','none','--history','codex','--yes','--json','--api',api],{env:{...process.env,HOME:dir,USERPROFILE:dir,OPENCRAWL_CONFIG_HOME:config,OPENCRAWL_API_URL:api,OPENCRAWL_NO_UPDATE:'1',OPENCRAWL_TOKEN:'fixture-read-token-01234567890',OPENCRAWL_SESSIONS_TOKEN:'fixture-write-token-01234567890',CLAUDE_CONFIG_DIR:join(dir,'claude'),CLAUDE_DESKTOP_CONFIG_DIR:join(dir,'desktop'),CODEX_HOME:codex,CURSOR_CONFIG_DIR:join(dir,'cursor'),ANTIGRAVITY_HOME:join(dir,'agy')},stdout:'pipe',stderr:'pipe'});
  const [stdout,stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect(stderr).toBe('');expect(exitCode).toBe(0);expect(JSON.parse(stdout).data.history.state).toBe('queued');expect(state()?.historyJob?.state).not.toBe('complete');
  const capture=JSON.parse(readFileSync(join(config,'opencrawl','capture','config.json'),'utf8'));expect(capture.harnesses).toEqual([]);
  appendFileSync(file,JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:'UNAPPROVED LATER MESSAGE'}})+'\n');
  const deadline=Date.now()+10000;while(!workerPid&&Date.now()<deadline){state();await pause(20);}
  expect(workerPid).toBeGreaterThan(0);releaseUpload();
  while(state()?.historyJob?.state!=='complete'&&Date.now()<deadline)await pause(20);
  expect(state()?.historyJob?.state).toBe('complete');expect(JSON.stringify(batches)).toContain('CONSENTED HISTORY');expect(JSON.stringify(batches)).not.toContain('UNAPPROVED LATER MESSAGE');
 }finally{
  releaseUpload();state();
  // Completion is durable before the final publish and lock release. Windows
  // keeps those files busy until this fixture's worker has actually exited.
  const alive=()=>{if(!workerPid)return false;try{process.kill(workerPid,0);return true;}catch{return false;}};
  const waitForExit=async()=>{const deadline=Date.now()+2000;while(alive()&&Date.now()<deadline)await pause(20);};
  await waitForExit();if(alive()){try{process.kill(workerPid!,'SIGTERM');}catch{}await waitForExit();}
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  if(alive())throw new Error('Fixture history worker did not exit; retaining its temporary HOME.');
  rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});
 }
},15000);
