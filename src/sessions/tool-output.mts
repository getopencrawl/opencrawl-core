import type {SessionEvent} from './types.mjs';
import {capturedReplicasRecord,projectReplicasRecord} from './replicas-record.mjs';

/** Canonical capture kinds and proven native result aliases. Tool calls and
 * connector records are separate; matching words in text are never a signal. */
export const TOOL_OUTPUT_KINDS=['tool_result','tool_output','function_call_output','custom_tool_call_output','exec_command_end','mcp_tool_call_end'] as const;
const outputKind=(value:unknown)=>typeof value==='string'&&(TOOL_OUTPUT_KINDS as readonly string[]).includes(value);

/** Claude places result blocks inside user-role messages. Classify the whole
 * event, including mixed text/result messages, without changing capture text. */
export function containsToolOutput(event:Pick<SessionEvent,'kind'|'data'>):boolean {
  const raw=capturedReplicasRecord(event);if(raw)event=projectReplicasRecord(raw);
  if(event.kind==='replicas_tool')return event.data?.output!==undefined||event.data?.exitCode!==undefined;
  if(outputKind(event.kind))return true;
  const data=event.data;
  if(!data||typeof data!=='object')return false;
  if(data.role==='tool'||data.role==='function'||outputKind(data.type))return true;
  function blocks(value:unknown,depth=0):boolean {
    if(depth>128)throw Object.assign(new Error('Event structure exceeds supported depth'),{status:400,permanent:true});
    if(Array.isArray(value))return value.some(block=>blocks(block,depth+1));
    if(!value||typeof value!=='object')return false;
    const block=value as Record<string,unknown>;
    if(outputKind(block.type))return true;
    // Inspect typed content blocks only, never arbitrary tool arguments or text.
    return block.content!==undefined&&blocks(block.content,depth+1);
  }
  return blocks(data.content);
}
