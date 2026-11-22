import type {Readable} from 'node:stream';
import {parseArgs} from 'node:util';
import {claudeMcpTool} from './claude-mcp-context.ts';

export const searchContextMarker = 'OpenCrawl search context';
// Advertised aliases prove the server accepts currentSession. Older servers
// expose only search and may reject new arguments in their schema.
const boardContextTools=['board_post','board_sync','board_presence','board_follow','board_inbox'];
const browseTool = 'opencrawl_browse';
const searchTools = [
  'mcp__opencrawl__opencrawl_browse',
  'mcp__plugin_opencrawl_opencrawl__opencrawl_browse',
  'mcp__codex_apps__opencrawl_opencrawl_browse',
  ...boardContextTools.flatMap(tool=>[`mcp__opencrawl__${tool}`,`mcp__plugin_opencrawl_opencrawl__${tool}`,`mcp__codex_apps__opencrawl_${tool}`]),
  'mcp__opencrawl__opencrawl_search',
  'mcp__plugin_opencrawl_opencrawl__opencrawl_search',
  'mcp__codex_apps__opencrawl_opencrawl_search',
  'mcp__opencrawl__opencrawl_search_v1',
  'mcp__plugin_opencrawl_opencrawl__opencrawl_search_v1',
  'mcp__codex_apps__opencrawl_opencrawl_search_v1',
] as const;
export const searchContextMatcher = '^(?:' + searchTools.join('|') + ')$';
const cursorSearchTools = ['MCP:opencrawl_search', 'MCP:opencrawl_search_v1', 'MCP:opencrawl_browse'];
export const cursorSearchContextMatcher = '^(?:' + cursorSearchTools.join('|') + ')$';
// Antigravity flattens server/tool names: plugin opencrawl/server opencrawl/raw
// search collides with manual server opencrawl/raw opencrawl_search. Its hook
// payload cannot distinguish them, so only v1 is safe. Keep raw search_v1
// unexposed on the server to prevent that collision recurring for v1.
const antigravitySearchTools = ['mcp_opencrawl_opencrawl_search_v1', 'mcp_opencrawl_opencrawl_opencrawl_search_v1','mcp_opencrawl_opencrawl_browse','mcp_opencrawl_opencrawl_opencrawl_browse',...boardContextTools.flatMap(tool=>[`mcp_opencrawl_${tool}`,`mcp_opencrawl_opencrawl_${tool}`])];
export const antigravitySearchContextMatcher = '^(?:' + [...antigravitySearchTools, 'call_mcp_tool'].join('|') + ')$';
const aliases = ['opencrawl_search','opencrawl_search_v1',browseTool,...boardContextTools];
// Candidate filter only. Claude supplies the server provenance at call time.
export const claudeSearchContextMatcher = '^(?:' + searchTools.join('|') + '|mcp__.+__(?:' + aliases.join('|') + '))$';
/** Match only this installed deployment, including the native identifier's
 * underscore spelling. Cursor's documented payload omits the server name. */
function selectedTools(harness:string,pluginName?:string) {
  if(pluginName===undefined)return {standard:[...searchTools] as string[],agy:[...antigravitySearchTools],servers:['opencrawl','opencrawl_opencrawl']};
  if(!/^opencrawl(?:-[a-f0-9]{12})?$/.test(pluginName))throw Error('Invalid plugin namespace');
  const names=[pluginName,pluginName.replaceAll('-','_')];
  return {
    standard:names.flatMap(name=>aliases.map(alias=>harness==='codex'?`mcp__${name}__${alias}`:`mcp__plugin_${name}_opencrawl__${alias}`)),
    agy:names.flatMap(name=>['opencrawl_search_v1',browseTool,...boardContextTools].map(tool=>`mcp_${name}_opencrawl_${tool}`)),
    servers:names.map(name=>name+'_opencrawl'),
  };
}
export function pluginSearchContextMatcher(harness:string,pluginName:string):string {
  const tools=selectedTools(harness,pluginName);
  const names=harness==='cursor'?cursorSearchTools:harness==='antigravity'?[...tools.agy,'call_mcp_tool']:tools.standard;
  return '^(?:'+names.join('|')+')$';
}
const sessionPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const sessionId = (value: unknown): value is string => typeof value === 'string' && sessionPattern.test(value);

/** Native hook identity is independent of credentials, board presence and the
 * model's arguments. Never consult a latest-session file or read a transcript. */
export function searchContext(harness: string, event: unknown, pluginName?:string, boardSupported=false, api?:string): Record<string, unknown> | undefined {
  const tools=selectedTools(harness,pluginName);
  if(object(event)&&harness!=='cursor'&&typeof event.cursor_version==='string')return;
  if (object(event) && harness === 'antigravity') {
    if (event.hookEventName !== 'PreToolUse' || !object(event.toolCall)
        || !object(event.toolCall.args) || !sessionId(event.conversationId)) return;
    const currentSession = {harness, sessionId:event.conversationId};
    if (event.toolCall.name === 'call_mcp_tool') {
      const args = event.toolCall.args;
      if(boardContextTools.includes(args.ToolName as string)&&!boardSupported)return;
      if (!tools.servers.includes(args.ServerName as string)
          || !['opencrawl_search_v1',browseTool,...boardContextTools].includes(args.ToolName as string) || !object(args.Arguments)) return;
      // GUI dispatch carries an object, not a JSON string. Native overwrite
      // replaces nested objects wholesale, so preserve every search argument.
      return {decision:'allow', overwrite:{Arguments:{...args.Arguments, currentSession}}};
    }
    if (!tools.agy.includes(event.toolCall.name as string)) return;
    const calledTool=event.toolCall.name;
    if(boardContextTools.some(tool=>String(calledTool).endsWith('_'+tool))&&!boardSupported)return;
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
      || typeof event.tool_name !== 'string' || !object(event.tool_input)) return;
  if (harness === 'claude-code' && !pluginName && event.mcp_server !== undefined &&
      !(object(event.mcp_server) && event.mcp_server.source === 'plugin')) {
    if (!api || !aliases.includes(claudeMcpTool(event, api) ?? '')) return;
  } else if (!tools.standard.includes(event.tool_name)) return;
  if (!sessionId(event.session_id)) return;
  if(boardContextTools.some(tool=>String(event.tool_name).endsWith('_'+tool))&&!boardSupported)return;
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

/** Early CLI dispatch: no login, update, migration or capture. Installed plugin
 * calls validate only their selected public bundle and saved profile binding. */
export async function searchContextCommand(args: string[], input: Readable = process.stdin, output: Pick<NodeJS.WriteStream, 'write'> = process.stdout) {
  try {
    const parsed = parseArgs({args, options: {harness: {type: 'string'},api:{type:'string'}}});
    const harness=parsed.values.harness??'';
    const pluginKeys=['OPENCRAWL_PLUGIN_API','OPENCRAWL_PLUGIN_NAME','OPENCRAWL_PLUGIN_CLIENT','OPENCRAWL_PLUGIN_ROOT'];
    let pluginName:string|undefined,check:(()=>void)|undefined;
    if(pluginKeys.some(key=>process.env[key]!==undefined)){
      const {pluginHookContext}=await import('./setup/plugin-context.ts');
      const api=parsed.values.api??process.env.OPENCRAWL_PLUGIN_API??'';
      // Reject invalid profile/client/API before consuming native tool input.
      const context=pluginHookContext(api,harness);if(!context)return 0;
      const binding=JSON.stringify(context);pluginName=context.pluginName;
      check=()=>{if(JSON.stringify(pluginHookContext(api,harness))!==binding)throw Error('Plugin binding changed');};
    }
    const event=await readSearchContextEvent(input);check?.();
    const {supportsAgentBoard}=await import('./board.ts');
    const {DEFAULT_API_ORIGIN}=await import('./oauth.ts');
    const {readCaptureConfig}=await import('./capture/runtime.ts');
    const api=parsed.values.api??process.env.OPENCRAWL_PLUGIN_API??process.env.OPENCRAWL_API_URL??readCaptureConfig()?.api??DEFAULT_API_ORIGIN;
    const {privateHookSession,denyBoardSend}=await import('./incognito.ts');
    const denied=privateHookSession(harness,event)?denyBoardSend(harness,event):undefined;
    const result = denied??searchContext(harness,event,pluginName,supportsAgentBoard(api),api);
    if (result) output.write(JSON.stringify(result) + '\n');
  } catch { /* Unknown identity or malformed native input must never guess. */ }
  return 0;
}
