import {fail} from '../errors.mjs';
import {devinOwnerId, type createDevinWorkloads} from '../identity/devin.mjs';
import type {Principal, SessionEvent} from '../sessions/types.mjs';
import {privatePrompt} from '../sessions/private-invocation.mjs';
import type {RecordingPolicy} from '../sessions/recording.mjs';
import type {SetupState} from '../state/setup.mjs';
import {withDevinEventClient} from './devin-events-client.mjs';
import {firstTurnDevinEvent, readDevinEventDetail} from './devin-session-events.mjs';

export type DevinEventRequest =
  | {action: 'list'; session_id: string; first: number; event_types: string[]; after?: string;created_after?:number;created_before?:number}
  | {action: 'details'; session_id: string; event_ids: string[]; max_content_length: number};

/** The grant is established before the session starts, scoped to the provider
 * organization and workspace. Rotation, opt-out or re-enrollment invalidates it. */
export interface DevinEventGrant {
  id: string;
  enabledAt: string;
  key: string;
  sessionId?:string|null;
}

interface StartupReaderOptions {
  audience: string;
  sessionAllowed(principal:Principal,sessionId:string):Promise<boolean>;
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
    const {record,devinInitialForward} = await options.setup.read(principal);
    const installation = record?.installations.find(item => item.installationId === installationId);
    const client = installation?.clients.find(item => item.client === 'devin');
    if (!client?.installed || !client.forward || !client.forwardSince || devinInitialForward?.installationId !== installationId ||
        devinInitialForward.forwardSince !== client.forwardSince) return deny();
    const policy = await options.recording.read(principal);
    if (policy.paused || !await options.sessionAllowed(principal,session_id)) return deny();
    const grant = await options.grant(principal.tenantId, organizationId);
    if (!grant) throw Object.assign(new Error('The Devin recording credential is missing'),{status:403,code:'DEVIN_RECORDING_CREDENTIAL_REQUIRED'});
    if (!Number.isFinite(Date.parse(grant.enabledAt))) return deny();
    if (grant.sessionId === null) fail(409,'Waiting for the administrator to select a Devin session');
    if (grant.sessionId !== undefined && grant.sessionId !== session_id) return deny();
    return {grant, forwardSince: client.forwardSince, revision: policy.revision};
  }
  const start = await authorize();
  const recheck = async () => {
    const current = await authorize();
    if (current.grant.id !== start.grant.id || current.grant.enabledAt !== start.grant.enabledAt ||
        current.forwardSince !== start.forwardSince || current.revision !== start.revision) deny();
  };
  const events = await (options.withClient ?? withDevinEventClient)(start.grant.key, organizationId, request =>
    collectStartupEvents(request, recheck, session_id, Date.parse(start.grant.enabledAt),
      Math.min(end,Date.parse(start.forwardSince)), options.audience));
  await recheck();
  return options.recording.capture(principal, start.revision, events.map(event => event.timestamp), async () => {
    await options.workloads.revalidate(principal);
    return events.sort((a, b) => Date.parse(a.timestamp!) - Date.parse(b.timestamp!));
  });
}

async function collectStartupEvents(request: (input: DevinEventRequest) => Promise<string>, recheck: () => Promise<void>,
  session_id: string, enabledAt: number, end: number, audience: string): Promise<SessionEvent[]> {
  async function detail(item: Listed) {
    await recheck();
    const response = await request({action: 'details', session_id, event_ids: [item.id], max_content_length: 100000});
    const actual = readDevinEventDetail(item.id, response);
    const timestamp = Date.parse(actual.timestamp);
    if (actual.type !== item.type || actual.category !== item.category || actual.direction !== item.direction ||
        Math.floor(timestamp / 1000) * 1000 !== item.second) {
      fail(502, 'Devin event details disagree with the session listing');
    }
    return actual;
  }

  // A private initial prompt must stop recovery before even requesting tool
  // summaries. The first query contains no shell or later-message selectors.
  await recheck();
  const bounds = {created_after:Math.floor(enabledAt/1000)-1, created_before:Math.ceil(end/1000)+1};
  const opening = readEventPage(await request({action:'list', session_id, first:2, event_types:['initial_user_message'], ...bounds}));
  if (opening.after || opening.records.length > 1) fail(502, 'Ambiguous initial Devin prompt');
  const opener = opening.records[0];
  if (!opener || opener.type !== 'initial_user_message' || opener.category !== 'message' || opener.direction !== 'incoming' ||
      opener.second > end || opener.second + 999 < enabledAt) return [];
  const prompt = await detail(opener);
  const openedAt = Date.parse(prompt.timestamp);
  if (openedAt < enabledAt || openedAt > end) return [];
  if (typeof prompt.contents.message === 'string' && privatePrompt(prompt.contents.message, audience)) {
    throw Object.assign(new Error('The initial Devin prompt selected private recording'),{status:403,code:'DEVIN_SESSION_PRIVATE'});
  }
  const first = firstTurnDevinEvent(prompt);
  if (!first) return [];

  const listed = new Map<string, Listed>();
  const cursors = new Set<string>();
  let after: string | undefined;
  do {
    await recheck();
    const page = readEventPage(await request({action:'list', session_id, first:100,
      event_types:selectors.filter(type => type !== 'initial_user_message'), ...bounds, ...(after && {after})}));
    for (const item of page.records) listed.set(item.id, item);
    after = page.after;
    if (after) {
      if (cursors.has(after) || cursors.size >= 9) fail(502, 'Devin session event listing is incomplete');
      cursors.add(after);
    }
  } while (after);
  // The listing only resolves whole seconds. Do not request the full text of
  // a follow-up user message or attribute tools in its ambiguous boundary second.
  const nextTurn = Math.min(Infinity,...Array.from(listed.values(), item =>
    item.type === 'user_message' && item.direction === 'incoming' && item.category === 'message' ? item.second : Infinity));
  const ordered = [...listed.values()].filter(item =>
    item.type.startsWith('shell_process_') && item.category === 'shell' && item.direction === 'outgoing' &&
    item.second >= opener.second && item.second < nextTurn && item.second <= end);
  ordered.sort((a, b) => a.second - b.second);
  const events = [first];
  let capturedBytes=Buffer.byteLength(JSON.stringify(first));
  if(ordered.length>128)fail(502,'Devin startup event count exceeded the read limit');
  for (const item of ordered) {
    const actual = await detail(item);
    const at = Date.parse(actual.timestamp);
    if (at < openedAt || at > end) continue;
    const event = firstTurnDevinEvent(actual);
    if (event) {
      capturedBytes+=Buffer.byteLength(JSON.stringify(event));
      if(capturedBytes>2*1024*1024)fail(502,'Devin startup events exceeded the read limit');
      events.push(event);
    }
  }
  return events;
}
