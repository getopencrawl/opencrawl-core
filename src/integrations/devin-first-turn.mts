import {fail} from '../errors.mjs';
import {devinOwnerId, type createDevinWorkloads} from '../identity/devin.mjs';
import type {Principal, SessionEvent} from '../sessions/types.mjs';
import type {RecordingPolicy} from '../sessions/recording.mjs';
import type {SetupState} from '../state/setup.mjs';
import {withDevinEventClient} from './devin-events-client.mjs';
import {firstTurnDevinEvent, readDevinEventDetail} from './devin-session-events.mjs';

export type DevinEventRequest =
  | {action: 'list'; session_id: string; first: number; event_types: string[]; after?: string}
  | {action: 'details'; session_id: string; event_ids: string[]; max_content_length: number};

/** The grant is established before the session starts, scoped to the provider
 * organization and workspace. Rotation, opt-out or re-enrollment invalidates it. */
export interface DevinEventGrant {
  id: string;
  enabledAt: string;
  key: string;
}

interface StartupReaderOptions {
  workloads: Pick<ReturnType<typeof createDevinWorkloads>, 'revalidate'>;
  setup: Pick<SetupState, 'read'>;
  recording: RecordingPolicy;
  grant(tenantId: string, organizationId: string): Promise<DevinEventGrant | null>;
  withClient?: typeof withDevinEventClient;
  now?: () => number;
}

const selectors = ['initial_user_message', 'user_message', 'shell_process_started', 'shell_process_completed'];
const listLine = /^\[(event-[a-zA-Z0-9_-]{1,160})\] (\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) UTC (<<<|>>>) ([a-z_]+) \(([a-z_]+)\):/gm;
type Listed = {id: string; second: number; direction: string; type: string; category: string};

function readEventPage(page: string) {
  if (Buffer.byteLength(page) > 1024 * 1024) fail(502, 'Devin session event listing exceeded the read limit');
  const header = page.split(/^\[event-/m, 1)[0]!;
  const continuation = /More results available\. Pass after=([^\s]{1,2048}) to fetch the next page\./.exec(header);
  if (header.includes('More results available') && !continuation) fail(502, 'Unrecognized Devin pagination response');
  const records: Listed[] = [];
  for (const match of page.matchAll(listLine)) {
    const [, id, day, time, arrow, type, category] = match;
    if (!id || !type || !category || !selectors.includes(type)) continue;
    const second = Date.parse(day + 'T' + time + 'Z');
    if (!Number.isFinite(second)) fail(502, 'Invalid Devin session event time');
    records.push({id, type, category, second, direction: arrow === '<<<' ? 'incoming' : 'outgoing'});
  }
  if (records.length > 100) fail(502, 'Devin session event page exceeded the requested size');
  return {records, after: continuation?.[1]};
}

/** Read the bounded gap observed at startup. The installation supplies only its
 * native cutoff. Every provider request uses the session from verified OIDC. */
export async function readDevinStartupEvents(options: StartupReaderOptions, principal: Principal,
  installationId: string, through: string): Promise<SessionEvent[]> {
  const owner = principal.owner;
  if (owner?.provider !== 'devin' || principal.userId !== devinOwnerId(owner.organizationId, owner.sessionId)) {
    fail(403, 'A signed Devin Cloud session is required');
  }
  const end = Date.parse(through);
  if (!Number.isFinite(end) || end > (options.now ?? Date.now)()) fail(400, 'Invalid startup interval');
  const {sessionId: session_id, organizationId} = owner;
  const deny = () => fail(403, 'Devin first-turn recording is not enabled for this installation');
  async function authorize() {
    await options.workloads.revalidate(principal);
    const {record} = await options.setup.read(principal);
    const installation = record?.installations.find(item => item.installationId === installationId);
    const client = installation?.clients.find(item => item.client === 'devin');
    if (!client?.installed || !client.forward || !client.forwardSince) return deny();
    const grant = await options.grant(principal.tenantId, organizationId);
    if (!grant || !Number.isFinite(Date.parse(grant.enabledAt))) return deny();
    const policy = await options.recording.read(principal);
    if (policy.paused) return deny();
    return {grant, forwardSince: client.forwardSince, revision: policy.revision};
  }
  const start = await authorize();
  const recheck = async () => {
    const current = await authorize();
    if (current.grant.id !== start.grant.id || current.grant.enabledAt !== start.grant.enabledAt ||
        current.forwardSince !== start.forwardSince || current.revision !== start.revision) deny();
  };
  const events = await (options.withClient ?? withDevinEventClient)(start.grant.key, request =>
    collectStartupEvents(request, recheck, session_id, Date.parse(start.grant.enabledAt), end));
  await recheck();
  return options.recording.capture(principal, start.revision, events.map(event => event.timestamp), async () => {
    await options.workloads.revalidate(principal);
    return events.sort((a, b) => Date.parse(a.timestamp!) - Date.parse(b.timestamp!));
  });
}

async function collectStartupEvents(request: (input: DevinEventRequest) => Promise<string>, recheck: () => Promise<void>,
  session_id: string, enabledAt: number, end: number): Promise<SessionEvent[]> {
  const listed = new Map<string,Listed>();
  const cursors = new Set<string>();
  let after: string | undefined;
  do {
    await recheck();
    const page = readEventPage(await request({action:'list', session_id, first:100, event_types:[...selectors], ...(after && {after})}));
    for (const item of page.records) listed.set(item.id, item);
    after = page.after;
    if (after) {
      if (cursors.has(after) || cursors.size >= 9) fail(502, 'Devin session event listing is incomplete');
      cursors.add(after);
    }
  } while (after);
  // Do not request the body of a subsequent user message. The provider's list
  // exposes only second precision, so exclude the ambiguous boundary second.
  const nextTurn = Math.min(Infinity,...Array.from(listed.values(), item =>
    item.type === 'user_message' && item.direction === 'incoming' && item.category === 'message' ? item.second : Infinity));
  const initial = [...listed.values()].filter(item => item.type === 'initial_user_message' && item.direction === 'incoming' && item.category === 'message');
  if (initial.length !== 1) return [];
  const opener = initial[0]!;
  const ordered = [...listed.values()].filter(item => item.type !== 'initial_user_message' && item.type !== 'user_message' && item.second >= opener.second);
  ordered.sort((a, b) => a.second - b.second);
  ordered.unshift(opener);
  const events: SessionEvent[] = [];
  for (const {id, second, direction, type, category} of ordered) {
    // Listing times have second precision. Check native precision again below.
    if (second >= nextTurn || second > end || second + 999 < enabledAt) {
      if (id === opener.id) return [];
      continue;
    }
    await recheck();
    const data = await request({action: 'details', session_id, event_ids: [id], max_content_length: 100000});
    const detail = readDevinEventDetail(id, data);
    if (detail.type !== type || detail.category !== category || detail.direction !== direction) {
      fail(502, 'Devin event details disagree with the session listing');
    }
    const timestamp = Date.parse(detail.timestamp);
    if (timestamp < enabledAt || timestamp > end || timestamp >= nextTurn) {
      if (id === opener.id) return [];
      continue;
    }
    const event = firstTurnDevinEvent(detail);
    if (!event) {
      if (id === opener.id) return [];
      continue;
    }
    events.push(event);
  }
  return events;
}
