import {readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync, unlinkSync, readdirSync, renameSync, statSync, chmodSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {removeLegacyService} from './legacy-service.ts';
import {randomUUID} from 'node:crypto';
import {HARNESSES, HARNESS_NAMES, readsTranscript, type Harness} from './parse.ts';
import {GROK_BOT_HOOK_EVENTS} from './grok-bot.ts';
import {CURSOR_HOOK_EVENTS} from './cursor.ts';
import {MUSE_HOOK_EVENTS} from './muse.ts';
import {openCodePlugin} from './opencode.ts';
import {isPayloadHarness, type PayloadHarness} from './payload.ts';
import {agentRoots, detectAgents, prepareOpenCode} from './agents.ts';
import {atomicFile, atomicJson, configDir, withSessionLock} from '../session.ts';
import {CliError} from '../oauth.ts';
import {retryWindowsSharing} from '../filesystem.ts';
import {environmentToken} from '../environment-token.ts';
import {captureDir, readCaptureConfig, commandForSelf, request, harnessRoot, codexHooksAwaitingReview, serverHarnesses, HOOK_MODE, type CaptureConfig} from './runtime.ts';
import {captureNoticeFor} from './policy.ts';
import {defaultClaudeDesktopSessionsRoot} from './desktop-history.ts';
const marker='OpenCrawl session capture';
const quote=(s:string)=>process.platform==='win32'?'"'+s.replace(/"/g,'""')+'"':"'"+s.replace(/'/g,"'\\''")+"'";
function readJson(file:string){return existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};}
/** Rewrite another program's JSON config the way people keep it: their
 * indentation (two spaces when new or unknown), same permissions, and the
 * directory left as it is. */
function writeHarnessJson(file:string,value:unknown) {
  const before=existsSync(file)?readFileSync(file,'utf8'):'';
  const text=before.trim();
  const indent=/\n([ \t]+)\S/.exec(text)?.[1]??(text&&!text.includes('\n')?'':'  ');
  mkdirSync(dirname(file),{recursive:true});
  replaceFile(file,(indent?JSON.stringify(value,null,indent):JSON.stringify(value))+'\n');
}
function backup(file:string){if(existsSync(file)){const p=join(captureDir(),'backups',randomUUID()+'.json');copyFileSync(file,p);}}
type HookEntry={command:string,async?:boolean,timeout:number};
function modifyHooks(file:string,events:string[],entry:((event:string)=>HookEntry)|null) {
  const config=readJson(file);
  if(config.hooks && (typeof config.hooks!=='object'||Array.isArray(config.hooks)))throw new CliError('CAPTURE_INVALID_CONFIG','Existing harness hooks config is invalid');
  const hooks=config.hooks??{};
  for(const [event,groups] of Object.entries(hooks)) {
    if(!Array.isArray(groups))throw new CliError('CAPTURE_INVALID_CONFIG','Existing hook groups are invalid');
    hooks[event]=groups.flatMap((group:any)=>{
      if(!Array.isArray(group.hooks))return [group];
      const remaining=group.hooks.filter((h:any)=>h.statusMessage!==marker);
      return remaining.length?[{...group,hooks:remaining}]:[];
    });
    if(!hooks[event].length)delete hooks[event];
  }
  if(entry)for(const event of events)(hooks[event]??=[]).push({hooks:[{type:'command',...entry(event),statusMessage:marker}]});
  backup(file);writeHarnessJson(file,{...config,hooks});
}
/** The one file capture writes for each agent. OpenCode's is a plugin of its
 * own; the others are the agent's hook configuration, shared with the person. */
const hookFile=(config:CaptureConfig,harness:Harness)=>join(harnessRoot(config,harness),
  harness==='claude-code'||harness==='muse'?'settings.json':harness==='opencode'?join('plugins','opencrawl.js'):'hooks.json');
// Cursor-format entries have no label field; the command itself marks ownership.
const ownedBy=(harness:Harness)=>{
  const pattern=new RegExp(String.raw`[\\/]capture[\\/]runner\.cjs\b.* collect hook .*--harness ${harness}\b`);
  return (entry:any)=>typeof entry?.command==='string'&&pattern.test(entry.command);
};
const grokBotOwned=ownedBy('grok-bot');
/** Grok Bot loads ~/.cursor/hooks.json: {version:1,hooks:{event:[{command,timeout}]}}.
 * Cursor itself reads the same file, so the two are never enrolled together. */
function modifyGrokBotHooks(file:string,command:string|null,owned=grokBotOwned,events:readonly string[]=GROK_BOT_HOOK_EVENTS) {
  if(!command&&!existsSync(file))return;
  const config=readJson(file);
  if(!config||typeof config!=='object'||Array.isArray(config)||config.version!==undefined&&config.version!==1||
    config.hooks!==undefined&&(!config.hooks||typeof config.hooks!=='object'||Array.isArray(config.hooks)))throw new CliError('CAPTURE_INVALID_CONFIG','Existing Grok Bot hooks file is not a version 1 Cursor hooks file');
  const hooks=config.hooks??{};
  for(const [event,entries] of Object.entries(hooks)) {
    if(!Array.isArray(entries))throw new CliError('CAPTURE_INVALID_CONFIG','Existing hook entries are invalid');
    hooks[event]=entries.filter(entry=>!owned(entry));
    if(!hooks[event].length)delete hooks[event];
  }
  // Every hook is passive, so a failure or the timeout never blocks the Bot. The
  // hook ends itself at five seconds; the timeout leaves room for a sign-in
  // renewal that must not be abandoned.
  if(command)for(const event of events)(hooks[event]??=[]).push({command,timeout:30});
  backup(file);replaceFile(file,JSON.stringify({...config,version:1,hooks},null,2)+'\n');
}
/** Cursor's own entries in the same file format. */
const modifyCursorHooks=(file:string,command:string|null)=>modifyGrokBotHooks(file,command,ownedBy('cursor'),CURSOR_HOOK_EVENTS);
/** Muse Code keeps a person's hooks in its settings file:
 * {schema_version:1,hooks:{Event:[{hooks:[{type:'command',command,timeout}]}]}}.
 * It rejects the whole file, and with it every command, when the file is not a
 * schema_version 1 document, so one that is not is left exactly as found. It
 * skips a handler that carries a field it does not know, so only the fields
 * it documents are written. */
function museSettings(file:string) {
  const config=existsSync(file)&&readFileSync(file,'utf8').trim()?readJson(file):null;
  if(config!==null&&(!config||typeof config!=='object'||Array.isArray(config)||config.schema_version!==1||
    config.hooks!==undefined&&(!config.hooks||typeof config.hooks!=='object'||Array.isArray(config.hooks))))throw new CliError('CAPTURE_INVALID_CONFIG','Existing Muse Code settings are not a schema_version 1 settings file');
  return config;
}
function modifyMuseHooks(file:string,command:string|null) {
  const config=museSettings(file);
  if(!command&&!config)return;
  const owned=ownedBy('muse'),hooks:Record<string,any>={...config?.hooks};
  for(const [event,groups] of Object.entries(hooks)) {
    // Only handler groups are ours to read; anything else under hooks stays.
    if(!Array.isArray(groups))continue;
    hooks[event]=groups.flatMap((group:any)=>{
      if(!Array.isArray(group?.hooks))return [group];
      const remaining=group.hooks.filter((handler:any)=>!owned(handler));
      return remaining.length?[{...group,hooks:remaining}]:[];
    });
    if(!hooks[event].length)delete hooks[event];
  }
  // Muse Code waits for a hook as long as it runs. The hook ends itself at five
  // seconds; the timeout, in seconds, is the limit if it ever did not, and
  // leaves room for a sign-in renewal that must not be abandoned.
  if(command)for(const event of MUSE_HOOK_EVENTS)(hooks[event]??=[]).push({hooks:[{type:'command',command,timeout:30}]});
  backup(file);
  const {hooks:_,...rest}=config??{schema_version:1};
  writeHarnessJson(file,Object.keys(hooks).length?{...rest,hooks}:rest);
}
/** OpenCode loads every plugin file in its plugins directory. This one is the
 * collector's own, so it is written whole and removed whole. */
function writeOpenCodePlugin(file:string,source:string|null) {
  if(source===null){try{unlinkSync(file);}catch(error:any){if(error?.code!=='ENOENT')throw error;}return;}
  if(existsSync(file)&&readFileSync(file,'utf8')===source)return;
  mkdirSync(dirname(file),{recursive:true});
  backup(file);replaceFile(file,source);
}
/** For a file in another program's directory: new contents, same permissions,
 * and the directory left as it is. */
function replaceFile(file:string,bytes:string|Buffer) {
  const temp=file+'.opencrawl-tmp',mode=existsSync(file)?statSync(file).mode&0o777:0o600;
  writeFileSync(temp,bytes,{mode:0o600});
  chmodSync(temp,mode); // the creation mode is narrowed by the umask
  retryWindowsSharing(()=>renameSync(temp,file));
}
function enableCodex(root:string) {
  const file=join(root,'config.toml');
  const before=(existsSync(file)?readFileSync(file,'utf8'):'').replace(/([^\n])$/, '$1\n');
  let after=before;
  const section=/^\[features\][^\n]*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m;
  if(section.test(before))after=before.replace(section,(whole,body)=>{
    if(/^hooks\s*=/m.test(body))return whole.replace(/^hooks\s*=.*$/m,'hooks = true');
    return whole.replace(/\n/,'\nhooks = true\n');
  });
  else if(/^features\.hooks\s*=/m.test(before))after=before.replace(/^features\.hooks\s*=.*$/m,'features.hooks = true');
  else after='features.hooks = true\n'+before;
  // Validate before touching the user's file.
  Bun.TOML.parse(after);
  backup(file);
  // Atomic replacement without changing unrelated TOML settings or permissions.
  replaceFile(file,after);
}
function configureHooks(config:CaptureConfig,harnesses:Harness[]) {
  const runner=join(captureDir(),'runner.cjs');
  const node=process.env.OPENCRAWL_NODE || Bun.which('node');
  if(!node)throw new CliError('NODE_REQUIRED','Install Node 22.15 or newer to run capture hooks');
  if(process.platform!=='win32') {
    const check=spawnSync(node,['-e',"process.exit(typeof process.execve==='function'?0:1)"],{stdio:'ignore',timeout:5000});
    if(check.status!==0)throw new CliError('NODE_REQUIRED','Install Node 22.15 or newer to run capture hooks');
  }
  // Resolve the selected npm binary without running its launcher. On Unix exec
  // preserves the PID owned by the harness, including cancellation and reaping.
  atomicFile(runner,`const command=${JSON.stringify(config.command)};
const env={...process.env,OPENCRAWL_CONFIG_HOME:${JSON.stringify(dirname(configDir()))}};
let file=command[0],args=command.slice(1);
if(args[0]&&require('node:path').basename(args[0])==='opencrawl.cjs'){env.OPENCRAWL_LAUNCHER=args[0];env.OPENCRAWL_NODE=file;const cli=require(args[0]);file=cli.binary(cli.activeRoot());args=args.slice(1);}
args.push(...process.argv.slice(2));
if(process.platform!=='win32')process.execve(file,[file,...args],env);
else {const r=require('node:child_process').spawnSync(file,args,{stdio:'inherit',windowsHide:true,env});process.exitCode=r.status??1;}
`);
  const hook=(...args:string[])=>(process.platform==='win32'?'':'exec ')+[quote(node),quote(runner),'collect','hook',...args].join(' ');
  const managed=(harness:Harness)=>():HookEntry=>({command:hook('--managed','--harness',harness),async:true,timeout:120});
  if(harnesses.includes('claude-code'))modifyHooks(join(config.roots['claude-code'],'settings.json'),
    ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','PostToolUseFailure','Stop','SubagentStop','SessionEnd'],managed('claude-code'));
  // Codex runs SessionEnd synchronously within 3s. Record its notice locally;
  // the next managed hook uploads it instead of delaying exit or being killed.
  if(harnesses.includes('codex'))modifyHooks(join(config.roots.codex,'hooks.json'),
    ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop','SubagentStop','SessionEnd'],
    event=>event==='SessionEnd'?{command:hook('--harness','codex'),timeout:3}:managed('codex')());
  // Cursor does not document a shell for hook commands. Quote only when needed
  // so the command also survives being split on spaces.
  const plain=(s:string)=>/^[\w@%+=:,./-]+$/.test(s)?s:quote(s);
  const waited=(harness:Harness)=>[plain(node),plain(runner),'collect','hook','--harness',harness].join(' ');
  // Grok Bot and Cursor read one hooks file, and only one of them is enrolled:
  // whichever it is also clears the other's entries from it.
  if(harnesses.includes('grok-bot')){modifyCursorHooks(hookFile(config,'grok-bot'),null);modifyGrokBotHooks(hookFile(config,'grok-bot'),waited('grok-bot'));}
  if(harnesses.includes('cursor')){modifyGrokBotHooks(hookFile(config,'cursor'),null);modifyCursorHooks(hookFile(config,'cursor'),waited('cursor'));}
  // Muse Code runs a hook's command through the shell, with most of the
  // environment cleared: both paths are absolute and the runner sets its own.
  if(harnesses.includes('muse'))modifyMuseHooks(hookFile(config,'muse'),hook('--harness','muse'));
  if(harnesses.includes('opencode'))writeOpenCodePlugin(hookFile(config,'opencode'),openCodePlugin([node,runner,'collect','hook','--harness','opencode'],join(captureDir(),'inbox','opencode')));
}
/** Upgrade existing installations without authentication or changing their queue. */
export async function upgradeCaptureHooks() {
  const config=readCaptureConfig();if(!config||config.disabled||config.hookMode===HOOK_MODE)return;
  try {await withSessionLock('capture:configuration',async()=>{
    const current=readCaptureConfig();if(!current||current.disabled||current.hookMode===HOOK_MODE)return;
    const harnesses=current.harnesses??['claude-code','codex'];
    for(const harness of harnesses)mkdirSync(harnessRoot(current,harness),{recursive:true,mode:0o700});
    mkdirSync(join(captureDir(),'backups'),{recursive:true,mode:0o700});
    const files=[join(captureDir(),'config.json'),join(captureDir(),'runner.cjs'),
      ...harnesses.map(h=>hookFile(current,h))];
    const originals=new Map(files.map(file=>[file,existsSync(file)?readFileSync(file):null]));
    try {
      configureHooks(current,harnesses);
      atomicJson(join(captureDir(),'config.json'),{...current,hookMode:HOOK_MODE});
    } catch(error) {
      for(const [file,bytes] of originals) {
        if(bytes===null){try{unlinkSync(file);}catch{}}
        // Harness configs keep their permissions; only our own files use atomicFile.
        else if(harnesses.some(h=>file===hookFile(current,h)))replaceFile(file,bytes);
        else atomicFile(file,bytes);
      }
      throw error;
    }
  },0);}catch(error:any){if(error?.code!=='SESSION_BUSY')throw error;}
}
const names=(harnesses:readonly Harness[])=>harnesses.map(harness=>HARNESS_NAMES[harness]).join(', ');
/** Grok Bot and Cursor both read ~/.cursor/hooks.json. Entries for both would
 * record every conversation twice, so the file has one owner at a time. */
const SHARED:Partial<Record<Harness,Harness>>={cursor:'grok-bot','grok-bot':'cursor'};
export async function installCapture(api:string,{background=false,deferAuth=false,home=homedir(),command=commandForSelf(),harnesses:chosen,detect=detectAgents,prepare=prepareOpenCode}:
  {background?:boolean,deferAuth?:boolean,home?:string,command?:string[],harnesses?:Harness[],detect?:typeof detectAgents,prepare?:typeof prepareOpenCode}={}) {
  const receiverToken=environmentToken('OPENCRAWL_SESSIONS_TOKEN',api);
  if(chosen&&(!chosen.length||chosen.some(h=>!HARNESSES.includes(h))))throw new CliError('INVALID_USAGE','Use --harness '+HARNESSES.join(', ')+'; separate several with commas.',64);
  if(chosen?.some(h=>SHARED[h]&&chosen.includes(SHARED[h]!)))throw new CliError('INVALID_USAGE','Grok Bot and Cursor share one hooks file. Choose --harness grok-bot on a Bot\'s cloud computer, or --harness cursor anywhere else.',64);
  // Image preparation cannot access runtime secrets. First worker authenticates
  // before parsing/spooling; hooks only persist notices even on first launch.
  const {principal,harnesses:answer}=deferAuth?{principal:{tenantId:'pending',userId:'pending'},harnesses:undefined}:await request(api,'/api/sessions/identity');
  if(!principal?.tenantId || !principal?.userId)throw new CliError('CAPTURE_IDENTITY_MISSING','Deployment does not supply capture identity');
  // A deployment stores sessions only for the agents it knows. Enrolling
  // another here would queue sessions it rejects, so an agent it does not list
  // is not enrolled. A prepared image has not asked yet: its batches wait.
  const accepted=deferAuth?null:serverHarnesses(answer);
  const refused=(list:Harness[])=>accepted?list.filter(h=>!accepted.includes(h)):[];
  if(chosen&&refused(chosen).length)throw new CliError('CAPTURE_HARNESS_UNSUPPORTED',`This deployment does not store ${names(refused(chosen))} sessions yet. Update the OpenCrawl server, then run collect install again.`);
  return withSessionLock('capture:configuration',async()=>{
  const previous=readCaptureConfig();
  const skipped:{harness:Harness,reason:string}[]=[];
  // A plain install records Claude Code and Codex, as it always has, and every
  // other supported agent found on this machine. It leaves Grok Bot's hooks
  // file to Grok Bot, which is only ever enrolled by name.
  const found=chosen||process.env.CLAUDE_CODE_REMOTE==='true'?[]:detect({home}).filter(harness=>{
    const owner=SHARED[harness];
    if(owner&&previous?.harnesses?.includes(owner)){skipped.push({harness,reason:`${HARNESS_NAMES[owner]} capture owns the hooks file ${HARNESS_NAMES[harness]} reads. Run collect install --harness ${harness} to record ${HARNESS_NAMES[harness]} instead.`});return false;}
    if(refused([harness]).length){skipped.push({harness,reason:`This deployment does not store ${HARNESS_NAMES[harness]} sessions yet. Update the OpenCrawl server, then run collect install again.`});return false;}
    return true;
  });
  const harnesses:Harness[]=chosen??[...(process.env.CLAUDE_CODE_REMOTE==='true'?['claude-code']:['claude-code','codex']) as Harness[],...found];
  // Re-running cloud preparation has no authenticated replacement identity.
  // Preserve a bound destination, including ownership of unprocessed notices.
  const preserveOwner=deferAuth && previous?.api===api && !previous.authPending;
  const authPending=deferAuth && !preserveOwner;
  const changed=previous && (previous.api!==api || !deferAuth && (previous.owner.userId!==principal.userId || previous.owner.tenantId!==principal.tenantId));
  if(changed && ['queue','notices'].some(dir=>existsSync(join(captureDir(),dir)) && readdirSync(join(captureDir(),dir)).length))throw new CliError('CAPTURE_PENDING_DESTINATION','Pending capture belongs to the previous destination. Upload it there or uninstall and explicitly purge local pending data before changing destination.');
  for(const dir of ['', 'backups','queue','state','blobs'])mkdirSync(join(captureDir(),dir),{recursive:true,mode:0o700});
  // Choosing one owner of the shared hooks file by name retires the other.
  const replaced=(previous?.harnesses??[]).filter(h=>harnesses.some(now=>SHARED[now]===h));
  const agents=agentRoots(home);
  const config:CaptureConfig={schemaVersion:1,exclusions:previous?.exclusions,hookMode:HOOK_MODE,api,installationId:previous?.installationId??(deferAuth?'pending':randomUUID()),owner:preserveOwner?previous.owner:principal,...(authPending?{authPending:true}:{}),
    harnesses:[...new Set([...(previous?.harnesses??[]).filter(h=>!replaced.includes(h)),...harnesses])],installedAt:previous?.installedAt??new Date().toISOString(),roots:{
      'claude-code':!harnesses.includes('claude-code')&&previous?.roots['claude-code']||process.env.CLAUDE_CONFIG_DIR||join(home,'.claude'),
      codex:!harnesses.includes('codex')&&previous?.roots.codex||process.env.CODEX_HOME||join(home,'.codex'),
      'grok-bot':!harnesses.includes('grok-bot')&&previous?.roots['grok-bot']||join(home,'.cursor'),
      ...Object.fromEntries((Object.keys(agents) as PayloadHarness[]).map(h=>[h,!harnesses.includes(h)&&previous?.roots[h]||agents[h]]))},
    claudeDesktopSessionsRoot:previous?.claudeDesktopSessionsRoot??defaultClaudeDesktopSessionsRoot(home),command};
  const enrolled=config.harnesses!;
  // Checked before the directories below are created.
  const transcripts=harnesses.filter(readsTranscript);
  const absent=transcripts.length>0&&!transcripts.some(harness=>existsSync(harnessRoot(config,harness))||Bun.which(harness==='codex'?'codex':'claude',{PATH:process.env.PATH}));
  for(const harness of enrolled)mkdirSync(harnessRoot(config,harness),{recursive:true,mode:0o700});
  // Validate every existing config before changing any of them.
  if(enrolled.includes('claude-code'))readJson(join(config.roots['claude-code'],'settings.json'));
  if(enrolled.includes('codex'))readJson(join(config.roots.codex,'hooks.json'));
  for(const harness of ['grok-bot','cursor'] as const)if(enrolled.includes(harness))readJson(hookFile(config,harness));
  if(enrolled.includes('muse'))museSettings(hookFile(config,'muse'));
  const toml=join(config.roots.codex,'config.toml');if(harnesses.includes('codex')&&existsSync(toml))Bun.TOML.parse(readFileSync(toml,'utf8'));
  const affected=[...new Set([join(captureDir(),'config.json'),join(captureDir(),'receiver-token.json'),join(captureDir(),'runner.cjs'),
    join(config.roots['claude-code'],'settings.json'),join(config.roots.codex,'hooks.json'),toml,
    ...enrolled.filter(h=>!readsTranscript(h)).map(h=>hookFile(config,h))])];
  const originals=new Map(affected.map(path=>[path,existsSync(path)?readFileSync(path):null]));
  let openCodeSupport:ReturnType<typeof prepareOpenCode>|null=null;
  try {
  atomicJson(join(captureDir(),'config.json'),config);
  if(receiverToken)atomicJson(join(captureDir(),'receiver-token.json'),{api,token:receiverToken});
  configureHooks(config,enrolled);
  if(harnesses.includes('codex'))enableCodex(config.roots.codex);
  // OpenCode installs its plugin support package before it loads a plugin, and
  // where it cannot it waits about a minute on every start. Pay that first
  // start here, and leave no plugin behind on a machine where it fails.
  if(harnesses.includes('opencode')) {
    openCodeSupport=prepare(harnessRoot(config,'opencode'));
    if(openCodeSupport==='unavailable') {
      const reason=`OpenCode could not install its plugin support package into ${harnessRoot(config,'opencode')}, which it does before loading any plugin; it usually means the npm registry is out of reach. With the capture plugin in place OpenCode would retry on every start, for about a minute each time, so OpenCode capture was not installed. Run collect install again once OpenCode can install it.`;
      if(chosen)throw new CliError('CAPTURE_OPENCODE_SUPPORT',reason);
      writeOpenCodePlugin(hookFile(config,'opencode'),null);
      skipped.push({harness:'opencode',reason});
      harnesses.splice(harnesses.indexOf('opencode'),1);
      config.harnesses=enrolled.filter(h=>h!=='opencode');
      atomicJson(join(captureDir(),'config.json'),config);
    }
  }
  } catch(error) {
    for(const [path,bytes] of originals) {
      if(bytes===null){try{unlinkSync(path);}catch{}}
      // Restore harness files with their own permissions; replaceFile keeps the mode.
      else replaceFile(path,bytes);
    }
    throw error;
  }
  // Retire only legacy OpenCrawl services. Collection itself needs no init system.
  removeLegacyService(home);
  const backgroundStatus='harness-managed';
  const added=harnesses.filter(isPayloadHarness);
  const steps=[
    ...(harnesses.some(readsTranscript)?[process.env.CLAUDE_CODE_REMOTE==='true'?'Cloud hooks installed. Run a new message and check collect status for a stored receipt. Configure the environment setup script for future sessions.':[...(codexHooksAwaitingReview(config)?['Codex needs you to trust the new hooks: open Codex, run /hooks (or desktop Settings > Hooks), trust "OpenCrawl session capture" and start a new session. collect status reports any hook still awaiting review.']:[]),'Restart existing Claude sessions if hooks have not reloaded.'].join(' ')]:[]),
    // An agent that ran the plain command on a Bot's computer reads this and corrects itself.
    ...(absent&&!deferAuth&&!enrolled.includes('grok-bot')&&process.env.CLAUDE_CODE_REMOTE!=='true'?['Neither Claude Code nor Codex was found on this machine. If it is a Grok Bot cloud computer, capture it with opencrawl collect install --yes --harness grok-bot.']:[]),
    ...(harnesses.includes('grok-bot')?[`Grok Bot hooks installed in ${hookFile(config,'grok-bot')}. Bots that are already running may keep the hooks they loaded earlier: from a newly created Bot, run a command, then check collect status for a stored receipt.`]:[]),
    ...(harnesses.includes('opencode')?[`OpenCode capture plugin installed at ${hookFile(config,'opencode')}. OpenCode loads plugins when it starts: restart running OpenCode sessions and servers.`
      +(openCodeSupport==='unknown'?' The first start with a plugin installs OpenCode\'s plugin support package, about 60 MB, into its configuration directory: a few seconds with access to the npm registry. Where OpenCode cannot reach the registry every start waits about a minute for it; on such a machine remove the plugin file.':'')]:[]),
    ...(harnesses.includes('cursor')?[`Cursor hooks installed in ${hookFile(config,'cursor')}. They apply to conversations in the editor, the Cursor CLI and the Cursor Agent SDK on this machine; Cursor's own cloud agents do not read this file.`]:[]),
    ...(harnesses.includes('muse')?[`Muse Code hooks installed in ${hookFile(config,'muse')}. Muse Code reads hooks when a session starts: start a new session.`]:[]),
    ...(added.length?[`To confirm ${names(added)}: send a message in a new session of each, then check collect status for a stored receipt.`]:[]),
    ...(replaced.length?[`${names(replaced)} capture was removed from this machine: it reads the same hooks file as ${names(replaced.map(h=>SHARED[h]!))}.`]:[]),
    ...skipped.map(item=>item.reason)];
  return {notice:captureNoticeFor(api,config.harnesses!),exclusions:config.exclusions??{projects:[],sessions:[]},installationId:config.installationId,owner:config.authPending?null:config.owner,background:backgroundStatus,harnesses:config.harnesses,
    ...(skipped.length?{skipped}:{}),nextStep:steps.join(' ')};
  });
}
export async function uninstallCapture(home=homedir()) {
  return withSessionLock('capture:configuration',async()=>{
  const config=readCaptureConfig();if(!config)return {installed:false};
  // Disable first so an existing worker cannot start another capture pass.
  atomicJson(join(captureDir(),'config.json'),{...config,disabled:true});
  removeLegacyService(home);
  if((config.harnesses??['claude-code','codex']).includes('claude-code'))modifyHooks(join(config.roots['claude-code'],'settings.json'),[],null);
  if((config.harnesses??['claude-code','codex']).includes('codex'))modifyHooks(join(config.roots.codex,'hooks.json'),[],null);
  if(config.harnesses?.includes('grok-bot'))modifyGrokBotHooks(hookFile(config,'grok-bot'),null);
  if(config.harnesses?.includes('cursor'))modifyCursorHooks(hookFile(config,'cursor'),null);
  if(config.harnesses?.includes('muse'))modifyMuseHooks(hookFile(config,'muse'),null);
  if(config.harnesses?.includes('opencode'))writeOpenCodePlugin(hookFile(config,'opencode'),null);
  // Stopping collection preserves queued data for an authenticated retry.
  atomicJson(join(captureDir(),'config.json'),{...config,disabled:true});
  return {installed:false,queuedDataPreserved:true};
  });
}
