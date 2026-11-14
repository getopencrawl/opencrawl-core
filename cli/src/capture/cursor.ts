import {CliError} from '../oauth.ts';
import {grokBotEvents, GROK_BOT_HOOK_EVENTS} from './grok-bot.ts';
import {realpathSync, openSync, closeSync, readSync, fstatSync} from 'node:fs';
import {join, relative, sep, basename} from 'node:path';

// Cursor and Grok Bot implement the same published hook payload format. Keep
// its content conversion shared, but their session namespaces are independent.
export const CURSOR_HOOK_EVENTS = GROK_BOT_HOOK_EVENTS;
export const cursorEvents = grokBotEvents;
/** Cursor CLI omits some content hooks. Reconcile only the active native JSONL
 * named by a hook, inside Cursor's own project transcript directory. Never read
 * a referenced project file or follow a link outside that directory. */
export function* cursorTranscript(root: string, sessionId: string, file: string, offset=0, ino?: number) {
  const base=realpathSync(root),path=realpathSync(file),parts=relative(base,path).split(sep);
  if(parts.length!==5||parts[0]!=='projects'||parts[2]!=='agent-transcripts'||parts[3]!==sessionId||basename(path)!==sessionId+'.jsonl')
    throw new CliError('CAPTURE_PATH_REJECTED','Cursor transcript outside its native conversation directory');
  const fd=openSync(path,'r');
  try {
    const stat=fstatSync(fd);if(!stat.isFile())throw new CliError('CAPTURE_PATH_REJECTED','Cursor transcript is not a regular file');
    if(offset>stat.size||ino!==undefined&&ino!==stat.ino)offset=0;
    let position=offset,pending=Buffer.alloc(0);
    const buffer=Buffer.alloc(64*1024);
    while(position<stat.size) {
      const count=readSync(fd,buffer,0,Math.min(buffer.length,stat.size-position),position);if(!count)break;position+=count;
      pending=Buffer.concat([pending,buffer.subarray(0,count)]);
      let end;
      while((end=pending.indexOf(10))>=0) {
        const bytes=pending.subarray(0,end),start=offset;offset+=end+1;pending=pending.subarray(end+1);
        if(bytes.length>8*1024*1024)throw new CliError('CAPTURE_LINE_TOO_LARGE','Cursor transcript record exceeds 8 MiB; cursor retained');
        let record;try{record=JSON.parse(bytes.toString('utf8'));}catch{throw new CliError('CAPTURE_INVALID_RECORD','Invalid Cursor transcript record; cursor retained');}
        // Tool records have no IDs/results in this transcript; hooks retain them.
        let data=null;
        if(['user','assistant'].includes(record.role)&&Array.isArray(record.message?.content)) {
          const content=record.message.content.filter((b:any)=>b&&['text','image','image_url','input_image'].includes(b.type));
          if(content.length)data={role:record.role,content};
        }
        yield {start,offset,ino:stat.ino,data};
      }
      if(pending.length>8*1024*1024)throw new CliError('CAPTURE_LINE_TOO_LARGE','Cursor transcript record exceeds 8 MiB; cursor retained');
    }
  } finally {closeSync(fd);}
}
export function cursorMessage(data:any) {
  // Cursor CLI wraps the human prompt in its native timestamp/query envelope.
  const content=data.content.map((block:any)=>{
    if(data.role!=='user'||block.type!=='text'||typeof block.text!=='string')return block;
    const match=/^<timestamp>[^\n]*<\/timestamp>\n<user_query>\n([\s\S]*)\n<\/user_query>$/.exec(block.text);
    return match?{...block,text:match[1]}:block;
  });
  return {...data,content};
}
export function cursorSession(event: any) {
  const sessionId = event?.conversation_id || event?.session_id;
  if (typeof sessionId !== 'string' || !/^[\w.:-]{1,200}$/.test(sessionId))
    throw new CliError('CAPTURE_SESSION_UNKNOWN', 'Cursor hook missing a native conversation ID');
  const cwd = (Array.isArray(event.workspace_roots) ? event.workspace_roots.find((root: unknown) => typeof root === 'string' && root) : undefined) ?? (typeof event.cwd === 'string' ? event.cwd : undefined);
  // Do not guess CLI/desktop/cloud from a model name or version string.
  const parentSessionId=typeof event.parent_conversation_id==='string'&&/^[\w.:-]{1,200}$/.test(event.parent_conversation_id)&&event.parent_conversation_id!==sessionId?event.parent_conversation_id:null;
  const origin = parentSessionId?'subagent':event.is_background_agent === true ? 'cloud' : 'unknown';
  return {sessionId, identified: true, conversationId: sessionId, cwd,
    version: typeof event.cursor_version === 'string' ? event.cursor_version : null,
    title: null, origin, parentSessionId, originEvidence: 'Cursor native conversation hook'};
}
