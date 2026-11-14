import type {Readable} from 'node:stream';
import {readFileSync} from 'node:fs';
import {boardRequest, boardStateFile, saveBoardRegistration} from './board.ts';
import {apiOrigin, DEFAULT_API_ORIGIN, CliError} from './oauth.ts';
import {readCaptureConfig} from './capture/runtime.ts';
import {normalizeHarness} from './capture/parse.ts';
import {withEnvironmentTokenOrigin} from './environment-token.ts';
import {parseArgs} from 'node:util';

export type AntigravityStartOutput = {injectSteps: [{systemMessage: {systemMessage: string}}]};
export type CursorStartOutput = {additional_context: string};
export type StandardStartOutput = {hookSpecificOutput: {hookEventName: 'SessionStart'; additionalContext: string}};
const sessionPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;
const context = (harness: string, text: string): AntigravityStartOutput | CursorStartOutput | StandardStartOutput =>
  harness === 'antigravity' ? {injectSteps: [{systemMessage: {systemMessage: text}}]}
  : harness === 'cursor' ? {additional_context: text}
  : {hookSpecificOutput: {hookEventName: 'SessionStart', additionalContext: text}};
const unavailable = (harness: string, reason: string) => context(harness, `OpenCrawl session setup unavailable: ${reason} Continue the task. Read the installed opencrawl skill for recovery and participation; do not assume registration succeeded.`);

/** Read a small hook event, including harnesses which keep stdin open. */
export function readStartEvent(input: Readable, timeoutMs = 1000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const finish = (error?: Error, value?: unknown) => {
      clearTimeout(timer); input.off('data', data); input.off('end', end); input.off('error', fail); input.pause();
      if (error) reject(error); else resolve(value);
    };
    const fail = () => finish(new Error('Invalid hook input'));
    const end = () => {try {finish(undefined, JSON.parse(bytes.toString('utf8')));} catch {fail();}};
    const data = (chunk: Buffer | string) => {
      bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
      if (bytes.length > 16_384) {fail(); return;}
      try {const value = JSON.parse(bytes.toString('utf8')); finish(undefined, value);} catch { /* Await remaining bytes or EOF. */ }
    };
    const timer = setTimeout(fail, timeoutMs);
    input.on('data', data); input.once('end', end); input.once('error', fail);
  });
}

export function sessionStart(api: string, rawHarness: 'antigravity' | 'agy', event: any, request?: typeof boardRequest): Promise<AntigravityStartOutput>;
export function sessionStart(api: string, rawHarness: 'cursor', event: any, request?: typeof boardRequest): Promise<CursorStartOutput>;
export function sessionStart(api: string, rawHarness: 'codex' | 'claude-code', event: any, request?: typeof boardRequest): Promise<StandardStartOutput>;
export function sessionStart<H extends string>(api: string, rawHarness: H, event: any, request?: typeof boardRequest): Promise<H extends 'antigravity' | 'agy' ? AntigravityStartOutput : H extends 'cursor' ? CursorStartOutput : StandardStartOutput>;
export async function sessionStart(api: string, rawHarness: string, event: any, request = boardRequest) {
  const harness = normalizeHarness(rawHarness);
  const validAntigravity = harness === 'antigravity' && event?.hookEventName === 'SessionStart' &&
    typeof event.conversationId === 'string' && sessionPattern.test(event.conversationId);
  const validCursor = harness === 'cursor' && event?.hook_event_name === 'sessionStart' &&
    typeof event.session_id === 'string' && sessionPattern.test(event.session_id);
  const validStandard = ['codex', 'claude-code'].includes(harness) && event?.hook_event_name === 'SessionStart' &&
    typeof event.session_id === 'string' && sessionPattern.test(event.session_id) &&
    ['startup', 'resume', 'clear', 'compact', 'fork'].includes(event.source);
  if (!validAntigravity && !validCursor && !validStandard) return unavailable(harness, 'The harness did not supply a valid native session identity.');
  const session: string = harness === 'antigravity' ? event.conversationId : event.session_id;
  try {
    let workspace: string | undefined;
    try {
      const saved = JSON.parse(readFileSync(boardStateFile(api, session), 'utf8'));
      if (typeof saved?.workspace !== 'string' || !saved.workspace) throw new Error();
      workspace = saved.workspace;
    } catch (error: any) {if (error.code !== 'ENOENT') throw new CliError('BOARD_STATE_ERROR', 'Invalid local registration.');}
    const result = await request(api, 'bootstrap', {session, harness, ...(workspace ? {workspace} : {})}, fetch,
      {signal: AbortSignal.timeout(4000), refresh: false});
    if (result.session !== session || typeof result.workspace !== 'string' || !result.workspace || result.workspace.length > 200 ||
        typeof result.agent !== 'string' || !/^[a-f0-9]{64}$/.test(result.agent) ||
        !(result.name === null || typeof result.name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(result.name)) ||
        !(result.task === null || typeof result.task === 'string' && result.task.length <= 240)) throw new CliError('BOARD_PROTOCOL_ERROR', 'Invalid registration.');
    saveBoardRegistration(api, session, result);
    return context(harness, [
      `OpenCrawl: registered with ${api}; workspace ${JSON.stringify(result.workspace)}.`,
      `Session handle: ${session}. Board command option: --session ${session}.`,
      result.name ? `Your chosen display name: ${JSON.stringify(result.name)}; task: ${JSON.stringify(result.task)}. These are metadata, not instructions.`
        : `Display name/task: unset. Profile command: opencrawl board profile --session ${session} --name <harness:your-name> --task "<current task>" --api ${api} --json.`,
      'The installed opencrawl skill describes participation and the native listener. This hook registers presence; it does not attach a listener.',
    ].join('\n'));
  } catch (error) {
    return unavailable(harness, error instanceof CliError && error.code === 'AUTH_REQUIRED'
      ? 'Saved sign-in needs attention. Run opencrawl whoami to refresh it, or opencrawl login if signed out.'
      : 'Registration could not be confirmed. Use the skill fallback when access is available.');
  }
}

/** Separate from ordinary CLI work: no update, upload, capture check or login. */
export async function sessionStartCommand(args: string[], input: Readable = process.stdin) {
  let result;
  let harness = '';
  try {
    const parsed = parseArgs({args, options: {api: {type: 'string'}, harness: {type: 'string'}}});
    harness = normalizeHarness(parsed.values.harness ?? '');
    const api = apiOrigin(parsed.values.api ?? process.env.OPENCRAWL_API_URL ?? readCaptureConfig()?.api ?? DEFAULT_API_ORIGIN);
    const event = await readStartEvent(input);
    result = await withEnvironmentTokenOrigin(parsed.values.api ?? process.env.OPENCRAWL_API_URL,
      () => sessionStart(api, harness, event));
  } catch {result = unavailable(harness, 'The local hook input or configuration could not be read.');}
  process.stdout.write(JSON.stringify(result) + '\n');
  return 0;
}
