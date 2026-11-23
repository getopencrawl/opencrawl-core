import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';
import {setup} from './test-board.mjs';

const [core,plugins,deps]=process.argv.slice(2);
const dir=fs.mkdtempSync(join(tmpdir(),'oc-replicas-read-')),plugin=join(dir,'plugin');
const api='http://127.0.0.1:19278',owner={tenantId:'fixture',userId:'tester'};
fs.cpSync(join(plugins,'plugins/claude-code'),plugin,{recursive:true});
fs.writeFileSync(join(plugin,'.opencrawl-binding.json'),JSON.stringify({schemaVersion:1,api,client:'claude-code',configHome:join(dir,'profile'),installationId:'fixture-installation',owner,captureMode:'hook',boardIdleMinutes:0}),{mode:0o600});
fs.writeFileSync(join(plugin,'.mcp.json'),JSON.stringify({mcpServers:{opencrawl:{url:api+'/mcp'}}}));
const require=createRequire(join(deps,'package.json'));
const {default:Postgres}=await import(pathToFileURL(require.resolve('embedded-postgres')).href);
const password=randomBytes(20).toString('hex');
const database=new Postgres({databaseDir:join(dir,'database'),user:'postgres',password,port:19279,persistent:true,postgresFlags:['-c','listen_addresses=127.0.0.1']});
await database.initialise();await database.start();
Object.assign(process.env,{PROBE_CORE:core,TEST_PLUGIN:plugin,OPENCRAWL_TEST_POSTGRES_URL:'postgres://postgres:'+password+'@127.0.0.1:19279/postgres'});
const f=await setup('claude-code');
try{
 const session=randomUUID(),word='HAZEL'+randomBytes(6).toString('hex').toUpperCase();
 await f.bind(session);
 await f.board.agent.post(owner,{session:'sender',posts:[{id:'challenge',channel:'validation',mentions:['fixture-receiver'],text:'Please return '+word}]});
 const server='plugin_opencrawl_opencrawl';
 const args=['-p','--verbose','--no-session-persistence','--session-id',session,'--setting-sources','','--plugin-dir',plugin,'--strict-mcp-config','--mcp-config',JSON.stringify({mcpServers:{[server]:f.config}}),'--model','haiku','--tools','','--allowedTools','mcp__'+server+'__board_inbox','--output-format','stream-json','Return 42. If a lifecycle notice signals a peer message, read its scoped board_inbox page and include the requested word.'];
 const proc=spawn('claude',args,{cwd:dir,stdio:['ignore','pipe','pipe']});
 let answer='',failed=false;const errors=[];proc.stderr.on('data',chunk=>{if(errors.length<2)errors.push(String(chunk).slice(0,240));});
 createInterface({input:proc.stdout}).on('line',line=>{let e;try{e=JSON.parse(line);}catch{return;}if(e.type==='result'){answer=e.result??'';failed=e.is_error;}});
 const timer=setTimeout(()=>proc.kill('SIGTERM'),65000);const code=await new Promise(r=>proc.on('exit',r));clearTimeout(timer);
 const reads=f.events.filter(e=>e.op==='poll'&&e.ids?.includes(1));
 const state=join(dir,'profile/opencrawl/plugin-state');
 const file=createHash('sha256').update(session).digest('hex')+'.json';
 const feed=JSON.parse(fs.readFileSync(join(state,fs.readdirSync(state)[0],'board',file))).feeds.direct;
 const result={native:'Claude Code',code,session,correctTask:answer.includes('42'),wordVerified:answer.includes(word),reads:reads.length,checkpoint:feed.after,pending:!!feed.pending,failed,
   diagnostic:failed||code?answer.slice(0,150)||errors.join(' ').slice(0,150):undefined};
 console.log(JSON.stringify(result));assert(code===0&&!failed&&result.correctTask&&result.wordVerified&&result.reads===1&&feed.after===1&&!feed.pending);
}finally{await f.close();await database.stop();}
