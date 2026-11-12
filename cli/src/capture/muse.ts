import {hash} from './parse.ts';
import {eventMaker, finite, sessionKey, structured, text, type PayloadAdapter, type PayloadNotice, type PayloadSession} from './payload.ts';

/** Muse Code runs command hooks from the `hooks` block of its settings file, in
 * the terminal, under `muse exec` and in the sessions `muse serve` hosts for
 * other programs, which is how cloud workspaces such as Replicas run it. Hook
 * payloads carry no transcript path, so a session is assembled from the
 * payloads themselves.
 *
 * Only observing hooks are registered. PreToolUse and PermissionRequest decide
 * whether an action runs, and PreLLMCall and PostLLMCall carry the whole
 * conversation, system prompt included, on every model step. */
export const MUSE_HOOK_EVENTS = ['SessionStart','UserPromptSubmit','PostToolUse','PostToolUseFailure','PostCompact','Stop','StopFailure','SessionEnd'] as const;
const BOUNDARIES = ['Stop','StopFailure','SessionStart','SessionEnd'];

/** Muse Code names the top-level chat and the running chat or subagent in the
 * hook's environment. Its payload names only the latter. */
const context = (env: NodeJS.ProcessEnv) => {
  const chat = text(env.MUSE_SESSION_ID), thread = text(env.MUSE_THREAD_ID);
  return chat || thread ? {...(chat ? {chat} : {}), ...(thread ? {thread} : {})} : null;
};

/** One top-level chat is one session. Muse Code also runs its own helper
 * agents beside every chat, and their hooks arrive with a session of their
 * own; those, and delegated subagents, are not recorded as sessions. What a
 * subagent returns reaches the chat as a tool result, and is recorded there. */
function session(event: any, _at: string, context?: Record<string, string> | null): PayloadSession | null {
  const native = text(event?.session_id);
  if (!native) return null;
  const chat = context?.chat ?? null;
  if (chat && chat !== native) return null;
  return {sessionId: sessionKey(native, hash), cwd: text(event.cwd), version: text(event.muse_version) ?? text(event.version), origin: 'cli', originEvidence: 'Muse Code hook', parentSessionId: null};
}

function events(notice: PayloadNotice) {
  const event = notice.event ?? {}, name = event.hook_event_name;
  const make = eventMaker(notice, text(event.turn_id));
  const evidence = () => [make('', 'hook', event)];
  if (event.captureStatus) return evidence();
  if (name === 'UserPromptSubmit') {
    const prompt = text(event.prompt);
    return prompt ? [make('', 'message', {role: 'user', content: [{type: 'text', text: prompt}]})] : evidence();
  }
  if (name === 'Stop') {
    // The reply that ended the turn. Text the agent wrote between its tool
    // calls is not delivered to hooks.
    const reply = text(event.last_assistant_message), model = text(event.model);
    return reply ? [make('', 'message', {role: 'assistant', content: [{type: 'text', text: reply}], ...(model && model !== 'unknown' ? {model} : {})})] : evidence();
  }
  if (name === 'PostToolUse' || name === 'PostToolUseFailure') {
    const tool = text(event.tool_name);
    if (!tool) return evidence();
    const callId = text(event.tool_use_id) ?? text(event.tool_call_id), call = callId ? {call_id: callId} : {}, failed = name === 'PostToolUseFailure';
    const output = event.tool_response ?? event.tool_output ?? event.tool_result;
    const error = text(event.error) ?? text(event.error_message) ?? (event.error && typeof event.error === 'object' ? event.error : null);
    return [
      make(':call', 'tool_call', {type: 'tool_use', name: tool, input: structured(event.tool_input) ?? null, ...call}, callId),
      make(':result', 'tool_result', {type: 'tool_result', name: tool, ...call,
        output: failed ? error ?? structured(output) ?? '' : structured(output) ?? null,
        ...(failed ? {is_error: true, ...(typeof event.is_interrupt === 'boolean' ? {is_interrupt: event.is_interrupt} : {})} : {}),
        ...(finite(event.duration_ms) ? {duration_ms: event.duration_ms} : {})}, callId, 1),
    ];
  }
  if (name === 'PostCompact') {
    const summary = text(event.compact_summary) ?? text(event.summary);
    return [make('', 'compaction', {...(text(event.trigger) ? {trigger: event.trigger} : {}), ...(summary ? {summary} : {})})];
  }
  return evidence();
}

export const museAdapter: PayloadAdapter = {
  session, events, context,
  name: event => text(event?.hook_event_name),
  // An empty object is a valid answer to every hook and changes nothing.
  response: () => ({}),
  boundary: event => BOUNDARIES.includes(event?.hook_event_name),
  identifying: ['hook_event_name','session_id','turn_id','cwd','model','tool_name','tool_use_id','tool_call_id'],
};
