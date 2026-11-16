/** Opt-in real Claude/macOS proof. All capture state and receiver data live in
 * one disposable profile. Claude's existing sign-in is used through its CLI;
 * credentials are never read here; global settings are hashed to detect changes. */
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,existsSync,rmSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {spawnSync} from 'node:child_process';
import {installCapture,uninstallCapture} from '../src/capture/install.ts';
import {captureDir,readCaptureConfig} from '../src/capture/runtime.ts';
import {atomicJson} from '../src/session.ts';
import {hash} from '../src/capture/parse.ts';
import {ensureCaptureDaemon} from '../src/capture/daemon-service.ts';

if(process.platform!=='darwin')throw Error('This supervised smoke test requires macOS.');
const output=process.argv[2];if(!output)throw Error('Supply a durable evidence output directory.');
mkdirSync(output,{recursive:true});
const scratch=mkdtempSync(join(tmpdir(),'opencrawl-claude-daemon-proof-')),before={...process.env};
const root=resolve(import.meta.dir,'..'),sessionId=randomUUID(),marker='opencrawl-daemon-proof-'+randomUUID();
const claudeRoot=before.CLAUDE_CONFIG_DIR||join(homedir(),'.claude');
const realSettings=join(claudeRoot,'settings.json'),settingsDigest=()=>existsSync(realSettings)?hash(readFileSync(realSettings)):null;
const settingsBefore=settingsDigest();
const received:{raw:string,batch:any,accepted:boolean}[]=[];
let offline=true,requests=0;
const server=createServer(async(req,res)=>{
  requests++;res.setHeader('content-type','application/json');
  if(req.url==='/api/sessions/identity'){res.end(JSON.stringify({data:{principal:{tenantId:'daemon-smoke',userId:'daemon-smoke'}}}));return;}
  const parts=[];for await(const chunk of req)parts.push(chunk);const raw=Buffer.concat(parts).toString();
  if(req.url==='/api/sessions/batches'){
    const batch=JSON.parse(raw);received.push({raw,batch,accepted:!offline});
    if(offline){res.statusCode=500;res.end('{}');return;}
    res.end(JSON.stringify({data:{stored:true,batchId:hash(raw)}}));return;
  }
  res.statusCode=404;res.end('{}');
});
await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
const api='http://127.0.0.1:'+(server.address() as any).port;
const sleep=(ms:number)=>new Promise(done=>setTimeout(done,ms));
async function until(check:()=>boolean,ms=45_000){const deadline=Date.now()+ms;while(!check()){if(Date.now()>deadline)throw Error('Proof condition timed out');await sleep(100);}}
const evidence:any={sessionId,marker,startedAt:new Date().toISOString(),runtime:'Bun TypeScript source',receiver:'isolated local synthetic receiver',checks:{}};
let daemonPid:number|undefined;
const save=()=>writeFileSync(join(output,'proof.json'),JSON.stringify(evidence,null,2)+'\n');
try{
  Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(scratch,'config'),XDG_CACHE_HOME:join(scratch,'cache'),XDG_DATA_HOME:join(scratch,'data'),OPENCRAWL_API_URL:api,OPENCRAWL_SESSIONS_TOKEN:'synthetic-daemon-smoke-token',OPENCRAWL_NO_UPDATE:'1',CLAUDE_CONFIG_DIR:join(scratch,'claude'),CODEX_HOME:join(scratch,'codex')});
  const command=process.argv[3]?[resolve(process.argv[3])]:[process.execPath,join(root,'src/cli.ts')];
  if(process.argv[3])evidence.runtime='compiled native CLI';
  const installed=await installCapture(api,{home:scratch,command,harnesses:['claude-code'],daemon:true});
  evidence.worker=(installed as any).worker;
  const generated=JSON.parse(readFileSync(join(scratch,'claude','settings.json'),'utf8'));
  evidence.hooks=Object.entries(generated.hooks).map(([event,groups]:[string,any])=>({event,async:groups[0].hooks[0].async,timeout:groups[0].hooks[0].timeout}));
  // Only the isolated capture profile points at Claude's actual transcript
  // root. The generated hooks are supplied to this one invocation via --settings.
  const config=readCaptureConfig()!;atomicJson(join(captureDir(),'config.json'),{...config,roots:{...config.roots,'claude-code':claudeRoot}});
  const settings=join(scratch,'proof-settings.json');writeFileSync(settings,JSON.stringify(generated));
  const status=join(captureDir(),'daemon/status.json');
  await until(()=>existsSync(status));daemonPid=JSON.parse(readFileSync(status,'utf8')).pid;
  evidence.initialPid=daemonPid;
  const start=performance.now();
  const claude=Bun.spawn(['claude','-p','Reply with exactly: '+marker,'--session-id',sessionId,'--setting-sources','','--settings',settings,'--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--tools','','--disable-slash-commands','--system-prompt','You are verifying session capture. Follow the requested exact response.','--output-format','stream-json','--verbose','--include-hook-events','--max-budget-usd','0.50'],{cwd:scratch,env:{...before,CLAUDE_CONFIG_DIR:claudeRoot,XDG_CACHE_HOME:process.env.XDG_CACHE_HOME,XDG_DATA_HOME:process.env.XDG_DATA_HOME,OPENCRAWL_NO_UPDATE:'1'},stdout:'pipe',stderr:'pipe'});
  const [exit,stdout,stderr]=await Promise.all([claude.exited,new Response(claude.stdout).text(),new Response(claude.stderr).text()]);
  evidence.claude={exit,elapsedMs:performance.now()-start,stderr:stderr.slice(-2000)};
  const events=stdout.split('\n').filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return {type:'unparsed'};}});
  evidence.claude.hookEvents=events.filter(event=>String(event.type).includes('hook')||String(event.subtype).includes('hook'));
  evidence.claude.result=events.slice().reverse().find(event=>event.type==='result');save();
  if(exit!==0||!stdout.includes(marker))throw Error('Real Claude invocation failed; see proof.json.');
  await until(()=>received.some(item=>item.batch.sessionId===sessionId));
  evidence.checks.recordedAfterClaudeExit=true;
  evidence.queuedWhileOffline=readdirSync(join(captureDir(),'queue')).filter(name=>name.endsWith('.json')).length;
  const first=received[0]!.raw;process.kill(daemonPid!,'SIGKILL');
  const killedAt=performance.now();
  // A session hook arriving during restart must wake the supervisor rather
  // than replace its worker with an unsupervised child.
  await sleep(50);await ensureCaptureDaemon();
  await until(()=>{const current=JSON.parse(readFileSync(status,'utf8'));return current.state==='running'&&current.pid!==daemonPid;});
  daemonPid=JSON.parse(readFileSync(status,'utf8')).pid;
  const supervisor=spawnSync('launchctl',['print','gui/'+process.getuid!()+'/'+(installed as any).worker.label],{encoding:'utf8'});
  evidence.checks.supervisorOwnsRestart=supervisor.status===0&&supervisor.stdout.includes('pid = '+daemonPid);
  if(!evidence.checks.supervisorOwnsRestart)throw Error('Restarted worker is not owned by launchd');
  evidence.checks.launchdRestart={pid:daemonPid,elapsedMs:performance.now()-killedAt};offline=false;
  await until(()=>received.some(item=>item.accepted&&item.raw===first));
  await until(()=>readdirSync(join(captureDir(),'queue')).filter(name=>name.endsWith('.json')).length===0);
  const accepted=received.filter(item=>item.accepted),all=accepted.flatMap(item=>item.batch.events);
  evidence.checks.identicalRetry=true;evidence.checks.queueDrained=true;
  evidence.checks.userCaptured=all.some(event=>event.data?.role==='user'&&JSON.stringify(event.data).includes(marker));
  evidence.checks.assistantCaptured=all.some(event=>event.data?.role==='assistant'&&JSON.stringify(event.data).includes(marker));
  await until(()=>readdirSync(join(captureDir(),'daemon/sessions')).length===0);
  const sample=()=>spawnSync('ps',['-p',String(daemonPid),'-o','rss=,time='],{encoding:'utf8'}).stdout.trim();
  const idleStart={requests,sample:sample(),at:Date.now()};await sleep(30_000);
  evidence.idle={before:idleStart,after:{requests,sample:sample(),at:Date.now()},networkRequests:requests-idleStart.requests};
  evidence.batchIds=accepted.map(item=>hash(item.raw));
  if(!evidence.checks.userCaptured||!evidence.checks.assistantCaptured||evidence.idle.networkRequests!==0)throw Error('Capture or idle assertions failed');
  evidence.passed=true;
}catch(error){evidence.passed=false;evidence.error=String(error);save();throw error;}
finally{
  if(process.env.OPENCRAWL_CONFIG_HOME!==join(scratch,'config'))throw Error('Refusing cleanup outside proof profile');
  // The read-only transcript root is real, but installation/uninstallation
  // must only ever target this proof's generated disposable settings file.
  const current=readCaptureConfig();
  if(current)atomicJson(join(captureDir(),'config.json'),{...current,roots:{...current.roots,'claude-code':join(scratch,'claude')}});
  await uninstallCapture(scratch);
  if(daemonPid)await until(()=>{try{process.kill(daemonPid!,0);return false;}catch{return true;}},10_000);
  server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));
  evidence.checks.sharedClaudeSettingsUnchanged=settingsDigest()===settingsBefore;
  if(!evidence.checks.sharedClaudeSettingsUnchanged){evidence.passed=false;evidence.error='Shared Claude settings changed during proof; inspect concurrent work before any repair.';}
  evidence.finishedAt=new Date().toISOString();save();rmSync(scratch,{recursive:true,force:true});
  if(!evidence.checks.sharedClaudeSettingsUnchanged)throw Error(evidence.error);
}
console.log(JSON.stringify(evidence,null,2));
