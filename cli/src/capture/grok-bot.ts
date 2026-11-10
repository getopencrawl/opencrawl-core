import {basename} from 'node:path';
import {hash} from './parse.ts';

/** Grok Bot runs a person's Bots on one cloud computer and loads Cursor-format
 * command hooks from ~/.cursor/hooks.json there. This collector reads no Grok
 * Bot transcript, so a session is assembled from the hook payloads themselves.
 *
 * No permission hook is registered: preToolUse and subagentStart block the
 * action on an invalid response, and postToolUse already carries the tool
 * input. Capture can therefore never deny or delay a decision. */
export const GROK_BOT_HOOK_EVENTS = ['sessionStart','sessionEnd','beforeSubmitPrompt','afterAgentResponse','afterAgentThought','postToolUse','postToolUseFailure','preCompact','stop'] as const;
/** A turn or session ended: the cheapest moment to upload. */
export const GROK_BOT_BOUNDARIES = ['stop','sessionStart','sessionEnd'];
/** One hook payload becomes at most two events, each under the 16 MiB batch limit. */
export const GROK_BOT_MAX_HOOK_BYTES = 15 * 1024 * 1024;
const PERMISSION_HOOKS = ['preToolUse','subagentStart','beforeShellExecution','beforeMCPExecution','beforeReadFile','beforeTabFileRead'];
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : null;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** The explicit answer each hook type expects. Only reached for hooks someone
 * wired by hand when it grants a permission; capture never withholds one. */
export function grokBotResponse(event: any) {
  const name = event?.hook_event_name;
  if (name === 'beforeSubmitPrompt') return {continue: true};
  return PERMISSION_HOOKS.includes(name) ? {permission: 'allow'} : {};
}

/** Grok Bot gives a Bot one conversation ID for its whole life, so a session is
 * that Bot's work on one UTC day: readable, and far below the per-session event
 * limit that an endless conversation would eventually reach. Excluding the
 * conversation ID excludes every day of it.
 *
 * Some runtimes send blank IDs. Their activity is grouped by workspace and day,
 * which keeps it searchable without presenting it as a conversation. */
export function grokBotSession(event: any, at: string) {
  const native = text(event?.conversation_id) ?? text(event?.session_id), day = at.slice(0, 10);
  const roots = Array.isArray(event?.workspace_roots) ? event.workspace_roots.filter((root: unknown) => typeof root === 'string' && root) : [];
  const cwd: string | null = text(event?.cwd) ?? roots[0] ?? null;
  const version = text(event?.cursor_version);
  if (native) {
    const bot = /^[\w.:-]{1,180}$/.test(native) ? native : 'conversation-' + hash(native).slice(0, 32);
    return {sessionId: `${bot}:${day}`, identified: true, conversationId: native.length <= 200 ? native : null, cwd, version, title: null, day};
  }
  const workspace: string = roots[0] ?? cwd ?? '';
  return {sessionId: `activity-${hash(workspace).slice(0, 16)}-${day}`, identified: false, conversationId: null, cwd, version,
    title: `Grok Bot activity in ${basename(workspace) || 'an unknown workspace'} on ${day}`, day};
}

/** Tool payloads arrive JSON-stringified. Restore the structure so inline
 * images become attachments instead of megabytes of indexed base64 text. */
function structured(value: unknown) {
  if (typeof value !== 'string' || !/^\s*[[{]/.test(value)) return value;
  try {return JSON.parse(value);} catch {return value;}
}

/** Keep a payload that cannot be uploaded as evidence that it happened. */
export function grokBotOversized(event: any, bytes: number) {
  const kept = ['hook_event_name','conversation_id','session_id','generation_id','workspace_roots','cwd','cursor_version','tool_name','tool_use_id','duration'];
  return {...Object.fromEntries(kept.filter(key => event?.[key] !== undefined).map(key => [key, event[key]])), captureStatus: 'too_large', bytes};
}

type Notice = {id: string; at: string; sequence?: number; event: any};
/** Message, reasoning, tool and compaction events in the shapes Claude Code and
 * Codex capture already produces. Lifecycle hooks and payloads without usable
 * content stay as unindexed hook evidence. */
export function grokBotEvents(notice: Notice) {
  const event = notice.event ?? {}, name = event.hook_event_name, sequence = notice.sequence ?? 0;
  const make = (suffix: string, kind: string, data: any, nativeId: string | null = null, order = 0) =>
    ({id: notice.id + suffix, kind, sequence: sequence + order, timestamp: notice.at, nativeId, parentId: null, turnId: text(event.generation_id), agentId: null, data});
  const evidence = () => [make('', 'hook', event)];
  if (event.captureStatus === 'too_large') return evidence();
  if (name === 'beforeSubmitPrompt') {
    const prompt = text(event.prompt);
    if (!prompt) return evidence();
    // Referenced files and rules are paths the person attached, never file bytes.
    const attachments = Array.isArray(event.attachments) ? event.attachments.filter((a: any) => typeof a?.file_path === 'string').map((a: any) => ({type: a.type, file_path: a.file_path})) : [];
    return [make('', 'message', {role: 'user', content: [{type: 'text', text: prompt}], ...(attachments.length ? {attachments} : {})})];
  }
  if (name === 'afterAgentResponse') {
    const reply = text(event.text), model = text(event.model_id) ?? text(event.model);
    return reply ? [make('', 'message', {role: 'assistant', content: [{type: 'text', text: reply}], ...(model ? {model} : {})})] : evidence();
  }
  if (name === 'afterAgentThought') {
    const thought = text(event.text);
    return thought ? [make('', 'reasoning_summary', {type: 'reasoning', summary: [{type: 'summary_text', text: thought}], ...(finite(event.duration_ms) ? {duration_ms: event.duration_ms} : {})})] : evidence();
  }
  if (name === 'postToolUse' || name === 'postToolUseFailure') {
    const tool = text(event.tool_name);
    if (!tool) return evidence();
    const callId = text(event.tool_use_id), call = callId ? {call_id: callId} : {}, failed = name === 'postToolUseFailure';
    return [
      make(':call', 'tool_call', {type: 'tool_use', name: tool, input: structured(event.tool_input) ?? null, ...call}, callId),
      make(':result', 'tool_result', {type: 'tool_result', name: tool, ...call,
        output: failed ? text(event.error_message) ?? '' : structured(event.tool_output) ?? null,
        ...(failed ? {is_error: true, ...(text(event.failure_type) ? {failure_type: event.failure_type} : {}), ...(typeof event.is_interrupt === 'boolean' ? {is_interrupt: event.is_interrupt} : {})} : {}),
        ...(finite(event.duration) ? {duration_ms: event.duration} : {})}, callId, 1),
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
