import {isAbsolute, resolve, sep,dirname,basename,join} from 'node:path';
import {realpathSync} from 'node:fs';
import {apiOrigin} from '../oauth.ts';

export type CaptureExclusions = {projects:string[], sessions:string[]};
export const captureNotice = (api:string) => `Destination: ${apiOrigin(api)}. Capture shares user/agent messages, tool inputs/results, attachments and native agent memory files with everyone who can read your OpenCrawl team or deployment. The CLI masks recognized secret formats in session captures locally before upload. Unknown formats, images and native memory files are not covered by this filter. Active conversations are read from their beginning. Memories refresh automatically during CLI use. Inactive conversation history requires separate consent. Uninstall stops collection; it does not delete uploaded or queued data.`;

/** One hooks file serves the whole cloud computer, so the scope is every Bot on it. */
export const grokBotNotice = 'Grok Bot capture records every Bot that runs on this cloud computer, including Bots created later and anyone chatting with a Bot hosted here, attributed to the person who installs it. Recording starts when a Bot loads the hooks; earlier conversations are not read.';
export const captureNoticeFor = (api:string,harness?:string) => harness==='grok-bot' ? captureNotice(api)+' '+grokBotNotice : captureNotice(api);

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
