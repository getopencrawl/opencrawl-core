import {readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync, unlinkSync, readdirSync, renameSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {homedir} from 'node:os';
import {removeLegacyService} from './legacy-service.ts';
import {randomUUID} from 'node:crypto';
import {type Harness} from './parse.ts';
import {atomicJson, configDir, withSessionLock} from '../session.ts';
import {CliError} from '../oauth.ts';
import {captureDir, readCaptureConfig, commandForSelf, request, type CaptureConfig} from './runtime.ts';
import {defaultClaudeDesktopSessionsRoot} from './desktop-history.ts';
const marker='OpenCrawl session capture';
const quote=(s:string)=>process.platform==='win32'?'"'+s.replace(/"/g,'""')+'"':"'"+s.replace(/'/g,"'\\''")+"'";
function readJson(file:string){return existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};}
function backup(file:string){if(existsSync(file)){const p=join(captureDir(),'backups',randomUUID()+'.json');copyFileSync(file,p);}}
function modifyHooks(file:string,events:string[],command:string|null) {
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
  if(command)for(const event of events)(hooks[event]??=[]).push({hooks:[{type:'command',command,timeout:30,statusMessage:marker}]});
  backup(file);atomicJson(file,{...config,hooks});
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
  const temp=file+'.opencrawl-tmp';writeFileSync(temp,after,{mode:0o600});
  // Atomic replacement without changing unrelated TOML settings.
  renameSync(temp,file);
}
export async function installCapture(api:string,{background=false,deferAuth=false,home=homedir(),command=commandForSelf(),harnesses=(process.env.CLAUDE_CODE_REMOTE==='true'?['claude-code']:['claude-code','codex']) as Harness[]}={}) {
  if(!harnesses.length||harnesses.some(h=>!['claude-code','codex'].includes(h)))throw new CliError('INVALID_USAGE','Use --harness claude-code or codex',64);
  // Image preparation cannot access runtime secrets. First worker authenticates
  // before parsing/spooling; hooks only persist notices even on first launch.
  const {principal}=deferAuth?{principal:{tenantId:'pending',userId:'pending'}}:await request(api,'/api/sessions/identity');
  if(!principal?.tenantId || !principal?.userId)throw new CliError('CAPTURE_IDENTITY_MISSING','Deployment does not supply capture identity');
  return withSessionLock('capture:configuration',async()=>{
  const previous=readCaptureConfig();
  for(const dir of ['', 'backups','queue','state','blobs'])mkdirSync(join(captureDir(),dir),{recursive:true,mode:0o700});
  const config:CaptureConfig={schemaVersion:1,api,installationId:previous?.installationId??(deferAuth?'pending':randomUUID()),owner:principal,...(deferAuth?{authPending:true}:{}),
    harnesses:[...new Set([...(previous?.harnesses??[]),...harnesses])],installedAt:previous?.installedAt??new Date().toISOString(),roots:{
      'claude-code':process.env.CLAUDE_CONFIG_DIR||join(home,'.claude'),codex:process.env.CODEX_HOME||join(home,'.codex')},
    claudeDesktopSessionsRoot:previous?.claudeDesktopSessionsRoot??defaultClaudeDesktopSessionsRoot(home),command};
  for(const harness of harnesses)mkdirSync(config.roots[harness],{recursive:true,mode:0o700});
  // Validate both existing configs before changing either one.
  if(harnesses.includes('claude-code'))readJson(join(config.roots['claude-code'],'settings.json'));
  if(harnesses.includes('codex'))readJson(join(config.roots.codex,'hooks.json'));
  const toml=join(config.roots.codex,'config.toml');if(harnesses.includes('codex')&&existsSync(toml))Bun.TOML.parse(readFileSync(toml,'utf8'));
  const affected=[join(captureDir(),'config.json'),join(captureDir(),'receiver-token.json'),join(captureDir(),'runner.cjs'),
    join(config.roots['claude-code'],'settings.json'),join(config.roots.codex,'hooks.json'),toml];
  const originals=new Map(affected.map(path=>[path,existsSync(path)?readFileSync(path):null]));
  try {
  atomicJson(join(captureDir(),'config.json'),config);
  if(process.env.OPENCRAWL_SESSIONS_TOKEN)atomicJson(join(captureDir(),'receiver-token.json'),{api,token:process.env.OPENCRAWL_SESSIONS_TOKEN});
  const runner=join(captureDir(),'runner.cjs');
  // Stable dispatcher follows the npm launcher's selected release; desktop needs no shell PATH setup.
  writeFileSync(runner,`const {spawnSync}=require('node:child_process');const r=spawnSync(${JSON.stringify(command[0])},[${command.slice(1).map(x=>JSON.stringify(x)).join(',')}${command.length>1?',':''}...process.argv.slice(2)],{stdio:'inherit',windowsHide:true,env:{...process.env,OPENCRAWL_CONFIG_HOME:${JSON.stringify(dirname(configDir()))},OPENCRAWL_NO_UPDATE:'1'}});process.exitCode=r.status??1;\n`,{mode:0o600});
  // Use the installed Node runtime for the dispatcher; compiled Bun also supports running it via BUN_BE_BUN.
  const node=process.env.OPENCRAWL_NODE || (process.execPath.endsWith('bun') ? process.execPath : Bun.which('node'));
  if(!node)throw new CliError('NODE_REQUIRED','Install Node to run capture hooks');
  const base=[quote(node),quote(runner),'collect','hook'].join(' ');
  if(harnesses.includes('claude-code'))modifyHooks(join(config.roots['claude-code'],'settings.json'),
    ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','PostToolUseFailure','Stop','SubagentStop','SessionEnd'],base+' --harness claude-code');
  if(harnesses.includes('codex'))modifyHooks(join(config.roots.codex,'hooks.json'),
    ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop','SubagentStop','SessionEnd'],base+' --harness codex');
  if(harnesses.includes('codex'))enableCodex(config.roots.codex);
  } catch(error) {
    for(const [path,bytes] of originals) {
      if(bytes===null){try{unlinkSync(path);}catch{}}
      else {const temp=path+'.rollback-'+randomUUID();writeFileSync(temp,bytes,{mode:0o600});renameSync(temp,path);}
    }
    throw error;
  }
  // Retire only legacy OpenCrawl services. Collection itself needs no init system.
  removeLegacyService(home);
  const backgroundStatus='on-demand';
  return {installationId:config.installationId,owner:deferAuth?null:principal,background:backgroundStatus,harnesses:config.harnesses,
    nextStep:process.env.CLAUDE_CODE_REMOTE==='true'?'Cloud hooks installed. Run a new message and check collect status for a stored receipt. Configure the environment setup script for future sessions.':'Review OpenCrawl hooks in Codex /hooks or desktop Settings > Hooks. Restart existing Claude sessions if hooks have not reloaded.'};
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
  // Stopping collection preserves queued data for an authenticated retry.
  atomicJson(join(captureDir(),'config.json'),{...config,disabled:true});
  return {installed:false,queuedDataPreserved:true};
  });
}
