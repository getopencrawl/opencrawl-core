import type {TenantPrincipal, ObjectStore, JsonValue} from './types.mjs';
import type {SearchRealm, DocumentItem, IndexHit} from '../search/types.mjs';
import {createSessionIngest, digest} from './ingest.mjs';
import {sourceBatchIdentity} from './event-identity.mjs';
import {createControls} from './controls.mjs';
import {withSessionDocumentWrites} from './write-barrier.mjs';
import {participantProjection} from './participants.mjs';

export interface ParticipantMigrationReport {events: number; skippedDeleted: number; after: JsonValue[] | null; complete: boolean}
/** Add sender metadata to existing first passages. Raw data and ownership stay
 * intact. Atomic writes cannot recreate deleted documents or restore privacy. */
export async function migrateSessionParticipants({realm, principal, store, prefix, dryRun = true, pageSize = 100, maxEvents = 1000, after = null, onPage = async () => {}}: {
  realm: SearchRealm; principal: TenantPrincipal; store: ObjectStore; prefix: string;
  dryRun?: boolean; pageSize?: number; maxEvents?: number; after?: JsonValue[] | null;
  onPage?(report: ParticipantMigrationReport): Promise<unknown>;
}): Promise<ParticipantMigrationReport> {
  if (!principal?.tenantId || principal.tenantId !== realm.tenantId || principal.captureAccess !== undefined) throw Object.assign(new Error('Realm scope denied'), {status: 403});
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500 || !Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 1_000_000) throw new Error('Invalid participant migration bounds');
  if (!dryRun) await realm.ensureIndex();
  const collection = realm.collection('session'), f = collection.field, ingest = createSessionIngest({store, prefix}), controls = createControls({store, prefix});
  const report: ParticipantMigrationReport = {events: 0, skippedDeleted: 0, after, complete: false};
  for (;;) {
    const page = await collection.search(principal, {size: Math.min(pageSize, maxEvents - report.events - report.skippedDeleted),
      query: {bool: {filter: [{term: {[f('chunk')]: 0}}, {terms: {[f('kind')]: ['message', 'user_message', 'agent_message', 'tool_call']}}], must_not: [{exists: {field: f('participantVersion')}}]}},
      _source: ['userId', 'harness', 'sessionId', 'installationId', 'eventId', 'kind', 'sourceKey', 'chunk'],
      sort: [...['userId', 'harness', 'sessionId', 'eventId'].map(key => ({[f(key)]: 'asc'})), {id: 'asc'}], ...(report.after ? {search_after: report.after} : {}),
    }, {createIfMissing: false});
    if (page.timed_out || page._shards?.failed !== 0) throw new Error('Incomplete participant migration scan');
    if (!page.hits.hits.length) {report.complete = true; report.after = null; await onPage({...report}); return report;}
    const cursor = page.hits.hits.at(-1)?.sort;
    if (!cursor || JSON.stringify(cursor) === JSON.stringify(report.after)) throw new Error('Non-advancing participant migration cursor');
    const groups = new Map<string, IndexHit[]>();
    for (const hit of page.hits.hits) {
      const d = hit._source, source = typeof d.sourceKey === 'string' ? sourceBatchIdentity(prefix, d.sourceKey) : null;
      if (d.tenantId !== principal.tenantId || typeof d.userId !== 'string' || typeof d.harness !== 'string' || typeof d.sessionId !== 'string' ||
        typeof d.installationId !== 'string' || typeof d.eventId !== 'string' || typeof d.kind !== 'string' || d.chunk !== 0 || !source ||
        source.tenantHash !== digest(principal.tenantId) || source.userHash !== digest(d.userId) || source.harness !== d.harness ||
        source.installationHash !== digest(d.installationId) || source.sessionHash !== digest(d.sessionId)) throw new Error('Participant source scope denied');
      const group = groups.get(d.sourceKey!) ?? []; group.push(hit); groups.set(d.sourceKey!, group);
    }
    const sources = [...groups], updates: DocumentItem[] = [];
    async function prepare([key, hits]: [string, IndexHit[]]) {
      const sample = hits[0]!._source, owner = {tenantId: principal.tenantId, userId: sample.userId!};
      const deleted = async () => Boolean((await controls.read(owner, 'sessions', sample.harness!, sample.sessionId!))?.deletedAt);
      if (await deleted()) {report.skippedDeleted += hits.length; return;}
      const batch = await ingest.getBatch(owner, {harness: sample.harness!, installationId: sample.installationId!, sessionId: sample.sessionId!, batchId: sourceBatchIdentity(prefix, key)!.batchId});
      if (!batch) {if (await deleted()) {report.skippedDeleted += hits.length; return;} throw new Error('Missing immutable participant source');}
      const events = new Map(batch.events.map(event => [event.id, event]));
      for (const hit of hits) {
        const event = events.get(hit._source.eventId!);
        if (!event || event.kind !== hit._source.kind) throw new Error('Participant source does not contain indexed event');
        updates.push({id: hit._id, document: {...hit._source, ...participantProjection(event, batch)}, policy: 'session-participants'});
      }
    }
    for (let offset = 0; offset < sources.length; offset += 4) {
      const results = await Promise.allSettled(sources.slice(offset, offset + 4).map(prepare));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    }
    if (!dryRun && updates.length) await withSessionDocumentWrites({store, prefix, tenantId: principal.tenantId, documents: updates}, async () => {
      await collection.bulk(principal, updates);
      const actual = await collection.mget(principal, updates.map(item => item.id));
      const byId = new Map(actual.docs.map(hit => [hit._id, hit]));
      for (const item of updates) if (!byId.get(item.id)?.found || byId.get(item.id)!._source.participantVersion !== 1) {
        const d = item.document;
        if (!(await controls.read({tenantId: principal.tenantId, userId: d.userId!}, 'sessions', d.harness!, d.sessionId!))?.deletedAt) throw new Error('Participant migration readback mismatch');
      }
    });
    report.events += updates.length; report.after = cursor; await onPage({...report});
    if (report.events + report.skippedDeleted >= maxEvents) return report;
  }
}
