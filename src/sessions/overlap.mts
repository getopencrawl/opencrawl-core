import type {Principal} from './types.mjs';
import {isSessionHarness} from './types.mjs';
import {digest, sessionScope} from './event-identity.mjs';
import {visibleTo} from './controls.mjs';
import type {createControls} from './controls.mjs';
import type {SearchCollection, QueryBody} from '../search/types.mjs';
import type {DailyOverlap, SessionOverlap} from '../application/reports.mjs';
interface Interval {first: number; last: number}
const DAY = 86_400_000;
const date = (time: number) => new Date(time).toISOString().slice(0, 10);

/** Exact integral and peak of half-open [first,last) spans. Idle gaps count. */
export function dailyOverlap(intervals: readonly Interval[], days: number, now: number): DailyOverlap[] {
  if (!Number.isInteger(days) || days < 1 || days > 365 || !Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) throw new Error('Invalid overlap window');
  const firstDay = Math.floor(now / DAY) * DAY - (days - 1) * DAY;
  const points = new Map<number, number>();
  for (const span of intervals) {
    if (!Number.isFinite(span.first) || !Number.isFinite(span.last) || span.last < span.first) throw new Error('Invalid session interval');
    const first = Math.max(firstDay, span.first), last = Math.min(now, span.last);
    if (last <= first) continue;
    points.set(first, (points.get(first) ?? 0) + 1);
    points.set(last, (points.get(last) ?? 0) - 1);
  }
  const endpoints = [...points].sort(([a], [b]) => a - b);
  const daily: DailyOverlap[] = [];
  let index = 0, active = 0;
  for (let start = firstDay; start <= now; start += DAY) {
    const end = Math.min(start + DAY, now);
    let cursor = start, area = 0, peak = 0;
    while (index < endpoints.length && endpoints[index]![0] < end) {
      const [time, delta] = endpoints[index++]!;
      if (time > cursor) {area += active * (time - cursor); peak = Math.max(peak, active);}
      active += delta;
      cursor = time;
    }
    if (end > cursor) {area += active * (end - cursor); peak = Math.max(peak, active);}
    daily.push({date: date(start), average: end > start ? area / (end - start) : 0, peak, partial: end < start + DAY});
  }
  return daily;
}

const fields = ['userId', 'harness', 'sessionId'] as const;
interface Bucket {key: string[]; doc_count: number; first: {value: number}; last: {value: number}; subagents: {doc_count: number}}
interface Buckets {buckets: Bucket[]; sum_other_doc_count: number; doc_count_error_upper_bound: number}

/** Key-ordered terms pages keep complete per-session spans on both realm backends.
 * Never restrict event time to the displayed window: a span may begin earlier.
 * Bounds fail closed instead of turning a partial scan into low concurrency. */
export async function sessionOverlap(collection: SearchCollection, controls: ReturnType<typeof createControls> | null,
  principal: Principal, {days = 30, now = Date.now()}: {days?: number; now?: number} = {}): Promise<SessionOverlap> {
  sessionScope(principal);
  if (principal.captureAccess !== undefined) throw Object.assign(new Error('Session read access required'), {status: 403});
  if (!controls) throw new Error('Session overlap requires authoritative resource controls');
  const daily = dailyOverlap([], days, now), since = Date.parse(daily[0]!.date + 'T00:00:00Z');
  const until = new Date(now).toISOString(), deadline = Date.now() + 8_000;
  const f = (field: string) => collection.field(field);
  const filter: QueryBody[] = [{term: {tenantId: principal.tenantId}}, {term: {[f('chunk')]: 0}}, visibleTo('session', principal),
    {range: {[f('timestamp')]: {lte: until}}}, {range: {[f('receivedAt')]: {lte: until}}}];
  let after: string[] | undefined;
  let remaining: number | undefined;
  const candidates: Bucket[] = [];
  const seen = new Set<string>();
  for (let page = 0; ; page++) {
    if (page >= 25 || Date.now() > deadline) throw new Error('Session overlap scan limit exceeded');
    const continuation = after ? [{bool: {minimum_should_match: 1, should: fields.map((field, i) => ({bool: {filter: [
      ...fields.slice(0, i).map((previous, j) => ({term: {[f(previous)]: after![j]}})), {range: {[f(field)]: {gt: after![i]}}},
    ]}}))}}] : [];
    const result = await collection.search(principal, {size: 0, track_total_hits: true, timeout: '2s', query: {bool: {filter: [...filter, ...continuation]}}, aggs: {
      sessions: {multi_terms: {terms: fields.map(field => ({field: f(field)})), size: 2000, order: {_key: 'asc'}, show_term_doc_count_error: true}, aggs: {
        first: {min: {field: f('timestamp')}}, last: {max: {field: f('timestamp')}}, subagents: {filter: {term: {[f('origin')]: 'subagent'}}},
      }},
    }});
    const aggregation = result.aggregations?.sessions as unknown as Buckets | undefined;
    if (result.timed_out || result._shards?.failed || result.hits.total?.relation !== 'eq' || !aggregation || !Array.isArray(aggregation.buckets)
      || !Number.isSafeInteger(result.hits.total.value) || result.hits.total.value < 0 || aggregation.buckets.length > 2000
      || remaining !== undefined && result.hits.total.value !== remaining
      || aggregation.doc_count_error_upper_bound !== 0 || !Number.isSafeInteger(aggregation.sum_other_doc_count) || aggregation.sum_other_doc_count < 0) throw new Error('Incomplete session overlap response');
    let counted = 0;
    for (const bucket of aggregation.buckets) {
      const [userId, harness, sessionId] = bucket.key ?? [];
      if (bucket.key?.length !== 3 || typeof userId !== 'string' || !userId || !isSessionHarness(harness) || typeof sessionId !== 'string' || !sessionId
        || !Number.isSafeInteger(bucket.doc_count) || bucket.doc_count <= 0 || !Number.isSafeInteger(bucket.subagents?.doc_count) || bucket.subagents.doc_count < 0 || bucket.subagents.doc_count > bucket.doc_count
        || !Number.isFinite(bucket.first?.value) || !Number.isFinite(bucket.last?.value) || bucket.last.value < bucket.first.value || bucket.last.value > now) throw new Error('Invalid session overlap bucket');
      const key = JSON.stringify(bucket.key);
      if (seen.has(key)) throw new Error('Session overlap cursor did not advance');
      seen.add(key); counted += bucket.doc_count;
      if (!bucket.subagents.doc_count && bucket.last.value > since && bucket.first.value < now) candidates.push(bucket);
    }
    if (counted + aggregation.sum_other_doc_count !== result.hits.total.value) throw new Error('Incomplete session overlap coverage');
    if (!aggregation.sum_other_doc_count) break;
    remaining = aggregation.sum_other_doc_count;
    after = aggregation.buckets.at(-1)?.key;
    if (!after) throw new Error('Session overlap cursor missing');
  }
  // Permission state is authoritative even when the search projection is stale.
  // Inventory controls once per owner/harness rather than one object read per session.
  const groups = new Map<string, Bucket[]>();
  for (const bucket of candidates) {
    const key = JSON.stringify(bucket.key.slice(0, 2));
    groups.set(key, [...(groups.get(key) ?? []), bucket]);
  }
  const intervals: Interval[] = [], entries = [...groups.values()];
  for (let offset = 0; offset < entries.length; offset += 8) await Promise.all(entries.slice(offset, offset + 8).map(async buckets => {
    const [userId, harness] = buckets[0]!.key;
    const current = await controls.list({...principal, userId: userId!}, 'sessions', harness!);
    for (const bucket of buckets) {
      const control = current.get(digest(bucket.key[2]!));
      if (control?.deletedAt || control?.visibility === 'private' && userId !== principal.userId) continue;
      intervals.push({first: bucket.first.value, last: bucket.last.value});
    }
  }));
  return {timeZone: 'UTC', measuredAt: until, sessions: intervals.length, daily: dailyOverlap(intervals, days, now)};
}
