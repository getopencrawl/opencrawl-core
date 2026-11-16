import {join,resolve,relative,sep,basename} from 'node:path';
import {mkdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {atomicJson} from '../session.ts';
import {CliError} from '../oauth.ts';
import {captureDir,readCaptureConfig,captureDaemonEnabled,harnessRoot,antigravityHookFields,antigravityBrainDirs,type CaptureConfig,type CaptureHookNotice} from './runtime.ts';
import {captureExcluded} from './policy.ts';
import {cursorSession} from './cursor.ts';
import {grokBotSession,grokBotUnsupported,GROK_BOT_MAX_HOOK_BYTES} from './grok-bot.ts';
import {type Harness} from './parse.ts';
import {devinSession,devinUnsupported,DEVIN_MAX_HOOK_BYTES} from './devin.ts';
import {codexNativeSession} from './codex-session.ts';

type Binding={api:string,installationId:string,owner:{tenantId:string,userId:string}};
export type DaemonRegistration=Binding&{harness:Harness,sessionId:string,path:string,cwd?:string,pid?:number,endedAt?:number,at:number,hook?:Record<string,unknown>};
export type DaemonNotice=Binding&{kind:'capture',id:string,at:number,record:CaptureHookNotice,pid?:number};
export const sameDaemonBinding=(record:Binding,config:CaptureConfig)=>!config.authPending&&record.api===config.api&&record.installationId===config.installationId&&record.owner?.tenantId===config.owner.tenantId&&record.owner?.userId===config.owner.userId;

/** Lexical validation also works before the native writer creates its file.
 * The existing parser independently checks the real path before opening it. */
export function daemonPathAllowed(config:CaptureConfig,harness:Harness,sessionId:string,file:string) {
  const root=resolve(harnessRoot(config,harness)),path=resolve(file),parts=relative(root,path).split(sep);
  if(harness==='claude-code')return parts[0]==='projects'&&parts.length===3&&basename(path)===sessionId+'.jsonl';
  if(harness==='codex')return ['sessions','archived_sessions'].includes(parts[0]??'')&&path.endsWith('.jsonl')&&basename(path).endsWith('-'+sessionId+'.jsonl');
  if(harness==='cursor')return parts.length===5&&parts[0]==='projects'&&parts[2]==='agent-transcripts'&&parts[3]===sessionId&&parts[4]===sessionId+'.jsonl';
  if(harness==='antigravity')return antigravityBrainDirs(root).some(({dir})=>{
    const segments=relative(dir,path).split(sep);return segments.length===4&&segments[0]===sessionId&&segments[1]==='.system_generated'&&segments[2]==='logs'&&['transcript.jsonl','transcript_full.jsonl'].includes(segments[3]!);
  });
  return false;
}

export function daemonSession(harness:Harness,event:any,at:string) {
  if(harness==='cursor')return cursorSession(event);
  if(harness==='grok-bot')return grokBotSession(event,at);
  if(harness==='devin')return devinSession(event);
  const fields=harness==='antigravity'?antigravityHookFields(event):{sessionId:event?.session_id,cwd:typeof event?.cwd==='string'?event.cwd:undefined};
  if(typeof fields.sessionId!=='string'||!/^[\w.:-]{1,200}$/.test(fields.sessionId))throw Error('Hook missing a native session ID');
  return {sessionId:fields.sessionId,cwd:fields.cwd};
}

/** One bounded, durable local write. No auth, network, transcript read, history
 * lookup or shared configuration lock runs on the native hook's path. */
export function recordNativeDaemonHook(harness:Harness,event:any,pid=process.ppid) {
  const config=readCaptureConfig();if(!config||config.disabled||config.authPending||!captureDaemonEnabled(config)||!config.harnesses?.includes(harness))return false;
  if(!event||typeof event!=='object'||Array.isArray(event))throw Error('Hook payload is not an object');
  if((harness==='claude-code'||harness==='codex')&&event.cursor_version)return false;
  if(harness==='claude-code'&&!['SessionStart','UserPromptSubmit','SessionEnd'].includes(event.hook_event_name))return false;
  const id=randomUUID(),at=Date.now(),time=new Date(at).toISOString(),session=daemonSession(harness,event,time);
  if(captureExcluded(config,{sessionId:session.sessionId,cwd:session.cwd??undefined}))return false;
  if(harness==='claude-code'&&(typeof event.transcript_path!=='string'||!daemonPathAllowed(config,harness,session.sessionId,event.transcript_path)))throw Error('Claude transcript outside configured session');
  const bytes=Buffer.byteLength(JSON.stringify(event));
  const maxBytes=harness==='devin'?DEVIN_MAX_HOOK_BYTES:GROK_BOT_MAX_HOOK_BYTES;
  if(bytes>maxBytes){
    if(harness==='cursor'||harness==='grok-bot'||harness==='devin'){
      event=(harness==='devin'?devinUnsupported:grokBotUnsupported)(event,'too_large',bytes);
      if(Buffer.byteLength(JSON.stringify(event))>maxBytes)throw new CliError('CAPTURE_HOOK_TOO_LARGE','Native hook metadata exceeds the local handoff limit');
    }
    else throw new CliError('CAPTURE_HOOK_TOO_LARGE','Capture hook exceeds 8 MiB; source transcript is preserved');
  }
  // Devin expands delivery into call, result and message; reserve adjacent IDs.
  const sequence=Math.round((performance.timeOrigin+performance.now())*1000)*(harness==='devin'?3:1);
  if(!Number.isSafeInteger(sequence+2))throw new CliError('CAPTURE_EVENT_INVALID','Native hook sequence exceeds the supported range');
  const record:CaptureHookNotice={id,at:time,sequence,harness,event};
  const notice:DaemonNotice={kind:'capture',id,at,api:config.api,installationId:config.installationId,owner:{tenantId:config.owner.tenantId,userId:config.owner.userId},record,...(harness==='claude-code'?{pid}:{})};
  // Do not copy tool payloads into the persistent session registration.
  if(harness==='claude-code')notice.record.event={session_id:session.sessionId,cwd:session.cwd,transcript_path:event.transcript_path,hook_event_name:event.hook_event_name};
  if(harness==='claude-code'&&(!Number.isSafeInteger(pid)||pid<=0))throw Error('Invalid Claude process identity');
  const inbox=join(captureDir(),'daemon','inbox');mkdirSync(inbox,{recursive:true,mode:0o700});
  const current=readCaptureConfig();
  if(!current||current.disabled||!captureDaemonEnabled(current)||!current.harnesses?.includes(harness)||!sameDaemonBinding(notice,current)||captureExcluded(current,{sessionId:session.sessionId,cwd:session.cwd??undefined}))return false;
  atomicJson(join(inbox,sequence+'-'+id+'.json'),notice);return true;
}

export function daemonRegistration(config:CaptureConfig,notice:DaemonNotice):DaemonRegistration|null {
  const {harness,event,at}=notice.record,session=daemonSession(harness,event,at);
  if(harness==='grok-bot'||harness==='devin')return null;
  const raw=harness==='antigravity'?antigravityHookFields(event).transcriptPath:event.transcript_path??(harness==='codex'?codexNativeSession(harnessRoot(config,harness),session.sessionId)?.path:undefined);
  // Text transcript metadata is not a native Cursor JSONL; content hooks are
  // still authoritative. Never search for a different transcript by scanning.
  if(typeof raw!=='string'||!raw.endsWith('.jsonl'))return null;
  const path=resolve(raw);
  if(!daemonPathAllowed(config,harness,session.sessionId,path))throw Error('Transcript outside the native session');
  const name=harness==='antigravity'?antigravityHookFields(event).hookEventName:event.hook_event_name;
  const ended=['SessionEnd','sessionEnd','Stop','stop'].includes(name??'');
  const hook=Object.fromEntries(['session_id','conversation_id','conversationId','cwd','workspace_roots','workspacePaths','generation_id','is_background_agent','parent_conversation_id','cursor_version'].filter(key=>event[key]!==undefined).map(key=>[key,event[key]]));
  return {harness,sessionId:session.sessionId,path,cwd:session.cwd??undefined,pid:notice.pid,at:notice.at,...(ended?{endedAt:notice.at}:{}),hook,
    api:notice.api,installationId:notice.installationId,owner:notice.owner};
}

/** Subagent hooks carry the parent's common session_id. Only their explicit
 * child ID/path or a matching indexed native parent link enrolls the child. */
export function daemonSubagent(config:CaptureConfig,notice:DaemonNotice):DaemonRegistration|null {
  if(notice.record.harness!=='codex')return null;
  const event=notice.record.event;
  if(!['SubagentStart','SubagentStop'].includes(event.hook_event_name)||typeof event.agent_id!=='string'||!/^[\w.:-]{1,200}$/.test(event.agent_id))return null;
  const indexed=event.agent_transcript_path?null:codexNativeSession(harnessRoot(config,'codex'),event.agent_id);
  if(!event.agent_transcript_path&&indexed?.parentId!==event.session_id)return null;
  const child={...notice,record:{...notice.record,event:{session_id:event.agent_id,transcript_path:event.agent_transcript_path??indexed?.path,cwd:event.cwd,hook_event_name:event.hook_event_name==='SubagentStop'?'Stop':'SessionStart'}}};
  return daemonRegistration(config,child);
}
