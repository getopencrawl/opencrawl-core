import {hash} from './parse.ts';
import {eventMaker, finite, sessionKey, structured, text, type PayloadAdapter, type PayloadNotice, type PayloadSession} from './payload.ts';

/** Cursor's agent runs command hooks from ~/.cursor/hooks.json in the editor,
 * in its CLI, and under the Cursor Agent SDK when the embedding program asks
 * for the person's own settings, which is how cloud workspaces such as Replicas
 * run it. A session is assembled from the hook payloads themselves: the
 * transcript Cursor writes has no tool results, IDs or times.
 *
 * No permission hook is registered: preToolUse, subagentStart and the before*
 * hooks block the action when their answer is not valid JSON, and postToolUse
 * already carries the tool input. Capture can therefore never deny a decision.
 *
 * Cursor ignores the whole file, the person's own hooks included, when it
 * holds an event name it does not know. Every name here is one Cursor has
 * shipped for a long time; do not add a newer one lightly. */
export const CURSOR_HOOK_EVENTS = ['sessionStart','sessionEnd','beforeSubmitPrompt','afterAgentResponse','afterAgentThought','postToolUse','postToolUseFailure','preCompact','stop'] as const;
const PERMISSION_HOOKS = ['preToolUse','subagentStart','beforeShellExecution','beforeMCPExecution','beforeReadFile','beforeTabFileRead'];
const BOUNDARIES = ['stop','sessionStart','sessionEnd'];

/** One Cursor conversation is one session. A subagent's own hooks, when the
 * runtime sends them, carry its conversation and name the parent. */
function session(event: any): PayloadSession | null {
  const native = text(event?.conversation_id) ?? text(event?.session_id);
  if (!native) return null;
  const roots = Array.isArray(event.workspace_roots) ? event.workspace_roots.filter((root: unknown) => typeof root === 'string' && root) : [];
  const parent = text(event.parent_conversation_id);
  const child = parent !== null && parent !== native;
  // Cloud agents set is_background_agent on the session hooks only. Nothing in a
  // payload tells the editor, the CLI and the SDK apart.
  const cloud = event.is_background_agent === true;
  return {
    sessionId: sessionKey(native, hash),
    // The workspace, not a tool call's own directory: it is the same for every
    // hook of the conversation, and it is what a project exclusion names.
    cwd: roots[0] ?? text(event.cwd),
    version: text(event.cursor_version),
    origin: child ? 'subagent' : cloud ? 'cloud' : 'unknown',
    originEvidence: child ? 'Cursor hook with parent_conversation_id' : cloud ? 'Cursor hook with is_background_agent' : 'Cursor hook',
    parentSessionId: child ? sessionKey(parent, hash) : null,
  };
}

/** The explicit answer each hook type expects. Only reached for hooks someone
 * wired by hand when it grants a permission; capture never withholds one. */
function response(event: any) {
  const name = event?.hook_event_name;
  if (name === 'beforeSubmitPrompt') return {continue: true};
  return PERMISSION_HOOKS.includes(name) ? {permission: 'allow'} : {};
}

function events(notice: PayloadNotice) {
  const event = notice.event ?? {}, name = event.hook_event_name;
  const make = eventMaker(notice, text(event.generation_id));
  const evidence = () => [make('', 'hook', event)];
  if (event.captureStatus) return evidence();
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

export const cursorAdapter: PayloadAdapter = {
  session, events, response,
  name: event => text(event?.hook_event_name),
  boundary: event => BOUNDARIES.includes(event?.hook_event_name),
  identifying: ['hook_event_name','conversation_id','session_id','generation_id','parent_conversation_id','workspace_roots','cwd','cursor_version','tool_name','tool_use_id','duration'],
};
