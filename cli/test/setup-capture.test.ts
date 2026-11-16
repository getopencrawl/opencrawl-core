import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,appendFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {installCapture} from '../src/capture/install.ts';
import {captureDir,readCaptureConfig,captureHook,captureTranscript} from '../src/capture/runtime.ts';
import {inventory} from '../src/capture/backfill.ts';
const line=(value:unknown)=>JSON.stringify(value)+'\n';
test('exact setup choices remove owned hooks, preserve unrelated hooks, and allow history without forward collection',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'opencrawl-setup-capture-')),saved={...process.env};
 const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({schemaVersion:1,data:{principal:{tenantId:'tenant',userId:'user'},capabilities:{harnesses:['codex','claude-code','cursor','antigravity']}}}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const api='http://127.0.0.1:'+(server.address() as {port:number}).port;
 try{
  Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(dir,'config'),OPENCRAWL_API_URL:api,OPENCRAWL_SESSIONS_TOKEN:'fixture-receiver-token',CLAUDE_DESKTOP_CONFIG_DIR:join(dir,'desktop'),CLAUDE_CONFIG_DIR:join(dir,'claude'),CODEX_HOME:join(dir,'codex'),CURSOR_CONFIG_DIR:join(dir,'cursor'),ANTIGRAVITY_HOME:join(dir,'agy')});
  mkdirSync(process.env.CODEX_HOME!,{recursive:true});writeFileSync(join(process.env.CODEX_HOME!,'hooks.json'),JSON.stringify({hooks:{Stop:[{hooks:[{type:'command',command:'preserve-me',timeout:3}]}]}}));
  await installCapture(api,{home:dir,harnesses:['codex'],command:['test-cli']});
  await installCapture(api,{home:dir,harnesses:[],historyHarnesses:['codex'],selectionMode:'replace',expectedOwner:{tenantId:'tenant',userId:'user'},command:['test-cli']});
  expect(readCaptureConfig()?.harnesses).toEqual([]);expect(readCaptureConfig()?.historyHarnesses).toEqual(['codex']);
  expect(readFileSync(join(process.env.CODEX_HOME!,'hooks.json'),'utf8')).toContain('preserve-me');expect(readFileSync(join(process.env.CODEX_HOME!,'hooks.json'),'utf8')).not.toContain('OpenCrawl session capture');
  await captureHook('codex',{session_id:'after-off',transcript_path:'not-needed'});expect(existsSync(join(captureDir(),'notices'))?readdirSync(join(captureDir(),'notices')):[]).toHaveLength(0);
  await expect(installCapture(api,{home:dir,harnesses:['codex'],selectionMode:'replace',expectedOwner:{tenantId:'other',userId:'user'}})).rejects.toMatchObject({code:'SETUP_SCOPE_CHANGED'});expect(readCaptureConfig()?.harnesses).toEqual([]);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);rmSync(dir,{recursive:true,force:true});}
});
test('future-only enrollment skips previous active transcript bytes and approved history cannot expand to later appends',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'opencrawl-setup-boundary-')),saved={...process.env};
 const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({schemaVersion:1,data:{principal:{tenantId:'tenant',userId:'user'},capabilities:{harnesses:['codex']}}}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const api='http://127.0.0.1:'+(server.address() as {port:number}).port;
 try{
  Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(dir,'config'),OPENCRAWL_API_URL:api,OPENCRAWL_SESSIONS_TOKEN:'fixture-receiver-token',CLAUDE_DESKTOP_CONFIG_DIR:join(dir,'desktop'),CLAUDE_CONFIG_DIR:join(dir,'claude'),CODEX_HOME:join(dir,'codex'),ANTIGRAVITY_HOME:join(dir,'agy')});
  const file=join(process.env.CODEX_HOME!,'sessions','native.jsonl');mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,line({type:'session_meta',payload:{id:'native',source:'cli'}})+line({type:'response_item',payload:{type:'message',role:'user',content:'OLD BEFORE CONSENT'}}));
  await installCapture(api,{home:dir,harnesses:['codex'],historyHarnesses:[],selectionMode:'replace',command:['test-cli']});const config=readCaptureConfig()!;
  appendFileSync(file,line({type:'response_item',payload:{type:'message',role:'user',content:'NEW AFTER CONSENT'}}));await captureTranscript(config,'codex',file);
  const queued=()=>readdirSync(join(captureDir(),'queue')).map(name=>readFileSync(join(captureDir(),'queue',name),'utf8')).join('\n');
  expect(queued()).toContain('NEW AFTER CONSENT');expect(queued()).not.toContain('OLD BEFORE CONSENT');expect(queued()).toContain('native');
  const approved=inventory(config,'codex').files[0];appendFileSync(file,line({type:'response_item',payload:{type:'message',role:'user',content:'LATER UNAPPROVED APPEND'}}));
  await captureTranscript(config,'codex',file,{},true,undefined,approved);expect(queued()).toContain('OLD BEFORE CONSENT');expect(queued()).not.toContain('LATER UNAPPROVED APPEND');
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);rmSync(dir,{recursive:true,force:true});}
});
