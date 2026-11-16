import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,rmSync,realpathSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {setupPluginFiles,setupPluginIdentity} from '../src/setup/plugins.ts';
import {pluginHookContext,recordPluginActivation,pluginActivationMatches,verifyPluginBundle,type PluginHookClient} from '../src/setup/plugin-context.ts';
import {sessionFile} from '../src/session.ts';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const json=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
const clients:PluginHookClient[]=['codex','claude-code','cursor','antigravity'];
const cli=resolve(import.meta.dir,'../src/cli.ts');
function fixture(client:PluginHookClient='codex',api='https://candidate.example'){
 const temporary=mkdtempSync(join(tmpdir(),'opencrawl-plugin-context-')),home=realpathSync(temporary),configHome=join(home,'profile'),previous=process.env.OPENCRAWL_CONFIG_HOME;
 process.env.OPENCRAWL_CONFIG_HOME=configHome;
 const identity=setupPluginIdentity(api),nativeRoot=join(home,'native-cache',identity.name),configFile=join(configHome,'opencrawl/capture/config.json'),receiptRoot=join(configHome,'opencrawl/setup-plugins',client,identity.key),installed=join(receiptRoot,'installed.json'),activation=join(receiptRoot,'activation.json');
 const binding={api,client,pluginName:identity.name,configHome,nativeRoot};
 const files=setupPluginFiles(client,api,{command:[process.execPath,cli],configHome});
 const config={schemaVersion:1,hookOwnership:'plugin',api,installationId:'test-installation',owner:{tenantId:'test-tenant',userId:'test-user'},harnesses:[],historyHarnesses:[],roots:{codex:join(home,'codex'),'claude-code':join(home,'claude'),cursor:join(home,'cursor'),antigravity:join(home,'agy')},installedAt:new Date().toISOString(),command:[process.execPath,cli]};
 const write=(path:string,value:unknown)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,typeof value==='string'?value:json(value));};
 const seal=()=>{
  for(const [name,text] of Object.entries(files))write(join(nativeRoot,name),text);
  const digest=hash(json(files));
  write(join(nativeRoot,'.opencrawl-setup-plugin.json'),{schemaVersion:2,...binding,version:'fixture',digest,files:Object.fromEntries(Object.entries(files).map(([name,text])=>[name,hash(text)]))});
  write(installed,{schemaVersion:2,...binding,digest});return digest;
 };
 const digest=seal();write(configFile,config);
 const env={...process.env,HOME:home,USERPROFILE:home,CODEX_HOME:config.roots.codex,CLAUDE_CONFIG_DIR:config.roots['claude-code'],CURSOR_CONFIG_DIR:config.roots.cursor,ANTIGRAVITY_HOME:config.roots.antigravity,OPENCRAWL_CONFIG_HOME:configHome,OPENCRAWL_PLUGIN_API:api,OPENCRAWL_PLUGIN_CLIENT:client,OPENCRAWL_PLUGIN_NAME:identity.name,OPENCRAWL_PLUGIN_ROOT:nativeRoot};
 for(const name of ['OPENCRAWL_TOKEN','OPENCRAWL_SESSIONS_TOKEN','OPENCRAWL_API_URL','OPENCRAWL_AUTH'])delete (env as NodeJS.ProcessEnv)[name];
 const event=client==='antigravity'?{hookEventName:'SessionStart',conversationId:'native-session'}:client==='cursor'?{hook_event_name:'sessionStart',session_id:'native-session',cursor_version:'fixture'}:{hook_event_name:'SessionStart',session_id:'native-session',source:'startup'};
 return {home,configHome,binding,files,digest,config,configFile,installed,activation,env,event,write,seal,close:()=>{if(previous===undefined)delete process.env.OPENCRAWL_CONFIG_HOME;else process.env.OPENCRAWL_CONFIG_HOME=previous;rmSync(temporary,{recursive:true,force:true});}};
}

test('native plugin activation works for every search-only client without collecting transcript content',()=>{
 for(const client of clients){const f=fixture(client);try{
  const context=pluginHookContext(f.binding.api,client,f.env)!;
  expect(context).toMatchObject({...f.binding,digest:f.digest,installationId:f.config.installationId});
  expect(pluginActivationMatches({...f.binding,digest:f.digest})).toBe(false);
  recordPluginActivation(context,{...f.event,transcript_path:'/must-not-read',messages:['unrelated-private-content']});
  expect(pluginActivationMatches({...f.binding,digest:f.digest})).toBe(true);
  const receipt=readFileSync(f.activation,'utf8');expect(receipt).not.toContain('unrelated-private-content');expect(receipt).not.toContain('transcript_path');
  expect(existsSync(join(f.configHome,'opencrawl/capture/queue'))).toBe(false);
 }finally{f.close();}}
});

test('endpoint, client, installation, owner, profile and native source changes invalidate activation',()=>{
 const f=fixture();try{
  const context=pluginHookContext(f.binding.api,'codex',f.env)!;recordPluginActivation(context,f.event);
  for(const env of [{...f.env,OPENCRAWL_PLUGIN_API:'https://another.example'},{...f.env,OPENCRAWL_PLUGIN_CLIENT:'cursor'},{...f.env,OPENCRAWL_CONFIG_HOME:join(f.home,'another-profile')},{...f.env,OPENCRAWL_PLUGIN_ROOT:join(f.home,'another-cache')},{...f.env,OPENCRAWL_PLUGIN_NAME:'opencrawl-foreign'}])expect(()=>pluginHookContext(f.binding.api,'codex',env)).toThrow();
  for(const config of [{...f.config,installationId:'another-installation'},{...f.config,owner:{...f.config.owner,userId:'another-user'}},{...f.config,authPending:true},{...f.config,hookOwnership:'global'},{...f.config,api:'https://another.example'}]){
   f.write(f.configFile,config);expect(pluginActivationMatches({...f.binding,digest:f.digest})).toBe(false);expect(()=>recordPluginActivation(context,f.event)).toThrow();
  }
  f.write(f.configFile,f.config);expect(pluginActivationMatches({...f.binding,digest:f.digest})).toBe(true);
  f.write(f.installed,{schemaVersion:2,...f.binding,digest:f.digest,nativeRoot:f.home});expect(()=>pluginHookContext(f.binding.api,'codex',f.env)).toThrow();
 }finally{f.close();}
});

test('modified assets and symlinked bundle files never count as the installed plugin',()=>{
 const f=fixture();try{
  const context=pluginHookContext(f.binding.api,'codex',f.env)!;recordPluginActivation(context,f.event);
  f.write(join(f.binding.nativeRoot,'.mcp.json'),json({mcpServers:{opencrawl:{url:'https://another.example/mcp'}}}));
  expect(()=>verifyPluginBundle(f.binding)).toThrow();expect(pluginActivationMatches({...f.binding,digest:f.digest})).toBe(false);
  f.seal();const target=join(f.binding.nativeRoot,'.mcp.json'),outside=join(f.home,'external-mcp.json');f.write(outside,f.files['.mcp.json']);rmSync(target);symlinkSync(outside,target);
  expect(()=>verifyPluginBundle(f.binding)).toThrow();expect(pluginActivationMatches({...f.binding,digest:f.digest})).toBe(false);
 }finally{f.close();}
});

test('Codex activation rejects owned generic, wrong-name and wrong-endpoint MCP bundles but permits migration ownership',()=>{
 const f=fixture();try{
  for(const servers of [
   {opencrawl:{type:'http',url:f.binding.api+'/mcp'}},
   {'opencrawl-000000000000':{type:'http',url:f.binding.api+'/mcp'}},
   {[f.binding.pluginName]:{type:'http',url:'https://another.example/mcp'}},
   {[f.binding.pluginName]:{type:'http',url:f.binding.api+'/mcp'},opencrawl:{type:'http',url:f.binding.api+'/mcp'}},
  ]){
   f.files['.mcp.json']=json({mcpServers:servers});const digest=f.seal();
   expect(verifyPluginBundle(f.binding).digest).toBe(digest);
   expect(()=>pluginHookContext(f.binding.api,'codex',f.env)).toThrow();
   expect(pluginActivationMatches({...f.binding,digest})).toBe(false);
   expect(existsSync(f.activation)).toBe(false);
  }
 }finally{f.close();}
});

test('invalid or cross-client native events cannot confirm activation',()=>{
 const f=fixture();try{
  const context=pluginHookContext(f.binding.api,'codex',f.env)!;
  for(const event of [{},{...f.event,session_id:'bad\nidentity'},{...f.event,source:'invented'},{...f.event,cursor_version:'cross-loaded'},{...f.event,hook_event_name:'invented'}])recordPluginActivation(context,event);
  expect(existsSync(f.activation)).toBe(false);recordPluginActivation(context,f.event);expect(existsSync(f.activation)).toBe(true);
 }finally{f.close();}
});

test('generated API arguments cannot rebind inherited tokens or workload authentication',()=>{
 const f=fixture();try{
  for(const key of ['OPENCRAWL_TOKEN','OPENCRAWL_SESSIONS_TOKEN','OPENCRAWL_AUTH']){
   expect(()=>pluginHookContext(f.binding.api,'codex',{...f.env,[key]:'sentinel-must-not-be-used'})).toThrow();
  }
  expect(existsSync(f.activation)).toBe(false);
 }finally{f.close();}
});

test('real plugin capture callbacks for search-only clients activate without workers, queue or paused notices',async()=>{
 for(const client of clients){const f=fixture(client);try{
  const child=Bun.spawn([process.execPath,cli,'collect','hook','--managed','--harness',client,'--api',f.binding.api],{env:f.env,stdin:new Blob([JSON.stringify(f.event)]),stdout:'pipe',stderr:'pipe'});
  const timer=setTimeout(()=>child.kill(),3000);
  try{const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code).toBe(0);expect(err).toBe('');expect(out).not.toContain('paused');expect(out).not.toContain('unavailable');}finally{clearTimeout(timer);}
  expect(pluginActivationMatches({...f.binding,digest:f.digest})).toBe(true);
  for(const name of ['queue','notices','last-error.json','worker.lock'])expect(existsSync(join(f.configHome,'opencrawl/capture',name))).toBe(false);
 }finally{f.close();}}
},15_000);

test('legacy callbacks into plugin-owned profiles exit silently without waiting for stdin or doing work',async()=>{
 const f=fixture();try{
  const env:NodeJS.ProcessEnv={...f.env};for(const key of Object.keys(env))if(key.startsWith('OPENCRAWL_PLUGIN_'))delete env[key];
  for(const args of [['session','start'],['collect','hook','--managed']]){
   const child=Bun.spawn([process.execPath,cli,...args,'--harness','codex','--api',f.binding.api],{env,stdin:'pipe',stdout:'pipe',stderr:'pipe'});
   const timer=setTimeout(()=>child.kill(),3000);
   try{const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect({code,out,err}).toEqual({code:0,out:'',err:''});}finally{clearTimeout(timer);child.stdin.end();}
  }
  expect(existsSync(f.activation)).toBe(false);expect(existsSync(join(f.configHome,'opencrawl/capture/queue'))).toBe(false);expect(existsSync(join(f.configHome,'opencrawl/update.json'))).toBe(false);
 }finally{f.close();}
},10_000);

test('imported Cursor startup hooks stay silent while native plugin startup still registers',async()=>{
 const requests:string[]=[];
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  expect(new URL(request.url).pathname).toBe('/api/board/bootstrap');
  expect(request.headers.get('authorization')).toBe('Bearer disposable-test-token');
  const input=await request.json();requests.push(input.harness);
  return Response.json({schemaVersion:1,data:{session:input.session,workspace:'test-tenant',agent:'a'.repeat(64),name:null,task:null}});
 }});
 try{for(const client of ['claude-code','codex','cursor'] as const){
  const f=fixture(client,`http://127.0.0.1:${server.port}`);try{
   const credentials=sessionFile(f.binding.api);
   f.write(credentials,{auth:{clientId:'fixture',tokenEndpoint:f.binding.api+'/unused-token'},accessToken:'disposable-test-token',refreshToken:'not-used',expiresAt:Date.now()+60_000});
   const savedCredentials=readFileSync(credentials,'utf8'),savedPaths=readdirSync(f.configHome,{recursive:true}).sort(),before=requests.length;
   const run=async(payload:unknown)=>{
    const child=Bun.spawn([process.execPath,cli,'session','start','--harness',client,'--api',f.binding.api],{env:f.env,stdin:new Blob([JSON.stringify(payload)]),stdout:'pipe',stderr:'pipe'});
    const timer=setTimeout(()=>child.kill(),3000);
    try{
     const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
     expect(code).toBe(0);expect(err).toBe('');return out;
    }finally{clearTimeout(timer);}
   };
   if(client!=='cursor'){
    // Cursor runs imported hooks with its native payload. Even an otherwise
    // valid standard event must not register as the imported plugin's client.
    for(const payload of [{hook_event_name:'sessionStart',session_id:'native-session',cursor_version:'fixture'},{...f.event,cursor_version:'fixture'}])
     expect(await run(payload)).toBe('');
    expect(requests).toHaveLength(before);expect(existsSync(f.activation)).toBe(false);
    expect(readdirSync(f.configHome,{recursive:true}).sort()).toEqual(savedPaths);
    expect(readFileSync(credentials,'utf8')).toBe(savedCredentials);
    expect(readFileSync(f.configFile,'utf8')).toBe(json(f.config));
   }
   // Do not silence genuinely invalid native inputs or suppress Cursor itself.
   expect(await run({...f.event,session_id:'invalid\nidentity'})).toContain('did not supply a valid native session identity');
   expect(requests).toHaveLength(before);expect(existsSync(f.activation)).toBe(false);
   expect(await run(f.event)).toContain('OpenCrawl: registered with');
   expect(requests.slice(before)).toEqual([client]);
   expect(JSON.parse(readFileSync(f.activation,'utf8'))).toMatchObject({client,event:client==='cursor'?'sessionStart':'SessionStart'});
   expect(readFileSync(f.configFile,'utf8')).toBe(json(f.config));
  }finally{f.close();}
 }}finally{server.stop(true);}
},15_000);

test('bad plugin binding is rejected by real CLI before capture consumes stdin or writes state',async()=>{
 const f=fixture();try{
  const env={...f.env,OPENCRAWL_PLUGIN_API:'https://another.example'};
  const child=Bun.spawn([process.execPath,cli,'collect','hook','--managed','--harness','codex','--api',f.binding.api,'--json'],{env,stdin:'pipe',stdout:'pipe',stderr:'pipe'});
  const timer=setTimeout(()=>child.kill(),3000);
  try{const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code).not.toBe(0);expect(out+err).toContain('PLUGIN_CONTEXT_INVALID');}finally{clearTimeout(timer);child.stdin.end();}
  expect(existsSync(f.activation)).toBe(false);expect(existsSync(join(f.configHome,'opencrawl/capture/queue'))).toBe(false);expect(existsSync(join(f.configHome,'opencrawl/capture/last-error.json'))).toBe(false);
 }finally{f.close();}
},5_000);

test('Cursor first-tool startup rejects a bad plugin binding before stdin or activation',async()=>{
 const f=fixture('cursor');try{
  for(const env of [{...f.env,OPENCRAWL_PLUGIN_API:'https://another.example'},{...f.env,OPENCRAWL_CONFIG_HOME:join(f.home,'another-profile')}]){
  const child=Bun.spawn([process.execPath,cli,'session','start','--harness','cursor','--after-tool','--api',f.binding.api],{env,stdin:'pipe',stdout:'pipe',stderr:'pipe'});
  const timer=setTimeout(()=>child.kill(),3000);
  try{
   const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
   expect(code).toBe(0);expect(err).toBe('');expect(JSON.parse(out).additional_context).toContain('local hook input or configuration could not be read');
  }finally{clearTimeout(timer);child.stdin.end();}
  }
  expect(existsSync(f.activation)).toBe(false);expect(existsSync(join(f.configHome,'opencrawl/startup/cursor-context'))).toBe(false);
  expect(existsSync(join(f.configHome,'opencrawl/capture/queue'))).toBe(false);expect(readFileSync(f.configFile,'utf8')).toBe(json(f.config));
 }finally{f.close();}
},5_000);

test('Cursor first-tool startup confirms a search-only plugin without enabling recording or retaining tool content',async()=>{
 let requests=0;
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  requests++;expect(new URL(request.url).pathname).toBe('/api/board/bootstrap');expect(request.headers.get('authorization')).toBe('Bearer disposable-test-token');
  const input=await request.json();expect(input).toMatchObject({session:'native-session',harness:'cursor'});
  return Response.json({schemaVersion:1,data:{session:'native-session',workspace:'test-tenant',agent:'a'.repeat(64),name:null,task:null}});
 }});
 const f=fixture('cursor',`http://127.0.0.1:${server.port}`);try{
  f.write(sessionFile(f.binding.api),{auth:{clientId:'fixture',tokenEndpoint:f.binding.api+'/unused-token'},accessToken:'disposable-test-token',refreshToken:'not-used',expiresAt:Date.now()+60_000});
  const payload={hook_event_name:'postToolUse',conversation_id:'native-session',generation_id:'native-turn',tool_output:'private-output'.repeat(2000)};
  const run=async()=>{
   const child=Bun.spawn([process.execPath,cli,'session','start','--harness','cursor','--after-tool','--api',f.binding.api],{env:f.env,stdin:new Blob([JSON.stringify(payload)]),stdout:'pipe',stderr:'pipe'});
   const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
   expect(code).toBe(0);expect(err).toBe('');expect(out).not.toContain('private-output');return JSON.parse(out);
  };
  expect((await run()).additional_context).toContain('Session handle: native-session');expect(await run()).toEqual({});expect(requests).toBe(1);
  expect(JSON.parse(readFileSync(f.activation,'utf8'))).toMatchObject({client:'cursor',event:'postToolUse',installationId:f.config.installationId});
  const state=join(f.configHome,'opencrawl/startup/cursor-context');expect(readdirSync(state).map(name=>JSON.parse(readFileSync(join(state,name),'utf8')))).toEqual([{generation:'native-turn'}]);
  expect(existsSync(join(f.configHome,'opencrawl/capture/queue'))).toBe(false);expect(existsSync(join(f.configHome,'opencrawl/capture/worker.pid'))).toBe(false);expect(readFileSync(f.configFile,'utf8')).toBe(json(f.config));
 }finally{f.close();server.stop(true);}
},10_000);


test('search-only plugin carrier validates its current deployment before stdin and attaches actual native identity',async()=>{
 for(const client of clients){const f=fixture(client);try{
  const args=['search-context','--harness',client,'--api',f.binding.api];
  const input={query:'isolated native identity',currentSession:{harness:'other',sessionId:'stale'},includeToolOutputs:true};
  const native=client==='cursor'?{hook_event_name:'preToolUse',conversation_id:'selected-chat',tool_name:'MCP:opencrawl_search_v1',tool_input:input}
   :client==='antigravity'?{hookEventName:'PreToolUse',conversationId:'selected-chat',toolCall:{name:'call_mcp_tool',args:{ServerName:f.binding.pluginName+'_opencrawl',ToolName:'opencrawl_search_v1',Arguments:input}}}
   :{hook_event_name:'PreToolUse',session_id:'selected-chat',tool_name:client==='codex'?`mcp__${f.binding.pluginName}__opencrawl_search_v1`:`mcp__plugin_${f.binding.pluginName}_opencrawl__opencrawl_search_v1`,tool_input:input};
  const before=readFileSync(f.configFile,'utf8');
  const run=async(env:NodeJS.ProcessEnv,payload?:unknown)=>{
   const child=Bun.spawn([process.execPath,cli,...args],{env,stdin:payload===undefined?'pipe':new Blob([JSON.stringify(payload)]),stdout:'pipe',stderr:'pipe'});
   const timer=setTimeout(()=>child.kill(),3000);
   try{const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code).toBe(0);expect(err).toBe('');return out;}finally{clearTimeout(timer);}
  };
  const output=JSON.parse(await run(f.env,native)),actual=client==='cursor'?output.updated_input:client==='antigravity'?output.overwrite.Arguments:output.hookSpecificOutput.updatedInput;
  expect(actual).toEqual({...input,currentSession:{harness:client,sessionId:'selected-chat'}});
  // Invalid API/profile checks must terminate even with stdin held open.
  expect(await run({...f.env,OPENCRAWL_PLUGIN_API:'https://other.example'})).toBe('');
  expect(await run({...f.env,OPENCRAWL_CONFIG_HOME:join(f.home,'unselected-profile')})).toBe('');
  expect(readFileSync(f.configFile,'utf8')).toBe(before);expect(existsSync(f.activation)).toBe(false);
  for(const name of ['queue','notices','daemon','last-error.json'])expect(existsSync(join(f.configHome,'opencrawl/capture',name))).toBe(false);
 }finally{f.close();}}
},15_000);
