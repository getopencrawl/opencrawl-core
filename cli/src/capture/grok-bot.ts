import {basename} from 'node:path';
import {hash} from './parse.ts';

/** Grok Bot runs a person's Bots on one cloud computer. This collector reads no
 * Grok Bot transcript, so a session is assembled from the hook payloads
 * themselves. Two engines deliver those hooks, and one install serves both:
 *
 * - Cursor's reads the entries in ~/.cursor/hooks.json and sends Cursor's
 *   payload: hook_event_name "postToolUse", conversation_id, tool_output, the
 *   reply on afterAgentResponse.
 * - Grok's runs matcher groups, which ~/.grok/hooks/*.json holds, and sends its
 *   own envelope: hook_event_name "PostToolUse" beside hookEventName
 *   "post_tool_use", sessionId, toolResult, the reply as lastAssistantMessage
 *   on Stop, and the time of the dispatch.
 *
 * No permission hook is registered: preToolUse and subagentStart block the
 * action on an invalid response, and postToolUse already carries the tool
 * input. Capture can therefore never deny or delay a decision. */
export const GROK_BOT_HOOK_EVENTS = ['sessionStart','sessionEnd','beforeSubmitPrompt','afterAgentResponse','afterAgentThought','postToolUse','postToolUseFailure','preCompact','stop'] as const;
/** The same moments under the names Grok's engine dispatches. StopCancelled and
 * StopFailure end a turn that Stop never reports. */
export const GROK_ENGINE_HOOK_EVENTS = ['SessionStart','SessionEnd','UserPromptSubmit','PostToolUse','PostToolUseFailure','PreCompact','Stop','StopCancelled','StopFailure'] as const;
/** A turn or session ended: the cheapest moment to upload. */
export const GROK_BOT_BOUNDARIES = ['stop','stopCancelled','stopFailure','sessionStart','sessionEnd'];
/** One hook payload becomes at most two events, well under the 16 MiB batch limit. */
export const GROK_BOT_MAX_HOOK_BYTES = 8 * 1024 * 1024;
const PERMISSION_HOOKS = ['preToolUse','subagentStart','beforeShellExecution','beforeMCPExecution','beforeReadFile','beforeTabFileRead'];
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : null;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
/** The first of these fields the payload carries. Grok spells its own fields in
 * camelCase and repeats some under Claude Code's snake_case names. */
const field = (event: any, ...keys: string[]) => {
  for (const key of keys) if (event?.[key] !== undefined && event[key] !== null) return event[key];
  return undefined;
};

// Keyed without case or separators, so "postToolUse", "PostToolUse" and
// "post_tool_use" are one event. A Map, because the name is the payload's.
const HOOK_NAMES = new Map<string, string>([
  ...[...GROK_BOT_HOOK_EVENTS, ...PERMISSION_HOOKS, 'stopCancelled', 'stopFailure', 'postCompact', 'subagentStop'].map((name): [string, string] => [name.toLowerCase(), name]),
  ['userpromptsubmit', 'beforeSubmitPrompt'], ['subagentend', 'subagentStop'],
]);
/** The hook under Cursor's name for it, whichever engine and spelling sent it.
 * A name neither engine documents is returned as it arrived. */
export function grokBotHookName(event: any): string | null {
  const name = text(event?.hook_event_name) ?? text(event?.hookEventName);
  return name ? HOOK_NAMES.get(name.replace(/[^A-Za-z]/g, '').toLowerCase()) ?? name : null;
}

/** The explicit answer each hook type expects. Only reached for hooks someone
 * wired by hand when it grants a permission; capture never withholds one. */
export function grokBotResponse(event: any) {
  const name = grokBotHookName(event);
  if (name === 'beforeSubmitPrompt') return {continue: true};
  return name && PERMISSION_HOOKS.includes(name) ? {permission: 'allow'} : {};
}

/** Grok's engine stamps every dispatch, to the nanosecond. The stamp makes a
 * dispatch that reaches two of this collector's registrations one event rather
 * than two, and orders events as the runtime produced them. Only a stamp with
 * at least microseconds is `precise` enough to order by: a coarser one would
 * give every event in the same second the same place. */
export function grokBotStamp(event: any): {at: string; sequence: number; precise: boolean} | null {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(text(event?.timestamp) ?? '');
  if (!match) return null;
  const seconds = Date.parse(match[1] + match[3]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const micros = Number(((match[2] ?? '') + '000000').slice(0, 6)), sequence = seconds * 1000 + micros;
  // Microseconds since the epoch stay exact until the year 2255.
  return Number.isSafeInteger(sequence) ? {at: new Date(seconds + Math.floor(micros / 1000)).toISOString(), sequence, precise: (match[2]?.length ?? 0) >= 6} : null;
}

/** Grok Bot gives a Bot one conversation ID for its whole life, so a session is
 * that Bot's work on one UTC day: readable, and far below the per-session event
 * limit that an endless conversation would eventually reach. Excluding the
 * conversation ID excludes every day of it.
 *
 * Some runtimes send blank IDs. Their activity is grouped by workspace and day,
 * which keeps it searchable without presenting it as a conversation. */
export function grokBotSession(event: any, at: string) {
  const native = text(event?.conversation_id) ?? text(event?.session_id) ?? text(event?.sessionId), day = at.slice(0, 10);
  const roots = Array.isArray(event?.workspace_roots) ? event.workspace_roots.filter((root: unknown) => typeof root === 'string' && root) : [];
  // Grok names the workspace on every event, while its cwd follows each tool call.
  const root = text(event?.workspaceRoot);
  const cwd: string | null = root ?? text(event?.cwd) ?? roots[0] ?? null;
  const version = text(event?.cursor_version);
  if (native) {
    const bot = /^[\w.:-]{1,180}$/.test(native) ? native : 'conversation-' + hash(native).slice(0, 32);
    return {sessionId: `${bot}:${day}`, identified: true, conversationId: native.length <= 200 ? native : null, cwd, version, title: null, day};
  }
  const workspace: string = root ?? roots[0] ?? cwd ?? '';
  return {sessionId: `activity-${hash(workspace).slice(0, 16)}-${day}`, identified: false, conversationId: null, cwd, version,
    title: `Grok Bot activity in ${basename(workspace) || 'an unknown workspace'} on ${day}`, day};
}

/** Every directory a payload names: the workspace, and under Grok's engine the
 * directory of the tool call or the launch beside it. An exclusion of any one
 * of them keeps the event on this computer. */
export function grokBotPaths(event: any): string[] {
  const roots = Array.isArray(event?.workspace_roots) ? event.workspace_roots : [];
  return [...new Set([event?.cwd, event?.workspaceRoot, ...roots].filter((path): path is string => typeof path === 'string' && Boolean(path.trim())))];
}

const deeper = (value: unknown, limit: number): boolean => value !== null && typeof value === 'object' && (limit === 0 || Object.values(value).some(child => deeper(child, limit - 1)));
/** Tool payloads arrive JSON-stringified. Restore the structure so inline
 * images become attachments instead of megabytes of indexed base64 text.
 * Events nest at most 128 levels, so deeper JSON stays the text it arrived as. */
function structured(value: unknown) {
  if (typeof value !== 'string' || !/^\s*[[{]/.test(value)) return value;
  try {const parsed = JSON.parse(value); return deeper(parsed, 96) ? value : parsed;} catch {return value;}
}
/** Grok's shell result repeats its output as an array of byte values beside the
 * text the model read. Keep the text; the bytes are several times its size. */
function toolResult(value: unknown) {
  const result: any = structured(value);
  if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.output_for_prompt !== 'string') return result;
  if (!Array.isArray(result.output) || !result.output.every((byte: unknown) => Number.isInteger(byte))) return result;
  const kept = {...result};
  delete kept.output;
  return kept;
}

/** A payload that can never be uploaded is kept as evidence that it happened,
 * so it cannot hold back the events around it. */
export function grokBotUnsupported(event: any, captureStatus: 'too_large' | 'unsupported', bytes: number) {
  const kept = ['hook_event_name','hookEventName','conversation_id','session_id','sessionId','generation_id','promptId','timestamp','workspace_roots','workspaceRoot','cwd','cursor_version',
    'tool_name','toolName','tool_use_id','toolUseId','duration','durationMs'];
  return {...Object.fromEntries(kept.filter(key => event?.[key] !== undefined).map(key => [key, event[key]])), captureStatus, bytes};
}

type Notice = {id: string; at: string; sequence?: number; event: any};
/** Message, reasoning, tool and compaction events in the shapes Claude Code and
 * Codex capture already produces. Lifecycle hooks and payloads without usable
 * content stay as unindexed hook evidence. */
export function grokBotEvents(notice: Notice) {
  const event = notice.event ?? {}, name = grokBotHookName(event), sequence = notice.sequence ?? 0;
  const turnId = text(event.generation_id) ?? text(event.promptId);
  const make = (suffix: string, kind: string, data: any, nativeId: string | null = null, order = 0) =>
    ({id: notice.id + suffix, kind, sequence: sequence + order, timestamp: notice.at, nativeId, parentId: null, turnId, agentId: null, data});
  const evidence = () => [make('', 'hook', event)];
  const reply = (value: unknown) => {
    const answer = text(value), model = text(event.model_id) ?? text(event.model);
    return answer ? [make('', 'message', {role: 'assistant', content: [{type: 'text', text: answer}], ...(model ? {model} : {})})] : evidence();
  };
  if (event.captureStatus) return evidence();
  if (name === 'beforeSubmitPrompt') {
    const prompt = text(event.prompt);
    if (!prompt) return evidence();
    // Referenced files and rules are paths the person attached, never file bytes.
    const attachments = Array.isArray(event.attachments) ? event.attachments.filter((a: any) => typeof a?.file_path === 'string').map((a: any) => ({type: a.type, file_path: a.file_path})) : [];
    return [make('', 'message', {role: 'user', content: [{type: 'text', text: prompt}], ...(attachments.length ? {attachments} : {})})];
  }
  if (name === 'afterAgentResponse') return reply(event.text);
  // Grok's engine has no reply hook: the turn's answer arrives when the turn
  // ends. An interrupted turn reports what it had already said. A failed turn
  // puts the error text in this field, which is not something the Bot said.
  if (name === 'stop' || name === 'stopCancelled') return reply(field(event, 'lastAssistantMessage', 'last_assistant_message'));
  if (name === 'afterAgentThought') {
    const thought = text(event.text);
    return thought ? [make('', 'reasoning_summary', {type: 'reasoning', summary: [{type: 'summary_text', text: thought}], ...(finite(event.duration_ms) ? {duration_ms: event.duration_ms} : {})})] : evidence();
  }
  if (name === 'postToolUse' || name === 'postToolUseFailure') {
    const tool = text(field(event, 'tool_name', 'toolName'));
    if (!tool) return evidence();
    const callId = text(field(event, 'tool_use_id', 'toolUseId')), call = callId ? {call_id: callId} : {}, failed = name === 'postToolUseFailure';
    const duration = field(event, 'duration', 'durationMs', 'duration_ms'), interrupt = field(event, 'is_interrupt', 'isInterrupt');
    return [
      make(':call', 'tool_call', {type: 'tool_use', name: tool, input: structured(field(event, 'tool_input', 'toolInput')) ?? null, ...call}, callId),
      make(':result', 'tool_result', {type: 'tool_result', name: tool, ...call,
        output: failed ? text(field(event, 'error_message', 'error')) ?? '' : toolResult(field(event, 'tool_output', 'toolResult', 'tool_response')) ?? null,
        ...(failed ? {is_error: true, ...(text(event.failure_type) ? {failure_type: event.failure_type} : {}), ...(typeof interrupt === 'boolean' ? {is_interrupt: interrupt} : {})} : {}),
        ...(finite(duration) ? {duration_ms: duration} : {})}, callId, 1),
    ];
  }
  if (name === 'preCompact') {
    const fields = ['trigger','context_usage_percent','context_tokens','context_window_size','message_count','messages_to_compact','is_first_compaction'];
    return [make('', 'compaction', Object.fromEntries(fields.filter(key => event[key] !== undefined).map(key => [key, event[key]])))];
  }
  return evidence();
}

/** Names an activity log, which has no first prompt to fall back on. Identical
 * on every batch of the session, so repeats are the same event. */
export function grokBotTitleEvent(sessionId: string, title: string, day: string) {
  return {id: hash('grok-bot-title:' + sessionId), kind: 'session_title', sequence: 0, timestamp: day + 'T00:00:00.000Z', data: {title, titleType: 'auto'}};
}
