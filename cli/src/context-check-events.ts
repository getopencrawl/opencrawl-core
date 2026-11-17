import {createHash} from 'node:crypto';
import {constants,openSync,readSync,fstatSync,closeSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {assertSessionTranscriptPath,resolveAntigravityTranscript,type CaptureConfig} from './capture/runtime.ts';
import {parseRecord} from './capture/parse.ts';
import {redactText} from './capture/redact.ts';

export const CHECK_HARNESSES=['codex','claude-code','cursor','antigravity','devin'] as const;
export type CheckHarness=typeof CHECK_HARNESSES[number];
export type CheckEvent={sessionId:string;eventId:string;message?:string;projects:string[];delivery:boolean};
export const object=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
export const nativeId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(value);
export const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export function boundedText(value:string,bytes:number):string {
  let result='';let size=0;
  for(const character of value){size+=Buffer.byteLength(JSON.stringify(character))-2;if(size>bytes)break;result+=character;}
  return result;
}
export const checkText=(value:string,bytes:number)=>boundedText(redactText(value).replace(/\bapikey_[A-Za-z0-9_-]+/g,'[REDACTED]'),bytes);

/** Antigravity exposes model invocations, not prompt IDs. Read only the tail of
 * this exact native session, and use the explicit USER_INPUT record's byte
 * offset. Never bill per invocation or deduplicate repeated text forever. */
function antigravityPrompt(event:Record<string,unknown>,config:CaptureConfig):{eventId:string;message:string}|undefined {
  if(!nativeId(event.conversationId)||typeof event.transcriptPath!=='string'||!isAbsolute(event.transcriptPath)||typeof event.lastUserInput!=='string')return;
  const selected=resolveAntigravityTranscript(event.transcriptPath);
  const {path}=assertSessionTranscriptPath(config,'antigravity',event.conversationId,selected,event.transcriptPath);
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const before=fstatSync(fd);if(!before.isFile())return;
    const start=Math.max(0,before.size-262144),buffer=Buffer.alloc(before.size-start);
    const count=readSync(fd,buffer,0,buffer.length,start),after=fstatSync(fd);
    if(count!==buffer.length||before.size!==after.size||before.mtimeMs!==after.mtimeMs)return;
    let offset=start,index=0,last:{eventId:string;message:string}|undefined;
    if(start){const newline=buffer.indexOf(10);if(newline<0)return;index=newline+1;offset+=index;}
    while(index<buffer.length){
      const end=buffer.indexOf(10,index);if(end<0)break;
      const line=buffer.subarray(index,end).toString('utf8');
      let record:unknown;try{record=JSON.parse(line);}catch{return;}
      if(object(record)&&record.type==='USER_INPUT'){
        // An intervening automation input cannot masquerade as the human prompt.
        last=undefined;
        if(!record.source||record.source==='USER_EXPLICIT'){
          const parsed=parseRecord('antigravity',record,offset);
          const content:unknown=parsed?.data?.content;
          const text=Array.isArray(content)?content.flatMap(block=>object(block)&&block.type==='text'&&typeof block.text==='string'?[block.text]:[]).join('\n'):'';
          if(text.trim()===event.lastUserInput.trim())last={eventId:'agy:'+hash(JSON.stringify([before.dev,before.ino,offset,line])),message:text};
        }
      }
      offset+=end-index+1;index=end+1;
    }
    return last;
  }finally{closeSync(fd);}
}

/** No tool content, assistant messages, imported hooks or subagent tasks are
 * treated as human prompts. Missing native prompt identity fails closed. */
export function checkEvent(harness:CheckHarness,event:unknown,config:CaptureConfig):CheckEvent|undefined {
  if(!object(event)||event.agent_id!=null||event.subagent_id!=null||event.parent_conversation_id!=null)return;
  if(harness!=='cursor'&&typeof event.cursor_version==='string')return;
  const projects=typeof event.cwd==='string'?[event.cwd]:Array.isArray(event.workspace_roots)?event.workspace_roots.filter((v):v is string=>typeof v==='string'):Array.isArray(event.workspacePaths)?event.workspacePaths.filter((v):v is string=>typeof v==='string'):[];
  if(projects.length>16||projects.some(path=>!isAbsolute(path)))return;
  if(harness==='antigravity'){
    if(event.hookEventName!=='PreInvocation')return;
    const prompt=antigravityPrompt(event,config);if(!prompt||!nativeId(event.conversationId))return;
    return {sessionId:event.conversationId,...prompt,projects,delivery:true};
  }
  const session=harness==='cursor'?event.conversation_id:event.session_id;
  const id=harness==='codex'?event.turn_id:harness==='cursor'?event.generation_id:event.prompt_id;
  if(!nativeId(session)||!nativeId(id))return;
  const submit=event.hook_event_name===(harness==='cursor'?'beforeSubmitPrompt':'UserPromptSubmit');
  const delivery=harness==='cursor'?['postToolUse','postToolUseFailure'].includes(String(event.hook_event_name)):harness==='devin'&&event.hook_event_name==='PostToolUse';
  if(!submit&&!delivery)return;
  if(submit&&(typeof event.prompt!=='string'||!event.prompt.trim()))return;
  // A steered Codex message can share an active turn ID. Distinct messages in
  // that turn still get their own receipt; retries of the same event do not.
  return {sessionId:session,eventId:harness==='codex'?'codex:'+hash(JSON.stringify([id,event.prompt])):id,projects,delivery,...(submit?{message:event.prompt as string}:{})};
}

export function checkOutput(harness:CheckHarness,text:string):Record<string,unknown> {
  if(harness==='cursor')return {additional_context:text};
  if(harness==='antigravity')return {injectSteps:[{ephemeralMessage:text}]};
  return {hookSpecificOutput:{hookEventName:harness==='devin'?'PostToolUse':'UserPromptSubmit',additionalContext:text}};
}
