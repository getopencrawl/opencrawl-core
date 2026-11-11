import type {Principal} from '../sessions/types.mjs';
import type {QueryBody, SearchDocument} from '../search/types.mjs';
import {digest, sessionScope} from '../sessions/event-identity.mjs';
import {realmField} from '../search/realm.mjs';
import {PASSAGE_VERSION} from '../search/passages.mjs';

export const MEMORY_HEAD_FIELDS = ['snapshotId', 'projectionId', 'passageVersion'];
const f = (field: string) => realmField('memory', field);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Projection identity changes independently of the immutable captured snapshot. */
export function memoryProjectionId(snapshotId: string, version = PASSAGE_VERSION) {
  if (!hash(snapshotId) || !Number.isSafeInteger(version) || version < 1) throw new Error('Invalid memory projection identity');
  return digest(JSON.stringify(['memory-projection', snapshotId, version]));
}
export function memoryPassageId(owner: Principal, snapshotId: string, path: string, chunk: number, projectionId?: string) {
  if (!hash(snapshotId) || projectionId !== undefined && !hash(projectionId) || !Number.isSafeInteger(chunk) || chunk < 0) throw new Error('Invalid memory passage identity');
  const scope = sessionScope(owner);
  return digest(JSON.stringify(projectionId === undefined ? [scope, snapshotId, path, chunk] : [scope, snapshotId, projectionId, path, chunk]));
}

/** Heads without a projection identity must never expose staged new passages. */
export function activeMemoryProjectionFilter(heads: SearchDocument[]): QueryBody {
  const legacy: string[] = [], projections: string[] = [];
  for (const head of heads) {
    if (!hash(head.snapshotId)) throw new Error('Invalid memory head snapshot');
    if (head.projectionId === undefined) legacy.push(head.snapshotId);
    else {
      if (!hash(head.projectionId) || !Number.isSafeInteger(head.passageVersion) || Number(head.passageVersion) < 1 ||
        head.projectionId !== memoryProjectionId(head.snapshotId, Number(head.passageVersion))) throw new Error('Invalid memory head projection');
      projections.push(head.projectionId);
    }
  }
  const should: QueryBody[] = [];
  if (legacy.length) should.push({bool: {filter: [{terms: {[f('snapshotId')]: legacy}}], must_not: [{exists: {field: f('projectionId')}}]}});
  if (projections.length) should.push({terms: {[f('projectionId')]: projections}});
  return should.length ? {bool: {minimum_should_match: 1, should}} : {match_none: {}};
}
