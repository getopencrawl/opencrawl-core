import {hash} from './parse.ts';
import {finite, sessionKey, text, type PayloadAdapter, type PayloadNotice, type PayloadSession} from './payload.ts';

/** OpenCode has no command hooks. It loads plugins, in every mode: the terminal
 * UI, `opencode run`, `opencode serve` and ACP, which is how editors and cloud
 * workspaces drive it. Capture installs one small plugin that forwards what
 * OpenCode's event stream says is finished, and nothing while it is streaming.
 *
 * The plugin writes each finished item as a file in an inbox before it returns,
 * then starts the collector without waiting for it: `opencode run` exits as
 * soon as the turn ends, and the last reply must already be on disk by then.
 * The collector reads the inbox through the same hook command as every other
 * agent, so exclusions, sign-in and upload limits are applied in one place.
 *
 * The plugin stays thin on purpose: an installed plugin is only rewritten when
 * capture is reinstalled, while this collector updates itself. Everything that
 * interprets an OpenCode event therefore lives here. */

/** A turn or a session ended. The newer session engine reports no idle state;
 * its last step does not ask for a tool. */
const boundary = (delivery: any) => {
  const type = delivery?.event?.type;
  return type === 'session.idle' || type === 'session.next.step.failed' || type === 'session.next.step.ended' && delivery.event.properties?.finish !== 'tool-calls';
};

function session(delivery: any): PayloadSession | null {
  const native = text(delivery?.session?.id);
  if (!native) return null;
  const parent = text(delivery.session.parentID);
  // `run` and the terminal UI are a person at a terminal. A server or an ACP
  // peer is driven by another program, which this collector cannot name.
  const mode = text(delivery.mode), terminal = mode === 'run' || mode === 'tui';
  return {
    sessionId: sessionKey(native, hash),
    cwd: text(delivery.session.directory),
    version: text(delivery.session.version),
    origin: parent ? 'subagent' : terminal ? 'cli' : 'unknown',
    originEvidence: parent ? 'OpenCode session with a parent session' : `OpenCode plugin (${mode ?? 'unknown mode'})`,
    parentSessionId: parent ? sessionKey(parent, hash) : null,
  };
}

/** OpenCode names a session before its first reply; that placeholder is not a title. */
const placeholderTitle = (title: string) => /^(New|Child) session - \d{4}-\d{2}-\d{2}T/.test(title);
const iso = (ms: unknown) => finite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
/** A file part: a data URL becomes a stored attachment, any other a reference. */
const fileBlock = (part: any) => ({type: 'file', ...(text(part.filename) ? {filename: part.filename} : {}), ...(text(part.mime) ? {mime: part.mime} : {}), ...(text(part.url) ? {image_url: part.url} : {})});

function events(notice: PayloadNotice) {
  const delivery = notice.event ?? {}, event = delivery.event ?? {}, type = event.type, p = event.properties ?? {};
  // An item names itself, and says when it finished. The same item delivered
  // twice is then the same event, whenever each copy was collected.
  const make = (key: string, kind: string, data: any, at: unknown, nativeId: string | null = null, order = 0, turnId: string | null = null) => {
    const ms = finite(at) && at > 0 ? at : finite(delivery.at) ? delivery.at : Date.parse(notice.at);
    return {id: 'opencode:' + hash(key), kind, sequence: Math.round(ms * 1000) + order, timestamp: iso(ms) ?? notice.at, nativeId, parentId: null, turnId, agentId: null, data};
  };
  const evidence = () => [{id: notice.id, kind: 'hook', sequence: notice.sequence ?? 0, timestamp: notice.at, nativeId: null, parentId: null, turnId: null, agentId: null, data: delivery.captureStatus ? delivery : {type, ...(p && typeof p === 'object' ? p : {})}}];
  if (delivery.captureStatus) return evidence();
  const model = text(delivery.model);
  const tool = (key: string, name: string, callId: string | null, input: unknown, at: unknown, turnId: string | null) =>
    make(key + ':call', 'tool_call', {type: 'tool_use', name, input: input ?? null, ...(callId ? {call_id: callId} : {})}, at, callId, 0, turnId);
  const result = (key: string, name: string | null, callId: string | null, output: unknown, at: unknown, turnId: string | null, extra: Record<string, unknown> = {}) =>
    make(key + ':result', 'tool_result', {type: 'tool_result', ...(name ? {name} : {}), ...(callId ? {call_id: callId} : {}), output, ...extra}, at, callId, 1, turnId);

  if (type === 'session.updated') {
    const title = text(p.info?.title);
    return title && !placeholderTitle(title) ? [make('title:' + delivery.session?.id + ':' + title, 'session_title', {title: title.trim(), titleType: 'auto'}, delivery.at)] : [];
  }
  if (type === 'session.compacted') return [make('compacted:' + delivery.session?.id + ':' + delivery.at, 'compaction', {trigger: 'session.compacted'}, delivery.at)];

  // The message engine: one part at a time, forwarded once it is finished.
  if (type === 'message.part.updated') {
    const part = p.part ?? {}, id = text(part.id), turnId = text(part.messageID);
    if (!id) return evidence();
    const role = delivery.role === 'user' ? 'user' : 'assistant';
    if (part.type === 'text') {
      const body = text(part.text);
      if (!body) return [];
      // After a compaction OpenCode writes the summary as an assistant message.
      if (delivery.summary) return [make(id, 'compaction', {summary: body}, part.time?.end ?? part.time?.start)];
      return [make(id, 'message', {role, content: [{type: 'text', text: body}], ...(role === 'assistant' && model ? {model} : {})}, part.time?.end ?? part.time?.start, id, 0, turnId)];
    }
    if (part.type === 'reasoning') {
      const thought = text(part.text), start = part.time?.start, end = part.time?.end;
      return thought ? [make(id, 'reasoning_summary', {type: 'reasoning', summary: [{type: 'summary_text', text: thought}], ...(finite(start) && finite(end) ? {duration_ms: end - start} : {})}, end ?? start, id, 0, turnId)] : [];
    }
    if (part.type === 'file') return [make(id, 'message', {role, content: [fileBlock(part)]}, delivery.at, id, 0, turnId)];
    if (part.type === 'tool') {
      const name = text(part.tool), state = part.state ?? {}, callId = text(part.callID);
      if (!name) return evidence();
      const failed = state.status === 'error', start = state.time?.start, end = state.time?.end;
      const attachments = Array.isArray(state.attachments) ? state.attachments.filter((file: any) => file && typeof file === 'object').map(fileBlock) : [];
      return [
        tool(id, name, callId, state.input, start ?? end, turnId),
        result(id, name, callId, failed ? text(state.error) ?? '' : state.output ?? null, end ?? start, turnId, {
          ...(failed ? {is_error: true} : {}), ...(text(state.title) ? {title: state.title} : {}), ...(attachments.length ? {attachments} : {}),
          ...(finite(start) && finite(end) ? {duration_ms: end - start} : {})}),
      ];
    }
    return evidence();
  }

  // The newer session engine: one event per finished thing. Its timestamp is
  // an instant object inside OpenCode and ISO text once the plugin has written it.
  const stamp = typeof p.timestamp === 'string' ? Date.parse(p.timestamp) : p.timestamp?.epochMilliseconds;
  const at = finite(stamp) ? stamp : undefined, turnId = text(p.assistantMessageID) ?? text(p.messageID);
  if (type === 'session.next.prompted') {
    const prompt = text(p.prompt?.text);
    const files = Array.isArray(p.prompt?.files) ? p.prompt.files.filter((file: any) => file && typeof file === 'object').map(fileBlock) : [];
    return prompt || files.length ? [make('prompt:' + p.messageID, 'message', {role: 'user', content: [...(prompt ? [{type: 'text', text: prompt}] : []), ...files]}, at, text(p.messageID), 0, turnId)] : evidence();
  }
  if (type === 'session.next.text.ended') {
    const body = text(p.text);
    return body ? [make('text:' + p.assistantMessageID + ':' + p.textID, 'message', {role: 'assistant', content: [{type: 'text', text: body}], ...(model ? {model} : {})}, at, null, 0, turnId)] : [];
  }
  if (type === 'session.next.reasoning.ended') {
    const thought = text(p.text);
    return thought ? [make('reasoning:' + p.assistantMessageID + ':' + (p.reasoningID ?? at), 'reasoning_summary', {type: 'reasoning', summary: [{type: 'summary_text', text: thought}]}, at, null, 0, turnId)] : [];
  }
  if (type === 'session.next.tool.called') {
    const name = text(p.tool), callId = text(p.callID);
    return name ? [tool('next:' + delivery.session?.id + ':' + callId, name, callId, p.input, at, turnId)] : evidence();
  }
  if (type === 'session.next.tool.success' || type === 'session.next.tool.failed') {
    const callId = text(p.callID), failed = type === 'session.next.tool.failed';
    const content = Array.isArray(p.content) ? p.content : null;
    // Text blocks read as one output; anything else keeps its structure.
    const plain = content?.every((block: any) => block?.type === 'text' && typeof block.text === 'string') ? content.map((block: any) => block.text).join('\n') : content;
    const error = text(p.error?.message) ?? text(p.error) ?? (p.error && typeof p.error === 'object' ? p.error : null);
    return [result('next:' + delivery.session?.id + ':' + callId, text(delivery.tool), callId, failed ? error ?? plain ?? '' : plain ?? p.structured ?? null, at, turnId,
      {...(failed ? {is_error: true} : {}), ...(!failed && p.structured && typeof p.structured === 'object' && plain !== null ? {structured: p.structured} : {})})];
  }
  if (type === 'session.next.compaction.ended') {
    const summary = text(p.text) ?? text(p.summary);
    return [make('compaction:' + delivery.session?.id + ':' + at, 'compaction', summary ? {summary} : {trigger: 'session.next.compaction.ended'}, at)];
  }
  return evidence();
}

export const openCodeAdapter: PayloadAdapter = {
  session, events, boundary,
  name: delivery => text(delivery?.event?.type),
  response: () => ({}),
  identifying: ['hook_event_name', 'v', 'at', 'mode', 'session', 'role'],
  inbox: true,
};

/** The plugin file, written into OpenCode's plugins directory. `command` is the
 * collector's hook command as an argument list; `inbox` the directory the
 * collector reads. It imports only Node built-ins and exports only the plugin
 * function: OpenCode fails the load of a plugin file with any other export.
 * Bump HOOK_MODE when this text changes, so existing installations are
 * rewritten. */
export function openCodePlugin(command: string[], inbox: string) {
  return `// OpenCrawl session capture for OpenCode.
// Written by \`opencrawl collect install\`; \`opencrawl collect uninstall\` removes it.
// It is replaced when capture is reinstalled or updated: keep changes elsewhere.
//
// It forwards finished prompts, replies, reasoning, tool calls and session
// names to the OpenCrawl collector on this machine. It changes nothing in a
// session, and an error here never reaches OpenCode.
import {mkdirSync, writeFileSync, renameSync, existsSync} from "node:fs";
import {join} from "node:path";
import {spawn} from "node:child_process";

const COMMAND = ${JSON.stringify(command)};
const INBOX = ${JSON.stringify(inbox)};
// One state per OpenCode process, however many times the plugin is loaded.
const state = globalThis[Symbol.for("opencrawl.capture.opencode")] ??= {sent: new Set(), messages: new Map(), sessions: new Map(), tools: new Map(), engines: new Map(), counter: 0, running: false, again: false, timer: null};
const mode = process.argv.slice(1).find(word => ["run", "serve", "acp", "web", "attach"].includes(word)) ?? (process.stdout.isTTY ? "tui" : "other");
const FINISHED = new Set(["session.next.prompted", "session.next.text.ended", "session.next.reasoning.ended", "session.next.tool.called", "session.next.tool.success", "session.next.tool.failed", "session.next.step.ended", "session.next.step.failed", "session.next.compaction.ended"]);
const remember = (map, key, value) => { map.set(key, value); if (map.size > 5000) map.delete(map.keys().next().value); };
const once = key => { if (state.sent.has(key)) return false; state.sent.add(key); if (state.sent.size > 20000) state.sent.delete(state.sent.values().next().value); return true; };
// A session is recorded from the first engine that reports it, never both.
const engine = (session, name) => { if (!state.engines.has(session)) remember(state.engines, session, name); return state.engines.get(session) === name; };

function poke() {
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  if (state.running) { state.again = true; return; }
  if (!existsSync(COMMAND[1])) return;
  state.running = true; state.again = false;
  const done = () => { if (!state.running) return; state.running = false; if (state.again) poke(); };
  try {
    // Never awaited: the collector ends itself within five seconds, and
    // OpenCode may exit before it does.
    const child = spawn(COMMAND[0], COMMAND.slice(1), {stdio: "ignore", windowsHide: true});
    child.on("error", done); child.on("exit", done); child.unref();
  } catch { done(); }
}
function soon() {
  if (state.timer) return;
  state.timer = setTimeout(() => { state.timer = null; poke(); }, 1000);
  state.timer.unref?.();
}
// On disk before this returns, so an exit right after a turn loses nothing.
function deliver(directory, sessionID, event, extra) {
  if (!existsSync(COMMAND[1])) return;
  const known = state.sessions.get(sessionID), session = {id: sessionID, directory: known?.directory ?? directory, parentID: known?.parentID, version: known?.version};
  const name = String(Date.now()).padStart(15, "0") + "-" + String(++state.counter).padStart(8, "0") + "-" + process.pid + ".json";
  mkdirSync(INBOX, {recursive: true, mode: 0o700});
  writeFileSync(join(INBOX, "." + name + ".tmp"), JSON.stringify({hook_event_name: "opencode", v: 1, at: Date.now(), mode, session, event, ...extra}), {mode: 0o600});
  renameSync(join(INBOX, "." + name + ".tmp"), join(INBOX, name));
}
function part(directory, value) {
  if (!value?.id || !value.sessionID || value.synthetic || value.ignored || !engine(value.sessionID, "message")) return;
  const message = state.messages.get(value.messageID);
  const finished = value.type === "tool" ? value.state?.status === "completed" || value.state?.status === "error"
    : value.type === "text" || value.type === "reasoning" ? Boolean(value.time?.end) || message?.role === "user"
    : value.type === "file" ? message?.role === "user" : false;
  if (!finished || !once(value.id)) return;
  deliver(directory, value.sessionID, {type: "message.part.updated", properties: {part: value}}, {role: message?.role, model: message?.model, summary: message?.summary});
  soon();
}
function handle(directory, event) {
  const type = event?.type, p = event?.properties ?? {};
  if (typeof type !== "string") return;
  if (type === "session.created" || type === "session.updated") {
    const info = p.info;
    if (!info?.id) return;
    const before = state.sessions.get(info.id);
    remember(state.sessions, info.id, {directory: info.directory, parentID: info.parentID, version: info.version, title: info.title});
    if (typeof info.title === "string" && info.title !== before?.title && !/^(New|Child) session - \\d{4}-/.test(info.title)) {
      deliver(directory, info.id, {type: "session.updated", properties: {info: {id: info.id, title: info.title}}});
      soon();
    }
    return;
  }
  if (type === "message.updated") {
    const info = p.info;
    if (info?.id && info.role) remember(state.messages, info.id, {role: info.role, model: info.modelID, summary: info.summary === true});
    return;
  }
  if (type === "message.part.updated") return part(directory, p.part);
  if (type === "session.idle" || type === "session.compacted") {
    if (!p.sessionID) return;
    deliver(directory, p.sessionID, {type, properties: {sessionID: p.sessionID}});
    return type === "session.idle" ? poke() : soon();
  }
  if (FINISHED.has(type)) {
    if (!p.sessionID || !engine(p.sessionID, "next")) return;
    if (type === "session.next.tool.called") remember(state.tools, p.callID, p.tool);
    if (!once(type + ":" + p.sessionID + ":" + (p.callID ?? p.messageID ?? "") + ":" + (p.assistantMessageID ?? "") + ":" + (p.textID ?? p.reasoningID ?? "") + ":" + String(p.timestamp?.epochMilliseconds ?? p.timestamp ?? ""))) return;
    deliver(directory, p.sessionID, {type, properties: p}, type === "session.next.tool.success" || type === "session.next.tool.failed" ? {tool: state.tools.get(p.callID)} : undefined);
    return type === "session.next.step.failed" || type === "session.next.step.ended" && p.finish !== "tool-calls" ? poke() : soon();
  }
}

export const OpenCrawlCapture = async ({directory}) => ({
  event: async input => { try { handle(directory, input?.event ?? input); } catch {} },
  // The prompt as OpenCode accepted it, in case its message event is not seen first.
  "chat.message": async (_input, output) => {
    try {
      const message = output?.message;
      if (!message?.id || message.role !== "user") return;
      remember(state.messages, message.id, {role: "user"});
      for (const value of output.parts ?? []) part(directory, value);
    } catch {}
  },
});
`;
}
