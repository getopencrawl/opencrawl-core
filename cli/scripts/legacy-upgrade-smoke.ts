// The source installation and updater are the real published 0.4.60 artifacts.
// Only transport is redirected in CI; --published verifies the actual next tag.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,existsSync,realpathSync} from 'node:fs';
import {join,resolve,dirname,delimiter} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {createRequire} from 'node:module';

const root=resolve(import.meta.dir,'..'),published=process.argv.includes('--published');
const transportOnly=process.argv.includes('--transport-only');
const expected=process.argv.find(arg=>arg.startsWith('--version='))?.slice(10)??JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version;
const oldVersion='0.4.60',platform=process.platform+'-'+process.arch;
const bootstrapVersion=process.argv.find(arg=>arg.startsWith('--bootstrap-version='))?.slice(20)??oldVersion;
const node=Bun.which('node')!,npm=[node,createRequire(import.meta.url)('../bin/opencrawl.cjs').npmCli(node)];
const scratch=mkdtempSync(join(tmpdir(),'opencrawl legacy upgrade '));
const environment:NodeJS.ProcessEnv={...process.env};
for(const name of Object.keys(environment))if(name.startsWith('OPENCRAWL_'))delete environment[name];
Object.assign(environment,{HOME:scratch,USERPROFILE:scratch,XDG_DATA_HOME:join(scratch,'data'),XDG_CACHE_HOME:join(scratch,'cache'),OPENCRAWL_CONFIG_HOME:join(scratch,'config'),CLAUDE_CONFIG_DIR:join(scratch,'claude'),CODEX_HOME:join(scratch,'codex'),OPENCRAWL_NO_UPDATE:'1',npm_config_cache:join(homedir(),'.npm')});
let proxy:ReturnType<typeof Bun.spawn>|undefined;
let running:ReturnType<typeof Bun.spawn>|undefined;
let api:ReturnType<typeof Bun.serve>|undefined;
let finishSearch:()=>void=()=>{};
function sync(command:string[],env=environment,cwd?:string){
  const child=Bun.spawnSync(command,{env,cwd,stdout:'pipe',stderr:'pipe',windowsVerbatimArguments:process.platform==='win32'&&command[0]!.toLowerCase().endsWith('cmd.exe')});
  assert.equal(child.exitCode,0,child.stderr.toString());return child.stdout.toString().trim();
}
async function run(command:string[],env=environment){
  const child=Bun.spawn(command,{env,stdout:'pipe',stderr:'pipe',windowsVerbatimArguments:process.platform==='win32'&&command[0]!.toLowerCase().endsWith('cmd.exe')});
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  assert.equal(code,0,err);return out.trim();
}
async function verify(){try{
  const prefix=join(scratch,'npm');
  if(!transportOnly){
  await run([...npm,'install','--global','--prefix',prefix,'--no-audit','--no-fund','--registry=https://registry.npmjs.org','--@getopencrawl:registry=https://registry.npmjs.org','@getopencrawl/cli@'+bootstrapVersion]);
  }
  const modules=join(prefix,...process.platform==='win32'?['node_modules']:['lib','node_modules']);
  const launcher=join(modules,'@getopencrawl/cli/bin/opencrawl.cjs');
  const oldBytes=transportOnly?Buffer.alloc(0):readFileSync(launcher);
  if(!transportOnly){
  assert.equal(createHash('sha256').update(oldBytes).digest('hex'),bootstrapVersion===oldVersion?'a91eaef546eb5a5122d38662af8c371911e347cb5506a289e58022fba3cafbb8':'5c6acd874e4b46bca803d039f8cafb6975fe2cf30a520ab29cf585554a3e2be0');
  if(bootstrapVersion!==oldVersion){
    const previous=join(environment.XDG_CACHE_HOME!,'opencrawl/releases',oldVersion);mkdirSync(previous,{recursive:true});
    await run([...npm,'install','--prefix',previous,'--ignore-scripts','--no-audit','--no-fund','--registry=https://registry.npmjs.org','--@getopencrawl:registry=https://registry.npmjs.org','@getopencrawl/cli@'+oldVersion]);
    writeFileSync(join(environment.XDG_CACHE_HOME!,'opencrawl/current.json'),JSON.stringify({version:oldVersion}));
  }
  assert.equal(sync([node,launcher,'--version']),oldVersion);
  sync([node,launcher,'skills','install','--client','claude-code','--client','codex','--json']);
  }

  if(!published){
    const inventory:Record<string,unknown>={};
    if(transportOnly)inventory['@getopencrawl/cli']={file:join(root,'package.json'),version:expected,metadata:{name:'@getopencrawl/cli',version:expected}};
    for(const folder of transportOnly?[]:['cli',platform]){
      const directory=join(root,'dist',folder),pkg=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'));
      assert.equal(pkg.version,expected);
      const pack=JSON.parse(sync([...npm,'pack','--json','--pack-destination',scratch],environment,directory))[0];
      const file=join(scratch,pack.filename),bytes=readFileSync(file);
      inventory[pkg.name]={file,version:pkg.version,metadata:{...pkg,dist:{tarball:`https://registry.npmjs.org/${pkg.name}/candidate.tgz`,integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64')}}};
    }
    const inventoryFile=join(scratch,'inventory.json'),cert=join(scratch,'ca.pem'),key=join(scratch,'key.pem');
    writeFileSync(inventoryFile,JSON.stringify(inventory));
    const openssl=Bun.which('openssl')??'C:\\Program Files\\Git\\usr\\bin\\openssl.exe';
    sync([openssl,'req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=registry.npmjs.org','-addext','subjectAltName=DNS:registry.npmjs.org','-addext','basicConstraints=critical,CA:TRUE','-keyout',key,'-out',cert]);
    proxy=Bun.spawn([node,join(root,'scripts/legacy-registry-proxy.mts'),inventoryFile,cert,key,join(scratch,'proxy-receipt.json')],{stdout:'pipe',stderr:'inherit'});
    const reader=(proxy.stdout as ReadableStream<Uint8Array>).getReader(),first=await reader.read();reader.releaseLock();
    const {port}=JSON.parse(new TextDecoder().decode(first.value));
    Object.assign(environment,{HTTPS_PROXY:`http://127.0.0.1:${port}`,https_proxy:`http://127.0.0.1:${port}`,NODE_EXTRA_CA_CERTS:cert,NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost'});
    // Fail with the transport error itself, before the published updater's
    // intentional best-effort error handling turns it into a later timeout.
    await run([process.execPath,'-e',`const response=await fetch('https://registry.npmjs.org/@getopencrawl%2fcli/next',{redirect:'error',signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('Fixture registry status '+response.status);console.log((await response.json()).version);`],environment).then(actual=>assert.equal(actual,expected));
  }
  if(transportOnly){console.log('Candidate registry TLS transport verified.');return;}

  const held=new Promise<void>(resolve=>{finishSearch=resolve;});
  api=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    if(new URL(request.url).pathname==='/api/search'){
      await held;return Response.json({schemaVersion:1,data:{results:[],coverage:[{source:'sessions',state:'ready'}],partial:false,next:null}});
    }
    return Response.json({error:'fixture endpoint'},{status:401});
  }});
  const capture=join(environment.OPENCRAWL_CONFIG_HOME!,'opencrawl/capture');
  mkdirSync(join(capture,'queue'),{recursive:true});mkdirSync(join(capture,'state'));
  const config={schemaVersion:1,api:api.url.origin,installationId:'existing-install',owner:{tenantId:'org_original',userId:'human'},installedAt:'2026-01-01T00:00:00Z',roots:{'claude-code':environment.CLAUDE_CONFIG_DIR,codex:environment.CODEX_HOME},command:[node,launcher],hookMode:'async-v3'};
  writeFileSync(join(capture,'config.json'),JSON.stringify(config));
  const sentinels=new Map([
    [join(capture,'queue/before-update.json'),JSON.stringify({schemaVersion:1,owner:config.owner,installationId:config.installationId,sessionId:'queued-session',harness:'codex',origin:'cli',events:[{id:'queued-event',kind:'message',data:{role:'user',content:'keep queued bytes'}}],attachments:[]})],
    [join(capture,'state/cursor.json'),'{"offset":42}'],
    [join(environment.OPENCRAWL_CONFIG_HOME!,'opencrawl',createHash('sha256').update('https://saved-login.example').digest('hex')+'.json'),JSON.stringify({auth:{clientId:'saved-client',tokenEndpoint:'https://saved-login.example/token'},accessToken:'synthetic-access-token',refreshToken:'synthetic-refresh-token',expiresAt:Date.now()+86_400_000})],
  ]);
  for(const [file,bytes] of sentinels)writeFileSync(file,bytes,{mode:0o600});
  environment.OPENCRAWL_NO_UPDATE='0';environment.OPENCRAWL_TOKEN='migration-fixture-token';
  const cache=join(environment.XDG_CACHE_HOME!,'opencrawl'),release=join(cache,'releases',expected,'node_modules/@getopencrawl/cli');
  // This ordinary command holds its HTTP request while the published native
  // process performs its real opportunistic download. No update helper is mocked.
  environment.PATH=process.platform==='win32'?prefix:join(prefix,'bin');
  running=Bun.spawn([node,launcher,'search','migration','--api',api.url.origin,'--json'],{env:environment,stdout:'pipe',stderr:'pipe'});
  const output=new Response(running.stdout as ReadableStream<Uint8Array>).text(),errors=new Response(running.stderr as ReadableStream<Uint8Array>).text();
  const deadline=Date.now()+75_000;
  while(!existsSync(join(release,'package.json'))){
    if(running.exitCode!==null)throw new Error('Published old command exited before updating: '+await errors+await output+'; updater state: '+(existsSync(join(cache,'update.json'))?readFileSync(join(cache,'update.json'),'utf8'):'missing'));
    if(Date.now()>deadline)throw new Error('Published old auto-updater did not install the candidate within its command lifetime');
    await Bun.sleep(100);
  }
  finishSearch();
  assert.equal(await running.exited,0,await errors+await output);running=undefined;
  delete environment.OPENCRAWL_TOKEN;
  const entry=join(prefix,...process.platform==='win32'?['opencrawl.cmd']:['bin','opencrawl']);
  const command=(args:string[])=>process.platform==='win32'?[join(process.env.SystemRoot||'C:\\Windows','System32/cmd.exe'),'/d','/s','/c',`""${entry}" ${args.join(' ')}"`]:[entry,...args];
  // Invoke the actual old npm command, including its active Windows .cmd shim.
  // It still needs Node for this invocation; subsequent calls must not need it.
  await run(command(['board','instructions']),{...environment,PATH:environment.PATH+delimiter+dirname(node)});
  const noRuntime={...environment,OPENCRAWL_NO_UPDATE:'1',PATH:join(scratch,'no-runtimes')};
  assert.equal(sync(command(['--version']),noRuntime),expected,'Original npm command still requires Node');
  if(process.platform==='win32'){
    const powershell=join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
    assert.equal(sync([powershell,'-NoProfile','-ExecutionPolicy','Bypass','-File',entry.replace(/\.cmd$/,'.ps1'),'--version'],noRuntime),expected);
  }
  assert.deepEqual(readFileSync(launcher),oldBytes,'Legacy bridge changed under existing callers');
  for(const [file,bytes] of sentinels)assert.equal(readFileSync(file,'utf8'),bytes,'Migration changed retained state');
  const migrated=JSON.parse(readFileSync(join(capture,'config.json'),'utf8'));
  assert.equal(migrated.command.length,1);
  assert.deepEqual({...migrated,command:config.command,hookMode:config.hookMode},config);
  const captureCommand=process.platform==='win32'&&migrated.command[0].endsWith('.cmd')?[join(process.env.SystemRoot||'C:\\Windows','System32/cmd.exe'),'/d','/s','/c',`""${migrated.command[0]}" --version"`]:[migrated.command[0],'--version'];
  assert.equal(sync(captureCommand,noRuntime),expected);
  for(const client of ['claude','codex']){
    const settings=JSON.parse(readFileSync(join(scratch,client,client==='claude'?'settings.json':'hooks.json'),'utf8'));
    const startup=settings.hooks.SessionStart.flatMap((group:{hooks:Array<{command:string;statusMessage?:string;shell?:string}>})=>group.hooks).find((hook:{statusMessage?:string})=>hook.statusMessage==='OpenCrawl session startup') as {command:string;shell?:string};
    assert(startup&&!startup.command.includes('runner.cjs'));
    const windows=process.platform==='win32';
    if(windows&&client==='claude')assert.equal(startup.shell,'powershell');
    const hook=windows?(client==='claude'?[join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),'-NoProfile','-Command',startup.command]:[join(process.env.SystemRoot||'C:\\Windows','System32/cmd.exe'),'/d','/s','/c','"'+startup.command+'"']):['/bin/sh','-c',startup.command];
    const child=Bun.spawn(hook,{env:noRuntime,windowsVerbatimArguments:windows&&client==='codex',stdin:new Blob([JSON.stringify({hook_event_name:'SessionStart',session_id:'legacy-migration-'+client})]),stdout:'pipe',stderr:'pipe'});
    const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    assert.equal(code,0,err);assert(out.includes('OpenCrawl'));
  }
  for(const [file,bytes] of sentinels)assert.equal(readFileSync(file,'utf8'),bytes,'Migrated startup hook changed retained state');
  assert.equal(JSON.parse(readFileSync(join(cache,'native-migration.json'),'utf8')).complete,true);
  if(proxy){proxy.kill('SIGTERM');await proxy.exited;proxy=undefined;
    const requests=JSON.parse(readFileSync(join(scratch,'proxy-receipt.json'),'utf8')) as Array<{path:string;npm:boolean}>;
    assert(requests.some(request=>request.path.endsWith('/candidate.tgz')));
    assert(requests.every(request=>!request.npm),'Automatic update unexpectedly invoked npm');
  }
  console.log(JSON.stringify({bootstrapVersion,oldVersion,version:expected,platform,published,unmodifiedPublishedUpdater:true,originalCommandAndStartupHooksNodeFree:true,credentialsQueueAndCursorPreserved:true,legacyBridgePreserved:true,captureCommand:realpathSync(migrated.command[0])}));
}catch(error){
  for(const file of [join(environment.XDG_CACHE_HOME!,'opencrawl/update.json'),join(scratch,'proxy-receipt.json')])if(existsSync(file))console.error(readFileSync(file,'utf8'));
  throw error;
}finally{
  finishSearch();
  if(running){await Promise.race([running.exited,Bun.sleep(10_000)]);if(running.exitCode===null){running.kill();await running.exited;}}
  api?.stop(true);
  if(proxy){proxy.kill('SIGTERM');await proxy.exited;}
  rmSync(scratch,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}}
await verify();
