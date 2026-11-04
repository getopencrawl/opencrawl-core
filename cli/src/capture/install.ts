import {readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync, unlinkSync, readdirSync, renameSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {atomicJson, configDir} from '../session.ts';
import {CliError} from '../oauth.ts';
import {captureDir, readCaptureConfig, commandForSelf, request, type CaptureConfig} from './runtime.ts';
const marker='OpenCrawl session capture';
const service='com.getopencrawl.capture';
const quote=(s:string)=>process.platform==='win32'?'"'+s.replace(/"/g,'""')+'"':"'"+s.replace(/'/g,"'\\''")+"'";
const xml=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
export async function installCapture(api:string,{background=true,home=homedir(),command=commandForSelf()}={}) {
  const {principal}=await request(api,'/api/sessions/identity');
  if(!principal?.tenantId || !principal?.userId)throw new CliError('CAPTURE_IDENTITY_MISSING','Deployment does not supply capture identity');
  const previous=readCaptureConfig();
  if(previous && (previous.api!==api || previous.owner.userId!==principal.userId || previous.owner.tenantId!==principal.tenantId))throw new CliError('CAPTURE_OWNER_CHANGED','Use a separate OPENCRAWL_CONFIG_HOME for another account or deployment');
  for(const dir of ['', 'backups','queue','state','blobs'])mkdirSync(join(captureDir(),dir),{recursive:true,mode:0o700});
  const config:CaptureConfig={schemaVersion:1,api,installationId:previous?.installationId??randomUUID(),owner:principal,
    installedAt:previous?.installedAt??new Date().toISOString(),roots:{
      'claude-code':process.env.CLAUDE_CONFIG_DIR||join(home,'.claude'),codex:process.env.CODEX_HOME||join(home,'.codex')},command};
  for(const root of Object.values(config.roots))mkdirSync(root,{recursive:true,mode:0o700});
  // Validate both existing configs before changing either one.
  readJson(join(config.roots['claude-code'],'settings.json'));readJson(join(config.roots.codex,'hooks.json'));
  const toml=join(config.roots.codex,'config.toml');if(existsSync(toml))Bun.TOML.parse(readFileSync(toml,'utf8'));
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
  modifyHooks(join(config.roots['claude-code'],'settings.json'),
    ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','PostToolUseFailure','Stop','SubagentStop','SessionEnd'],base+' --harness claude-code');
  modifyHooks(join(config.roots.codex,'hooks.json'),
    ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop','SubagentStop','SessionEnd'],base+' --harness codex');
  enableCodex(config.roots.codex);
  } catch(error) {
    for(const [path,bytes] of originals) {
      if(bytes===null){try{unlinkSync(path);}catch{}}
      else {const temp=path+'.rollback-'+randomUUID();writeFileSync(temp,bytes,{mode:0o600});renameSync(temp,path);}
    }
    throw error;
  }
  const backgroundStatus=background?installService(config,home):'disabled';
  return {installationId:config.installationId,owner:principal,background:backgroundStatus,
    nextStep:'Review OpenCrawl hooks in Codex /hooks or desktop Settings > Hooks. Restart existing Claude sessions if hooks have not reloaded.'};
}
function installService(config:CaptureConfig,home:string) {
  const args=[...config.command,'collect','sync'];
  const env={OPENCRAWL_CONFIG_HOME:dirname(configDir()),OPENCRAWL_NO_UPDATE:'1'};
  if(process.platform==='darwin') {
    const file=join(home,'Library/LaunchAgents',service+'.plist');mkdirSync(dirname(file),{recursive:true});
    writeFileSync(file,`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${service}</string><key>ProgramArguments</key><array>${args.map(a=>'<string>'+xml(a)+'</string>').join('')}</array><key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k,v])=>'<key>'+k+'</key><string>'+xml(v)+'</string>').join('')}</dict><key>StartInterval</key><integer>60</integer><key>RunAtLoad</key><true/></dict></plist>`,{mode:0o600});
    const domain='gui/'+process.getuid!();
    spawnSync('launchctl',['bootout',domain+'/'+service],{stdio:'ignore'});
    const result=spawnSync('launchctl',['bootstrap',domain,file],{stdio:'pipe'});
    return result.status===0?'launchd':'launchd-configured-not-running';
  }
  if(process.platform==='linux') {
    const dir=join(home,'.config/systemd/user');mkdirSync(dir,{recursive:true});
    const escaped=(s:string)=>'"'+s.replace(/[%\\"]/g,c=>c==='%'?'%%':'\\'+c)+'"';
    writeFileSync(join(dir,service+'.service'),`[Service]\nType=oneshot\nEnvironment=${Object.entries(env).map(([k,v])=>escaped(k+'='+v)).join(' ')}\nExecStart=${args.map(escaped).join(' ')}\n`);
    writeFileSync(join(dir,service+'.timer'),'[Timer]\nOnBootSec=30\nOnUnitActiveSec=60\n[Install]\nWantedBy=timers.target\n');
    spawnSync('systemctl',['--user','daemon-reload'],{stdio:'ignore'});
    return spawnSync('systemctl',['--user','enable','--now',service+'.timer'],{stdio:'ignore'}).status===0?'systemd':'systemd-configured-not-running';
  }
  return 'hooks-only';
}
export function uninstallCapture(home=homedir()) {
  const config=readCaptureConfig();if(!config)return {installed:false};
  if(process.platform==='darwin'){
    spawnSync('launchctl',['bootout','gui/'+process.getuid!()+'/'+service],{stdio:'ignore'});
    try{unlinkSync(join(home,'Library/LaunchAgents',service+'.plist'));}catch{}
  } else if(process.platform==='linux'){
    spawnSync('systemctl',['--user','disable','--now',service+'.timer'],{stdio:'ignore'});
    for(const ext of ['service','timer'])try{unlinkSync(join(home,'.config/systemd/user',service+'.'+ext));}catch{}
  }
  modifyHooks(join(config.roots['claude-code'],'settings.json'),[],null);
  modifyHooks(join(config.roots.codex,'hooks.json'),[],null);
  // Preserve queue and owner so offline data cannot be reassigned on another login.
  atomicJson(join(captureDir(),'config.json'),{...config,disabled:true});
  return {installed:false,queuedDataPreserved:true};
}
