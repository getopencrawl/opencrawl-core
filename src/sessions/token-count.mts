import {countTokens} from 'gpt-tokenizer/encoding/o200k_base';
import type {SessionEvent} from './types.mjs';

const AS_TEXT = {disallowedSpecial: new Set<string>()};
const OMIT = new Set(['id', 'type', 'role', 'call_id', 'tool_use_id', 'encrypted_content', 'signature', 'image_url']);
export const hasCapturedText = (harness: string, kind: string) => ['message', 'agent_message', 'tool_call', 'tool_result', 'exec_command_end'].includes(kind) || kind === 'user_message' && harness !== 'codex';
/** A stable size measure, independent of model usage and commercial metering.
 * Count message text and tool inputs/results, including imported history. */
export function capturedEventTokens(harness: string, event: SessionEvent): number {
  const data = event.data ?? {};
  let content: unknown;
  if (event.kind === 'message' || event.kind === 'agent_message') content = data.content;
  else if (event.kind === 'user_message' && harness !== 'codex') content = data.message;
  else if (event.kind === 'tool_call') content = {name: data.name, input: data.arguments ?? data.input ?? data.action};
  else if (event.kind === 'tool_result') content = data.output ?? data.content;
  else if (event.kind === 'exec_command_end') content = data.aggregated_output ?? data.formatted_output ?? data.stdout;
  else return 0;
  function tokens(value: unknown, depth = 0): number {
    if (depth > 128) throw new Error('Token content exceeds supported depth');
    if (typeof value === 'string') return value.startsWith('data:') ? 0 : countTokens(value, AS_TEXT);
    if (!value || typeof value !== 'object') return 0;
    if (Array.isArray(value)) return value.reduce((sum, part) => sum + tokens(part, depth + 1), 0);
    const fields = value as Record<string, unknown>;
    if (['thinking', 'redacted_thinking', 'image', 'input_image', 'opencrawl_attachment'].includes(String(fields.type))) return 0;
    return Object.keys(fields).sort().reduce((sum, key) => sum + (OMIT.has(key) ? 0 : tokens(fields[key], depth + 1)), 0);
  }
  return tokens(content);
}
