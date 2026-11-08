import {isAbsolute, resolve, sep,dirname,basename,join} from 'node:path';
import {realpathSync} from 'node:fs';

export type CaptureExclusions = {projects:string[], sessions:string[]};
export const captureNotice = 'Capture shares user/agent messages, raw tool inputs/results, attachments and native agent memory files with everyone who can read your OpenCrawl team or deployment. Secrets in those records are not automatically redacted. Active conversations are read from their beginning. Memories refresh automatically during CLI use. Inactive conversation history requires separate consent. Uninstall stops collection; it does not delete uploaded or queued data.';

export function projectPath(value:string) {
  if(!isAbsolute(value))throw new Error('Use an absolute project directory.');
  let parent=resolve(value);const tail:string[]=[];
  for(;;) {
    try{return join(realpathSync(parent),...tail);}catch(error:any){
      if(error?.code!=='ENOENT')throw error;
      const next=dirname(parent);if(next===parent)throw error;
      tail.unshift(basename(parent));parent=next;
    }
  }
}
export function captureExcluded(config:{exclusions?:CaptureExclusions}, meta:{sessionId?:string,cwd?:string}) {
  const exclusions=config.exclusions;
  if(!exclusions)return false;
  if(exclusions.sessions.some(id=>meta.sessionId===id || meta.sessionId?.startsWith(id+':')))return true;
  if(!exclusions.projects.length)return false;
  // Unknown working directories cannot establish that a project exclusion is safe.
  if(!meta.cwd || !isAbsolute(meta.cwd))return true;
  let cwd:string;try{cwd=projectPath(meta.cwd);}catch{return true;}
  return exclusions.projects.some(path=>cwd===path || cwd.startsWith(path.endsWith(sep)?path:path+sep));
}
