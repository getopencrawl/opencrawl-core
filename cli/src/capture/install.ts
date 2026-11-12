import {readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync, unlinkSync, readdirSync, renameSync, statSync, chmodSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {removeLegacyService} from './legacy-service.ts';
import {randomUUID} from 'node:crypto';
import {HARNESSES, readsTranscript, type Harness} from './parse.ts';
import {GROK_BOT_HOOK_EVENTS} from './grok-bot.ts';
import {atomicFile, atomicJson, configDir, withSessionLock} from '../session.ts';
import {CliError, apiOrigin} from '../oauth.ts';
import {environmentToken} from '../environment-token.ts';
import {captureDir, readCaptureConfig, commandForSelf, request, harnessRoot, codexHooksAwaitingReview, HOOK_MODE, type CaptureConfig} from './runtime.ts';
import {captureNotice, grokBotNotice} from './policy.ts';
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
const hookFile=(config:CaptureConfig,harness:Harness)=>join(harnessRoot(config,harness),harness==='claude-code'?'settings.json':'hooks.json');
// Cursor-format entries have no label field; the command itself marks ownership.
const grokBotOwned=(entry:any)=>typeof entry?.command==='string'&&/[\\/]capture[\\/]runner\.cjs\b.* collect hook .*--harness grok-bot\b/.test(entry.command);
/** Grok Bot loads ~/.cursor/hooks.json: {version:1,hooks:{event:[{command,timeout}]}}. */
function modifyGrokBotHooks(file:string,command:string|null) {
  if(!command&&!existsSync(file))return;
  const config=readJson(file);
  if(!config||typeof config!=='object'||Array.isArray(config)||config.version!==undefined&&config.version!==1||
    config.hooks!==undefined&&(!config.hooks||typeof config.hooks!=='object'||Array.isArray(config.hooks)))throw new CliError('CAPTURE_INVALID_CONFIG','Existing Grok Bot hooks file is not a version 1 Cursor hooks file');
  const hooks=config.hooks??{};
  for(const [event,entries] of Object.entries(hooks)) {
    if(!Array.isArray(entries))throw new CliError('CAPTURE_INVALID_CONFIG','Existing hook entries are invalid');
    hooks[event]=entries.filter(entry=>!grokBotOwned(entry));
    if(!hooks[event].length)delete hooks[event];
  }
  // Every hook is passive, so a failure or the timeout never blocks the Bot. The
  // hook ends itself at five seconds; the timeout leaves room for a sign-in
  // renewal that must not be abandoned.
  if(command)for(const event of GROK_BOT_HOOK_EVENTS)(hooks[event]??=[]).push({command,timeout:30});
  backup(file);replaceFile(file,JSON.stringify({...config,version:1,hooks},null,2)+'\n');
}
/** For a file in another program's directory: new contents, same permissions,
 * and the directory left as it is. */
function replaceFile(file:string,bytes:string|Buffer) {
  const temp=file+'.opencrawl-tmp',mode=existsSync(file)?statSync(file).mode&0o777:0o600;
  writeFileSync(temp,bytes,{mode:0o600});
  chmodSync(temp,mode); // the creation mode is narrowed by the umask
  renameSync(temp,file);
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
  // An environment token is only sent to a deployment the invocation names.
  // Hooks installed without a sign-in get theirs from the environment later,
  // so they carry the deployment their install was told to use.
  const hook=(...args:string[])=>(process.platform==='win32'?'':'exec ')+[quote(node),quote(runner),'collect','hook',...args,...(config.hookApi?['--api',quote(config.hookApi)]:[])].join(' ');
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
  if(harnesses.includes('grok-bot'))modifyGrokBotHooks(hookFile(config,'grok-bot'),[plain(node),plain(runner),'collect','hook','--harness','grok-bot',...(config.hookApi?['--api',plain(config.hookApi)]:[])].join(' '));
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
export async function installCapture(api:string,{background=false,deferAuth=false,namedApi=false,home=homedir(),command=commandForSelf(),harnesses=(process.env.CLAUDE_CODE_REMOTE==='true'?['claude-code']:['claude-code','codex']) as Harness[]}={}) {
  const receiverToken=environmentToken('OPENCRAWL_SESSIONS_TOKEN',api);
  if(!harnesses.length||harnesses.some(h=>!HARNESSES.includes(h)))throw new CliError('INVALID_USAGE','Use --harness claude-code, codex or grok-bot',64);
  // Image preparation cannot access runtime secrets. First worker authenticates
  // before parsing/spooling; hooks only persist notices even on first launch.
  const {principal}=deferAuth?{principal:{tenantId:'pending',userId:'pending'}}:await request(api,'/api/sessions/identity');
  if(!principal?.tenantId || !principal?.userId)throw new CliError('CAPTURE_IDENTITY_MISSING','Deployment does not supply capture identity');
  return withSessionLock('capture:configuration',async()=>{
  const previous=readCaptureConfig();
  // Re-running cloud preparation has no authenticated replacement identity.
  // Preserve a bound destination, including ownership of unprocessed notices.
  const preserveOwner=deferAuth && previous?.api===api && !previous.authPending;
  const authPending=deferAuth && !preserveOwner;
  const changed=previous && (previous.api!==api || !deferAuth && (previous.owner.userId!==principal.userId || previous.owner.tenantId!==principal.tenantId));
  if(changed && ['queue','notices'].some(dir=>existsSync(join(captureDir(),dir)) && readdirSync(join(captureDir(),dir)).length))throw new CliError('CAPTURE_PENDING_DESTINATION','Pending capture belongs to the previous destination. Upload it there or uninstall and explicitly purge local pending data before changing destination.');
  for(const dir of ['', 'backups','queue','state','blobs'])mkdirSync(join(captureDir(),dir),{recursive:true,mode:0o700});
  const config:CaptureConfig={schemaVersion:1,exclusions:previous?.exclusions,hookMode:HOOK_MODE,api,installationId:previous?.installationId??(deferAuth?'pending':randomUUID()),owner:preserveOwner?previous.owner:principal,...(authPending?{authPending:true}:{}),
    harnesses:[...new Set([...(previous?.harnesses??[]),...harnesses])],installedAt:previous?.installedAt??new Date().toISOString(),roots:{
      'claude-code':!harnesses.includes('claude-code')&&previous?.roots['claude-code']||process.env.CLAUDE_CONFIG_DIR||join(home,'.claude'),
      codex:!harnesses.includes('codex')&&previous?.roots.codex||process.env.CODEX_HOME||join(home,'.codex'),
      'grok-bot':!harnesses.includes('grok-bot')&&previous?.roots['grok-bot']||join(home,'.cursor')},
    claudeDesktopSessionsRoot:previous?.claudeDesktopSessionsRoot??defaultClaudeDesktopSessionsRoot(home),command,
    // Only where the person named the deployment, and kept while it stays the same one.
    ...(deferAuth&&namedApi?{hookApi:apiOrigin(api)}:previous?.hookApi&&previous.api===api?{hookApi:previous.hookApi}:{})};
  const enrolled=config.harnesses!;
  // Checked before the directories below are created.
  const absent=harnesses.every(readsTranscript)&&!harnesses.some(harness=>existsSync(harnessRoot(config,harness))||Bun.which(harness==='codex'?'codex':'claude',{PATH:process.env.PATH}));
  for(const harness of enrolled)mkdirSync(harnessRoot(config,harness),{recursive:true,mode:0o700});
  // Validate every existing config before changing any of them.
  if(enrolled.includes('claude-code'))readJson(join(config.roots['claude-code'],'settings.json'));
  if(enrolled.includes('codex'))readJson(join(config.roots.codex,'hooks.json'));
  if(enrolled.includes('grok-bot'))readJson(hookFile(config,'grok-bot'));
  const toml=join(config.roots.codex,'config.toml');if(harnesses.includes('codex')&&existsSync(toml))Bun.TOML.parse(readFileSync(toml,'utf8'));
  const affected=[join(captureDir(),'config.json'),join(captureDir(),'receiver-token.json'),join(captureDir(),'runner.cjs'),
    join(config.roots['claude-code'],'settings.json'),join(config.roots.codex,'hooks.json'),toml,
    ...(enrolled.includes('grok-bot')?[hookFile(config,'grok-bot')]:[])];
  const originals=new Map(affected.map(path=>[path,existsSync(path)?readFileSync(path):null]));
  try {
  atomicJson(join(captureDir(),'config.json'),config);
  if(receiverToken)atomicJson(join(captureDir(),'receiver-token.json'),{api,token:receiverToken});
  configureHooks(config,enrolled);
  if(harnesses.includes('codex'))enableCodex(config.roots.codex);
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
  const steps=[
    ...(harnesses.some(readsTranscript)?[process.env.CLAUDE_CODE_REMOTE==='true'?'Cloud hooks installed. Run a new message and check collect status for a stored receipt. Configure the environment setup script for future sessions.':[...(codexHooksAwaitingReview(config)?['Codex needs you to trust the new hooks: open Codex, run /hooks (or desktop Settings > Hooks), trust "OpenCrawl session capture" and start a new session. collect status reports any hook still awaiting review.']:[]),'Restart existing Claude sessions if hooks have not reloaded.'].join(' ')]:[]),
    // An agent that ran the plain command on a Bot's computer reads this and corrects itself.
    ...(absent&&!deferAuth&&!enrolled.includes('grok-bot')&&process.env.CLAUDE_CODE_REMOTE!=='true'?['Neither Claude Code nor Codex was found on this machine. If it is a Grok Bot cloud computer, capture it with opencrawl collect install --yes --harness grok-bot.']:[]),
    ...(harnesses.includes('grok-bot')?[`Grok Bot hooks installed in ${hookFile(config,'grok-bot')}. Bots that are already running may keep the hooks they loaded earlier: from a newly created Bot, run a command, then check collect status for a stored receipt.`]:[])];
  return {notice:enrolled.includes('grok-bot')?captureNotice(api)+' '+grokBotNotice:captureNotice(api),exclusions:config.exclusions??{projects:[],sessions:[]},installationId:config.installationId,owner:config.authPending?null:config.owner,background:backgroundStatus,harnesses:config.harnesses,
    nextStep:steps.join(' ')};
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
  // Stopping collection preserves queued data for an authenticated retry.
  atomicJson(join(captureDir(),'config.json'),{...config,disabled:true});
  return {installed:false,queuedDataPreserved:true};
  });
}
