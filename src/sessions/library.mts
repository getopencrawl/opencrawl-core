import type {Principal, ObjectStore, SessionEvent, JsonValue} from './types.mjs';
import {isSessionHarness, SESSION_HARNESSES, parseJson} from './types.mjs';
import {gunzipSync} from 'node:zlib';
import type {SessionBatch} from './types.mjs';
import {sessionWriteBarrier} from './write-barrier.mjs';
import {createSessionDeletionRequests} from './deletion-requests.mjs';
import type {RealmOptions, QueryBody, IndexHit} from '../search/types.mjs';
import {createRealmResolver, realmField} from '../search/realm.mjs';
import {createSessionIngest, sessionScope, digest} from './ingest.mjs';
import {sourceBatchIdentity} from './event-identity.mjs';
import {createControls, visibleTo} from './controls.mjs';
import type {ResourceControl} from './controls.mjs';
import {capturedTitle, TITLE_KINDS} from './titles.mjs';

export interface SessionKey {userId: string; harness: string; sessionId: string}
export interface SessionSummary extends SessionKey {
  title: string; private: boolean; mine: boolean; origin: string | null; host: string | null;
  hosts: string[]; hostsTruncated: boolean;
  firstActivityAt: string | null; lastActivityAt: string | null; events: number;
}
export type TranscriptEntry =
  | {type: 'message'; role: 'user' | 'assistant'; text: string}
  | {type: 'tool_call'; name: string; input: string; truncated: boolean}
  | {type: 'tool_result'; text: string; truncated: boolean}
  | {type: 'note'; label: string; text: string; truncated: boolean};
export interface TranscriptEvent {eventId: string; kind: string; timestamp: string | null; entries: TranscriptEntry[]}

const identity = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
const f = (field: string) => realmField('session', field);
// Bound per-session metadata while retaining the legacy most-frequent host.
const hostTerms = {terms: {field: f('host'), size: 20, exclude: ''}};
type HostBuckets = {buckets: Array<{key: string}>; sum_other_doc_count?: number};
function capturedHosts(value?: HostBuckets) {
  const hosts = [...new Set((value?.buckets ?? []).map(bucket => bucket.key).filter(host => typeof host === 'string' && host.trim()))];
  return {host: hosts[0] ?? null, hosts: hosts.sort(), hostsTruncated: (value?.sum_other_doc_count ?? 0) > 0};
}
const MAX_TEXT = 20000;
function fail(status: number, message: string): never {throw Object.assign(new Error(message), {status});}
function clip(text: string) {return text.length > MAX_TEXT ? {text: text.slice(0, MAX_TEXT), truncated: true} : {text, truncated: false};}
function stringify(value: unknown) {if (typeof value === 'string') return value; try {return JSON.stringify(value, null, 2) ?? '';} catch {return '';}}
function iso(value: unknown) {return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null;}
// Codex stores injected context and notifications as user-role records.
const INJECTED = /^(?:# AGENTS\.md instructions\b|<(?:environment_context|external_codex_apps_\w+|subagent_notification|turn_aborted|user_instructions|system-reminder)\b)/;
// Codex prefixes IDE context and attached files before the person's request.
const CODEX_CONTEXT = /^# (?:Context from my IDE setup|Files (?:mentioned|pasted) by the user):/;
const CODEX_REQUEST = /^# (?:Context from my IDE setup|Files (?:mentioned|pasted) by the user):[\s\S]*?## My request(?: for Codex)?:\s*/;
/** The person's own words from a prompt, or null for injected context. */
export function promptText(text: string) {
  const trimmed = text.trimStart(), request = trimmed.replace(CODEX_REQUEST, '');
  if (request !== trimmed) return request.trim() || null;
  return INJECTED.test(trimmed) || CODEX_CONTEXT.test(trimmed) ? null : trimmed.trim() || null;
}
// Readable conversation kinds, and bookkeeping kinds that never render.
const CONVERSATION = ['message', 'user_message', 'agent_message'];
const HIDDEN = ['token_count', 'hook', 'turn_metadata', ...TITLE_KINDS];
// Rendered-text budget for reused batches (UTF-16 code units, about 64 MB).
const CACHE_CHARS = 32 * 1024 * 1024, FETCH_CONCURRENCY = 12;
const TITLE_FETCH_CONCURRENCY = 4;
function checkKey({userId, harness, sessionId}: Partial<SessionKey>) {
  if (!identity(userId) || !isSessionHarness(harness) || !identity(sessionId)) fail(400, 'Invalid session');
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
    : collection.byQuery(principal, 'update', query, {set: {'session.private': control.visibility === 'private'}});
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
export interface SessionLibraryOptions extends RealmOptions {store: ObjectStore; prefix: string; purgeCopies?: (principal: Principal, key: SessionKey, store: ObjectStore) => Promise<number>; scheduleDeletion?: (key: string) => Promise<unknown>}
export function createSessionLibrary({store, prefix, purgeCopies, scheduleDeletion, ...options}: SessionLibraryOptions) {
  const resolve = createRealmResolver(options), ingest = createSessionIngest({store, prefix}), controls = createControls({store, prefix});
  const reader = (principal: Principal) => {
    sessionScope(principal);
    if (principal.captureAccess !== undefined) fail(403, 'Session read access required');
    return resolve(principal).collection('session');
  };
  const sessionFilter = (key: SessionKey) => [{term: {[f('userId')]: key.userId}}, {term: {[f('harness')]: key.harness}}, {term: {[f('sessionId')]: key.sessionId}}];
  async function readable(principal: Principal, key: SessionKey) {
    const control = await controls.read({...principal, userId: key.userId}, 'sessions', key.harness, key.sessionId);
    return !control?.deletedAt && (control?.visibility !== 'private' || key.userId === principal.userId);
  }
  async function pendingDeletions(principal: Principal) {
    const pending: Array<{harness: string; sessionId: string}> = [];
    for (const harness of SESSION_HARNESSES) for (const control of (await controls.list(principal, 'sessions', harness)).values()) {
      if (control.deletedAt && control.deletion?.state === 'pending') pending.push({harness, sessionId: control.deletion.sessionId});
    }
    return pending;
  }
  const userText = {bool: {minimum_should_match: 1, should: [{term: {[f('kind')]: 'user_message'}}, {bool: {filter: [{term: {[f('kind')]: 'message'}}, {term: {[f('role')]: 'user'}}]}}]}};
  /** One scoped query for all displayed titles. Read the originals, since indexed
   * text also contains native IDs, channels and tool-result strings. */
  async function titles(principal: Principal, keys: SessionKey[], before?: string) {
    const values = new Map<string, string>(), keyOf = (key: SessionKey) => JSON.stringify([key.userId, key.harness, key.sessionId]);
    if (!keys.length) return values;
    const allowed = new Set(keys.map(keyOf));
    const result = await reader(principal).search(principal, {size: 0, query: {bool: {filter: [
      {term: {[f('chunk')]: 0}}, visibleTo('session', principal),
      ...(before ? [{range: {[f('timestamp')]: {lte: Date.parse(before)}}}] : []),
      {bool: {minimum_should_match: 1, should: keys.map(key => ({bool: {filter: sessionFilter(key)}}))}},
      {bool: {minimum_should_match: 1, should: [userText, {terms: {[f('kind')]: TITLE_KINDS}}]}},
    ]}}, aggs: {titles: {multi_terms: {terms: ['userId', 'harness', 'sessionId'].map(field => ({field: f(field)})), size: keys.length}, aggs: {
      metadata: {filter: {terms: {[f('kind')]: TITLE_KINDS}}, aggs: {records: {top_hits: {size: 20, sort: [{timestamp: 'desc'}, {[f('sequence')]: 'desc'}, {id: 'desc'}]}}}},
      prompts: {filter: userText, aggs: {records: {top_hits: {size: 20, sort: [{timestamp: 'asc'}, {[f('sequence')]: 'asc'}, {id: 'asc'}]}}}},
    }}}});
    type Records = {records: {hits: {hits: IndexHit[]}}};
    const buckets = result.aggregations?.titles?.buckets as unknown as Array<{key: string[]; metadata: Records; prompts: Records}>;
    if (!Array.isArray(buckets)) throw new Error('Invalid session title response');
    type Name = {kind: string; title: string | null; prompt: string | null};
    // Retain only compact names, never an entire page's raw conversation batches.
    const batches = new Map<string, Promise<Map<string, Name>>>();
    async function original(hit: IndexHit, key: SessionKey) {
      // top_hits inside aggregations retain the realm envelope.
      const envelope = hit._source, d = envelope?.session as IndexHit['_source'] | undefined;
      if (envelope?.schema !== 1 || envelope.tenantId !== principal.tenantId || envelope.corpus !== 'session' || hit._id !== `session:${envelope.id}` ||
        !d || d.userId !== key.userId || d.harness !== key.harness || d.sessionId !== key.sessionId || typeof d.eventId !== 'string' || typeof d.installationId !== 'string' ||
        d.private === true && key.userId !== principal.userId) throw new Error('Invalid session title scope');
      const sourceKey = envelope.sourceKey, source = typeof sourceKey === 'string' ? sourceBatchIdentity(prefix, sourceKey) : null;
      if (!source || source.tenantHash !== digest(principal.tenantId) || source.userHash !== digest(key.userId) || source.harness !== key.harness ||
        source.installationHash !== digest(d.installationId) || source.sessionHash !== digest(key.sessionId)) throw new Error('Invalid session title source');
      let pending = batches.get(sourceKey!);
      if (!pending) {
        pending = ingest.getBatch(principal, {...key, installationId: d.installationId, batchId: source.batchId}).then(batch => new Map(batch?.events.map(event => {
          const prompt = (event.kind === 'user_message' || event.kind === 'message' && event.data?.role === 'user')
            ? transcriptEntries(event).find(entry => entry.type === 'message' && entry.role === 'user') : undefined;
          return [event.id, {kind: event.kind, title: capturedTitle(event, batch), prompt: prompt?.type === 'message' ? prompt.text.replace(/\s+/g, ' ').trim().slice(0, 240) : null}];
        })));
        if (batches.size >= 64) batches.delete(batches.keys().next().value!);
        batches.set(sourceKey!, pending);
      }
      const record = (await pending).get(d.eventId);
      return record?.kind === d.kind ? record : null;
    }
    for (let offset = 0; offset < buckets.length; offset += TITLE_FETCH_CONCURRENCY) await Promise.all(buckets.slice(offset, offset + TITLE_FETCH_CONCURRENCY).map(async bucket => {
      if (!Array.isArray(bucket.key) || bucket.key.length !== 3) throw new Error('Invalid session title response');
      const key = {userId: bucket.key[0]!, harness: bucket.key[1]!, sessionId: bucket.key[2]!}, encoded = keyOf(key);
      if (!allowed.has(encoded)) throw new Error('Invalid session title scope');
      for (const hit of bucket.metadata.records.hits.hits) {
        const record = await original(hit, key), title = record?.title;
        if (title) {values.set(encoded, title); return;}
      }
      for (const hit of bucket.prompts.records.hits.hits) {
        const record = await original(hit, key);
        if (record?.prompt) {values.set(encoded, record.prompt); return;}
      }
    }));
    return values;
  }
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
  const deletionRequests = createSessionDeletionRequests({store, prefix});
  // Provider status codes are not user authorization failures. Keep storage
  // details out of the request response; durable accepted intents still recover.
  async function deletionStorage<T>(operation: () => Promise<T>): Promise<T> {
    try {return await operation();}
    catch {fail(503, 'Session deletion is temporarily unavailable. Try again.');}
  }
  async function revokeDeletion(principal: Principal, key: SessionKey) {
    reader(principal);
    const previous = await controls.read(principal, 'sessions', key.harness, key.sessionId);
    if (!previous?.deletedAt && !await deletionRequests.readFor(principal, key) && !await owned(principal, key)) fail(404, 'Only the person who captured a session can delete it');
    const control = await controls.update(principal, 'sessions', key.harness, key.sessionId, current => ({
      visibility: current?.visibility ?? 'team', deletedAt: current?.deletedAt ?? new Date().toISOString(),
      deletion: {sessionId: key.sessionId, state: current?.deletion?.state === 'complete' ? 'complete' : 'pending'},
    }));
    rendered.clear(); cachedChars = 0;
    return control;
  }
  async function prepareDeletion(principal: Principal, input: {harness?: unknown; sessionId?: unknown}) {
    const key = checkKey({userId: principal.userId, harness: input.harness as string, sessionId: input.sessionId as string});
    const control = await revokeDeletion(principal, key);
    const fence = await sessionWriteBarrier(store, prefix, principal, key.harness, key.sessionId).close();
    const documents = (await apply(principal, key, control)).changed;
    if (fence.pending) throw Object.assign(new Error('Session deletion is waiting for unfinished writes'), {type: 'SessionDeletionWritesPending'});
    if (!store.purgePrefix) throw new Error('Permanent version deletion is unavailable');
    return {documents};
  }
  async function deletionControl(principal: Principal, key: SessionKey) {
    reader(principal);
    const control = await controls.read(principal, 'sessions', key.harness, key.sessionId);
    if (!control?.deletedAt) fail(409, 'Session deletion has not been requested');
    const fence = await sessionWriteBarrier(store, prefix, principal, key.harness, key.sessionId).close();
    if (fence.pending) throw Object.assign(new Error('Session deletion is waiting for unfinished writes'), {type: 'SessionDeletionWritesPending'});
    return control;
  }
  async function purgeDeletionArchives(principal: Principal, input: {harness?: unknown; sessionId?: unknown}) {
    const key = checkKey({userId: principal.userId, harness: input.harness as string, sessionId: input.sessionId as string});
    await deletionControl(principal, key);
    return {objects: purgeCopies ? await purgeCopies(principal, key, store) : 0};
  }
  async function finishDeletion(principal: Principal, input: {harness?: unknown; sessionId?: unknown}) {
    const key = checkKey({userId: principal.userId, harness: input.harness as string, sessionId: input.sessionId as string});
    const control = await deletionControl(principal, key);
    if (!store.purgePrefix) throw new Error('Permanent version deletion is unavailable');
    let objects = 0, documents = 0;
    const root = `${prefix}/${sessionScope(principal)}/${key.harness}/`, sessionHash = digest(key.sessionId);
    objects += await store.purgePrefix(root, {select: object => new RegExp(`^[a-f0-9]{64}/${sessionHash}/`).test(object.slice(root.length)), beforeDelete: async (object, read) => {
      if (!object.endsWith('.json.gz')) return;
      const batch = parseJson<SessionBatch>(gunzipSync(await read(), {maxOutputLength: 17 * 1024 * 1024}));
      if (batch.owner?.tenantId !== principal.tenantId || batch.owner?.userId !== principal.userId || batch.harness !== key.harness || batch.sessionId !== key.sessionId) throw new Error('Purge source scope mismatch');
      // Old clients used owner-scoped blobs: erase all of their versions
      // before removing the manifest needed to find them on a retry.
      for (const attachment of batch.attachments ?? []) if (attachment.status === 'captured' && /^[a-f0-9]{64}$/.test(attachment.sha256 ?? '')) {
        const blob = `${prefix}/${sessionScope(principal)}/attachments/${attachment.sha256}`;
        objects += await store.purgePrefix!(blob, {select: candidate => candidate === blob});
      }
    }});
    // Include unrefreshed writes completed before the fence closed.
    await resolve(principal).refresh(principal);
    documents += (await apply(principal, key, control)).changed;
    if (await owned(principal, key)) throw new Error('Session search documents remain');
    await controls.update(principal, 'sessions', key.harness, key.sessionId, current => ({
      visibility: current?.visibility ?? 'team', deletedAt: control.deletedAt,
      deletion: {sessionId: key.sessionId, state: 'complete'},
    }));
    return {...key, deleted: true as const, pending: false as const, objects, documents};
  }
  return {
    /** Names for a displayed search page. Recheck controls around the original
     * source reads; absence from the map means the resource is no longer visible. */
    async titles(principal: Principal, input: SessionKey[], {before}: {before?: string} = {}) {
      reader(principal);
      if (!Array.isArray(input) || input.length > 40 || before !== undefined && !Number.isFinite(Date.parse(before))) fail(400, 'Invalid title lookup');
      const keyOf = (key: SessionKey) => JSON.stringify([key.userId, key.harness, key.sessionId]);
      const keys = [...new Map(input.map(value => {const key = checkKey(value); return [keyOf(key), key] as const;})).values()];
      const visible: SessionKey[] = [];
      for (let start = 0; start < keys.length; start += TITLE_FETCH_CONCURRENCY) {
        const page = keys.slice(start, start + TITLE_FETCH_CONCURRENCY), allowed = await Promise.all(page.map(key => readable(principal, key)));
        visible.push(...page.filter((_, i) => allowed[i]));
      }
      const names = await titles(principal, visible, before), result = new Map<string, string>();
      for (let start = 0; start < visible.length; start += TITLE_FETCH_CONCURRENCY) await Promise.all(visible.slice(start, start + TITLE_FETCH_CONCURRENCY).map(async key => {
        if (await readable(principal, key)) result.set(keyOf(key), (names.get(keyOf(key)) ?? `Session ${key.sessionId}`).slice(0, 240));
      }));
      return result;
    },
    async list(principal: Principal, {scope = 'all', query = '', limit = 50}: {scope?: unknown; query?: unknown; limit?: unknown} = {}) {
      const collection = reader(principal);
      if (!['all', 'mine'].includes(String(scope)) || typeof query !== 'string' || query.length > 500 || !Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 500) fail(400, 'Invalid session list');
      // Summarize from conversation records only: bookkeeping is most of the index.
      // A Grok Bot runtime that reports only tool hooks has no messages to list by.
      const listed = (kinds: string[]): QueryBody => ({bool: {minimum_should_match: 1, should: [{terms: {[f('kind')]: kinds}},
        {bool: {filter: [{term: {[f('harness')]: 'grok-bot'}}, {term: {[f('kind')]: 'tool_call'}}]}}]}});
      const filter: QueryBody[] = [{term: {[f('chunk')]: 0}}, listed(CONVERSATION), visibleTo('session', principal), ...(scope === 'mine' ? [{term: {[f('userId')]: principal.userId}}] : [])];
      const fields = ['userId', 'harness', 'sessionId'].map(field => ({field: f(field)}));
      const order = [{lastActivity: 'desc'}, {_key: 'asc'}];
      if (query.trim()) {
        // Select sessions containing the words, then summarize each whole session.
        const matchFilter = filter.map((value, index) => index === 1 ? listed([...CONVERSATION, ...TITLE_KINDS]) : value);
        const matched = await collection.search(principal, {size: 0, query: {bool: {filter: matchFilter, must: [{match: {text: {query: query.trim(), operator: 'and'}}}]}},
          aggs: {sessions: {multi_terms: {terms: fields, size: limit, order}, aggs: {lastActivity: {max: {field: 'timestamp'}}}}}});
        const keys = (matched.aggregations?.sessions?.buckets ?? []) as unknown as Array<{key: string[]}>;
        if (!keys.length) return {sessions: [], limit};
        filter.push({bool: {minimum_should_match: 1, should: keys.map(bucket => ({bool: {filter: sessionFilter({userId: bucket.key[0]!, harness: bucket.key[1]!, sessionId: bucket.key[2]!})}}))}});
      }
      const result = await collection.search(principal, {size: 0, query: {bool: {filter}}, aggs: {sessions: {multi_terms: {terms: fields, size: limit, order}, aggs: {
        lastActivity: {max: {field: 'timestamp'}}, firstActivity: {min: {field: 'timestamp'}},
        private: {filter: {term: {[f('private')]: true}}},
        origin: {terms: {field: f('origin'), size: 1}}, host: hostTerms,
      }}}});
      type Bucket = {key: string[]; doc_count: number; lastActivity: {value: number | null}; firstActivity: {value: number | null}; private: {doc_count: number};
        origin: {buckets: Array<{key: string}>}; host: HostBuckets};
      const buckets = result.aggregations?.sessions?.buckets as unknown as Bucket[] | undefined;
      if (!Array.isArray(buckets)) throw new Error('Invalid session list response');
      const sessions: SessionSummary[] = buckets.map(bucket => {
        const [userId, harness, sessionId] = bucket.key;
        if (!identity(userId) || !isSessionHarness(harness) || !identity(sessionId)) throw new Error('Invalid session list response');
        return {userId: userId!, harness: harness!, sessionId: sessionId!, title: `Session ${sessionId}`,
          private: bucket.private.doc_count > 0, mine: userId === principal.userId, origin: bucket.origin.buckets[0]?.key ?? null, ...capturedHosts(bucket.host),
          firstActivityAt: iso(bucket.firstActivity.value), lastActivityAt: iso(bucket.lastActivity.value), events: bucket.doc_count};
      });
      const names = await titles(principal, sessions);
      for (const session of sessions) session.title = names.get(JSON.stringify([session.userId, session.harness, session.sessionId])) ?? session.title;
      const allowed = await Promise.all(sessions.map(session => readable(principal, session)));
      return {sessions: sessions.filter((_, index) => allowed[index]), limit};
    },

    /** Index order and paging; content comes from the verified original batch. */
    async read(principal: Principal, input: Partial<SessionKey> & {cursor?: unknown; limit?: unknown}) {
      const key = checkKey(input), after = decodeCursor(input.cursor), limit = input.limit ?? 100;
      if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 200) fail(400, 'Invalid page size');
      const collection = reader(principal);
      if (!await readable(principal, key)) fail(404, 'Session not found');
      const filter = [...sessionFilter(key), {term: {[f('chunk')]: 0}}, visibleTo('session', principal)];
      const page = await collection.search(principal, {size: limit, track_total_hits: true, query: {bool: {filter, must_not: [{terms: {[f('kind')]: HIDDEN}}]}},
        aggs: {host: hostTerms},
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
      const names = await titles(principal, [key]);
      if (!await readable(principal, key)) fail(404, 'Session not found');
      return {session: {...key, title: names.get(JSON.stringify([key.userId, key.harness, key.sessionId])) ?? `Session ${key.sessionId}`, mine: key.userId === principal.userId, private: page.hits.hits.some(hit => hit._source?.private === true), origin: typeof first?.origin === 'string' ? first.origin : null,
          ...capturedHosts(page.aggregations?.host as HostBuckets | undefined)},
        events, total: page.hits.total.value, next: page.hits.hits.length === limit ? encodeCursor(page.hits.hits.at(-1)!.sort) : null};
    },

    async setVisibility(principal: Principal, input: {harness?: unknown; sessionId?: unknown; visibility?: unknown}) {
      const key = checkKey({userId: principal.userId, harness: input.harness as string, sessionId: input.sessionId as string});
      if (!['team', 'private'].includes(String(input.visibility))) fail(400, 'Choose team or private visibility');
      if (!await owned(principal, key)) fail(404, 'Only the person who captured a session can change it');
      // Realms created before owner visibility gain the field before the first write.
      await resolve(principal).ensureIndex();
      const control = await controls.update(principal, 'sessions', key.harness, key.sessionId, current => ({visibility: input.visibility as 'team' | 'private', deletedAt: current?.deletedAt ?? null}));
      if (control.deletedAt) fail(404, 'Session not found');
      await apply(principal, key, control);
      return {...key, visibility: control.visibility};
    },

    /** Product deletion only records intent and revokes access. Temporal owns erasure. */
    async requestDeletion(principal: Principal, input: {harness?: unknown; sessionId?: unknown}) {
      const key = checkKey({userId: principal.userId, harness: input.harness as string, sessionId: input.sessionId as string});
      reader(principal);
      if (!scheduleDeletion) fail(503, 'Session deletion worker is not configured');
      const previous = await deletionStorage(() => controls.read(principal, 'sessions', key.harness, key.sessionId));
      if (!previous?.deletedAt && !await deletionStorage(() => deletionRequests.readFor(principal, key)) && !await deletionStorage(() => owned(principal, key))) fail(404, 'Only the person who captured a session can delete it');
      if (previous?.deletion?.state === 'complete') return {...key, deleted: true, pending: false};
      // Intent precedes revocation: a crash at either boundary is recoverable by
      // the scheduled Temporal sweep, even if the direct start was never sent.
      const requestKey = await deletionStorage(async () => {
        const saved = await deletionRequests.put(principal, {harness: key.harness, sessionId: key.sessionId});
        await revokeDeletion(principal, key);
        return saved;
      });
      try {await scheduleDeletion(requestKey);}
      catch {console.error(JSON.stringify({event: 'session.deletion.submission_deferred', requestKey}));}
      return {...key, deleted: false, pending: true};
    },
    pendingDeletions,
    prepareDeletion, purgeDeletionArchives, finishDeletion,
    /** Low-level operator erasure, also used by upgrade verification. Public
     * HTTP/RPC deletion calls requestDeletion and never runs cleanup inline. */
    async delete(principal: Principal, input: {harness?: unknown; sessionId?: unknown}) {
      let objects = 0, documents = 0;
      try {
        documents += (await prepareDeletion(principal, input)).documents;
        objects += (await purgeDeletionArchives(principal, input)).objects;
        const result = await finishDeletion(principal, input);
        return {...result, objects: objects + result.objects, documents: documents + result.documents};
      } catch (error) {
        if ((error as {status?: number}).status === 403 || (error as {status?: number}).status === 404 || (error as {status?: number}).status === 400) throw error;
        return {userId: principal.userId, harness: String(input.harness), sessionId: String(input.sessionId), deleted: false, pending: true, objects, documents};
      }
    },
  };
}
