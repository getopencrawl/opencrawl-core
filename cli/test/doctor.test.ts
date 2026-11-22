import {test,expect} from 'bun:test';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync,statSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {scopeKey} from '../src/setup/state.ts';
import {setupPluginIdentity,writeBundle} from '../src/setup/plugins.ts';
import {bundleManifest} from '../src/setup/plugin-bundle.ts';
import {pluginRelease} from '../src/setup/plugin-release.ts';
const cli=join(import.meta.dir,'../src/cli.ts');
const json=(file:string,value:unknown)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(value),{mode:0o600});};
const owner={tenantId:'doctor-tenant',userId:'doctor-user'},installationId='doctor-host';
async function run(home:string,api:string|undefined,extra:Record<string,string>={}){
  const env={...process.env,HOME:home,USERPROFILE:home,OPENCRAWL_CONFIG_HOME:home,OPENCRAWL_NO_UPDATE:'1',OPENCRAWL_API_URL:api,OPENCRAWL_TOKEN:'doctor-test',OPENCRAWL_SESSIONS_TOKEN:'doctor-test',...extra};
  const child=Bun.spawn([process.execPath,cli,'doctor','--json'],{env,stdout:'pipe',stderr:'pipe',stdin:'ignore'});
  const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  if(!out)throw Error(err);
  return {exit,...JSON.parse(out)};
}
test('doctor distinguishes consent, explicitly recording off, and an unfinished choice without contacting a service',async()=>{
  const home=mkdtempSync(join(tmpdir(),'oc-doctor-off-')),api='http://127.0.0.1:1',scope={api,...owner};
  const file=join(home,'opencrawl','setup',scopeKey(scope)+'.json');
  const state={schemaVersion:1,scope,acceptedAt:'now',firstRun:'complete',selections:{plugins:{},forward:{},history:{}}};
  try{
    expect(await run(home,api)).toMatchObject({exit:2,status:'needs_human',nextAction:{kind:'choose_setup'}});
    json(file,state);const bytes=readFileSync(file),mtime=statSync(file).mtimeMs;
    for(let attempt=0;attempt<2;attempt++)expect(await run(home,api)).toMatchObject({exit:0,status:'green',recordingOff:true,repairs:[]});
    expect((await run(home,undefined)).status).toBe('green');
    expect(readFileSync(file)).toEqual(bytes);expect(statSync(file).mtimeMs).toBe(mtime);
    json(file,{...state,firstRun:'choosing'});expect((await run(home,api)).exit).toBe(2);
  }finally{rmSync(home,{recursive:true,force:true});}
},30000);

test('doctor challenges an active bundle, resumes on the same revision and refuses stale proof after a configuration change',async()=>{
  const home=mkdtempSync(join(tmpdir(),'oc-doctor-proof-'));
  let seen='',phase='native',supported=true,account=owner;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
    const path=new URL(req.url).pathname;
    const ok=(data:unknown)=>Response.json({schemaVersion:1,data});
    if(path==='/api/setup')return ok({scope:account,revisionProofSupported:supported,installations:[{installationId,clients:[{client:'cursor',forward:true,installed:true}]}]});
    if(path==='/api/sessions/identity')return ok({principal:owner,capabilities:{harnesses:['cursor']}});
    if(path!=='/api/setup/verify')return new Response(null,{status:404});
    const {revision}=await req.json();
    if(phase!=='stale')seen=revision;
    const proof={id:'0'.repeat(32),marker:'opencrawlverify'+'0'.repeat(32),revision:seen,state:'waiting_capture'};
    return ok({client:'cursor',forward:true,installed:true,humanTasks:[],mcp:phase==='native'?{state:'pending'}:{state:'authenticated',observedAt:new Date().toISOString()},
      proof:phase==='index'?{...proof,state:'waiting_index'}:phase==='green'||phase==='stale'?{...proof,state:'verified',sessionId:'new-native-session',eventId:'e',passageId:'p',verifiedAt:'2026-01-01T00:00:00.000Z'}:proof});
  }});
  const api=server.url.origin,scope={api,...owner},base=join(home,'opencrawl'),identity=setupPluginIdentity(api),client='cursor';
  const manager=join(base,'setup-plugins',client,identity.key),live=join(home,'.cursor','plugins','local',identity.name);
  const pin=pluginRelease.packages.find(row=>row.harness===client)!,archive=pin.archives![process.platform+'-'+process.arch]!;
  const source={repository:pluginRelease.repository,ref:pin.ref??pluginRelease.ref,name:pin.name,path:pin.path,version:pin.version,archive:{...archive,platform:process.platform+'-'+process.arch}};
  const config={schemaVersion:1,api,owner,installationId,hookOwnership:'plugin',roots:{cursor:join(home,'.cursor'),codex:join(home,'.codex'),'claude-code':join(home,'.claude')},command:[process.execPath,cli],harnesses:[client]};
  const files={'.opencrawl-source.json':JSON.stringify(source),'.opencrawl-binding.json':JSON.stringify({schemaVersion:1,api,configHome:home,client,installationId,owner,captureMode:'hook'})};
  const state={schemaVersion:1,firstRun:'ready',scope,installationId,acceptedAt:new Date().toISOString(),captureMode:'hook',selections:{plugins:{cursor:true},forward:{cursor:true},history:{}},pluginResults:[{client,status:'installed',captureAvailable:true,source}]};
  try{
    writeBundle(live,files,client,api,identity.name,home,home);
    json(join(manager,'installed.json'),{schemaVersion:2,api,client,pluginName:identity.name,configHome:home,nativeRoot:live,directory:live,digest:bundleManifest(files).digest});
    json(join(base,'capture','config.json'),config);json(join(base,'setup',scopeKey(scope)+'.json'),state);
    const check=()=>run(home,api);
    const first=await check();expect(first).toMatchObject({exit:3,status:'needs_agent',nextAction:{client,tool:'verify_installation',arguments:{client,installationId}}});
    expect(seen).toMatch(/^[a-f0-9]{64}$/);const before=seen;
    phase='index';expect(await check()).toMatchObject({exit:75,status:'retry',nextAction:{kind:'indexing'}});expect(seen).toBe(before);
    phase='green';expect(await check()).toMatchObject({exit:0,apps:{cursor:{observed:'verified',sessionId:'new-native-session'}}});
    json(join(base,'capture','config.json'),{...config,exclusions:{sessions:['excluded']}});
    phase='stale';expect(await check()).toMatchObject({exit:1,status:'blocked'});
    phase='native';expect((await check()).exit).toBe(3);expect(seen).not.toBe(before);
    supported=false;expect(await check()).toMatchObject({exit:1,nextAction:{kind:'server_upgrade_required'}});
    account={...owner,userId:'somebody-else'};expect(await check()).toMatchObject({exit:1,nextAction:{kind:'setup_scope_changed'}});
  }finally{server.stop(true);rmSync(home,{recursive:true,force:true});}
},30000);
