// Run the published installer shape and generated hooks with no Node/npm/Bun
// command available. The parent test harness serves only these built artifacts.
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,symlinkSync,existsSync,readdirSync,lstatSync,chmodSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve,dirname} from 'node:path';
import {skillFiles,skillRevision} from '../src/skills.ts';
import {tmpdir} from 'node:os';
const root=resolve(import.meta.dir,'..'),pkg=JSON.parse(readFileSync(join(root,'dist/cli/package.json'),'utf8'));
const scratch=mkdtempSync(join(tmpdir(),'opencrawl-native-smoke-'));
const systemBin=join(scratch,'system-bin');mkdirSync(systemBin);
const env={...process.env,HOME:scratch,USERPROFILE:scratch,SHELL:'/bin/bash',ZDOTDIR:scratch,OPENCRAWL_CONFIG_HOME:join(scratch,'config'),XDG_CONFIG_HOME:join(scratch,'config'),XDG_CACHE_HOME:join(scratch,'cache'),XDG_DATA_HOME:join(scratch,'data'),OPENCRAWL_INSTALL_DIR:join(scratch,'bin'),CLAUDE_CONFIG_DIR:join(scratch,'claude'),CODEX_HOME:join(scratch,'codex'),CURSOR_CONFIG_DIR:join(scratch,'.cursor'),ANTIGRAVITY_HOME:join(scratch,'.gemini'),OPENCRAWL_NO_UPDATE:'1',PATH:systemBin};
for(const key of Object.keys(env))if(key.startsWith('OPENCRAWL_PLUGIN_')||['OPENCRAWL_TOKEN','OPENCRAWL_SESSIONS_TOKEN','OPENCRAWL_AUTH','OPENCRAWL_LAUNCHER','OPENCRAWL_NODE'].includes(key))delete (env as NodeJS.ProcessEnv)[key];
if(process.platform==='win32')env.PATH=join(process.env.SystemRoot||'C:\\Windows','System32');
else for(const name of ['sh','curl','uname','sed','grep','awk','sha256sum','shasum','mktemp','rm','tar','gzip','chmod','sysctl','ldd','tty']){const file=Bun.which(name);if(file)symlinkSync(file,join(systemBin,name));}
async function run(command:string[],extra:Record<string,string|undefined>={}){const child=Bun.spawn(command,{env:{...env,...extra},stdout:'pipe',stderr:'pipe'});const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);if(code)throw new Error('Native smoke failed: '+err+out);return out.trim();}
function snapshot(paths:string[]) {
  const rows:unknown[]=[];
  const visit=(file:string)=>{if(!existsSync(file)){rows.push({file,absent:true});return;}const stat=lstatSync(file);
    if(stat.isSymbolicLink())throw new Error('Unexpected fixture symlink: '+file);
    rows.push({file,mode:stat.mode&0o777,directory:stat.isDirectory(),...(stat.isFile()?{sha256:createHash('sha256').update(readFileSync(file)).digest('hex')}:{})});
    if(stat.isDirectory())for(const name of readdirSync(file).sort())visit(join(file,name));};
  for(const file of paths)visit(file);return JSON.stringify(rows);
}
let corrupt=false,apiRequests=0;
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){const name=new URL(request.url).pathname.slice(1);if(!/^(SHA256SUMS|opencrawl-(darwin|linux|win32)-(arm64|x64)\.tgz)$/.test(name)){apiRequests++;return new Response('',{status:404});}if(corrupt&&name.endsWith('.tgz'))return new Response('corrupted download');return new Response(Bun.file(join(root,'native',name)));}});
const windows=process.platform==='win32',powershell=windows?join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'):'';
try{
  const installer=windows?[powershell,'-NoProfile','-File',join(root,'install.ps1'),pkg.version]:['/bin/sh',join(root,'install.sh'),pkg.version];
  // Both profiles use the same fixture HOME/native roots. Only OpenCrawl's
  // profile differs; a binary install must not refresh the older global tree.
  const otherProfile=join(scratch,'other-profile','opencrawl'),otherRunner=join(otherProfile,'startup',windows?'runner.cmd':'runner.sh');
  mkdirSync(dirname(otherRunner),{recursive:true});writeFileSync(otherRunner,'other profile startup runner\n');
  const roots=[env.CODEX_HOME,env.CLAUDE_CONFIG_DIR,env.CURSOR_CONFIG_DIR,join(env.ANTIGRAVITY_HOME,'config')];
  const skills=[join(scratch,'.agents','skills','opencrawl'),...roots.slice(1).map(root=>join(root,'skills','opencrawl'))];
  const clients=['codex','claude-code','cursor','antigravity'];
  mkdirSync(join(env.ANTIGRAVITY_HOME,'antigravity-cli'),{recursive:true});
  for(const [index,directory] of skills.entries()) {
    mkdirSync(join(directory,'references'),{recursive:true});
    for(const [name,text] of Object.entries({'SKILL.md':'Previous profile guidance\n','references/setup.md':'Previous profile setup guide\n','.opencrawl-skill.json':JSON.stringify({schemaVersion:2,revision:10,files:{'SKILL.md':'previous'}})})) {
      const file=join(directory,name);writeFileSync(file,text);chmodSync(file,name==='SKILL.md'?0o640:0o600);
    }
    mkdirSync(roots[index]!,{recursive:true});
    const command='"'+otherRunner+'" session start --harness '+clients[index];
    const hook={type:'command',command,statusMessage:'OpenCrawl session startup'};
    const settings=index===2?{version:1,hooks:{sessionStart:[{command}]}}:index===3?{'opencrawl-startup':{SessionStart:[hook]}}:{hooks:{SessionStart:[{hooks:[hook]}]}};
    writeFileSync(join(roots[index]!,index===1?'settings.json':'hooks.json'),JSON.stringify(settings)+'\n',{mode:0o600});
  }
  const sharedPaths=[...roots,skills[0]!,otherProfile],beforeInstall=snapshot(sharedPaths);
  const installed=await run(installer,{...(process.platform==='linux'?{SHELL:undefined}:{}),OPENCRAWL_DOWNLOAD_BASE:server.url.origin,OPENCRAWL_NO_UPDATE:undefined});
  if(snapshot(sharedPaths)!==beforeInstall)throw new Error('Binary installation changed another profile\'s native skills/hooks or file modes');
  if(existsSync(join(env.OPENCRAWL_CONFIG_HOME,'opencrawl','startup'))||existsSync(join(env.OPENCRAWL_CONFIG_HOME,'opencrawl','capture','config.json')))throw new Error('Binary installation enrolled native integrations');
  const guided=windows?[...installer,'-Setup']:['/bin/sh',join(root,'install.sh'),'--setup',pkg.version];
  const unattended=await run(guided,{OPENCRAWL_DOWNLOAD_BASE:server.url.origin});
  if(!unattended.includes('Run opencrawl setup in a terminal')||snapshot(sharedPaths)!==beforeInstall)throw new Error('Unattended guided install did not defer setup');
  if (!windows) {
    const connect = ['/bin/sh', join(root, 'install.sh'), '--connect', '--api', server.url.origin, pkg.version];
    const output = await run(connect, {OPENCRAWL_DOWNLOAD_BASE: server.url.origin});
    if (!output.includes('Run opencrawl setup in a terminal') || !output.includes(server.url.origin) || snapshot(sharedPaths) !== beforeInstall)
      throw new Error('Unattended connect must preserve existing agents and show the workspace and next command.');
  }
  const entry=join(env.OPENCRAWL_INSTALL_DIR,windows?'opencrawl.cmd':'opencrawl');
  if(!existsSync(entry))throw new Error('Installer did not create its command: '+installed);
  const shellVersion=windows
    ?await run([powershell,'-NoProfile','-Command',"$env:Path=[Environment]::GetEnvironmentVariable('Path','User')+';'+$env:Path; opencrawl --version"])
    :await run(['/bin/bash','-ic','opencrawl --version']);
  if(shellVersion.split(/\r?\n/).at(-1)!==pkg.version)throw new Error('A fresh shell could not find the installed CLI on PATH: '+shellVersion);
  const command=(args:string[])=>windows?[powershell,'-NoProfile','-Command',`& '${entry.replace(/'/g,"''")}' ${args.map(v=>"'"+v.replace(/'/g,"''")+"'").join(' ')}`]:[entry,...args];
  if(process.platform==='linux'){
    const result=JSON.parse(await run(command(['setup','--api',server.url.origin,'--json'])));
    if(result.data?.status!=='action_required'||result.data.humanTasks?.[0]?.id!=='cli-login')
      throw new Error('Fresh Linux setup must reach workspace sign-in.');
  }
  if(!windows){
    const guidedPipe=['/bin/sh','-c','/bin/cat "$1" | /bin/sh -s -- --setup "$2"','sh',join(root,'install.sh'),pkg.version];
    for(const invocation of [guidedPipe,[entry]]){
      let output='',continued=false,cancelled=false;
      const child=Bun.spawn(invocation,{env:{...env,TERM:'xterm-256color',OPENCRAWL_DOWNLOAD_BASE:server.url.origin},terminal:{
        cols:110,rows:40,data(terminal,chunk){
          output=(output+new TextDecoder().decode(chunk)).slice(-16000);
          if(!continued&&output.includes('› [ Continue ]')){
            continued=true;
            setTimeout(()=>terminal.write('\r'),100);
          }
          if(!cancelled&&output.includes('Where is your workspace?')){
            cancelled=true;
            setTimeout(()=>terminal.write('\x1b'),100);
          }
        },
      }});
      const timeout=setTimeout(()=>child.kill('SIGKILL'),45000);
      try{if(await child.exited!==0||!cancelled)throw new Error('Guided install or bare CLI did not accept keyboard input: '+output.slice(-2000));}
      finally{clearTimeout(timeout);child.terminal?.close();}
    }
  }
  if(await run(command(['--version']))!==pkg.version)throw new Error('Native install version mismatch');
  // A rejected launcher replacement must not run the finally-path legacy hook
  // upgrade. This config is synthetic and removed before explicit enrollment.
  const captureDirectory=join(env.OPENCRAWL_CONFIG_HOME,'opencrawl','capture'),captureFile=join(captureDirectory,'config.json');
  mkdirSync(captureDirectory,{recursive:true});
  writeFileSync(captureFile,JSON.stringify({schemaVersion:1,hookMode:'managed',hookOwnership:'global',api:server.url.origin,installationId:'native-install-preservation',owner:{tenantId:'fixture',userId:'fixture'},installedAt:new Date().toISOString(),harnesses:['claude-code'],historyHarnesses:[],roots:{'claude-code':env.CLAUDE_CONFIG_DIR,codex:env.CODEX_HOME},command:[entry]})+'\n',{mode:0o600});
  const conflictDirectory=join(scratch,'custom-bin'),conflictEntry=join(conflictDirectory,windows?'opencrawl.cmd':'opencrawl');
  mkdirSync(conflictDirectory);writeFileSync(conflictEntry,'custom command\n',{mode:0o700});
  const preservedPaths=[...sharedPaths,captureDirectory,conflictEntry],beforeFailure=snapshot(preservedPaths);
  let conflictRejected=false;
  try{await run(command(['--json','install']),{OPENCRAWL_INSTALL_DIR:conflictDirectory,OPENCRAWL_NO_UPDATE:undefined});}
  catch(error){if(!String(error).includes('INSTALL_CONFLICT'))throw error;conflictRejected=true;}
  if(!conflictRejected||snapshot(preservedPaths)!==beforeFailure)throw new Error('Failed binary installation changed existing capture/native configuration');
  rmSync(captureFile);
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
    {client:'claude-code',entry:settings.hooks.PreToolUse.flatMap((g:any)=>g.hooks).find((h:any)=>h.statusMessage==='OpenCrawl search context'),event:{hook_event_name:'PreToolUse',session_id:'native-claude',tool_name:'mcp__opencrawl__opencrawl_search_v1',tool_input:{query:'evidence',includeToolOutputs:true}},id:'native-claude'},
    {client:'codex',entry:codexSettings.hooks.PreToolUse.flatMap((g:any)=>g.hooks).find((h:any)=>h.statusMessage==='OpenCrawl search context'),event:{hook_event_name:'PreToolUse',session_id:'native-codex',tool_name:'mcp__opencrawl__opencrawl_search_v1',tool_input:{query:'evidence',includeToolOutputs:true}},id:'native-codex'},
    {client:'cursor',entry:cursorSettings.hooks.preToolUse[0],event:{hook_event_name:'preToolUse',conversation_id:'native-cursor',tool_name:'MCP:opencrawl_search_v1',tool_input:{query:'evidence',includeToolOutputs:true}},id:'native-cursor'},
    {client:'antigravity',entry:agySettings['opencrawl-startup'].PreToolUse[0].hooks[0],event:{hookEventName:'PreToolUse',conversationId:'native-agy',toolCall:{name:'mcp_opencrawl_opencrawl_search_v1',args:{query:'evidence',includeToolOutputs:true}}},id:'native-agy'},
    {client:'antigravity',entry:agySettings['opencrawl-startup'].PreToolUse[0].hooks[0],event:{hookEventName:'PreToolUse',conversationId:'native-agy-plugin',toolCall:{name:'mcp_opencrawl_opencrawl_opencrawl_search_v1',args:{query:'evidence',includeToolOutputs:true}}},id:'native-agy-plugin'},
    {client:'antigravity',entry:agySettings['opencrawl-startup'].PreToolUse[0].hooks[0],event:{hookEventName:'PreToolUse',conversationId:'native-agy-wrapper',toolCall:{name:'call_mcp_tool',args:{ServerName:'opencrawl_opencrawl',ToolName:'opencrawl_search_v1',Arguments:{query:'evidence',includeToolOutputs:true,includeCurrentSession:true}}}},id:'native-agy-wrapper'},
  ];
  for(const {client,entry:searchHook,event,id} of searchHooks){
    if(!searchHook||searchHook.command.includes('runner.cjs'))throw new Error('Missing native search context hook for '+client);
    const matcher=client==='antigravity'?agySettings['opencrawl-startup'].PreToolUse[0].matcher
      :client==='cursor'?cursorSettings.hooks.preToolUse[0].matcher
      :(client==='codex'?codexSettings:settings).hooks.PreToolUse.find((group:any)=>group.hooks.includes(searchHook))?.matcher;
    if(typeof matcher!=='string'||!new RegExp(matcher).test(event.toolCall?.name??event.tool_name!))throw new Error('Native search matcher missed v1 for '+client);
    if(client==='antigravity'&&new RegExp(matcher).test('mcp_opencrawl_opencrawl_search'))throw new Error('Antigravity matcher retained ambiguous legacy name');
    const powershellHook=windows&&client==='claude-code';
    const invocation=powershellHook?[powershell,'-NoProfile','-Command',searchHook.command]:windows?[join(process.env.SystemRoot||'C:\\Windows','System32','cmd.exe'),'/d','/s','/c','"'+searchHook.command+'"']:['/bin/sh','-c',searchHook.command];
    const child=Bun.spawn(invocation,{env,windowsVerbatimArguments:windows&&!powershellHook,stdin:new Blob([JSON.stringify(event)]),stdout:'pipe',stderr:'pipe'});
    const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    if(code)throw new Error('Native search hook failed for '+client+': '+err);
    const answer=JSON.parse(out),updated=answer.hookSpecificOutput?.updatedInput??answer.updated_input??answer.overwrite?.Arguments??answer.overwrite;
    if(updated?.currentSession?.harness!==client||updated.currentSession.sessionId!==id)throw new Error('Native search hook identity mismatch for '+client);
    if((client!=='antigravity'||event.toolCall?.name==='call_mcp_tool')&&(updated.query!=='evidence'||updated.includeToolOutputs!==true))throw new Error('Native search hook changed explicit arguments');
    if(event.toolCall?.name==='call_mcp_tool'&&updated.includeCurrentSession!==true)throw new Error('Native wrapper hook changed current-session override');
    if(client==='claude-code'&&answer.hookSpecificOutput.permissionDecision!==undefined)throw new Error('Claude search hook granted approval');
  }
  // An existing installation must activate new guidance/hooks through the native
  // lifecycle too. SessionStart does not schedule update checks, so leave the
  // update opt-out unset without introducing a network/update test bypass.
  const skill=join(env.CLAUDE_CONFIG_DIR,'skills','opencrawl'),manifest=join(skill,'.opencrawl-skill.json');
  const previous=JSON.parse(readFileSync(manifest,'utf8'));previous.revision=11;
  writeFileSync(manifest,JSON.stringify(previous));writeFileSync(join(skill,'SKILL.md'),'Previous revision 11 guidance.\n');
  mkdirSync(join(skill,'references'),{recursive:true});
  for(const name of ['search.md','participation.md','codex-listener.md']) writeFileSync(join(skill,'references',name),'old guidance');
  const oldSettings=JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR,'settings.json'),'utf8'));
  for(const group of oldSettings.hooks.PreToolUse)if(group.hooks.some((entry:any)=>entry.statusMessage==='OpenCrawl search context'))
    group.matcher='^(?:mcp__opencrawl__opencrawl_search|mcp__plugin_opencrawl_opencrawl__opencrawl_search|mcp__codex_apps__opencrawl_opencrawl_search)$';
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
  const restoredMatcher=refreshed.hooks.PreToolUse.find((group:any)=>group.hooks.includes(restored))?.matcher;
  if(JSON.parse(readFileSync(manifest,'utf8')).revision!==skillRevision||readFileSync(join(skill,'SKILL.md'),'utf8')!==skillFiles()['SKILL.md']||existsSync(join(skill,'references'))||
    restored?.command!==searchHooks[0]!.entry.command||typeof restoredMatcher!=='string'||!new RegExp(restoredMatcher).test('mcp__opencrawl__opencrawl_search_v1')||
    JSON.parse(activationOut).hookSpecificOutput?.reloadSkills!==true)
    throw new Error('Native SessionStart did not activate current guidance and search hooks');
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
  console.log('Native installer preserves other-profile skills/hooks and failed-install capture state; explicit skill activation and capture setup run without Node/npm/Bun on PATH.');
}finally{
  server.stop(true);
  if(windows)await run([powershell,'-NoProfile','-Command',`$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true)
    if ($key -and $key.GetValueNames() -contains 'Path') {
      $raw=$key.GetValue('Path','','DoNotExpandEnvironmentNames')
      $rest=($raw -split ';' | Where-Object { $_ -ne $env:OPENCRAWL_INSTALL_DIR }) -join ';'
      if ($rest -ne $raw) { $key.SetValue('Path',$rest,$key.GetValueKind('Path')) }
      $key.Dispose()
    }`]);
  rmSync(scratch,{recursive:true,force:true});
}
