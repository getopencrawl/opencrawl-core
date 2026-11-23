import fs from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {join,resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import {setup} from './test-board.mjs';

// Starts a private receiver for one existing disposable Cloud Agent. Both
// native hooks and the member's test MCP use the VM loopback interface.
const [core,plugins,deps,workspace,session]=process.argv.slice(2).map(String);
assert(/^bc-[A-Za-z0-9-]{1,100}$/.test(session));
assert(fs.statSync(workspace).isDirectory());
const state=fs.mkdtempSync(join(tmpdir(),'oc-cloud-fixture-'));
const plugin=join(state,'plugin'), configHome=join(state,'profile'), api='http://127.0.0.1:19278';
const owner={tenantId:'fixture',userId:'tester'},installationId='test-installation';
const json=(file,value)=>{fs.mkdirSync(dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,JSON.stringify(value)+'\n',{mode:0o600});};
fs.cpSync(join(resolve(plugins),'plugins/cursor'),plugin,{recursive:true});
json(join(plugin,'.opencrawl-binding.json'),{schemaVersion:1,api,client:'cursor',configHome,installationId,owner,captureMode:'hook'});
json(join(plugin,'mcp.json'),{mcpServers:{oc_board_verify:{url:api+'/mcp'}}});
process.env.PROBE_CORE=resolve(core);process.env.TEST_PLUGIN=plugin;
const require=createRequire(join(resolve(deps),'package.json'));
const {default:Postgres}=await import(pathToFileURL(require.resolve('embedded-postgres')).href);
const pass=randomBytes(16).toString('hex');
const database=new Postgres({databaseDir:join(state,'database'),user:'postgres',password:pass,port:19279,
  persistent:true,postgresFlags:['-c','listen_addresses=127.0.0.1']});
await database.initialise();await database.start();
process.env.OPENCRAWL_TEST_POSTGRES_URL='postgres://postgres:'+pass+'@127.0.0.1:19279/postgres';
const word='ASH'+randomBytes(5).toString('hex').toUpperCase();
let sent=false, finished=false, fixture;
const stop=async()=>{if(finished)return;finished=true;await fixture?.close();await database.stop();};
process.once('SIGTERM',()=>{void stop();});process.once('SIGINT',()=>{void stop();});
try{
  fixture=await setup('cursor',async id=>{
    assert.equal(id,session);
    await fixture.bind(id);
    if(!sent){
      sent=true;
      await fixture.board.agent.post(owner,{session:'sender',posts:[{id:'random-word',channel:'validation',text:'Report this exact test word: '+word,mentions:['fixture-receiver']}]});
    }
  });
  const hash=createHash('sha256').update(session).digest('hex');
  const statusPath=join(state,'status.json');
  const report=()=>{
    const base=join(configHome,'opencrawl/plugin-state');
    let checkpoint;
    if(fs.existsSync(base))for(const key of fs.readdirSync(base)){
      const p=join(base,key,'board',hash+'.json');if(fs.existsSync(p))checkpoint=JSON.parse(fs.readFileSync(p)).feeds?.direct;
    }
    const reads=fixture.events.filter(e=>e.op==='poll'&&e.ids?.length);
    json(statusPath,{session,sent,reads:reads.map(r=>({lane:r.lane,ids:r.ids,session:r.session})),offers:fixture.events.filter(e=>e.op==='sync'&&e.ids.length).length,after:checkpoint?.after,pending:Boolean(checkpoint?.pending),wordSha256:createHash('sha256').update(word).digest('hex')});
  };
  // Preserve the diagnostic hooks. The bound runtime receives the unchanged
  // native payload. Limit this one test's idle window through the host timeout.
  const hooksFile=join(resolve(workspace),'.cursor/hooks.json');
  const hooks=JSON.parse(fs.readFileSync(hooksFile,'utf8'));
  const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
  const command=quote(process.execPath)+' '+quote(join(plugin,'bin/opencrawl-hook.mjs'))+' --root '+quote(plugin)+' --action ';
  for(const [event,action] of [['beforeSubmitPrompt','capture'],['postToolUse','capture'],['stop','inbox']]){
    hooks.hooks[event]??=[];
    hooks.hooks[event].push({command:command+action,timeout:event==='stop'?10:7,failClosed:false,...(event==='stop'?{loop_limit:1}:{})});
  }
  json(hooksFile,hooks);
  report();const timer=setInterval(report,600);timer.unref();
  console.log(JSON.stringify({ready:true,statusPath,session,expiresMinutes:20}));
  setTimeout(()=>{clearInterval(timer);void stop();},20*60_000).unref();
}catch(error){await stop();throw error;}
