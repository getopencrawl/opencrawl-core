import {readdirSync,realpathSync,lstatSync,openSync,readSync,closeSync,fstatSync} from 'node:fs';
import {join,resolve,relative,sep} from 'node:path';
import {homedir} from 'node:os';
import {CliError} from '../oauth.ts';

type Roots={roots:{'claude-code':string},claudeDesktopSessionsRoot?:string};
/** Host-readable Claude Desktop history; never inspect VM images or unrelated app data. */
export function defaultClaudeDesktopSessionsRoot(home=homedir(),platform=process.platform) {
  const actualHome=resolve(home)===resolve(homedir());
  const data=process.env.CLAUDE_DESKTOP_CONFIG_DIR || (platform==='darwin'
    ?join(home,'Library','Application Support','Claude')
    :platform==='win32'?join(actualHome&&process.env.APPDATA||join(home,'AppData','Roaming'),'Claude')
    :join(actualHome&&process.env.XDG_CONFIG_HOME||join(home,'.config'),'Claude'));
  return join(resolve(data),'local-agent-mode-sessions');
}
export function claudeDesktopSessionsRoot(config:Roots,home=homedir()) {
  if(config.claudeDesktopSessionsRoot)return resolve(config.claudeDesktopSessionsRoot);
  // Upgrade default installations without expanding custom/test transcript roots.
  if(resolve(config.roots['claude-code'])===resolve(join(home,'.claude')))return defaultClaudeDesktopSessionsRoot(home);
}
function directories(path:string) {
  try{return readdirSync(path,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>join(path,entry.name));}
  catch(error:any){if(error.code==='ENOENT')return [];throw new CliError('BACKFILL_SCAN_FAILED','Cannot inspect Claude Desktop history. Check its permissions.');}
}
function ordinaryDirectory(path:string) {
  try{return lstatSync(path).isDirectory();}
  catch(error:any){if(error.code==='ENOENT')return false;throw new CliError('BACKFILL_SCAN_FAILED','Cannot inspect Claude Desktop history. Check its permissions.');}
}
export function claudeDesktopHistories(config:Roots) {
  const configured=claudeDesktopSessionsRoot(config);if(!configured)return {projects:[],audits:[]};
  let root:string;try{root=realpathSync(configured);}catch(error:any){if(error.code==='ENOENT')return {projects:[],audits:[]};throw new CliError('BACKFILL_SCAN_FAILED','Cannot inspect Claude Desktop history. Check its permissions.');}
  const projects:string[]=[],audits:string[]=[];
  for(const account of directories(root))for(const session of directories(account)) {
    const agent=join(session,'agent');if(!ordinaryDirectory(agent))continue;
    for(const runtime of directories(agent)) {
      const claude=join(runtime,'.claude'),project=join(claude,'projects');
      if(ordinaryDirectory(claude)&&ordinaryDirectory(project))projects.push(project);
      const audit=join(runtime,'audit.jsonl');
      try{if(lstatSync(audit).isFile())audits.push(audit);}catch(error:any){if(error.code!=='ENOENT')throw error;}
    }
  }
  return {projects,audits};
}
export function isClaudeDesktopTranscript(path:string,config:Roots) {
  const configured=claudeDesktopSessionsRoot(config);if(!configured)return false;
  let root:string;try{root=realpathSync(configured);}catch(error:any){if(error.code==='ENOENT')return false;throw error;}
  if(!path.startsWith(root+sep)||!path.endsWith('.jsonl'))return false;
  const parts=relative(root,path).split(sep);
  if(parts[2]!=='agent')return false;
  if(!(parts.length===5&&parts[4]==='audit.jsonl'||parts.length>=8&&parts[4]==='.claude'&&parts[5]==='projects'))return false;
  // Reject links at every level, including links into another native runtime.
  let current=root;for(const part of parts){current=join(current,part);if(lstatSync(current).isSymbolicLink())return false;}
  return true;
}

/** Called only after explicit import consent. Audit copies with native UUIDs are redundant. */
export function desktopNativeMessageIds(audit:string) {
  const ids=new Set<string>(),runtime=resolve(audit,'..'),claude=join(runtime,'.claude'),projects=join(claude,'projects');
  if(!ordinaryDirectory(claude)||!ordinaryDirectory(projects))return ids;
  function scan(dir:string) {
    for(const entry of readdirSync(dir,{withFileTypes:true})) {
      const path=join(dir,entry.name);
      if(entry.isDirectory()){scan(path);continue;}
      if(!entry.isFile()||!entry.name.endsWith('.jsonl'))continue;
      const fd=openSync(path,'r');
      try {
        const size=fstatSync(fd).size;let offset=0;
        while(offset<size) {
          const bytes=Buffer.alloc(Math.min(size-offset,48*1024*1024));
          const read=readSync(fd,bytes,0,bytes.length,offset),end=bytes.subarray(0,read).lastIndexOf(10);
          if(end<0){if(offset+read<size)throw new CliError('CAPTURE_LINE_TOO_LARGE','Transcript line exceeds capture chunk size');break;}
          for(const line of bytes.subarray(0,end+1).toString('utf8').split('\n').slice(0,-1)) {
            if(!line.trim())continue;
            let record;try{record=JSON.parse(line);}catch{throw new CliError('CAPTURE_INVALID_RECORD','Invalid native transcript record; audit cursor retained');}
            if(['user','assistant'].includes(record.type)&&typeof record.uuid==='string')ids.add(record.uuid);
          }
          offset+=end+1;
        }
      } finally{closeSync(fd);}
    }
  }
  scan(projects);return ids;
}
