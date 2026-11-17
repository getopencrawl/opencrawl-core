import type {TenantPrincipal, JsonValue, ObjectStore} from './types.mjs';
import type {DocumentItem, IndexHit, SearchDocument} from '../search/types.mjs';
import type {createRealm} from '../search/realm.mjs';
import {createHash} from 'node:crypto';
import {sessionScope} from './ingest.mjs';
import {sessionDocumentId} from './indexer.mjs';
import {withSessionDocumentWrites} from './write-barrier.mjs';

type Realm = Pick<ReturnType<typeof createRealm>, 'tenantId' | 'collection'>;
type Hit = IndexHit<SearchDocument>;
export interface SessionIdentityReport {
  scanned: number; groups: number; rewritten: number; duplicatesRemoved: number; unchanged: number;
  /** Same native position but different content: kept, never guessed. */
  distinctContent: number; after: JsonValue[] | null; complete: boolean;
}
/** Everything one step changes: restoring it returns the realm to its prior state. */
export interface SessionIdentityBackup {written: string[]; removed: DocumentItem[]}

// Sorting by native position places every copy of one captured record next to
// each other, whichever installation or event-ID scheme uploaded it. A copy is
// all chunks of one uploaded event (event ID + installation).
const position = ['userId', 'harness', 'sessionId', 'sequence', 'kind', 'nativeId', 'timestamp'] as const;
const order = [...position, 'eventId', 'installationId', 'chunk'] as const;
const MAX_BULK_BYTES = 3 * 1024 * 1024;
const text = (value: unknown) => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
const positionKey = (doc: SearchDocument) => JSON.stringify(position.map(field => doc[field] ?? null));
// Two copies are the same event when everything search shows is equal. Earlier
// indexers extracted text in a different object-key order, so lines are
// compared as a sorted list and chunk boundaries are ignored.
function contentKey(copy: Hit[]) {
  const first = copy[0]!._source;
  const lines = copy.map(hit => text(hit._source.text)).join('').split('\n').sort();
  return createHash('sha256').update(JSON.stringify([lines, [...(Array.isArray(first.toolNames) ? first.toolNames as unknown[] : [])].map(String).sort(),
    first.toolCallId ?? null, first.role ?? null, first.parentId ?? null, first.turnId ?? null])).digest('hex');
}

function canonicalId(doc: SearchDocument) {
  if (typeof doc.userId !== 'string' || typeof doc.harness !== 'string' || typeof doc.sessionId !== 'string' || typeof doc.eventId !== 'string' || !Number.isSafeInteger(doc.chunk))
    throw Object.assign(new Error('Session document lacks its stored identity'), {permanent: true});
  return sessionDocumentId({scope: sessionScope({tenantId: doc.tenantId, userId: doc.userId}), harness: doc.harness, sessionId: doc.sessionId, eventId: doc.eventId, chunk: doc.chunk as number});
}
// Keep the current wire-format copy, then one already at its new IDs, then the newest receipt.
function survivor(copies: Hit[][]) {
  const rank = (copy: Hit[]) => [String(copy[0]!._source.eventId).startsWith('wire1:') ? 0 : 1, copy.every(hit => hit._id === canonicalId(hit._source)) ? 0 : 1];
  return [...copies].sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0]! - y[0]! || x[1]! - y[1]! || String(b[0]!._source.receivedAt ?? '').localeCompare(String(a[0]!._source.receivedAt ?? '')) || a[0]!._id.localeCompare(b[0]!._id);
  })[0]!;
}

async function write(sessions: ReturnType<Realm['collection']>, principal: TenantPrincipal, items: DocumentItem[]) {
  for (let start = 0; start < items.length;) {
    let end = start, size = 0;
    while (end < items.length && (end === start || size + JSON.stringify(items[end]!.document).length < MAX_BULK_BYTES)) size += JSON.stringify(items[end++]!.document).length;
    await sessions.bulk(principal, items.slice(start, end));
    start = end;
  }
}

/**
 * Moves one tenant's session documents to installation-independent IDs and
 * removes copies of the same captured record uploaded more than once. Re-running
 * converges: each step either finds nothing to do or repeats an idempotent write.
 * Each step's new IDs and removed documents go to `backup` before any write, so
 * `restoreSessionDocumentIds` can undo it; the index is also rebuildable from
 * stored capture batches.
 */
export async function migrateSessionDocumentIds({realm, principal, store, prefix, backup, dryRun = false, pageSize = 500, after = null, onPage = async () => {}}: {
  realm: Realm; principal: TenantPrincipal; store:ObjectStore; prefix:string; backup(step: SessionIdentityBackup): Promise<unknown>; dryRun?: boolean; pageSize?: number;
  after?: JsonValue[] | null; onPage?(report: SessionIdentityReport): Promise<unknown>;
}): Promise<SessionIdentityReport> {
  if (principal?.tenantId !== realm.tenantId || principal.captureAccess !== undefined) throw Object.assign(new Error('Realm scope denied'), {status: 403});
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new Error('Invalid page size');
  const sessions = realm.collection('session'), field = sessions.field;
  const report: SessionIdentityReport = {scanned: 0, groups: 0, rewritten: 0, duplicatesRemoved: 0, unchanged: 0, distinctContent: 0, after, complete: false};
  let writes: DocumentItem[] = [], removals: DocumentItem[] = [];

  async function flush() {
    if (dryRun || !writes.length && !removals.length) {writes = []; removals = []; return;}
    await withSessionDocumentWrites({store,prefix,tenantId:principal.tenantId,documents:[...writes,...removals]},async()=>{
    await backup({written: writes.map(item => item.id), removed: removals});
    // Write the surviving copy before removing anything, so an interrupted run
    // leaves at most an extra copy that the next run resolves.
    await write(sessions, principal, writes);
    for (let start = 0; start < removals.length; start += 500) {
      await sessions.delete(principal, removals.slice(start, start + 500).map(item => item.id));
    }
    });
    writes = []; removals = [];
  }
  function resolve(group: Hit[]) {
    report.groups++;
    const copies = new Map<string, Hit[]>();
    for (const hit of group) {
      const key = JSON.stringify([hit._source.eventId, hit._source.installationId]), copy = copies.get(key) || [];
      // One upload stored twice under old and new IDs (an interrupted run): keep the new one.
      const same = copy.findIndex(other => other._source.chunk === hit._source.chunk);
      if (same < 0) copy.push(hit);
      else {
        const [keep, drop] = hit._id === canonicalId(hit._source) ? [hit, copy[same]!] : [copy[same]!, hit];
        copy[same] = keep; removals.push({id: drop._id, document: drop._source}); report.duplicatesRemoved++;
      }
      copies.set(key, copy);
    }
    const byContent = new Map<string, Hit[][]>();
    for (const copy of copies.values()) {const key = contentKey(copy); byContent.set(key, [...byContent.get(key) || [], copy]);}
    if (byContent.size > 1) report.distinctContent += byContent.size - 1;
    const taken = new Set(group.map(hit => hit._id));
    for (const same of byContent.values()) {
      const keep = survivor(same), ids = keep.map(hit => canonicalId(hit._source));
      // Another copy with different content already owns one of these IDs: leave all of them.
      if (keep.some((hit, i) => ids[i] !== hit._id && taken.has(ids[i]!))) {report.unchanged += same.flat().length; continue;}
      keep.forEach((hit, i) => {
        const id = ids[i]!;
        if (id === hit._id) {report.unchanged++; return;}
        writes.push({id, document: hit._source}); removals.push({id: hit._id, document: hit._source}); report.rewritten++; taken.add(id);
      });
      for (const copy of same) if (copy !== keep) for (const hit of copy) {removals.push({id: hit._id, document: hit._source}); report.duplicatesRemoved++;}
    }
  }

  // `cursor` continues the scan; `report.after` is a safe resume point that
  // never splits a group of copies.
  let group: Hit[] = [], key: string | null = null, cursor = after;
  for (;;) {
    const result = await sessions.search(principal, {size: pageSize, track_total_hits: false, query: {match_all: {}},
      // The envelope ID breaks ties, so an original and its rewritten copy never straddle a page.
      sort: [...order.map(name => ({[field(name)]: {order: 'asc', missing: '_last'}})), {id: {order: 'asc'}}], ...(cursor ? {search_after: cursor} : {})});
    const hits = result.hits.hits as Hit[];
    for (const hit of hits) {
      report.scanned++;
      const next = positionKey(hit._source);
      if (next !== key && group.length) {resolve(group); report.after = group.at(-1)!.sort ?? null; group = [];}
      key = next; group.push(hit);
    }
    if (hits.length < pageSize) break;
    cursor = hits.at(-1)!.sort ?? null;
    if (!cursor) throw new Error('Session scan returned no sort cursor');
    await flush(); await onPage({...report});
  }
  if (group.length) resolve(group);
  await flush();
  report.complete = true; report.after = null;
  await onPage({...report});
  return report;
}

/** Undoes migration steps, newest first: puts removed documents back, then drops IDs the step created. */
export async function restoreSessionDocumentIds({realm, principal, store, prefix, steps}: {realm: Realm; principal: TenantPrincipal; store:ObjectStore; prefix:string; steps: SessionIdentityBackup[]}) {
  if (principal?.tenantId !== realm.tenantId || principal.captureAccess !== undefined) throw Object.assign(new Error('Realm scope denied'), {status: 403});
  const sessions = realm.collection('session');
  let restored = 0, removed = 0;
  for (const step of [...steps].reverse()) {
    await withSessionDocumentWrites({store,prefix,tenantId:principal.tenantId,documents:step.removed},()=>write(sessions, principal, step.removed));
    const previous = new Set(step.removed.map(item => item.id)), created = step.written.filter(id => !previous.has(id));
    for (let start = 0; start < created.length; start += 500) await sessions.delete(principal, created.slice(start, start + 500));
    restored += step.removed.length; removed += created.length;
  }
  return {restored, removed};
}
