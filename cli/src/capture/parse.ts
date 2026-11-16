import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {CliError} from '../oauth.ts';
export type Harness = 'claude-code'|'codex'|'cursor'|'grok-bot'|'antigravity'|'devin'|'reason';
/** Harnesses that persist a native transcript this collector reads. Cursor and Grok Bot
 * sessions are assembled from hook payloads instead; see cursor.ts and grok-bot.ts. */
export type TranscriptHarness = Exclude<Harness,'grok-bot'|'cursor'|'devin'>;
export const HARNESSES:Harness[] = ['claude-code','codex','cursor','grok-bot','antigravity','devin','reason'];
export const readsTranscript = (harness:Harness): harness is TranscriptHarness => harness==='claude-code'||harness==='codex'||harness==='antigravity'||harness==='reason';
/** Normalize CLI flag aliases ('agy' -> 'antigravity') before validation. */
export const normalizeHarness = <T extends string|undefined>(value:T): T|('antigravity' extends T ? 'antigravity' : string) => (value==='agy'?'antigravity':value) as any;
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
  if (harness === 'antigravity') {
    if(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(environment.REPLICAS_WORKSPACE_ID??''))return {origin:'cloud',evidence:'https://app.replicas.dev/workspace/'+environment.REPLICAS_WORKSPACE_ID};
    return {origin:'unknown',evidence:null};
  }
  // The session log does not say which surface started the agent.
  if (harness === 'reason') return {origin:'unknown',evidence:null};
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

/** New Codex transcripts put injected setup in user-role messages, with native
 * per-block provenance. Text that merely looks like instructions is still user
 * content; omit only the two explicitly identified setup block types. */
function codexConversationMessage(message:any) {
  const metadata=message.internal_chat_message_metadata_passthrough;
  const content=message.content,kinds=metadata?.content_item_kinds,items=metadata?.content_item_metadata;
  if(message.role!=='user'||!Array.isArray(content)||!Array.isArray(kinds)||!Array.isArray(items)||content.length!==kinds.length||content.length!==items.length)return message;
  const keep=content.map((_:unknown,index:number)=>index).filter(index=>
    !(kinds[index]==='agents_md.instructions'&&items[index]?.provenance?.type==='agents_md')&&
    !(kinds[index]==='environments.environment_context'&&items[index]?.provenance?.type==='harness'));
  if(keep.length===content.length)return message;
  if(!keep.length)return null;
  return {...message,content:keep.map(index=>content[index]),internal_chat_message_metadata_passthrough:{...metadata,
    content_item_kinds:keep.map(index=>kinds[index]),content_item_metadata:keep.map(index=>items[index])}};
}

function antigravityMediaBlocks(media:any):any[] {
  if(!Array.isArray(media))return [];
  const blocks:any[]=[];
  for(const item of media) {
    const uri=typeof item?.uri==='string'?item.uri.trim():'';
    if(!uri)continue;
    const mime=typeof item?.mime_type==='string'&&item.mime_type?item.mime_type:undefined;
    if(/^https?:\/\//i.test(uri)) {
      blocks.push({type:'url',url:uri,...(mime?{media_type:mime}:{})});
      continue;
    }
    let path=uri;
    if(uri.startsWith('file://')) {
      try{path=fileURLToPath(uri);}catch{path=decodeURIComponent(uri.slice('file://'.length));}
    }
    blocks.push({type:'input_file',path,...(mime?{media_type:mime}:{})});
  }
  return blocks;
}

function antigravityUserText(raw:string):string {
  const match=/<USER_REQUEST>\r?\n?([\s\S]*?)\r?\n?<\/USER_REQUEST>/.exec(raw);
  if(match)return match[1]!;
  return raw.replace(/<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*?<\/(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>/g,'').trim();
}

/** Reason capture reads one session log per conversation in the Pi session format:
 * <agent dir>/sessions/--<cwd>--/<timestamp>_<session id>.jsonl. */
export const reasonTranscriptName = (name:string,sessionId:string) => name.endsWith('.jsonl')&&name.slice(0,-'.jsonl'.length).endsWith('_'+sessionId);
/** A forked session names its parent by file path, not by ID. */
export function reasonParentSessionId(parentSession:unknown):string|null {
  if(typeof parentSession!=='string')return null;
  const match=/_([\w.:-]{1,200})\.jsonl$/.exec(parentSession.split(/[\\/]/).pop()??'');
  return match?match[1]!:null;
}
function reasonBlocks(content:any,role:'user'|'assistant'):any[] {
  if(typeof content==='string')return content.trim()?[{type:'text',text:content}]:[];
  if(!Array.isArray(content))return [];
  const blocks:any[]=[];
  for(const block of content) {
    if(!block||typeof block!=='object')continue;
    if(block.type==='text'&&typeof block.text==='string'){if(block.text.trim())blocks.push({type:'text',text:block.text});}
    // Signatures are opaque provider replay data; redacted thinking has no text.
    else if(block.type==='thinking'&&role==='assistant'){if(typeof block.thinking==='string'&&block.thinking.trim())blocks.push({type:'thinking',thinking:block.thinking});}
    else if(block.type==='toolCall'&&role==='assistant'){
      if(typeof block.name==='string'&&block.name)blocks.push({type:'tool_use',...(typeof block.id==='string'&&block.id?{id:block.id}:{}),name:block.name,input:block.arguments??{}});
    }
    else if(block.type==='image'&&typeof block.data==='string')blocks.push({type:'image',source:{type:'base64',media_type:typeof block.mimeType==='string'?block.mimeType:'application/octet-stream',data:block.data}});
  }
  return blocks;
}
/** One session log entry. System messages repeat the prompt and tool
 * declarations; usage, labels, context edits and extension state are bookkeeping. */
function parseReasonRecord(record:any):{kind:string,data:any}|null {
  if(!record||typeof record!=='object')return null;
  if(record.type==='session') {
    if(typeof record.id!=='string'||!record.id)return null;
    return {kind:'session_metadata',data:{id:record.id,...(record.version!==undefined?{version:record.version}:{}),...(typeof record.cwd==='string'?{cwd:record.cwd}:{}),
      ...(reasonParentSessionId(record.parentSession)?{forked_from_id:reasonParentSessionId(record.parentSession)}:{})}};
  }
  if(record.type==='message') {
    const message=record.message;
    if(!message||typeof message!=='object')return null;
    if(message.role==='user') {
      const content=reasonBlocks(message.content,'user');
      return content.length?{kind:'message',data:{role:'user',content}}:null;
    }
    if(message.role==='assistant') {
      const content=reasonBlocks(message.content,'assistant');
      const error=typeof message.errorMessage==='string'&&message.errorMessage.trim()?message.errorMessage:null;
      if(!content.length&&!error)return null;
      return {kind:'message',data:{role:'assistant',content,
        ...(typeof message.model==='string'?{model:message.model}:{}),...(typeof message.provider==='string'?{provider:message.provider}:{}),
        ...(typeof message.stopReason==='string'?{stop_reason:message.stopReason}:{}),...(error?{error}:{}),
        ...(message.usage&&typeof message.usage==='object'?{usage:message.usage}:{})}};
    }
    if(message.role==='toolResult') {
      const blocks=reasonBlocks(message.content,'user');
      const output=blocks.filter(block=>block.type==='text').map(block=>block.text).join('\n');
      const media=blocks.filter(block=>block.type!=='text');
      return {kind:'tool_result',data:{type:'tool_result',...(typeof message.toolCallId==='string'&&message.toolCallId?{tool_use_id:message.toolCallId}:{}),
        ...(typeof message.toolName==='string'&&message.toolName?{name:message.toolName}:{}),output,...(media.length?{content:media}:{}),...(message.isError===true?{is_error:true}:{})}};
    }
    if(message.role==='bashExecution') {
      if(typeof message.command!=='string'||!message.command)return null;
      // A command the person ran directly; the same evidence shape as a recorded command execution.
      return {kind:'exec_command_end',data:{type:'user_shell_command',command:message.command,aggregated_output:typeof message.output==='string'?message.output:'',
        ...(typeof message.exitCode==='number'?{exit_code:message.exitCode}:{}),...(message.cancelled===true?{cancelled:true}:{}),...(message.truncated===true?{truncated:true}:{})}};
    }
    return null;
  }
  if(record.type==='custom_message') {
    const content=reasonBlocks(record.content,'user');
    if(!content.length)return null;
    return {kind:'automation_message',data:{source:typeof record.customType==='string'&&record.customType?record.customType:'extension',content}};
  }
  if(record.type==='compaction'||record.type==='branch_summary') {
    if(typeof record.summary!=='string'||!record.summary.trim())return null;
    return {kind:'compaction',data:{type:record.type,summary:record.summary,
      ...(typeof record.firstKeptEntryId==='string'?{firstKeptEntryId:record.firstKeptEntryId}:{}),...(typeof record.fromId==='string'?{fromId:record.fromId}:{}),
      ...(typeof record.tokensBefore==='number'?{tokensBefore:record.tokensBefore}:{})}};
  }
  if(record.type==='session_info') {
    if(typeof record.name!=='string'||!record.name.trim())return null;
    return {kind:'session_title',data:{title:record.name.trim(),titleType:'custom'}};
  }
  if(record.type==='model_change') {
    if(typeof record.modelId!=='string'||!record.modelId)return null;
    return {kind:'turn_metadata',data:{model:record.modelId,...(typeof record.provider==='string'?{model_provider:record.provider}:{})}};
  }
  if(record.type==='thinking_level_change') {
    if(typeof record.thinkingLevel!=='string'||!record.thinkingLevel)return null;
    return {kind:'turn_metadata',data:{effort:record.thinkingLevel}};
  }
  return null;
}

/** Preserve native message/tool content; discard repeated system/developer prompts and UI/transport bookkeeping. */
export function parseRecord(harness: Harness, record: any, offset: number) {
  const r = record.payload ?? {};
  let kind: string|undefined, data: any;
  if (harness === 'reason') {
    const parsed=parseReasonRecord(record);
    if(!parsed)return null;
    // The header has no entry ID; every other entry has one that is unique in its file.
    return {id:hash(harness+':'+offset+':'+JSON.stringify(record)), kind:parsed.kind, sequence:offset, timestamp:typeof record.timestamp==='string'?record.timestamp:null,
      nativeId:record.type==='session'?null:(typeof record.id==='string'?record.id:null), parentId:record.type==='session'?null:(typeof record.parentId==='string'?record.parentId:null),
      turnId:null, agentId:null, data:parsed.data};
  }
  if (harness === 'antigravity') {
    if (record.type === 'USER_INPUT') {
      const raw=typeof record.content==='string'?record.content:'';
      if (record.source && record.source !== 'USER_EXPLICIT') {
        if(!raw.trim())return null;
        kind='automation_message';data={source:record.source,content:raw};
      } else {
        const text=antigravityUserText(raw);
        const blocks=[...(text.trim()?[{type:'text',text}]:[]),...antigravityMediaBlocks(record.media)];
        if(!blocks.length)return null;
        kind='message';data={role:'user',content:blocks};
      }
    } else if (record.type === 'PLANNER_RESPONSE') {
      const blocks:any[]=[];
      if(typeof record.thinking==='string'&&record.thinking.trim())blocks.push({type:'thinking',thinking:record.thinking});
      if(typeof record.content==='string'&&record.content.trim())blocks.push({type:'text',text:record.content});
      blocks.push(...antigravityMediaBlocks(record.media));
      if(Array.isArray(record.tool_calls))for(const tc of record.tool_calls) {
        if(tc&&typeof tc.name==='string'&&tc.name)blocks.push({type:'tool_use',...(typeof tc.id==='string'&&tc.id?{id:tc.id}:{}),name:tc.name,input:tc.args??tc.input??{}});
      }
      if(!blocks.length)return null;
      kind='message';data={role:'assistant',content:blocks};
    } else if (record.type === 'GENERIC') {
      const output=typeof record.content==='string'&&record.content?record.content:(typeof record.error==='string'?record.error:'');
      const media=antigravityMediaBlocks(record.media);
      if(!output&&!media.length&&record.status!=='ERROR')return null;
      kind='tool_result';data={type:'tool_result',output,...(media.length?{content:media}:{}),...(record.status==='ERROR'?{is_error:true,...(typeof record.error==='string'?{error:record.error}:{})}:{})};
    } else if (record.type === 'SYSTEM_MESSAGE' && record.source === 'SYSTEM' && typeof record.content === 'string'
      && /(?:^|\n)\[Message\] timestamp=\S+ sender=\S+ priority=\S+ content=/.test(record.content)) {
      // Native task completions and inbox notices carry new execution evidence.
      // SessionStart prompts and repeated environment context remain filtered.
      kind='automation_message';data={source:record.source,content:record.content};
    } else if (record.type === 'CHECKPOINT' && typeof record.content === 'string' && record.content.trim()) {
      kind='compaction';data={content:record.content};
    } else if (record.type === 'ERROR_MESSAGE') {
      const content=typeof record.content==='string'?record.content:'';
      const error=typeof record.error==='string'?record.error:'';
      if(!content.trim()&&!error.trim())return null;
      kind='error';data={...(content.trim()?{content}:{}),...(error.trim()?{error}:{})};
    }
    if (!kind) return null;
    // Compact and full transcripts describe the same native steps at different
    // byte offsets. The final wire identity still distinguishes content revisions,
    // after attachment extraction/redaction, without duplicating unchanged steps.
    const step=Number.isSafeInteger(record.step_index)&&record.step_index>=0?record.step_index:null;
    return {id:hash(step===null?harness+':'+offset+':'+JSON.stringify(record):harness+':step:'+step), kind, sequence:step??offset, timestamp:record.created_at ?? record.timestamp ?? null,
      nativeId:typeof record.step_index==='number'?String(record.step_index):(record.uuid ?? null), parentId:null,
      turnId:null, agentId:null, data};
  }
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
      if (r.type === 'message' && ['user','assistant'].includes(r.role)) {kind='message';data=codexConversationMessage(r);if(!data)return null;}
      else if (r.type === 'agent_message') {
        kind='agent_message';
        data={type:r.type,author:r.author,recipient:r.recipient,content:Array.isArray(r.content)?r.content.filter((block:any)=>block?.type!=='encrypted_content'):r.content};
      }
      else if (/call|tool/.test(r.type ?? '')) {kind=/output|result/.test(r.type) ? 'tool_result':'tool_call';data=r;}
      else if (r.type === 'reasoning' && r.summary?.length) {kind='reasoning_summary';data={type:r.type,summary:r.summary};}
    } else if (record.type === 'turn_context') {kind='turn_metadata';data={turn_id:r.turn_id,model:r.model,model_provider:r.model_provider,effort:r.effort,cwd:r.cwd};}
    else if (record.type === 'compacted') {kind='compaction';data=r;}
    // Raw tool execution evidence, attachments and subagent relationships not always represented as response items.
    // Code-mode MCP calls retain their real invocation and result in native
    // item completion metadata; the outer exec call is not the MCP call.
    else if (record.type === 'event_msg' && r.type === 'item_completed' && r.item?.type === 'McpToolCall') {kind='mcp_tool_call_end';data=r;}
    else if (record.type === 'event_msg' && /exec_command_end|mcp_tool_call_end|collab_|view_image|user_message|token_count/.test(r.type ?? '')) {kind=r.type;data=r;}
    else if (record.type === 'session_meta') {kind='session_metadata';data={id:r.id,source:r.source,originator:r.originator,cli_version:r.cli_version,cwd:r.cwd,git:r.git,forked_from_id:r.forked_from_id,...(typeof r.title==='string'?{title:r.title}:{})};}
  }
  if (!kind) return null;
  return {id:hash(harness+':'+offset+':'+JSON.stringify(record)), kind, sequence:offset, timestamp:record.timestamp ?? null,
    nativeId:record.uuid ?? r.id ?? null, parentId:record.parentUuid ?? null,
    turnId:r.turn_id ?? record.turnId ?? null, agentId:record.agentId ?? null, data};
}
