import type {SessionEvent} from '../sessions/types.mjs';

const eventId = /^event-[a-zA-Z0-9_-]{1,160}$/;
const detailHeader = /^Event details \(1 events?\):\r?\n\r?\n--- (event-[a-zA-Z0-9_-]+) ---\r?\n  type: ([a-z_]+) \(([a-z_]+)\)\r?\n  direction: (incoming|outgoing)\r?\n  created_at: [^\r\n]+\r?\n  contents: /;
const timestampWithZone = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;

type Detail = {
  id: string;
  type: string;
  category: string;
  direction: string;
  timestamp: string;
  contents: Record<string, unknown>;
};

/** Request one event per detail response. Only the provider's envelope names
 * the event. Text inside the JSON payload can contain any number of headers. */
export function readDevinEventDetail(id: string, response: string): Detail {
  const invalid = () => new Error('Devin returned an incomplete or mismatched session event');
  if (!eventId.test(id) || Buffer.byteLength(response) > 1024 * 1024) throw invalid();
  const header = detailHeader.exec(response);
  if (!header || header[1] !== id) throw invalid();
  let body: unknown;
  try { body = JSON.parse(response.slice(header[0].length)); } catch { throw invalid(); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid();
  const contents = body as Record<string, unknown>;
  if (contents.type !== header[2] || typeof contents.timestamp !== 'string' ||
      !timestampWithZone.test(contents.timestamp) || !Number.isFinite(Date.parse(contents.timestamp))) throw invalid();
  return {id, type: header[2]!, category: header[3]!, direction: header[4]!, timestamp: contents.timestamp, contents};
}

/** Preserve native IDs on each event and use Devin's process ID to pair shell
 * calls and results, including separate executions of identical commands. */
export function firstTurnDevinEvent(detail: Detail): SessionEvent | null {
  const {id, type, category, direction, timestamp, contents} = detail;
  const base = {id: 'devin-event:' + id, nativeId: id, timestamp};
  if (type === 'initial_user_message' && category === 'message' && direction === 'incoming') {
    if (typeof contents.message !== 'string' || !contents.message.trim()) return null;
    return {...base, kind: 'message', data: {role: 'user', content: [{type: 'text', text: contents.message}]}};
  }
  if (category !== 'shell' || direction !== 'outgoing' || typeof contents.process_id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,160}$/.test(contents.process_id)) return null;
  const call = {name: 'exec', call_id: contents.process_id};
  if (type === 'shell_process_started' && typeof contents.command === 'string') {
    const input = {command: contents.command, ...(typeof contents.starting_dir === 'string' && {workdir: contents.starting_dir})};
    return {...base, kind: 'tool_call', data: {type: 'tool_use', ...call, input}};
  }
  if (type === 'shell_process_completed' && typeof contents.output_trunc === 'string') {
    const status = contents.exit_code;
    if (typeof status !== 'string' || !/^-?\d{1,10}$/.test(status)) return null;
    // Devin names this field output_trunc. Even a valid completion receipt
    // alone cannot certify that the provider retained every output byte.
    return {...base, kind: 'tool_result', data: {type: 'tool_result', ...call, output: contents.output_trunc,
      exit_code: Number(status), is_error: Number(status) !== 0, outputCapture: {status: 'provider_excerpt'}}};
  }
  return null;
}
