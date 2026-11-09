import type {Principal, ObjectStore, SessionEvent, SessionBatch, JsonValue} from './types.mjs';
import type {RealmOptions, QueryBody, IndexHit} from '../search/types.mjs';
interface RecentBucket {key: string[]; lastActivity: {value: number}}
import {createRealmResolver, realmField} from '../search/realm.mjs';
import {createSessionIngest, sessionScope, digest} from './ingest.mjs';
import {sourceBatchIdentity} from './event-identity.mjs';
import {visibleTo} from './controls.mjs';
import {capturedTitle, TITLE_KINDS} from './titles.mjs';
import {promptText} from './library.mjs';

const identityFields = ['userId', 'harness', 'installationId', 'sessionId'];
const f = (key: string) => realmField('session', key);
const invalid = () => new Error('Invalid recent session response');
const iso = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

// Only message text is context. Tool arguments/results, thinking, attachments,
// transport metadata and routing instructions must never become message text.
export function sessionMessage(event: SessionEvent) {
  const data = event?.data;
  let role;
  if (event?.kind === 'message') role = data?.role;
  else if (event?.kind === 'agent_message' && data?.author === 'assistant' && (!data.recipient || data.recipient === 'all')) role = 'assistant';
  else if (event?.kind === 'user_message') role = 'user';
  if (!['user', 'assistant'].includes(role ?? '') || (data?.recipient && data.recipient !== 'all')) return null;
  const content = event.kind === 'user_message' ? data?.message : data?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content
    .filter(block => ['text', 'input_text', 'output_text'].includes(block?.type) && typeof block.text === 'string')
    .map(block => block.text).join('\n') : '';
  // Codex stores injected context and agent notifications in user-role records.
  // They are not human prompts and must not become a chat's title or last ask.
  const own = role === 'user' ? promptText(text) : text;
  return own?.trim() ? {role, text: own} : null;
}

/** Read the current tenant's ten newest indexed sessions, then verify and read
 * original events from immutable capture. No new projection or reindex needed. */
export function createRecentSessions({store, prefix, ...options}: RealmOptions & {store: ObjectStore; prefix: string}) {
  const resolve = createRealmResolver(options), ingest = createSessionIngest({store, prefix});
  return {async read(principal: Principal, {signal}: {signal?: AbortSignal} = {}) {
    sessionScope(principal);
    if (principal.captureAccess !== undefined) throw Object.assign(new Error('Session read access required'), {status: 403});
    const collection = resolve(principal).collection('session');
    const query = (body: QueryBody) => {signal?.throwIfAborted(); return collection.search(principal, body);};
    // max descending selects the correct top buckets across shards. Use the
    // canonical event timestamp (receipt fallback), never backfill upload time.
    const result = await query({size: 0, query: {bool: {filter: [{term: {[f('chunk')]: 0}}, visibleTo('session', principal)]}}, aggs: {
      recent: {multi_terms: {terms: identityFields.map(key => ({field: f(key)})), size: 10,
        order: [{lastActivity: 'desc'}, {_key: 'asc'}]}, aggs: {lastActivity: {max: {field: 'timestamp'}}}},
    }});
    const buckets = result.aggregations?.recent?.buckets as unknown as RecentBucket[] | undefined;
    if (!Array.isArray(buckets) || buckets.length > 10) throw invalid();
    const sessions = [];
    for (const bucket of buckets) {
      if (!Array.isArray(bucket.key) || bucket.key.length !== 4 || bucket.key.some(value => typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value)) || !Number.isFinite(bucket.lastActivity?.value)) throw invalid();
      const identity = Object.fromEntries(identityFields.map((key, i) => [key, bucket.key[i]]));
      if (!['codex', 'claude-code'].includes(identity.harness)) throw invalid();
      const filter: QueryBody[] = identityFields.map(key => ({term: {[f(key)]: identity[key]}}));
      const lastActivityAt = new Date(bucket.lastActivity.value).toISOString();
      filter.push({term: {[f('chunk')]: 0}}, {range: {timestamp: {lte: lastActivityAt}}}, visibleTo('session', principal));
      // Per-session cache only; evict large batches as we advance through history.
      const batches = new Map<string, SessionBatch>();
      async function original(hit: IndexHit) {
        signal?.throwIfAborted();
        const d = hit._source;
        if (d?.tenantId !== principal.tenantId || identityFields.some(key => d[key] !== identity[key]) || typeof d.eventId !== 'string') throw invalid();
        const source = sourceBatchIdentity(prefix, d.sourceKey || '');
        if (!source || source.tenantHash !== digest(principal.tenantId) || source.userHash !== digest(identity.userId) || source.harness !== identity.harness || source.installationHash !== digest(identity.installationId) || source.sessionHash !== digest(identity.sessionId)) throw invalid();
        let batch = batches.get(d.sourceKey ?? '');
        if (!batch) {
          batch = (await ingest.getBatch(principal, {...identity, batchId: source.batchId})) ?? undefined;
          if (!batch) throw new Error('Recent session source unavailable');
          if (batches.size >= 4) batches.delete(batches.keys().next().value!);
          batches.set(d.sourceKey!, batch);
        }
        const event = batch.events.find(event => event.id === d.eventId);
        if (!event || event.kind !== d.kind) throw invalid();
        return {event, batch};
      }
      let partial = false;
      async function select(role: string, direction: string) {
        let after: JsonValue[] | undefined;
        const should = role === 'user'
          ? [{bool: {filter: [{term: {[f('kind')]: 'message'}}, {term: {[f('role')]: 'user'}}]}}, {term: {[f('kind')]: 'user_message'}}]
          : [{bool: {filter: [{term: {[f('kind')]: 'message'}}, {term: {[f('role')]: 'assistant'}}]}}, {term: {[f('kind')]: 'agent_message'}}];
        // Tool-only native messages can precede the desired text. Page through
        // them; explicitly report an incomplete field if this work bound is hit.
        for (let page = 0; page < 10; page++) {
          const found = await query({size: 20, query: {bool: {filter, should, minimum_should_match: 1}},
            sort: [{timestamp: direction}, {[f('sequence')]: direction}, {[f('eventId')]: direction}, {id: direction}],
            ...(after ? {search_after: after} : {})});
          for (const hit of found.hits.hits) {
            const {event, batch} = await original(hit), message = sessionMessage(event);
            if (message?.role === role) return {text: message.text, timestamp: iso(event.timestamp), receivedAt: iso(batch.receivedAt), eventId: event.id};
          }
          if (found.hits.hits.length < 20) return null;
          after = found.hits.hits.at(-1)!.sort;
          if (!Array.isArray(after)) throw invalid();
        }
        partial = true;
        return null;
      }
      const firstUserMessage = await select('user', 'asc');
      const lastUserMessage = await select('user', 'desc');
      const latestAssistantMessage = await select('assistant', 'desc');
      let title = null, titleTimestamp = null;
      const metadata = await query({size: 20, query: {bool: {filter: [...filter,
        {terms: {[f('kind')]: TITLE_KINDS}}]}}, sort: [{timestamp: 'desc'}, {[f('sequence')]: 'desc'}, {id: 'desc'}]});
      for (const hit of metadata.hits.hits) {
        const {event, batch} = await original(hit);
        const candidate = capturedTitle(event, batch);
        if (typeof candidate === 'string' && candidate.trim()) {title = candidate; titleTimestamp = iso(event.timestamp); break;}
      }
      const titleSource = title ? 'captured' : firstUserMessage ? 'first_user_message' : 'session_id';
      title ||= firstUserMessage?.text.replace(/\s+/g, ' ').trim() || `Session ${identity.sessionId}`;
      if (titleSource === 'first_user_message') titleTimestamp = firstUserMessage!.timestamp;
      sessions.push({...identity, title, titleSource, titleTimestamp, lastActivityAt, firstUserMessage, lastUserMessage, latestAssistantMessage, partial});
    }
    return sessions;
  }};
}
