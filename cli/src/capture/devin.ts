import {CliError} from '../oauth.ts';
import {constants} from 'node:fs';
import {lstat, open, realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';
import {createHash} from 'node:crypto';

/** Devin Cloud command hooks supply the conversation events themselves.
 * No transcript path, local CLI export, or permission decision is inferred.
 * https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks
 *
 * Cloud has no SessionEnd. Stop flushes the final reply only when the runtime
 * actually supplies last_assistant_message; an empty Stop is not a reply.
 */
export const DEVIN_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'PostCompaction'] as const;
export const DEVIN_MAX_HOOK_BYTES = 8 * 1024 * 1024;

type Payload = Record<string, unknown>;
type Notice = {id: string; at: string; sequence?: number; event: unknown};
const object = (value: unknown): Payload => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Payload : {};
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;

export type DevinOverflow = {status: 'captured'; output: string; bytes: number; sha256: string}
  | {status: 'unavailable' | 'outside_root' | 'too_large' | 'not_regular' | 'changed'};

/** Worker-only recovery of a native output reference. Never follow a path from
 * tool arguments or scan the VM. The root is operator/runtime configuration,
 * not an event field. Hooks only persist the original notice.
 *
 * Observed Cloud PostToolUse uses overflow_path and a truncated output string.
 * The source can disappear before the worker runs; retain that gap explicitly.
 */
export async function devinOverflow(value: unknown, root = join(homedir(), '.devin-files', `devin-remote-overflows-${process.getuid?.()}`)): Promise<DevinOverflow | undefined> {
  const event = object(value), path = text(object(event.tool_response).overflow_path);
  if (event.hook_event_name !== 'PostToolUse' || event.tool_name !== 'exec' || !path) return;
  const base = resolve(root), candidate = resolve(path), rel = relative(base, candidate);
  const parts = rel.split(sep);
  if (!isAbsolute(path) || parts.length !== 2 || !/^shell-[\w-]+$/.test(parts[0] ?? '') || parts[1] !== 'content.txt') return {status: 'outside_root'};
  try {
    // Both the root and every path component must remain in the provider's
    // output pool. O_NOFOLLOW protects the final component at open time.
    if (await realpath(base) !== base || await realpath(candidate) !== candidate) return {status: 'outside_root'};
    const before = await lstat(candidate);
    if (!before.isFile()) return {status: 'not_regular'};
    if (before.size > DEVIN_MAX_HOOK_BYTES) return {status: 'too_large'};
    const file = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return {status: 'not_regular'};
      if (stat.dev !== before.dev || stat.ino !== before.ino) return {status: 'changed'};
      if (stat.size > DEVIN_MAX_HOOK_BYTES) return {status: 'too_large'};
      const buffer = Buffer.alloc(stat.size + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const read = await file.read(buffer, bytes, buffer.length - bytes, bytes);
        if (!read.bytesRead) break;
        bytes += read.bytesRead;
      }
      const after = await file.stat();
      if (bytes !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return {status: 'changed'};
      const body = buffer.subarray(0, bytes);
      return {status: 'captured', output: body.toString('utf8'), bytes, sha256: createHash('sha256').update(body).digest('hex')};
    } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') return {status: 'outside_root'};
    return {status: 'unavailable'};
  }
}

function commandExitCode(name: string, output: unknown): number | null {
  if (name !== 'exec' || typeof output !== 'string' || !/^Output from command in shell [\w-]+[.:]/.test(output)) return null;
  const match = /\nExit code: (\d+)\s*$/.exec(output);
  return match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : null;
}

export function devinSession(value: unknown) {
  const event = object(value), sessionId = text(event.session_id);
  if (!sessionId || !/^[\w.:-]{1,200}$/.test(sessionId)) throw new CliError('CAPTURE_SESSION_UNKNOWN', 'Devin hook missing a valid native session ID');
  return {sessionId, cwd: text(event.cwd)};
}

/** Retain a bounded receipt for unusable content, without reintroducing the
 * oversize payload into the next batch. This never fabricates a conversation. */
export function devinUnsupported(value: unknown, captureStatus: 'too_large' | 'unsupported', bytes: number) {
  const event = object(value);
  const fields = ['hook_event_name', 'session_id', 'prompt_id', 'tool_name', 'tool_use_id'];
  return {...Object.fromEntries(fields.flatMap(key => typeof event[key] === 'string' && event[key].length <= 200 ? [[key, event[key]]] : [])), captureStatus, bytes};
}

/** Capture only roles/events explicitly carried by the hook contract. In
 * particular, arbitrary context injections are not human-authored messages. */
export function devinEvents(notice: Notice, overflow?: DevinOverflow) {
  const event = object(notice.event), sequence = notice.sequence ?? 0;
  const make = (suffix: string, kind: string, data: Payload, order = 0, nativeId: string | null = null) => ({
    id: notice.id + suffix, kind, sequence: sequence + order, timestamp: notice.at,
    nativeId, parentId: null, turnId: text(event.prompt_id), agentId: null, data,
  });
  const evidence = () => [make('', 'hook', event)];
  if (event.captureStatus) return evidence();
  if (event.hook_event_name === 'UserPromptSubmit') {
    const prompt = text(event.prompt);
    return prompt ? [make('', 'message', {role: 'user', content: [{type: 'text', text: prompt}]})] : evidence();
  }
  if (event.hook_event_name === 'Stop') {
    const reply = text(event.last_assistant_message);
    return reply ? [make('', 'message', {role: 'assistant', content: [{type: 'text', text: reply}]})] : evidence();
  }
  if (event.hook_event_name === 'PostToolUse') {
    const name = text(event.tool_name), response = object(event.tool_response);
    if (!name || typeof response.success !== 'boolean') return evidence();
    const nativeId = text(event.tool_use_id);
    // The reference does not guarantee a call ID. A receipt-local ID pairs the
    // input and result without falsely linking repeated identical executions.
    const call = {call_id: nativeId ?? 'devin-hook:' + notice.id};
    const exitCode = commandExitCode(name, response.output);
    const output = overflow?.status === 'captured' ? overflow.output : response.output ?? null;
    const recovered = overflow?.status === 'captured' ? {status: overflow.status, bytes: overflow.bytes, sha256: overflow.sha256} : overflow ?? {status: 'unavailable'};
    const events = [
      make(':call', 'tool_call', {type: 'tool_use', name, input: event.tool_input ?? null, ...call}, 0, nativeId),
      make(':result', 'tool_result', {type: 'tool_result', name, ...call,
        // The shared renderer/indexer reads output; put error text there too,
        // retaining partial stdout instead of replacing it on a failed call.
        output: text(response.error) ? {output, error: response.error} : output,
        is_error: !response.success || exitCode !== null && exitCode !== 0,
        transport_success: response.success,
        ...(exitCode !== null ? {exit_code: exitCode} : {}),
        ...(text(response.overflow_path) ? {outputCapture: {...recovered, path: response.overflow_path}} : {}),
      }, 1, nativeId),
    ];
    // Cloud sends interim/final assistant messages through this native tool.
    // A successful delivery is a message; failed attempts and PreToolUse are
    // not. Keep the tool evidence as well, without indexing it as user prose.
    const input = object(event.tool_input), message = text(input.message);
    if (name === 'message_user' && response.success && message) events.push(make(':message', 'message', {
      role: 'assistant', content: [{type: 'text', text: message}],
      ...(typeof input.block_on_user === 'boolean' ? {final: input.block_on_user} : {}),
    }, 2, nativeId));
    return events;
  }
  if (event.hook_event_name === 'PostCompaction') {
    return [make('', 'compaction', {summary: text(event.summary)})];
  }
  return evidence();
}
