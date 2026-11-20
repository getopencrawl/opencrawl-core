import type {SearchCollection, QueryBody} from '../search/types.mjs';
import type {Principal} from './types.mjs';
import {memberEmailKey} from './participants.mjs';

export interface UsageMember {id: string; email: string; emailVerified?: boolean}
interface ActivityBucket {key: string; doc_count: number; last: {value_as_string?: string}; week: {doc_count: number}}
export interface OwnerBucket extends ActivityBucket {
  sessions: {count: {value: number}}; subagentSessions: {count: {value: number}};
  messages: {doc_count: number}; toolCalls: {value: number};
}
export function ownerUsage(b: OwnerBucket) {
  return {userId: b.key, events: b.doc_count, sessions: b.sessions.count.value, subagentSessions: b.subagentSessions.count.value,
    messages: b.messages.doc_count, toolCalls: b.toolCalls.value, lastAt: b.last.value_as_string ?? null, weekEvents: b.week.doc_count};
}

/** Query actual directory members in bounded groups. A workload sender proves human
 * activity on that message. Session starts and tool calls still use capture ownership. */
export async function memberUsage(collection: SearchCollection, principal: Principal, members: UsageMember[],
  window: QueryBody, ownerMetrics: QueryBody, activityMetrics: QueryBody) {
  const f = collection.field;
  const byEmail = new Map<string, string | null>();
  const keys = new Map<string, string>();
  for (const member of members) {
    const key = member.emailVerified && memberEmailKey(principal.tenantId, member.email);
    if (key) {
      byEmail.set(key, byEmail.has(key) ? null : member.id);
      keys.set(member.id, key);
    }
  }
  const result = new Map<string, ReturnType<typeof ownerUsage>>();
  for (let start = 0; start < members.length; start += 250) {
    const ids = members.slice(start, start + 250).map(m => m.id);
    const emails = ids.map(id => keys.get(id)).filter((key): key is string => !!key && !!byEmail.get(key));
    const owned = {terms: {[f('userId')]: ids}};
    const reported = {bool: {filter: [{terms: {[f('participantEmailKey')]: emails}}], must_not: [{term: {[f('private')]: true}}]}};
    const body = await collection.search(principal, {size: 0, query: {bool: {filter: [window, {term: {[f('chunk')]: 0}}],
      should: [owned, reported], minimum_should_match: 1}}, aggs: {
      direct: {filter: owned, aggs: {members: {terms: {field: f('userId'), size: ids.length}, aggs: ownerMetrics}}},
      shared: {filter: reported, aggs: {members: {terms: {field: f('participantEmailKey'), size: ids.length}, aggs: activityMetrics}}},
    }});
    const a = body.aggregations as unknown as {direct: {members: {buckets: OwnerBucket[]}}; shared: {members: {buckets: ActivityBucket[]}}};
    if (body.timed_out || body._shards?.failed || !Array.isArray(a?.direct?.members?.buckets) || !Array.isArray(a?.shared?.members?.buckets)) throw new Error('Incomplete member usage response');
    for (const b of a.direct.members.buckets) {
      if (!ids.includes(b.key)) throw new Error('Unexpected member usage owner');
      result.set(b.key, ownerUsage(b));
    }
    for (const b of a.shared.members.buckets) {
      const userId = byEmail.get(b.key);
      if (!userId || !ids.includes(userId)) throw new Error('Unexpected member usage sender');
      const row = result.get(userId) ?? {userId, events: 0, sessions: 0, subagentSessions: 0, messages: 0, toolCalls: 0, lastAt: null, weekEvents: 0};
      const last = b.last.value_as_string;
      if (last && (!row.lastAt || Date.parse(last) > Date.parse(row.lastAt))) row.lastAt = last;
      row.weekEvents += b.week.doc_count;
      result.set(userId, row);
    }
  }
  return [...result.values()];
}
