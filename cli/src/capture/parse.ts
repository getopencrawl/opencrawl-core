import {createHash} from 'node:crypto';
import {CliError} from '../oauth.ts';
export type Harness = 'claude-code'|'codex'|'grok-bot';
/** Harnesses that persist a native transcript this collector reads. Grok Bot
 * sessions are assembled from hook payloads instead; see grok-bot.ts. */
export type TranscriptHarness = Exclude<Harness,'grok-bot'>;
export const HARNESSES:Harness[] = ['claude-code','codex','grok-bot'];
export const readsTranscript = (harness:Harness): harness is TranscriptHarness => harness!=='grok-bot';
export type Origin = 'cli'|'desktop'|'cloud'|'subagent'|'unknown';
export const hash = (data: string|Buffer) => createHash('sha256').update(data).digest('hex');
/** Finalize only after attachment extraction and metadata normalization. The
 * source ID distinguishes native positions/notices; every serialized field
 * distinguishes revisions. Existing queued batches must never pass here again.
 */
export function finalizeEventIdentity(event:any) {
  const wire=JSON.parse(JSON.stringify(event));
  if(!wire||typeof wire.id!=='string'||!wire.id)throw new CliError('CAPTURE_EVENT_INVALID','Capture event has no source identity');
  const digest=createHash('sha256').update('opencrawl-wire-event-v1\n');
  // Buffer small canonical fragments to avoid one native hash call per key
  // or separator. Large strings go directly to the hash; extra space is bounded.
  let pieces:string[]=[],characters=0;
  const flush=()=>{if(characters){digest.update(pieces.join(''));pieces=[];characters=0;}};
  const write=(text:string)=>{
   if(text.length>=16384){flush();digest.update(text);return;}
   pieces.push(text);characters+=text.length;if(characters>=16384)flush();
  };
  function visit(value:any,depth=0) {
    if(depth>128)throw new CliError('CAPTURE_EVENT_TOO_DEEP','Capture event exceeds the supported nesting depth');
    if(value===null||typeof value!=='object'){write(JSON.stringify(value));return;}
    if(Array.isArray(value)){write('[');for(let i=0;i<value.length;i++){if(i)write(',');visit(value[i],depth+1);}write(']');return;}
    write('{');let first=true;
    for(const key of Object.keys(value).sort()){if(!first)write(',');first=false;write(JSON.stringify(key)+':');visit(value[key],depth+1);}
    write('}');
  }
  visit(wire);flush();
  wire.id='wire1:'+digest.digest('hex');
  return wire;
}
export function detectOrigin(harness: Harness, record: any, environment:NodeJS.ProcessEnv=process.env): {origin:Origin, evidence:string|null} {
  const r = harness === 'codex' ? record.payload ?? record : record;
  if(harness==='claude-code' && r.type==='attachment' && r.attachment?.type==='remote_session_change' && /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+$/.test(r.attachment.url??'')) return {origin:'cloud',evidence:r.attachment.url};
  const value = [r.originator, r.entrypoint, typeof r.source === 'string' ? r.source : '', r.client].filter(Boolean).join(' ');
  if (typeof r.source === 'object' && r.source?.subagent || r.isSidechain || r.agentId) return {origin:'subagent',evidence:JSON.stringify(r.source ?? {agentId:r.agentId})};
  // Runtime provenance is descriptive, never an authentication claim. Replicas
  // starts SDK agents without Claude's remote URL or Codex's cloud originator.
  if(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(environment.REPLICAS_WORKSPACE_ID??''))return {origin:'cloud',evidence:'https://app.replicas.dev/workspace/'+environment.REPLICAS_WORKSPACE_ID};
  if (harness==='codex' && /^(cli|exec|tui)$/.test(r.source ?? ''))return {origin:'cli',evidence:value};
  if (/desktop|claude-desktop|local-agent/i.test(value)) return {origin:'desktop',evidence:value};
  if (/^(cli|exec|tui)$/.test(r.source ?? '') || /^(cli|sdk-cli|cli-print|cli-interactive)$/.test(r.entrypoint ?? '') || /codex_cli_rs/.test(value)) return {origin:'cli',evidence:value};
  return {origin:'unknown',evidence:value || null};
}

/** Preserve native message/tool content; discard repeated system/developer prompts and UI/transport bookkeeping. */
export function parseRecord(harness: Harness, record: any, offset: number) {
  const r = record.payload ?? {};
  let kind: string|undefined, data: any;
  if (harness === 'claude-code') {
    if (['user','assistant'].includes(record.type)) {
      if(record.type==='user'&&record.isMeta===true)return null;
      kind=record.type==='user'&&record.origin?.kind==='task-notification'?'automation_message':'message';data=record.message;
    }
    else if (['custom-title','ai-title'].includes(record.type)) {
      const title=record.type==='custom-title'?record.customTitle:record.aiTitle;
      if(typeof title!=='string'||!title.trim())return null;
      kind='session_title';data={title:title.trim(),titleType:record.type==='custom-title'?'custom':'auto'};
    }
    else if (record.type === 'attachment') {
      const attachment=record.attachment;
      if(['prompt_snapshot','instructions','mcp_instructions_delta','credential_org','environment','date','model','agent_listing_delta','deferred_tools_delta','deferred_tools_record','skill_listing','auto_mode','session_context','task_reminder','silent_turn_reminder','command_permissions','thinking_drop'].includes(attachment?.type))return null;
      // Claude's SDK records messages delivered during a turn as queued prompts.
      // Preserve the content blocks (including images) as conversation, without
      // treating system/task notifications or other queued modes as human input.
      if(attachment?.type==='queued_command' && attachment.commandMode==='prompt' && (typeof attachment.prompt==='string'||Array.isArray(attachment.prompt))) {
        kind='message';data={role:'user',content:attachment.prompt};
      } else {kind=attachment?.type==='remote_session_change'?'session_metadata':'attachment';data=attachment;}
    }
    else if (record.type === 'system' && /compact/.test(record.subtype ?? '')) {kind='compaction';data=record;}
    else if (record.type === 'summary') {kind='compaction';data=record;}
  } else {
    if (record.type === 'response_item') {
      if (r.type === 'message' && ['user','assistant'].includes(r.role)) {kind='message';data=r;}
      else if (r.type === 'agent_message') {
        kind='agent_message';
        data={type:r.type,author:r.author,recipient:r.recipient,content:Array.isArray(r.content)?r.content.filter((block:any)=>block?.type!=='encrypted_content'):r.content};
      }
      else if (/call|tool/.test(r.type ?? '')) {kind=/output|result/.test(r.type) ? 'tool_result':'tool_call';data=r;}
      else if (r.type === 'reasoning' && r.summary?.length) {kind='reasoning_summary';data={type:r.type,summary:r.summary};}
    } else if (record.type === 'turn_context') {kind='turn_metadata';data={turn_id:r.turn_id,model:r.model,model_provider:r.model_provider,effort:r.effort,cwd:r.cwd};}
    else if (record.type === 'compacted') {kind='compaction';data=r;}
    // Raw tool execution evidence, attachments and subagent relationships not always represented as response items.
    else if (record.type === 'event_msg' && /exec_command_end|mcp_tool_call_end|collab_|view_image|user_message|token_count/.test(r.type ?? '')) {kind=r.type;data=r;}
    else if (record.type === 'session_meta') {kind='session_metadata';data={id:r.id,source:r.source,originator:r.originator,cli_version:r.cli_version,cwd:r.cwd,git:r.git,forked_from_id:r.forked_from_id,...(typeof r.title==='string'?{title:r.title}:{})};}
  }
  if (!kind) return null;
  return {id:hash(harness+':'+offset+':'+JSON.stringify(record)), kind, sequence:offset, timestamp:record.timestamp ?? null,
    nativeId:record.uuid ?? r.id ?? null, parentId:record.parentUuid ?? null,
    turnId:r.turn_id ?? record.turnId ?? null, agentId:record.agentId ?? null, data};
}
