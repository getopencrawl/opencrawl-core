import type {Principal, ObjectStore, SessionEvent, JsonValue} from './types.mjs';
import type {RealmOptions, QueryBody, IndexHit} from '../search/types.mjs';
import {createRealmResolver, realmField} from '../search/realm.mjs';
import {createSessionIngest, sessionScope, digest} from './ingest.mjs';
import {sourceBatchIdentity} from './event-identity.mjs';
import {createControls, visibleTo} from './controls.mjs';
import type {ResourceControl} from './controls.mjs';

export interface SessionKey {userId: string; harness: string; sessionId: string}
export interface SessionSummary extends SessionKey {
  title: string; private: boolean; mine: boolean; origin: string | null; host: string | null;
  firstActivityAt: string | null; lastActivityAt: string | null; events: number;
}
export type TranscriptEntry =
  | {type: 'message'; role: 'user' | 'assistant'; text: string}
  | {type: 'tool_call'; name: string; input: string; truncated: boolean}
  | {type: 'tool_result'; text: string; truncated: boolean}
  | {type: 'note'; label: string; text: string; truncated: boolean};
export interface TranscriptEvent {eventId: string; kind: string; timestamp: string | null; entries: TranscriptEntry[]}

const HARNESSES = ['claude-code', 'codex'];
const identity = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
const f = (field: string) => realmField('session', field);
const MAX_TEXT = 20000;
function fail(status: number, message: string): never {throw Object.assign(new Error(message), {status});}
function clip(text: string) {return text.length > MAX_TEXT ? {text: text.slice(0, MAX_TEXT), truncated: true} : {text, truncated: false};}
function stringify(value: unknown) {if (typeof value === 'string') return value; try {return JSON.stringify(value, null, 2) ?? '';} catch {return '';}}
function iso(value: unknown) {return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null;}
// Codex stores injected context and notifications as user-role records.
const INJECTED = /^(?:# AGENTS\.md instructions\b|<(?:environment_context|external_codex_apps_\w+|subagent_notification|turn_aborted|user_instructions|system-reminder)\b)/;
// Codex prefixes IDE context and attached files before the person's request.
const CODEX_REQUEST = /^# (?:Context from my IDE setup|Files mentioned by the user):[\s\S]*?## My request for Codex:\s*/;
/** The person's own words from a prompt, or null for injected context. */
export function promptText(text: string) {
  const trimmed = text.trimStart(), request = trimmed.replace(CODEX_REQUEST, '');
  if (request !== trimmed) return request.trim() || null;
  return INJECTED.test(trimmed) || /^# (?:Context from my IDE setup|Files mentioned by the user):/.test(trimmed) ? null : trimmed.trim() || null;
}
// Readable conversation kinds, and bookkeeping kinds that never render.
const CONVERSATION = ['message', 'user_message', 'agent_message'];
const HIDDEN = ['token_count', 'hook', 'turn_metadata', 'session_metadata'];
// Rendered-text budget for reused batches (UTF-16 code units, about 64 MB).
const CACHE_CHARS = 32 * 1024 * 1024, FETCH_CONCURRENCY = 12;
function checkKey({userId, harness, sessionId}: Partial<SessionKey>) {
  if (!identity(userId) || !HARNESSES.includes(harness ?? '') || !identity(sessionId)) fail(400, 'Invalid session');
  return {userId: userId!, harness: harness!, sessionId: sessionId!};
}
function blockText(block: Record<string, unknown>) {
  if (typeof block.text === 'string') return block.text;
  if (Array.isArray(block.content)) return block.content.map(part => typeof part === 'string' ? part : part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string' ? (part as Record<string, unknown>).text as string : '').filter(Boolean).join('\n');
  return stringify(block.content ?? block.output ?? '');
}

/** Readable transcript entries from one original captured event. Thinking,
 * encrypted content, token accounting and transport bookkeeping are omitted. */
export function transcriptEntries(event: SessionEvent): TranscriptEntry[] {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const entries: TranscriptEntry[] = [];
  const message = (role: unknown, text: string) => {
    if (!text.trim() || !['user', 'assistant'].includes(String(role))) return;
    if (role === 'user') {
      const own = promptText(text);
      if (own === null) {entries.push({type: 'note', label: 'Injected context', ...clip(text)}); return;}
      if (own !== text.trim()) entries.push({type: 'note', label: 'Attached context', ...clip(text.slice(0, text.length - own.length))});
      entries.push({type: 'message', role: 'user', text: own}); return;
    }
    entries.push({type: 'message', role: role as 'user' | 'assistant', text});
  };
  if (event.kind === 'message') {
    const content = data.content;
    if (typeof content === 'string') message(data.role, content);
    else if (Array.isArray(content)) for (const raw of content) {
      if (!raw || typeof raw !== 'object') continue;
      const block = raw as Record<string, unknown>;
      if (['text', 'input_text', 'output_text'].includes(String(block.type)) && typeof block.text === 'string') message(data.role, block.text);
      else if (block.type === 'tool_use') entries.push({type: 'tool_call', name: String(block.name ?? 'tool'), ...((c => ({input: c.text, truncated: c.truncated}))(clip(stringify(block.input))))});
      else if (block.type === 'tool_result') entries.push({type: 'tool_result', ...clip(blockText(block))});
      else if (block.type === 'image' || block.type === 'input_image') entries.push({type: 'note', label: 'Image', text: '', truncated: false});
    }
  } else if (event.kind === 'user_message') message('user', typeof data.message === 'string' ? data.message : '');
  else if (event.kind === 'agent_message') {
    if (data.author === 'assistant' && (!data.recipient || data.recipient === 'all')) message('assistant', Array.isArray(data.content) ? data.content.map(b => b && typeof b === 'object' && typeof (b as Record<string, unknown>).text === 'string' ? (b as Record<string, unknown>).text : '').join('\n') : stringify(data.content));
  } else if (event.kind === 'tool_call') {
    entries.push({type: 'tool_call', name: String(data.name ?? data.type ?? 'tool'), ...((c => ({input: c.text, truncated: c.truncated}))(clip(stringify(data.arguments ?? data.input ?? data.action ?? ''))))});
  } else if (event.kind === 'tool_result') entries.push({type: 'tool_result', ...clip(stringify(data.output ?? data.content ?? ''))});
  else if (event.kind === 'exec_command_end') entries.push({type: 'tool_result', ...clip(stringify(data.aggregated_output ?? data.formatted_output ?? data.stdout ?? ''))});
  else if (event.kind === 'reasoning_summary') {
    const text = Array.isArray(data.summary) ? data.summary.map(part => part && typeof part === 'object' ? String((part as Record<string, unknown>).text ?? '') : '').join('\n') : '';
    if (text.trim()) entries.push({type: 'note', label: 'Reasoning summary', ...clip(text)});
  } else if (event.kind === 'compaction') entries.push({type: 'note', label: 'Context compacted', ...clip(stringify(data.summary ?? ''))});
  else if (event.kind === 'attachment' && typeof data.type === 'string') entries.push({type: 'note', label: 'Attachment', ...clip(stringify(data.filename ?? data.path ?? data.type))});
  return entries;
}

type SessionCollection = ReturnType<ReturnType<ReturnType<typeof createRealmResolver>>['collection']>;
/** Applies an owner's current control to every indexed document of the session. */
export function applySessionControl(collection: SessionCollection, principal: Principal, key: SessionKey, control: ResourceControl) {
  const query = {bool: {filter: [{term: {[f('userId')]: key.userId}}, {term: {[f('harness')]: key.harness}}, {term: {[f('sessionId')]: key.sessionId}}]}};
  return control.deletedAt ? collection.byQuery(principal, 'delete', query)
    : collection.byQuery(principal, 'update', query, {lang: 'painless', source: 'ctx._source.session.private = params.value', params: {value: control.visibility === 'private'}});
}

function encodeCursor(sort: JsonValue[] | undefined) {return sort ? Buffer.from(JSON.stringify(sort)).toString('base64url') : null;}
function decodeCursor(cursor: unknown): JsonValue[] | undefined {
  if (cursor === undefined || cursor === null) return undefined;
  if (typeof cursor !== 'string' || cursor.length > 2048) fail(400, 'Invalid cursor');
  try {const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown; if (Array.isArray(value) && value.length === 5 && value.every(v => ['string', 'number'].includes(typeof v))) return value as JsonValue[];} catch { /* rejected below */ }
  fail(400, 'Invalid cursor');
}

/** Team members read every session that is not private to another member.
 * Only the owner changes visibility or deletes; deletion removes raw capture,
 * search documents and future uploads of the same session. */
export function createSessionLibrary({store, prefix, ...options}: RealmOptions & {store: ObjectStore; prefix: string}) {
  const resolve = createRealmResolver(options), ingest = createSessionIngest({store, prefix}), controls = createControls({store, prefix});
  const reader = (principal: Principal) => {
    sessionScope(principal);
    if (principal.captureAccess !== undefined) fail(403, 'Session read access required');
    return resolve(principal).collection('session');
  };
  const sessionFilter = (key: SessionKey) => [{term: {[f('userId')]: key.userId}}, {term: {[f('harness')]: key.harness}}, {term: {[f('sessionId')]: key.sessionId}}];
  async function owned(principal: Principal, key: SessionKey) {
    const result = await reader(principal).search(principal, {size: 0, track_total_hits: 1, query: {bool: {filter: sessionFilter(key)}}});
    return result.hits.total.value > 0;
  }
  const apply = (principal: Principal, key: SessionKey, control: ResourceControl) => applySessionControl(reader(principal), principal, key, control);
  // Batches are immutable and content-addressed, so rendered events can be reused
  // across pages and readers. Every read still authorizes through the index first.
  const rendered = new Map<string, {value: Promise<Map<string, TranscriptEvent> | null>; size: number}>();
  let cachedChars = 0;
  const weigh = (events: Map<string, TranscriptEvent>) => [...events.values()].reduce((sum, event) => sum + 64 + event.entries.reduce((total, entry) => total + (entry.type === 'tool_call' ? entry.input.length + entry.name.length : entry.type === 'note' ? entry.text.length + entry.label.length : entry.text.length), 0), 0);
  function renderedBatch(principal: Principal, key: SessionKey, sourceKey: string, installationId: string, batchId: string) {
    const cached = rendered.get(sourceKey);
    if (cached) {rendered.delete(sourceKey); rendered.set(sourceKey, cached); return cached.value;}
    const entry = {value: ingest.getBatch(principal, {...key, installationId, batchId}).then(batch => batch && new Map(batch.events.map(event => [event.id, {eventId: event.id, kind: event.kind, timestamp: iso(event.timestamp), entries: transcriptEntries(event)}]))), size: 0};
    rendered.set(sourceKey, entry);
    entry.value.then(events => {
      if (rendered.get(sourceKey) !== entry) return;
      entry.size = events ? weigh(events) : 0; cachedChars += entry.size;
      for (const [oldest, value] of rendered) {if (cachedChars <= CACHE_CHARS || oldest === sourceKey) break; rendered.delete(oldest); cachedChars -= value.size;}
    }, () => {if (rendered.get(sourceKey) === entry) rendered.delete(sourceKey);});
    return entry.value;
  }
  return {
    async list(principal: Principal, {scope = 'all', query = '', limit = 50}: {scope?: unknown; query?: unknown; limit?: unknown} = {}) {
      const collection = reader(principal);
      if (!['all', 'mine'].includes(String(scope)) || typeof query !== 'string' || query.length > 500 || !Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 500) fail(400, 'Invalid session list');
      // Summarize from conversation records only: bookkeeping is most of the index.
      const filter: QueryBody[] = [{term: {[f('chunk')]: 0}}, {terms: {[f('kind')]: CONVERSATION}}, visibleTo('session', principal), ...(scope === 'mine' ? [{term: {[f('userId')]: principal.userId}}] : [])];
      const fields = ['userId', 'harness', 'sessionId'].map(field => ({field: f(field)}));
      const order = [{lastActivity: 'desc'}, {_key: 'asc'}];
      if (query.trim()) {
        // Select sessions containing the words, then summarize each whole session.
        const matched = await collection.search(principal, {size: 0, query: {bool: {filter, must: [{match: {text: {query: query.trim(), operator: 'and'}}}]}},
          aggs: {sessions: {multi_terms: {terms: fields, size: limit, order}, aggs: {lastActivity: {max: {field: 'timestamp'}}}}}});
        const keys = (matched.aggregations?.sessions?.buckets ?? []) as unknown as Array<{key: string[]}>;
        if (!keys.length) return {sessions: [], limit};
        filter.push({bool: {minimum_should_match: 1, should: keys.map(bucket => ({bool: {filter: sessionFilter({userId: bucket.key[0]!, harness: bucket.key[1]!, sessionId: bucket.key[2]!})}}))}});
      }
      const userText = {bool: {minimum_should_match: 1, should: [{term: {[f('kind')]: 'user_message'}}, {bool: {filter: [{term: {[f('kind')]: 'message'}}, {term: {[f('role')]: 'user'}}]}}]}};
      const result = await collection.search(principal, {size: 0, query: {bool: {filter}}, aggs: {sessions: {multi_terms: {terms: fields, size: limit, order}, aggs: {
        lastActivity: {max: {field: 'timestamp'}}, firstActivity: {min: {field: 'timestamp'}},
        private: {filter: {term: {[f('private')]: true}}},
        origin: {terms: {field: f('origin'), size: 1}}, host: {terms: {field: f('host'), size: 1}},
        prompts: {filter: userText, aggs: {first: {top_hits: {size: 8, sort: [{timestamp: 'asc'}, {[f('sequence')]: 'asc'}], _source: ['text']}}}},
      }}}});
      type Bucket = {key: string[]; doc_count: number; lastActivity: {value: number | null}; firstActivity: {value: number | null}; private: {doc_count: number};
        origin: {buckets: Array<{key: string}>}; host: {buckets: Array<{key: string}>}; prompts: {first: {hits: {hits: Array<{_source?: {text?: unknown}}>}}}};
      const buckets = result.aggregations?.sessions?.buckets as unknown as Bucket[] | undefined;
      if (!Array.isArray(buckets)) throw new Error('Invalid session list response');
      const sessions: SessionSummary[] = buckets.map(bucket => {
        const [userId, harness, sessionId] = bucket.key;
        if (!identity(userId) || !HARNESSES.includes(harness ?? '') || !identity(sessionId)) throw new Error('Invalid session list response');
        const prompt = bucket.prompts.first.hits.hits.map(hit => typeof hit._source?.text === 'string' ? promptText(hit._source.text) : null).find(Boolean);
        return {userId: userId!, harness: harness!, sessionId: sessionId!, title: prompt ? prompt.replace(/\s+/g, ' ').slice(0, 240) : `Session ${sessionId}`,
          private: bucket.private.doc_count > 0, mine: userId === principal.userId, origin: bucket.origin.buckets[0]?.key ?? null, host: bucket.host.buckets[0]?.key ?? null,
          firstActivityAt: iso(bucket.firstActivity.value), lastActivityAt: iso(bucket.lastActivity.value), events: bucket.doc_count};
      });
      return {sessions, limit};
    },

    /** Index order and paging; content comes from the verified original batch. */
    async read(principal: Principal, input: Partial<SessionKey> & {cursor?: unknown; limit?: unknown}) {
      const key = checkKey(input), after = decodeCursor(input.cursor), limit = input.limit ?? 100;
      if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 200) fail(400, 'Invalid page size');
      const collection = reader(principal);
      const filter = [...sessionFilter(key), {term: {[f('chunk')]: 0}}, visibleTo('session', principal)];
      const page = await collection.search(principal, {size: limit, track_total_hits: true, query: {bool: {filter, must_not: [{terms: {[f('kind')]: HIDDEN}}]}},
        sort: [{timestamp: {order: 'asc', missing: '_first'}}, {[f('sequence')]: 'asc'}, {[f('eventId')]: 'asc'}, {[f('installationId')]: 'asc'}, {id: 'asc'}],
        ...(after ? {search_after: after} : {})});
      if (!after && !page.hits.hits.length) fail(404, 'Session not found');
      const hits = (page.hits.hits as IndexHit[]).map(hit => {
        const d = hit._source;
        if (d?.tenantId !== principal.tenantId || d.userId !== key.userId || d.harness !== key.harness || d.sessionId !== key.sessionId || typeof d.eventId !== 'string' || typeof d.installationId !== 'string') throw new Error('Invalid session read response');
        const source = sourceBatchIdentity(prefix, d.sourceKey ?? '');
        if (!source || source.tenantHash !== digest(principal.tenantId) || source.userHash !== digest(key.userId) || source.harness !== key.harness || source.installationHash !== digest(d.installationId) || source.sessionHash !== digest(key.sessionId)) throw new Error('Invalid session source');
        return {eventId: d.eventId, kind: d.kind, sourceKey: d.sourceKey!, installationId: d.installationId, batchId: source.batchId};
      });
      // Fetch every batch this page needs concurrently (bounded), not one at a time.
      const needed = [...new Map(hits.map(hit => [hit.sourceKey, hit])).values()], loaded = new Map<string, Map<string, TranscriptEvent> | null>();
      for (let index = 0; index < needed.length; index += FETCH_CONCURRENCY) await Promise.all(needed.slice(index, index + FETCH_CONCURRENCY).map(async hit => loaded.set(hit.sourceKey, await renderedBatch(principal, key, hit.sourceKey, hit.installationId, hit.batchId))));
      const events: TranscriptEvent[] = [];
      for (const hit of hits) {
        const event = loaded.get(hit.sourceKey)?.get(hit.eventId); // Missing: raw capture removed after indexing (for example, mid-delete).
        if (event && event.kind === hit.kind) events.push(event);
      }
      const first = page.hits.hits[0]?._source;
      return {session: {...key, mine: key.userId === principal.userId, private: page.hits.hits.some(hit => hit._source?.private === true), origin: typeof first?.origin === 'string' ? first.origin : null},
        events, total: page.hits.total.value, next: page.hits.hits.length === limit ? encodeCursor(page.hits.hits.at(-1)!.sort) : null};
    },

    async setVisibility(principal: Principal, input: {harness?: unknown; sessionId?: unknown; visibility?: unknown}) {
      const key = checkKey({userId: principal.userId, harness: input.harness as string, sessionId: input.sessionId as string});
      if (!['team', 'private'].includes(String(input.visibility))) fail(400, 'Choose team or private visibility');
      if (!await owned(principal, key)) fail(404, 'Only the person who captured a session can change it');
      const control = await controls.update(principal, 'sessions', key.harness, key.sessionId, current => ({visibility: input.visibility as 'team' | 'private', deletedAt: current?.deletedAt ?? null}));
      if (control.deletedAt) fail(404, 'Session not found');
      await apply(principal, key, control);
      return {...key, visibility: control.visibility};
    },

    async delete(principal: Principal, input: {harness?: unknown; sessionId?: unknown}) {
      const key = checkKey({userId: principal.userId, harness: input.harness as string, sessionId: input.sessionId as string});
      if (!await owned(principal, key)) fail(404, 'Only the person who captured a session can delete it');
      if (!store.delete) fail(503, 'Session deletion requires object deletion support');
      // Tombstone first: uploads and indexing that race this request are discarded.
      const control = await controls.update(principal, 'sessions', key.harness, key.sessionId, current => ({visibility: current?.visibility ?? 'team', deletedAt: current?.deletedAt ?? new Date().toISOString()}));
      const root = `${prefix}/${sessionScope(principal)}/${key.harness}/`, sessionHash = digest(key.sessionId);
      let removed = 0, installations: string | null = null;
      const seen = new Set<string>();
      do {
        const page = await store.listPage(root, {delimiter: '/', continuationToken: installations, maxKeys: 1000});
        for (const installation of page.prefixes ?? []) {
          if (!installation.startsWith(root) || !/^[a-f0-9]{64}\/$/.test(installation.slice(root.length))) continue;
          const source = installation + sessionHash + '/';
          let cursor: string | null = null;
          do {
            const objects = await store.listPage(source, {continuationToken: cursor, maxKeys: 1000});
            for (const object of objects.keys) {if (!object.startsWith(source)) throw new Error('Session inventory outside scope'); await store.delete(object); removed++;}
            cursor = objects.nextToken;
          } while (cursor);
        }
        installations = page.nextToken;
        if (installations) {if (seen.has(installations)) throw new Error('Session inventory cursor did not advance'); seen.add(installations);}
      } while (installations);
      const {changed} = await apply(principal, key, control);
      return {...key, deleted: true, objects: removed, documents: changed};
    },
  };
}
