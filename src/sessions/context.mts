import type {Principal} from './types.mjs';
import type {Passage, SearchCollection, SessionContextInput, SessionContextResult} from '../search/types.mjs';
import type {createControls} from './controls.mjs';
import {visibleTo} from './controls.mjs';
import {sessionScope} from './ingest.mjs';
import {realmField} from '../search/realm-format.mjs';
import {sessionSearchExclusions} from '../search/context.mjs';
import {TITLE_KINDS} from './titles.mjs';

const f = (field: string) => realmField('session', field);
function fail(status: number, message: string): never {throw Object.assign(new Error(message), {status});}

/** One first passage per neighboring event, never one row per passage chunk.
 * The selected passage remains the anchor, including matches deep in a long
 * event. Each direction obtains its own native sort tuple: missing timestamps
 * have different OpenSearch sentinels in ascending and descending order.
 */
export async function sessionContext(collection: SearchCollection, controls: ReturnType<typeof createControls>, principal: Principal,
  anchor: Passage, input: SessionContextInput): Promise<SessionContextResult> {
  sessionScope(principal);
  if (principal.captureAccess !== undefined) fail(403, 'Session read access required');
  if (anchor.tenantId !== principal.tenantId || !anchor.userId || !anchor.harness || !anchor.sessionId || !anchor.eventId || !anchor.id)
    fail(400, 'Invalid context anchor');
  if (![input.before, input.after].every(n => Number.isInteger(n) && n >= 0 && n <= 10) || typeof input.includeToolOutputs !== 'boolean')
    fail(400, 'Invalid event context window');
  async function authorize() {
    const control = await controls.read({...principal, userId: anchor.userId!}, 'sessions', anchor.harness!, anchor.sessionId!);
    if (control?.deletedAt || control?.visibility === 'private' && anchor.userId !== principal.userId)
      fail(404, 'Session not found or no longer available.');
  }
  const sameSession = (doc: Passage) => doc.tenantId === principal.tenantId && doc.userId === anchor.userId && doc.harness === anchor.harness && doc.sessionId === anchor.sessionId;
  const scope = [{term: {tenantId: principal.tenantId}}, ...['userId', 'harness', 'sessionId'].map(key => ({term: {[f(key)]: anchor[key]}})), visibleTo('session', principal)];
  await authorize();
  async function direction(count: number, reverse: boolean) {
    // Query one extra event even for a zero-sized side, so more is truthful.
    const order = reverse ? 'desc' : 'asc';
    const sort = [{[f('timestamp')]: {order, missing: reverse ? '_last' : '_first'}}, {[f('sequence')]: order}, {[f('eventId')]: order}];
    const selected = await collection.search(principal, {size: 1, query: {bool: {filter: [...scope, {term: {id: anchor.id}}]}}, sort});
    const found = selected.hits.hits[0];
    if (!found) fail(404, 'Context anchor not found or no longer available.');
    const doc = {...found._source, id: found._id};
    if (!sameSession(doc) || doc.id !== anchor.id || doc.eventId !== anchor.eventId || !Array.isArray(found.sort) || found.sort.length !== 3)
      throw new Error('Invalid session context anchor scope');
    const result = await collection.search(principal, {size: count + 1, track_total_hits: false, sort, search_after: found.sort,
      query: {bool: {filter: [...scope, {term: {[f('chunk')]: 0}}, ...sessionSearchExclusions(principal, {includeToolOutputs: input.includeToolOutputs})],
        must_not: [{term: {[f('eventId')]: anchor.eventId}}, {terms: {[f('kind')]: ['hook', 'token_count', 'turn_metadata', ...TITLE_KINDS]}}]}}});
    const hits = result.hits.hits.map(hit => ({...hit._source, id: hit._id}));
    if (hits.length > count + 1 || hits.some(hit => !sameSession(hit) || typeof hit.eventId !== 'string' || hit.eventId === anchor.eventId || hit.chunk !== 0) || new Set(hits.map(hit => hit.eventId)).size !== hits.length)
      throw new Error('Invalid session context result scope');
    const events = hits.slice(0, count);
    return {events: reverse ? events.reverse() : events, more: hits.length > count};
  }
  const [before, after] = await Promise.all([direction(input.before, true), direction(input.after, false)]);
  // Buffer every event until the final authoritative privacy/deletion barrier.
  await authorize();
  return {before: before.events, after: after.events, moreBefore: before.more, moreAfter: after.more};
}
