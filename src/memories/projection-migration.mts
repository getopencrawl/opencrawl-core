import type {ObjectStore, Principal, TenantPrincipal} from '../sessions/types.mjs';
import type {DocumentItem, SearchDocument} from '../search/types.mjs';
import type {createRealm} from '../search/realm.mjs';
import type {createMemorySearch} from './search.mjs';
import type {StoredMemorySnapshot} from './types.mjs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {digest, sessionScope} from '../sessions/event-identity.mjs';
import {createControls} from '../sessions/controls.mjs';
import {MAX_MEMORY_BYTES, memorySourceIdentity, verifyStoredMemory} from './snapshot.mjs';
import {activeMemoryProjectionFilter, memoryProjectionId} from './projection.mjs';
import {PASSAGE_VERSION} from '../search/passages.mjs';

type Realm = Pick<ReturnType<typeof createRealm>, 'tenantId' | 'collection' | 'ensureIndex' | 'refresh'>;
interface MigrationBinding {realm: Realm; principal: TenantPrincipal; store: ObjectStore; prefix: string}
export interface MemoryProjectionBackup {head: DocumentItem; replacementProjectionId: string; previousPassages: number; sourceSha256: string}
function scope({realm, principal}: MigrationBinding, headId: string) {
  if (!principal?.tenantId || principal.tenantId !== realm.tenantId || principal.captureAccess !== undefined) throw Object.assign(new Error('Memory migration scope denied'), {status: 403});
  if (!/^[a-f0-9]{64}$/.test(headId)) throw new Error('Invalid memory head identity');
}
async function readSource(binding: MigrationBinding, head: DocumentItem) {
  scope(binding, head.id);
  const {document} = head, {principal, prefix, store} = binding;
  const identity = memorySourceIdentity(prefix, document.sourceKey!);
  if (document.kind !== 'snapshot' || document.tenantId !== principal.tenantId || typeof document.userId !== 'string' || !identity ||
    identity.tenantHash !== digest(principal.tenantId) || identity.userHash !== digest(document.userId) || identity.harness !== document.harness ||
    identity.generation !== document.generation || identity.snapshotId !== document.snapshotId || identity.installationHash !== digest(document.installationId ?? '')) throw new Error('Memory head source scope mismatch');
  const owner: Principal = {tenantId: principal.tenantId, userId: document.userId};
  if (head.id !== digest(JSON.stringify([sessionScope(owner), document.harness, document.installationId, 'head']))) throw new Error('Memory head identity mismatch');
  const bytes = await store.get(document.sourceKey!, {maxBytes: MAX_MEMORY_BYTES + 1048576});
  if (!bytes) throw new Error('Missing immutable memory source; projection preserved');
  const snapshot = JSON.parse(gunzipSync(bytes, {maxOutputLength: MAX_MEMORY_BYTES + 1048576}).toString('utf8')) as StoredMemorySnapshot;
  verifyStoredMemory({prefix, key: document.sourceKey!, snapshot, principal: owner});
  if (snapshot.receivedAt !== document.receivedAt) throw new Error('Memory head chronology differs from immutable capture');
  return {owner, snapshot, sourceSha256: createHash('sha256').update(bytes).digest('hex')};
}
async function passageCount(binding: MigrationBinding, head: SearchDocument) {
  const collection = binding.realm.collection('memory'), f = collection.field;
  const result = await collection.search(binding.principal, {size: 0, track_total_hits: true,
    query: {bool: {filter: [{term: {[f('kind')]: 'passage'}}, activeMemoryProjectionFilter([head])]}}}, {createIfMissing: false});
  if (result.hits.total.relation !== 'eq') throw new Error('Incomplete retained memory inventory');
  return result.hits.total.value;
}
async function headDocument(binding: MigrationBinding, headId: string) {
  const hit = (await binding.realm.collection('memory').mget(binding.principal, [headId])).docs[0];
  return hit?.found ? {id: hit._id, document: hit._source} : null;
}

/** One bounded snapshot per call; source bytes and generation never change.
 * The durable backup contains only the prior head and integrity/count receipts.
 * Old passage documents remain in the realm under their original identities. */
export async function migrateMemoryProjection(input: MigrationBinding & {
  headId: string; search: Pick<ReturnType<typeof createMemorySearch>, 'putSnapshot'>;
  backup(step: MemoryProjectionBackup): Promise<unknown>; dryRun?: boolean;
}) {
  scope(input, input.headId);
  const head = await headDocument(input, input.headId);
  if (!head) throw new Error('Memory head is no longer available');
  const {owner, snapshot, sourceSha256} = await readSource(input, head);
  const projectionId = memoryProjectionId(snapshot.snapshotId);
  if (head.document.projectionId === projectionId) return {status: 'already-current' as const, headId: head.id, projectionId};
  if (head.document.projectionId && Number(head.document.passageVersion) >= PASSAGE_VERSION) throw new Error('Memory projection version conflict');
  const previousPassages = await passageCount(input, head.document);
  if (input.dryRun !== false) return {status: 'dry-run' as const, headId: head.id, projectionId, previousPassages, files: snapshot.files.length, sourceSha256};
  await input.realm.ensureIndex();
  await input.backup({head, replacementProjectionId: projectionId, previousPassages, sourceSha256});
  const controls = await createControls(input).list(owner, 'memories', snapshot.harness);
  const passages = await input.search.putSnapshot(snapshot, owner, head.document.sourceKey!, {controls});
  const after = await headDocument(input, head.id);
  const active = after?.document.snapshotId === snapshot.snapshotId && after.document.projectionId === projectionId;
  return {status: active ? 'activated' as const : 'superseded' as const, headId: head.id, projectionId, passages, previousPassages, sourceSha256};
}

/** Restore a retained pointer only while this exact projection is still active.
 * Fresh resource controls still govern every read; no passage is resurrected. */
export async function rollbackMemoryProjection(input: MigrationBinding & {backup: MemoryProjectionBackup; dryRun?: boolean}) {
  const {backup} = input; scope(input, backup.head.id);
  const {snapshot, sourceSha256} = await readSource(input, backup.head);
  if (sourceSha256 !== backup.sourceSha256 || backup.replacementProjectionId !== memoryProjectionId(snapshot.snapshotId) || !Number.isSafeInteger(backup.previousPassages) || backup.previousPassages < 0) throw new Error('Memory rollback evidence mismatch');
  if (await passageCount(input, backup.head.document) !== backup.previousPassages) throw new Error('Retained memory projection changed; rollback refused');
  const current = await headDocument(input, backup.head.id);
  if (!current || current.document.snapshotId !== snapshot.snapshotId || current.document.generation !== snapshot.generation) throw new Error('A newer memory capture cannot be replaced by rollback');
  if (current.document.projectionId === backup.head.document.projectionId) return {status: 'already-restored' as const};
  if (current.document.projectionId !== backup.replacementProjectionId) throw new Error('Memory projection changed; rollback refused');
  if (input.dryRun !== false) return {status: 'dry-run' as const};
  await input.realm.collection('memory').bulk(input.principal, [{...backup.head, policy: {name:'memory-projection-rollback',expectedProjectionId:backup.replacementProjectionId}}], {refresh: true});
  const after = await headDocument(input, backup.head.id);
  if (!after || after.document.snapshotId !== snapshot.snapshotId || after.document.projectionId !== backup.head.document.projectionId) throw new Error('Memory head changed during rollback');
  return {status: 'restored' as const};
}
