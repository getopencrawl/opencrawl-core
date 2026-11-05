import {createHash} from 'node:crypto';
export type Harness = 'claude-code'|'codex';
export type Origin = 'cli'|'desktop'|'cloud'|'subagent'|'unknown';
export const hash = (data: string|Buffer) => createHash('sha256').update(data).digest('hex');
export function detectOrigin(harness: Harness, record: any): {origin:Origin, evidence:string|null} {
  const r = harness === 'codex' ? record.payload ?? record : record;
  if(harness==='claude-code' && r.type==='attachment' && r.attachment?.type==='remote_session_change' && /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+$/.test(r.attachment.url??'')) return {origin:'cloud',evidence:r.attachment.url};
  const value = [r.originator, r.entrypoint, typeof r.source === 'string' ? r.source : '', r.client].filter(Boolean).join(' ');
  if (typeof r.source === 'object' && r.source?.subagent || r.isSidechain || r.agentId) return {origin:'subagent',evidence:JSON.stringify(r.source ?? {agentId:r.agentId})};
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
    if (['user','assistant'].includes(record.type)) {kind='message';data=record.message;}
    else if (record.type === 'attachment') {
      const attachment=record.attachment;
      if(['prompt_snapshot','mcp_instructions_delta','credential_org','environment','date','model','agent_listing_delta','deferred_tools_delta','skill_listing','auto_mode','session_context','task_reminder','silent_turn_reminder'].includes(attachment?.type))return null;
      kind=attachment?.type==='remote_session_change'?'session_metadata':'attachment';data=attachment;
    }
    else if (record.type === 'system' && /compact/.test(record.subtype ?? '')) {kind='compaction';data=record;}
    else if (record.type === 'summary') {kind='compaction';data=record;}
  } else {
    if (record.type === 'response_item') {
      if (r.type === 'message' && ['user','assistant'].includes(r.role)) {kind='message';data=r;}
      else if (/call|tool/.test(r.type ?? '')) {kind=/output|result/.test(r.type) ? 'tool_result':'tool_call';data=r;}
      else if (r.type === 'reasoning' && r.summary?.length) {kind='reasoning_summary';data={type:r.type,summary:r.summary};}
    } else if (record.type === 'turn_context') {kind='turn_metadata';data={turn_id:r.turn_id,model:r.model,model_provider:r.model_provider,effort:r.effort,cwd:r.cwd};}
    else if (record.type === 'compacted') {kind='compaction';data=r;}
    // Raw tool execution evidence, attachments and subagent relationships not always represented as response items.
    else if (record.type === 'event_msg' && /exec_command_end|mcp_tool_call_end|collab_|view_image|user_message|token_count/.test(r.type ?? '')) {kind=r.type;data=r;}
    else if (record.type === 'session_meta') {kind='session_metadata';data={id:r.id,source:r.source,originator:r.originator,cli_version:r.cli_version,cwd:r.cwd,git:r.git,forked_from_id:r.forked_from_id};}
  }
  if (!kind) return null;
  return {id:hash(harness+':'+offset+':'+JSON.stringify(record)), kind, sequence:offset, timestamp:record.timestamp ?? null,
    nativeId:record.uuid ?? r.id ?? null, parentId:record.parentUuid ?? null,
    turnId:r.turn_id ?? record.turnId ?? null, agentId:record.agentId ?? null, data};
}
