import {fail} from '../errors.mjs';
import {transcriptFragment} from '../application/transcript-links.mjs';
import {sessionScope} from '../sessions/event-identity.mjs';
import type {ResourceControls} from '../sessions/controls.mjs';
import type {Principal, JsonValue} from '../sessions/types.mjs';
import type {SearchRealm} from '../search/types.mjs';
import type {CaptureLinks} from '../state/capture-links.mjs';
import type {IntentPassage, IntentSource} from './corpus.mjs';

type Session = Pick<IntentSource, 'owner' | 'harness' | 'sessionId'>;
const sessionKey = (s: Session) => JSON.stringify([s.owner, s.harness, s.sessionId]);

/** New control reads for each operation, shared across passages from the same session. */
export function sharedIntentSources(controls: Pick<ResourceControls,'read'>) {
  return async (workspace: string, sources: readonly (Session & {id: string})[]) => {
    const sessions = new Map(sources.map(s => [sessionKey(s), s]));
    const visible = new Set<string>();
    const entries = [...sessions];
    for (let i = 0; i < entries.length; i += 8) {
      await Promise.all(entries.slice(i, i + 8).map(async ([key, s]) => {
        const current = await controls.read({tenantId: workspace, userId: s.owner}, 'sessions', s.harness, s.sessionId);
        if (!current?.deletedAt && current?.visibility !== 'private') visible.add(key);
      }));
    }
    return new Set(sources.filter(s => visible.has(sessionKey(s))).map(s => s.id));
  };
}

export interface HistoryWindow {from: string; until: string; after: JsonValue[] | null}

/** Seek through indexed shared dialogue in session order. Advance past hidden hits as well as visible ones. */
export async function intentHistoryPage(realm: SearchRealm, controls: ResourceControls, links: CaptureLinks, principal: Principal, window: HistoryWindow) {
  sessionScope(principal);
  if (principal.tenantId !== realm.tenantId || principal.captureAccess !== undefined) fail(403, 'Workspace history access required');
  const from = Date.parse(window.from), until = Date.parse(window.until);
  if (!Number.isFinite(from) || !Number.isFinite(until) || from >= until) fail(400, 'Invalid history window');
  const collection = realm.collection('session'), field = collection.field;
  const order = ['userId','harness','sessionId','timestamp','sequence','eventId','chunk'];
  const result = await collection.search(principal, {size: 48, track_total_hits: false, query: {bool: {
    filter: [{term:{tenantId:principal.tenantId}}, {term:{[field('kind')]:'message'}},
      {terms:{[field('role')]:['user','assistant']}}, {range:{[field('timestamp')]:{gte:from,lt:until}}}],
    must_not: [{term:{[field('private')]:true}}, {term:{[field('containsToolOutput')]:true}}],
  }}, sort:[...order.map(k => ({[field(k)]:'asc'})), {id:'asc'}], ...(window.after && {search_after:window.after})}, {createIfMissing:false});
  if (result.timed_out || result._shards?.failed) fail(503, 'Incomplete session history response');
  const hits = result.hits.hits;
  const page = hits.map(({_source: d, _id}) => {
    if (d.tenantId !== principal.tenantId || !d.userId || !d.sessionId || !d.harness || !d.eventId ||
        (d.role !== 'user' && d.role !== 'assistant') || typeof d.text !== 'string' || d.private === true || !d.timestamp) {
      fail(503, 'Invalid session history record');
    }
    const time = new Date(d.timestamp).getTime();
    if (!(time >= from && time < until)) fail(503, 'History record outside the selected window');
    return {id:'sessions:'+_id, tenantId:principal.tenantId, owner:d.userId, sessionId:d.sessionId, harness:d.harness,
      role:d.role, timestamp:new Date(time).toISOString(), text:d.text, eventId:d.eventId, installationId:d.installationId};
  });
  const allowed = await sharedIntentSources(controls)(principal.tenantId, page);
  const shared = page.filter(s => allowed.has(s.id));
  const ids = await links.register(principal.tenantId, 'sessions', shared.map(s => ({userId:s.owner, harness:s.harness, name:s.sessionId})));
  const passages: IntentPassage[] = shared.map((s,i) => {
    const {eventId, installationId, ...source} = s;
    const url = '/sessions/'+ids[i]+transcriptFragment({eventId, installationId});
    return {...source, role:s.role as 'user'|'assistant', url};
  });
  const after = hits.length === 48 ? hits.at(-1)?.sort : null;
  if (after === undefined || (after && JSON.stringify(after) === JSON.stringify(window.after))) fail(503, 'Session history cursor did not advance');
  return {passages, after};
}
