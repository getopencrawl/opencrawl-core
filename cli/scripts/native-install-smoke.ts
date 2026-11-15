// Run the published installer shape and generated hooks with no Node/npm/Bun
// command available. The parent test harness serves only these built artifacts.
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,symlinkSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
const root=resolve(import.meta.dir,'..'),pkg=JSON.parse(readFileSync(join(root,'dist/cli/package.json'),'utf8'));
const scratch=mkdtempSync(join(tmpdir(),'opencrawl-native-smoke-'));
const systemBin=join(scratch,'system-bin');mkdirSync(systemBin);
const env={...process.env,HOME:scratch,USERPROFILE:scratch,OPENCRAWL_CONFIG_HOME:join(scratch,'config'),XDG_CONFIG_HOME:join(scratch,'config'),XDG_CACHE_HOME:join(scratch,'cache'),XDG_DATA_HOME:join(scratch,'data'),OPENCRAWL_INSTALL_DIR:join(scratch,'bin'),CLAUDE_CONFIG_DIR:join(scratch,'claude'),CODEX_HOME:join(scratch,'codex'),CURSOR_CONFIG_DIR:join(scratch,'.cursor'),ANTIGRAVITY_HOME:join(scratch,'.gemini'),OPENCRAWL_NO_UPDATE:'1',PATH:systemBin};
if(process.platform==='win32')env.PATH=join(process.env.SystemRoot||'C:\\Windows','System32');
else for(const name of ['sh','curl','uname','sed','grep','awk','sha256sum','shasum','mktemp','rm','tar','gzip','chmod','sysctl','ldd']){const file=Bun.which(name);if(file)symlinkSync(file,join(systemBin,name));}
async function run(command:string[],extra:Record<string,string>={}){const child=Bun.spawn(command,{env:{...env,...extra},stdout:'pipe',stderr:'pipe'});const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);if(code)throw new Error('Native smoke failed: '+err+out);return out.trim();}
let corrupt=false,apiRequests=0;
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){const name=new URL(request.url).pathname.slice(1);if(!/^(SHA256SUMS|opencrawl-(darwin|linux|win32)-(arm64|x64)\.tgz)$/.test(name)){apiRequests++;return new Response('',{status:404});}if(corrupt&&name.endsWith('.tgz'))return new Response('corrupted download');return new Response(Bun.file(join(root,'native',name)));}});
try{
  const windows=process.platform==='win32',powershell=windows?join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'):'';
  const installer=windows?[powershell,'-NoProfile','-File',join(root,'install.ps1'),pkg.version]:['/bin/sh',join(root,'install.sh'),pkg.version];
  const installed=await run(installer,{OPENCRAWL_DOWNLOAD_BASE:server.url.origin});
  const entry=join(env.OPENCRAWL_INSTALL_DIR,windows?'opencrawl.cmd':'opencrawl');
  if(!existsSync(entry))throw new Error('Installer did not create its command: '+installed);
  const command=(args:string[])=>windows?[powershell,'-NoProfile','-Command',`& '${entry.replace(/'/g,"''")}' ${args.map(v=>"'"+v.replace(/'/g,"''")+"'").join(' ')}`]:[entry,...args];
  if(await run(command(['--version']))!==pkg.version)throw new Error('Native install version mismatch');
  await run(command(['skills','install','--client','claude-code','--client','codex','--client','cursor','--client','antigravity','--json']));
  const settings=JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR,'settings.json'),'utf8'));
  const startup=settings.hooks.SessionStart.flatMap((g:any)=>g.hooks).find((h:any)=>h.statusMessage==='OpenCrawl session startup');
  if(!startup||startup.command.includes('node')||startup.command.includes('runner.cjs'))throw new Error('Startup hook still needs Node');
  // A missing credential gives a bounded unavailable receipt, not an execution failure.
  if(windows&&startup.shell!=='powershell')throw new Error('Claude Windows startup hook must select PowerShell');
  const hook=windows?[powershell,'-NoProfile','-Command',startup.command]:['/bin/sh','-c',startup.command];
  const child=Bun.spawn(hook,{env,stdin:new Blob([JSON.stringify({hook_event_name:'SessionStart',session_id:'native-smoke'})]),stdout:'pipe',stderr:'pipe'});
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  if(code||!out.includes('OpenCrawl'))throw new Error('Native startup hook failed: '+err+out);
  const codexSettings=JSON.parse(readFileSync(join(env.CODEX_HOME,'hooks.json'),'utf8'));
  const codexStartup=codexSettings.hooks.SessionStart.flatMap((g:any)=>g.hooks).find((h:any)=>h.statusMessage==='OpenCrawl session startup');
  const codexHook=windows?[join(process.env.SystemRoot||'C:\\Windows','System32','cmd.exe'),'/d','/s','/c','"'+codexStartup.command+'"']:['/bin/sh','-c',codexStartup.command];
  const codex=Bun.spawn(codexHook,{env,windowsVerbatimArguments:windows,stdin:new Blob([JSON.stringify({hook_event_name:'SessionStart',session_id:'native-smoke-codex'})]),stdout:'pipe',stderr:'pipe'});
  const [codexOut,codexErr,codexCode]=await Promise.all([new Response(codex.stdout).text(),new Response(codex.stderr).text(),codex.exited]);
  if(codexCode||!codexOut.includes('OpenCrawl'))throw new Error('Native Codex startup hook failed: '+codexErr+codexOut);
  const cursorSettings=JSON.parse(readFileSync(join(scratch,'.cursor','hooks.json'),'utf8'));
  const agySettings=JSON.parse(readFileSync(join(scratch,'.gemini','config','hooks.json'),'utf8'));
  const searchHooks=[
    {client:'claude-code',entry:settings.hooks.PreToolUse.flatMap((g:any)=>g.hooks).find((h:any)=>h.statusMessage==='OpenCrawl search context'),event:{hook_event_name:'PreToolUse',session_id:'native-claude',tool_name:'mcp__opencrawl__opencrawl_search',tool_input:{query:'evidence',includeToolOutputs:true}},id:'native-claude'},
    {client:'codex',entry:codexSettings.hooks.PreToolUse.flatMap((g:any)=>g.hooks).find((h:any)=>h.statusMessage==='OpenCrawl search context'),event:{hook_event_name:'PreToolUse',session_id:'native-codex',tool_name:'mcp__opencrawl__opencrawl_search',tool_input:{query:'evidence',includeToolOutputs:true}},id:'native-codex'},
    {client:'cursor',entry:cursorSettings.hooks.preToolUse[0],event:{hook_event_name:'preToolUse',conversation_id:'native-cursor',tool_name:'MCP:opencrawl_search',tool_input:{query:'evidence',includeToolOutputs:true}},id:'native-cursor'},
    {client:'antigravity',entry:agySettings['opencrawl-startup'].PreToolUse[0].hooks[0],event:{hookEventName:'PreToolUse',conversationId:'native-agy',toolCall:{name:'mcp_opencrawl_opencrawl_search',args:{query:'evidence',includeToolOutputs:true}}},id:'native-agy'},
  ];
  for(const {client,entry:searchHook,event,id} of searchHooks){
    if(!searchHook||searchHook.command.includes('runner.cjs'))throw new Error('Missing native search context hook for '+client);
    const powershellHook=windows&&client==='claude-code';
    const invocation=powershellHook?[powershell,'-NoProfile','-Command',searchHook.command]:windows?[join(process.env.SystemRoot||'C:\\Windows','System32','cmd.exe'),'/d','/s','/c','"'+searchHook.command+'"']:['/bin/sh','-c',searchHook.command];
    const child=Bun.spawn(invocation,{env,windowsVerbatimArguments:windows&&!powershellHook,stdin:new Blob([JSON.stringify(event)]),stdout:'pipe',stderr:'pipe'});
    const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    if(code)throw new Error('Native search hook failed for '+client+': '+err);
    const answer=JSON.parse(out),updated=answer.hookSpecificOutput?.updatedInput??answer.updated_input??answer.overwrite;
    if(updated?.currentSession?.harness!==client||updated.currentSession.sessionId!==id)throw new Error('Native search hook identity mismatch for '+client);
    if(client!=='antigravity'&&(updated.query!=='evidence'||updated.includeToolOutputs!==true))throw new Error('Native search hook changed explicit arguments');
    if(client==='claude-code'&&answer.hookSpecificOutput.permissionDecision!==undefined)throw new Error('Claude search hook granted approval');
  }
  // An existing installation must activate new guidance/hooks through the native
  // lifecycle too. SessionStart does not schedule update checks, so leave the
  // update opt-out unset without introducing a network/update test bypass.
  const skill=join(env.CLAUDE_CONFIG_DIR,'skills','opencrawl'),manifest=join(skill,'.opencrawl-skill.json');
  const previous=JSON.parse(readFileSync(manifest,'utf8'));previous.revision=8;
  writeFileSync(manifest,JSON.stringify(previous));writeFileSync(join(skill,'SKILL.md'),'Previous revision 8 guidance.\n');
  const oldSettings=JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR,'settings.json'),'utf8'));
  oldSettings.hooks.PreToolUse=oldSettings.hooks.PreToolUse.map((group:any)=>({...group,
    hooks:group.hooks.filter((entry:any)=>entry.statusMessage!=='OpenCrawl search context')})).filter((group:any)=>group.hooks.length);
  writeFileSync(join(env.CLAUDE_CONFIG_DIR,'settings.json'),JSON.stringify(oldSettings));
  rmSync(join(env.XDG_CACHE_HOME,'opencrawl','skills-update.json'),{force:true});
  rmSync(join(env.OPENCRAWL_CONFIG_HOME,'opencrawl','skills-update.json'),{force:true});
  const activationEnv:NodeJS.ProcessEnv={...env,OPENCRAWL_API_URL:server.url.origin};
  for(const name of ['OPENCRAWL_NO_UPDATE','OPENCRAWL_TOKEN','OPENCRAWL_SESSIONS_TOKEN','OPENCRAWL_AUTH','OPENCRAWL_LAUNCHER','OPENCRAWL_NODE'])delete activationEnv[name];
  const requestsBeforeActivation=apiRequests;
  const activation=Bun.spawn(hook,{env:activationEnv,timeout:15_000,killSignal:'SIGKILL',
    stdin:new Blob([JSON.stringify({hook_event_name:'SessionStart',session_id:'native-activation',source:'startup'})]),stdout:'pipe',stderr:'pipe'});
  const [activationOut,activationErr,activationCode]=await Promise.all([new Response(activation.stdout).text(),new Response(activation.stderr).text(),activation.exited]);
  if(activationCode||apiRequests!==requestsBeforeActivation)throw new Error('Native lifecycle activation failed or requested authentication/network: '+activationErr+activationOut);
  const refreshed=JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR,'settings.json'),'utf8'));
  const restored=refreshed.hooks.PreToolUse.flatMap((group:any)=>group.hooks).find((entry:any)=>entry.statusMessage==='OpenCrawl search context');
  if(JSON.parse(readFileSync(manifest,'utf8')).revision!==10||!readFileSync(join(skill,'SKILL.md'),'utf8').includes('Native hooks target only opencrawl_search')||
    restored?.command!==searchHooks[0]!.entry.command||JSON.parse(activationOut).hookSpecificOutput?.reloadSkills!==true)
    throw new Error('Native SessionStart did not activate revision 10 guidance and search hooks');
  await run(command(['collect','install','--yes','--defer-auth','--backfill','skip','--harness','claude-code','--json']));
  const capture=JSON.parse(readFileSync(join(env.OPENCRAWL_CONFIG_HOME,'opencrawl/capture/config.json'),'utf8'));
  if(capture.command.length!==1||capture.command[0]!==entry)throw new Error('Capture did not use the durable native command');
  const configured=JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR,'settings.json'),'utf8'));
  const stop=configured.hooks.Stop.flatMap((g:any)=>g.hooks).find((h:any)=>h.statusMessage==='OpenCrawl session capture');
  if(!stop||stop.command.includes('node')||stop.command.includes('runner.cjs'))throw new Error('Capture hook still needs Node');
  if(windows&&stop.shell!=='powershell')throw new Error('Claude Windows capture hook must select PowerShell');
  const captureHook=windows?[powershell,'-NoProfile','-Command',stop.command]:['/bin/sh','-c',stop.command];
  const collector=Bun.spawn(captureHook,{env,stdin:new Blob([JSON.stringify({hook_event_name:'Stop',session_id:'native-smoke'})]),stdout:'pipe',stderr:'pipe'});
  const [captureOut,captureErr,captureCode]=await Promise.all([new Response(collector.stdout).text(),new Response(collector.stderr).text(),collector.exited]);
  if(captureCode)throw new Error('Native capture hook failed: '+captureErr+captureOut);
  corrupt=true;
  let rejected=false;try{await run(installer,{OPENCRAWL_DOWNLOAD_BASE:server.url.origin});}catch(error){if(!String(error).includes('checksum mismatch'))throw error;rejected=true;}
  if(!rejected||await run(command(['--version']))!==pkg.version)throw new Error('Corrupted download was accepted or damaged the active version');
  console.log('Native installer, versioned launcher, revision 8 skill/hook activation and capture setup run without Node/npm/Bun on PATH.');
}finally{server.stop(true);rmSync(scratch,{recursive:true,force:true});}
