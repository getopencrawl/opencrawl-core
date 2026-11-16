import {CliError} from '../oauth.ts';
import {transcriptCheckpoint,transcriptIdentity,transcriptIdentityMatches} from './transcript-checkpoint.ts';
import {createHash} from 'node:crypto';
import {grokBotEvents, GROK_BOT_HOOK_EVENTS} from './grok-bot.ts';
import {realpathSync, openSync, closeSync, readSync, fstatSync, lstatSync} from 'node:fs';
import {join, relative, resolve, isAbsolute, sep, basename} from 'node:path';

// Cursor and Grok Bot implement the same published hook payload format. Keep
// its content conversion shared, but their session namespaces are independent.
export const CURSOR_HOOK_EVENTS = GROK_BOT_HOOK_EVENTS;
export const cursorEvents = grokBotEvents;
export type CursorThoughtHooks = {generation: string; turn: Record<string,number>; model: Record<string,number>};
/** Native notification turns have no beforeSubmitPrompt. Recognize only the
 * UUID / UUID-modelIndex-suffix pair observed in desktop hooks, so their first
 * thought can establish the turn without guessing at arbitrary generation IDs. */
export function cursorThoughtState(state: CursorThoughtHooks | undefined, event: {generation_id?:unknown;hook_event_name?:unknown}): CursorThoughtHooks | undefined {
  const id=event.generation_id;
  if(typeof id!=='string'||!id)return state;
  const generation=event.hook_event_name==='beforeSubmitPrompt'?id:
    event.hook_event_name==='afterAgentThought'?/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-\d+-[a-z0-9]+)?$/i.exec(id)?.[1]:undefined;
  return generation&&generation!==state?.generation?{generation,turn:{},model:{}}:state;
}
/** Desktop emits the same thought through its model and turn hooks. Pair only
 * aliases of the observed native generation. Occurrence counts
 * preserve repeated thoughts within a turn and leave unidentified hooks alone. */
export function cursorThoughtDuplicate(state: CursorThoughtHooks | undefined, event: any) {
  const generation=event.generation_id;
  if(!state||event.hook_event_name!=='afterAgentThought'||typeof event.text!=='string'||typeof generation!=='string')return false;
  const source=generation===state.generation?'turn':generation.startsWith(state.generation+'-')?'model':null;
  if(!source)return false;
  const key=createHash('sha256').update(JSON.stringify([event.text,event.duration_ms??null])).digest('hex');
  const count=(state[source][key]??0)+1;state[source][key]=count;
  return count<=(state[source==='turn'?'model':'turn'][key]??0);
}
/** Cursor CLI omits some content hooks. Reconcile only the active native JSONL
 * named by a hook, inside Cursor's own project transcript directory. Never read
 * a referenced project file or follow a link outside that directory. */
function openCursorTranscript(root:string,sessionId:string,file:string) {
  const supplied=resolve(file),base=realpathSync(root),path=realpathSync(file),parts=relative(base,path).split(sep);
  const inside=(value:string)=>!isAbsolute(value)&&value.split(sep)[0]!=='..';
  const spelling=relative(resolve(root),supplied),lexical=inside(spelling)?spelling:relative(base,supplied);
  if(!inside(lexical)||lstatSync(supplied).isSymbolicLink()||path!==resolve(base,lexical))throw new CliError('CAPTURE_PATH_REJECTED','Cursor transcript redirects outside its supplied native path');
  if(parts.length!==5||parts[0]!=='projects'||parts[2]!=='agent-transcripts'||parts[3]!==sessionId||basename(path)!==sessionId+'.jsonl')
    throw new CliError('CAPTURE_PATH_REJECTED','Cursor transcript outside its native conversation directory');
  const fd=openSync(path,'r');
  if(!fstatSync(fd).isFile()){closeSync(fd);throw new CliError('CAPTURE_PATH_REJECTED','Cursor transcript is not a regular file');}
  return fd;
}
/** Enrollment reads only a bounded fingerprint and the final newline, never old messages. */
export function cursorTranscriptBoundary(root:string,sessionId:string,file:string) {
  const fd=openCursorTranscript(root,sessionId,file);
  try{
    const stat=fstatSync(fd),identity=transcriptIdentity(fd),last=Buffer.alloc(1);if(stat.size)readSync(fd,last,0,1,stat.size-1);
    return {offset:stat.size,ino:stat.ino,identity,checkpoint:transcriptCheckpoint(fd,stat.size),skipPartial:Boolean(stat.size&&last[0]!==10)};
  }finally{closeSync(fd);}
}
export function* cursorTranscript(root: string, sessionId: string, file: string, offset=0, ino?: number, checkpoint?: string,{forwardBoundary=false,skipPartial=false,identity:savedIdentity}:{forwardBoundary?:boolean;skipPartial?:boolean;identity?:string}={}) {
  const fd=openCursorTranscript(root,sessionId,file);
  try {
    const stat=fstatSync(fd),identity=transcriptIdentity(fd);
    const fingerprint=(end:number)=>transcriptCheckpoint(fd,end);
    // Replaying a rewritten prefix is safe only when its original messages were
    // already observed. A consent boundary has deliberately never parsed them.
    const identityChanged=forwardBoundary?!transcriptIdentityMatches(savedIdentity,identity):savedIdentity!==undefined?savedIdentity!==identity:ino!==undefined&&ino!==stat.ino;
    const changed=identityChanged||offset>stat.size||offset>0&&(!checkpoint||checkpoint!==fingerprint(offset));
    if(changed&&forwardBoundary){
      const last=Buffer.alloc(1);if(stat.size)readSync(fd,last,0,1,stat.size-1);
      yield {start:stat.size,offset:stat.size,ino:stat.ino,identity,checkpoint:fingerprint(stat.size),data:null,forwardRebased:true,skipPartial:Boolean(stat.size&&last[0]!==10)};
      return;
    }
    if(changed)offset=0;
    let position=offset,pending=Buffer.alloc(0);
    const buffer=Buffer.alloc(64*1024);
    while(position<stat.size) {
      const count=readSync(fd,buffer,0,Math.min(buffer.length,stat.size-position),position);if(!count)break;position+=count;
      pending=Buffer.concat([pending,buffer.subarray(0,count)]);
      let end;
      while((end=pending.indexOf(10))>=0) {
        const bytes=pending.subarray(0,end),start=offset;offset+=end+1;pending=pending.subarray(end+1);
        if(bytes.length>8*1024*1024)throw new CliError('CAPTURE_LINE_TOO_LARGE','Cursor transcript record exceeds 8 MiB; cursor retained');
        if(skipPartial){skipPartial=false;yield {start,offset,ino:stat.ino,identity,checkpoint:fingerprint(offset),data:null,forwardRebased:false,skipPartial:false};continue;}
        let record;try{record=JSON.parse(bytes.toString('utf8'));}catch{throw new CliError('CAPTURE_INVALID_RECORD','Invalid Cursor transcript record; cursor retained');}
        // Tool records have no IDs/results in this transcript; hooks retain them.
        let data=null;
        if(['user','assistant'].includes(record.role)&&Array.isArray(record.message?.content)) {
          const content=record.message.content.filter((b:any)=>b&&['text','image','image_url','input_image'].includes(b.type));
          if(content.length)data={role:record.role,content};
        }
        yield {start,offset,ino:stat.ino,identity,checkpoint:fingerprint(offset),data,forwardRebased:false,skipPartial:false};
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
