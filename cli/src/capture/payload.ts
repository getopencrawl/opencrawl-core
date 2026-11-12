import type {Origin} from './parse.ts';

/** Agents whose sessions this collector assembles from what their own hooks or
 * plugin deliver, because they keep no transcript file it reads. Grok Bot works
 * the same way and predates this table; see grok-bot.ts. */
export type PayloadHarness = 'opencode'|'cursor'|'muse';
/** One delivery, saved before the hook returned. */
export type PayloadNotice = {id:string; at:string; sequence?:number; context?:Record<string,string>|null; event:any};
/** Batch metadata for one delivery: where it belongs, never its content. */
export type PayloadSession = {sessionId:string; cwd:string|null; version:string|null; origin:Origin; originEvidence:string; parentSessionId:string|null};

export interface PayloadAdapter {
  /** The session a delivery belongs to; null when nothing in it names one. */
  session(event:any, at:string, context?:Record<string,string>|null): PayloadSession|null;
  /** Message, reasoning, tool and compaction events in the shapes transcript
   * capture produces. Lifecycle deliveries stay as unindexed hook evidence. */
  events(notice:PayloadNotice): any[];
  /** The fields that still identify a delivery too large or too deep to upload. */
  identifying: readonly string[];
  /** What the agent must read on stdout to carry on unchanged. */
  response(event:any): unknown;
  /** A turn or session ended: the cheapest moment to upload. */
  boundary(event:any): boolean;
  /** What the agent calls this delivery, for the counts in collect status. */
  name(event:any): string|null;
  /** The agent's plugin leaves its deliveries as files in an inbox instead of
   * piping one to each hook process. */
  inbox?: boolean;
  /** Facts only the hook's own environment holds, kept beside the delivery. */
  context?(env: NodeJS.ProcessEnv): Record<string, string> | null;
}

export const PAYLOAD_HARNESSES: readonly PayloadHarness[] = ['opencode', 'cursor', 'muse'];
export const isPayloadHarness = (harness: unknown): harness is PayloadHarness => (PAYLOAD_HARNESSES as readonly unknown[]).includes(harness);

/** One delivery becomes a handful of events, well under the 16 MiB batch limit. */
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
/** A delivery that can never be uploaded is kept as evidence that it happened,
 * so it cannot hold back the events around it. */
export function unsupportedPayload(adapter: PayloadAdapter, event: any, captureStatus: 'too_large' | 'unsupported', bytes: number) {
  return {...Object.fromEntries(adapter.identifying.filter(key => event?.[key] !== undefined).map(key => [key, event[key]])), captureStatus, bytes};
}

// Shared by the adapters.
export const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : null;
export const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const deeper = (value: unknown, limit: number): boolean => value !== null && typeof value === 'object' && (limit === 0 || Object.values(value).some(child => deeper(child, limit - 1)));
/** Tool payloads often arrive JSON-stringified. Restore the structure so inline
 * images become attachments instead of megabytes of indexed base64 text.
 * Events nest at most 128 levels, so deeper JSON stays the text it arrived as. */
export function structured(value: unknown) {
  if (typeof value !== 'string' || !/^\s*[[{]/.test(value)) return value;
  try {const parsed = JSON.parse(value); return deeper(parsed, 96) ? value : parsed;} catch {return value;}
}
/** A session ID the receiver accepts. A native ID that is not one keeps its
 * identity through a digest. */
export function sessionKey(native: string, digest: (value: string) => string) {
  return /^[\w.:-]{1,180}$/.test(native) ? native : 'session-' + digest(native).slice(0, 32);
}
/** An event in the collector's wire shape. */
export function eventMaker(notice: PayloadNotice, turnId: string | null) {
  const sequence = notice.sequence ?? 0;
  return (suffix: string, kind: string, data: any, nativeId: string | null = null, order = 0, timestamp: string | null = null) =>
    ({id: notice.id + suffix, kind, sequence: sequence + order, timestamp: timestamp ?? notice.at, nativeId, parentId: null, turnId, agentId: null, data});
}
