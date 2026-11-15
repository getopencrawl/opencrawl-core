import type {Readable} from 'node:stream';
import {parseArgs} from 'node:util';

export const searchContextMarker = 'OpenCrawl search context';
// Advertised aliases prove the server accepts currentSession. Older servers
// expose only search and may reject new arguments in their schema.
const searchTools = [
  'mcp__opencrawl__opencrawl_search',
  'mcp__plugin_opencrawl_opencrawl__opencrawl_search',
  'mcp__codex_apps__opencrawl_opencrawl_search',
  'mcp__opencrawl__opencrawl_search_v1',
  'mcp__plugin_opencrawl_opencrawl__opencrawl_search_v1',
  'mcp__codex_apps__opencrawl_opencrawl_search_v1',
] as const;
export const searchContextMatcher = '^(?:' + searchTools.join('|') + ')$';
const cursorSearchTools = ['MCP:opencrawl_search', 'MCP:opencrawl_search_v1'];
export const cursorSearchContextMatcher = '^(?:' + cursorSearchTools.join('|') + ')$';
// Antigravity flattens server/tool names: plugin opencrawl/server opencrawl/raw
// search collides with manual server opencrawl/raw opencrawl_search. Its hook
// payload cannot distinguish them, so only v1 is safe. Keep raw search_v1
// unexposed on the server to prevent that collision recurring for v1.
const antigravitySearchTools = ['mcp_opencrawl_opencrawl_search_v1', 'mcp_opencrawl_opencrawl_opencrawl_search_v1'];
export const antigravitySearchContextMatcher = '^(?:' + [...antigravitySearchTools, 'call_mcp_tool'].join('|') + ')$';
const sessionPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const sessionId = (value: unknown): value is string => typeof value === 'string' && sessionPattern.test(value);

/** Native hook identity is independent of credentials, board presence and the
 * model's arguments. Never consult a latest-session file or read a transcript. */
export function searchContext(harness: string, event: unknown): Record<string, unknown> | undefined {
  if (object(event) && harness === 'antigravity') {
    if (event.hookEventName !== 'PreToolUse' || !object(event.toolCall)
        || !object(event.toolCall.args) || !sessionId(event.conversationId)) return;
    const currentSession = {harness, sessionId:event.conversationId};
    if (event.toolCall.name === 'call_mcp_tool') {
      const args = event.toolCall.args;
      if (!['opencrawl', 'opencrawl_opencrawl'].includes(args.ServerName as string)
          || args.ToolName !== 'opencrawl_search_v1' || !object(args.Arguments)) return;
      // GUI dispatch carries an object, not a JSON string. Native overwrite
      // replaces nested objects wholesale, so preserve every search argument.
      return {decision:'allow', overwrite:{Arguments:{...args.Arguments, currentSession}}};
    }
    if (!antigravitySearchTools.includes(event.toolCall.name as string)) return;
    // overwrite is a shallow argument merge; allow continues the ordinary
    // policy checks (auto_approve and permissionOverrides are never emitted).
    return {decision:'allow', overwrite:{currentSession}};
  }
  if (object(event) && harness === 'cursor') {
    // Cursor omits the MCP server name. Only our unique alias can be safely
    // selected; bare MCP:search might belong to an unrelated provider.
    if (event.hook_event_name !== 'preToolUse' || !cursorSearchTools.includes(event.tool_name as string) || !object(event.tool_input)) return;
    const nativeId = event.conversation_id ?? event.session_id;
    if (!sessionId(nativeId)) return;
    return {updated_input: {...event.tool_input, currentSession: {harness, sessionId: nativeId}}};
  }
  if (!object(event) || !['codex', 'claude-code'].includes(harness) || event.hook_event_name !== 'PreToolUse'
      || !searchTools.includes(event.tool_name as typeof searchTools[number]) || !object(event.tool_input)) return;
  if (!sessionId(event.session_id)) return;
  let nativeId = event.session_id;
  if (event.agent_id !== undefined && event.agent_id !== null) {
    if (!sessionId(event.agent_id)) return;
    // Codex's subagent session_id names its parent; agent_id is the child's
    // native thread ID. Claude capture names a child with parent:agent.
    nativeId = harness === 'codex' ? event.agent_id : nativeId + ':' + event.agent_id;
  }
  if (!sessionId(nativeId)) return;
  const updatedInput = {...event.tool_input, currentSession: {harness, sessionId: nativeId}};
  return {hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    // Codex requires this for rewriting, and still runs the tool's permission
    // checks. Claude's allow would auto-approve: omit its decision entirely.
    ...(harness === 'codex' ? {permissionDecision: 'allow'} : {}),
    updatedInput,
  }};
}

export function readSearchContextEvent(input: Readable, timeoutMs = 1000, maxBytes = 128 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0), finished = false;
    const finish = (error?: Error, value?: unknown) => {
      if (finished) return;
      finished = true; clearTimeout(timer); input.off('data', data); input.off('end', end); input.off('error', fail); input.pause();
      if (error) reject(error); else resolve(value);
    };
    const fail = () => finish(new Error('Invalid search hook input'));
    const end = () => {try {finish(undefined, JSON.parse(bytes.toString('utf8')));} catch {fail();}};
    const data = (chunk: Buffer | string) => {
      if (bytes.length + Buffer.byteLength(chunk) > maxBytes) {fail(); return;}
      bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
      try {const value = JSON.parse(bytes.toString('utf8')); finish(undefined, value);} catch { /* Await remaining bytes. */ }
    };
    const timer = setTimeout(fail, timeoutMs);
    input.on('data', data); input.once('end', end); input.once('error', fail);
  });
}

/** Early CLI dispatch: no login, update, migration, capture or state access. */
export async function searchContextCommand(args: string[], input: Readable = process.stdin, output: Pick<NodeJS.WriteStream, 'write'> = process.stdout) {
  try {
    const parsed = parseArgs({args, options: {harness: {type: 'string'}}});
    const result = searchContext(parsed.values.harness ?? '', await readSearchContextEvent(input));
    if (result) output.write(JSON.stringify(result) + '\n');
  } catch { /* Unknown identity or malformed native input must never guess. */ }
  return 0;
}
