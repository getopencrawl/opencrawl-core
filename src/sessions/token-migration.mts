import type {TenantPrincipal, ObjectStore, JsonValue} from './types.mjs';
import type {SearchRealm, DocumentItem, IndexHit} from '../search/types.mjs';
import {createSessionIngest, digest} from './ingest.mjs';
import {sourceBatchIdentity} from './event-identity.mjs';
import {capturedEventTokens} from './token-count.mjs';
import {createControls} from './controls.mjs';
import {withSessionDocumentWrites} from './write-barrier.mjs';

export interface TokenMigrationReport {events: number; skippedDeleted: number; after: JsonValue[] | null; complete: boolean}
/** Add counts to existing first passages, without rewriting content, receipts,
 * visibility or billing. Retrying fills only missing values. No deleted document
 * can be recreated. Scope and source batches are verified before every write. */
export async function migrateSessionTokens({realm, principal, store, prefix, dryRun = true, pageSize = 100, maxEvents = 1000, after = null, onPage = async () => {}}: {
  realm: SearchRealm; principal: TenantPrincipal; store: ObjectStore; prefix: string;
  dryRun?: boolean; pageSize?: number; maxEvents?: number; after?: JsonValue[] | null;
  onPage?(report: TokenMigrationReport): Promise<unknown>;
}): Promise<TokenMigrationReport> {
  if (!principal?.tenantId || principal.tenantId !== realm.tenantId || principal.captureAccess !== undefined) throw Object.assign(new Error('Realm scope denied'), {status: 403});
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500 || !Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 1_000_000) throw new Error('Invalid token migration bounds');
  if (!dryRun) await realm.ensureIndex();
  const collection = realm.collection('session'), f = collection.field, ingest = createSessionIngest({store, prefix}), controls = createControls({store, prefix});
  // Retain numeric counts only, never raw transcript buffers between groups.
  const batches = new Map<string, Map<string, {kind: string; tokens: number}>>();
  const report: TokenMigrationReport = {events: 0, skippedDeleted: 0, after, complete: false};
  for (;;) {
    const page = await collection.search(principal, {size: Math.min(pageSize, maxEvents - report.events - report.skippedDeleted),
      query: {bool: {filter: [{term: {[f('chunk')]: 0}}], must_not: [{exists: {field: f('capturedTokens')}}]}},
      _source: ['userId', 'harness', 'sessionId', 'installationId', 'eventId', 'kind', 'sourceKey', 'chunk'],
      sort: [...['userId', 'harness', 'sessionId', 'eventId'].map(key => ({[f(key)]: 'asc'})), {id: 'asc'}], ...(report.after ? {search_after: report.after} : {}),
    }, {createIfMissing: false});
    if (page.timed_out || page._shards?.failed !== 0) throw new Error('Incomplete token migration scan');
    if (!page.hits.hits.length) {
      report.complete = true; report.after = null; await onPage({...report}); return report;
    }
    const cursor = page.hits.hits.at(-1)?.sort;
    if (!cursor || JSON.stringify(cursor) === JSON.stringify(report.after)) throw new Error('Non-advancing token migration cursor');
    const groups = new Map<string, IndexHit[]>();
    for (const hit of page.hits.hits) {
      const d = hit._source, key = d.sourceKey, source = typeof key === 'string' ? sourceBatchIdentity(prefix, key) : null;
      if (d.tenantId !== principal.tenantId || typeof d.userId !== 'string' || typeof d.harness !== 'string' || typeof d.sessionId !== 'string' ||
        typeof d.installationId !== 'string' || typeof d.eventId !== 'string' || typeof d.kind !== 'string' || d.chunk !== 0 || !source ||
        source.tenantHash !== digest(principal.tenantId) || source.userHash !== digest(d.userId) || source.harness !== d.harness ||
        source.installationHash !== digest(d.installationId) || source.sessionHash !== digest(d.sessionId)) throw new Error('Token migration source scope denied');
      const group = groups.get(key!) ?? []; group.push(hit); groups.set(key!, group);
    }
    for (const [key, hits] of groups) {
      const sample = hits[0]!._source, owner = {tenantId: principal.tenantId, userId: sample.userId!};
      const deleted = async () => Boolean((await controls.read(owner, 'sessions', sample.harness!, sample.sessionId!))?.deletedAt);
      if (await deleted()) {report.skippedDeleted += hits.length; continue;}
      const source = sourceBatchIdentity(prefix, key)!;
      let events = batches.get(key);
      if (!events) {
        const batch = await ingest.getBatch(owner, {harness: sample.harness!, installationId: sample.installationId!, sessionId: sample.sessionId!, batchId: source.batchId});
        if (!batch) {
          if (await deleted()) {report.skippedDeleted += hits.length; continue;}
          throw new Error('Missing immutable token source');
        }
        events = new Map(batch.events.map(event => [event.id, {kind: event.kind, tokens: capturedEventTokens(batch.harness, event)}]));
      }
      batches.delete(key); batches.set(key, events);
      if (batches.size > 64) batches.delete(batches.keys().next().value!);
      const updates: DocumentItem[] = hits.map(hit => {
        const event = events.get(hit._source.eventId!);
        if (!event || event.kind !== hit._source.kind) throw new Error('Token source does not contain indexed event');
        return {id: hit._id, document: {...hit._source, capturedTokens: event.tokens}, policy: 'session-tokens'};
      });
      if (!dryRun) {
        await withSessionDocumentWrites({store, prefix, tenantId: principal.tenantId, documents: updates}, async () => {
          await collection.bulk(owner, updates);
          const actual = await collection.mget(owner, updates.map(item => item.id));
          const byId = new Map(actual.docs.map(hit => [hit._id, hit]));
          if (updates.some(item => !byId.get(item.id)?.found || byId.get(item.id)!._source.capturedTokens !== item.document.capturedTokens)) {
            if (!await deleted()) throw new Error('Token migration readback mismatch');
          }
        });
      }
      report.events += hits.length;
    }
    report.after = cursor; await onPage({...report});
    if (report.events + report.skippedDeleted >= maxEvents) return report;
  }
}
