import {createHash} from 'node:crypto';
import {privatePrompt} from '../sessions/private-invocation.mjs';
import type {SessionEvent} from '../sessions/types.mjs';
import {devinConversationEvent, type DevinSession, type devinSessionApi} from './devin-api.mjs';
import {checkedDevinEventDetail, readDevinEventPage} from './devin-session-events.mjs';
import {readDevinToolPage} from './devin-tool-page.mjs';
import type {DevinEventRequest} from './devin-first-turn.mjs';

export interface DevinSessionCursor {
  phase: 'messages' | 'tools';
  admitted?: boolean;
  openingSeen?: boolean;
  messageAfter?: string;
  lastMessage?: string;
  toolAfter?: string;
  fromMs?: number;
  throughMs?: number;
  scannedThroughMs?: number;
  pageHistory?: string[];
  finalReview?: boolean;
  reviewThroughMs?: number;
  toolRetryAt?: number;
}

type Read = (request: DevinEventRequest) => Promise<string>;
type EventsClient = <T>(operation: (read: Read) => Promise<T>) => Promise<T>;
type Step = {
  cursor: DevinSessionCursor;
  events: SessionEvent[];
  state: 'continue' | 'caught-up' | 'private' | 'before-consent' | 'waiting-for-prompt' | 'waiting-for-tools';
};
function nextPage(cursor: DevinSessionCursor, after: string) {
  const digest = createHash('sha256').update(after).digest('base64url');
  if (cursor.pageHistory?.includes(digest)) throw new Error('Devin returned a repeated page cursor.');
  return [...cursor.pageHistory ?? [], digest];
}

/** Decide the ambiguous consent second using the opening event's full provider
 * timestamp. REST creation and message timestamps have only whole seconds. */
async function admit(session: DevinSession, enabledAt: number, withEvents: EventsClient) {
  const second = session.created_at * 1000;
  if (second >= enabledAt) return true;
  if (second + 999 < enabledAt) return false;
  return withEvents(async read => {
    const selected = ['initial_user_message'];
    const page = readDevinEventPage(await read({action:'list', session_id:session.session_id, first:2, event_types:selected}), selected);
    if (page.after || page.records.length > 1) throw new Error('Ambiguous Devin session opening.');
    const first = page.records[0];
    if (!first) return undefined;
    if (first.direction !== 'incoming' || first.category !== 'message') throw new Error('Invalid Devin session opening.');
    const detail = await checkedDevinEventDetail(read, session.session_id, first);
    return Date.parse(detail.timestamp) >= enabledAt;
  });
}

/** One bounded unit of provider work. Callers commit emitted events and the
 * cursor under the same connection generation, after a final consent check. */
export async function readDevinSessionStep(input: {
  session: DevinSession; cursor: DevinSessionCursor; enabledAt: number; now: number; audience: string;
  api: Pick<ReturnType<typeof devinSessionApi>,'messages'>; withEvents: EventsClient;
  previouslyStored?: (ids: string[]) => Promise<Set<string>>;
}): Promise<Step> {
  const {api, withEvents, session, enabledAt, audience} = input;
  const cursor = {...input.cursor};
  const empty = (state: Step['state']): Step => ({cursor,events:[],state});
  if (!cursor.admitted) {
    const admitted = await admit(session, enabledAt, withEvents);
    if (admitted === false) return empty('before-consent');
    if (admitted === undefined) return empty('waiting-for-prompt');
    cursor.admitted = true;
  }
  if (cursor.phase === 'messages') {
    // Freeze the tool window before reading messages, including on paginated
    // reads. A new turn after the read belongs to the next polling cycle.
    cursor.fromMs ??= Math.max(enabledAt, session.created_at * 1000, (cursor.scannedThroughMs ?? 0) - 15000);
    cursor.throughMs ??= Math.min(cursor.reviewThroughMs ?? input.now - 2000, Math.max(cursor.scannedThroughMs ?? cursor.fromMs,cursor.fromMs) + 120000);
    const page = await api.messages(session.session_id, cursor.messageAfter);
    if (!cursor.openingSeen) {
      if (!page.items.length) return empty('waiting-for-prompt');
      if (page.items[0]!.source !== 'user') throw new Error('Devin has not returned the opening user prompt.');
      cursor.openingSeen = true;
    }
    if (page.items.some(message => message.source === 'user' && privatePrompt(message.message, audience))) return empty('private');
    const previous = cursor.lastMessage ? page.items.findIndex(item => item.event_id === cursor.lastMessage) : -1;
    const events = page.items.slice(previous + 1).map(devinConversationEvent);
    if (page.has_next_page) {
      cursor.pageHistory = nextPage(cursor, page.end_cursor!);
      cursor.messageAfter = page.end_cursor!;
      delete cursor.lastMessage;
    } else {
      // Devin omits an end cursor at the tail. Revisit the last page to pick up
      // new messages while keeping the earlier pages checkpointed.
      cursor.lastMessage = page.items.at(-1)?.event_id ?? cursor.lastMessage;
      delete cursor.pageHistory;
      if (cursor.toolRetryAt && cursor.toolRetryAt > input.now) return {cursor,events,state:'waiting-for-tools'};
      delete cursor.toolRetryAt;
      cursor.phase = 'tools';
    }
    return {cursor, events, state:'continue'};
  }
  const from = cursor.fromMs!, through = cursor.throughMs!;
  if (!Number.isFinite(from) || !Number.isFinite(through)) throw new Error('Invalid Devin event checkpoint.');
  const page = through >= from ? await withEvents(read => readDevinToolPage(read, session.session_id, from, through, cursor.toolAfter,input.previouslyStored)) : {events:[],after:undefined};
  if (page.after) {
    cursor.pageHistory = nextPage(cursor, page.after);
    cursor.toolAfter = page.after;
    return {cursor, events:page.events, state:'continue'};
  }
  cursor.phase = 'messages';
  cursor.scannedThroughMs = Math.max(through, cursor.scannedThroughMs ?? 0);
  delete cursor.fromMs;
  delete cursor.throughMs;
  delete cursor.toolAfter;
  delete cursor.pageHistory;
  const horizon = cursor.reviewThroughMs ?? input.now - 2000;
  return {cursor, events:page.events, state:through < horizon - 3000 ? 'continue' : 'caught-up'};
}
