import type {Principal, ObjectStore} from '../sessions/types.mjs';
import type {RealmOptions, QueryBody} from '../search/types.mjs';
import type {StoredMemorySnapshot} from './types.mjs';
import {createRealmResolver, realmField} from '../search/realm.mjs';
import {sessionScope} from '../sessions/event-identity.mjs';
import {createControls, visibleTo} from '../sessions/controls.mjs';

export interface MemoryKey {userId: string; harness: string; path: string}
export interface MemorySummary extends MemoryKey {
  project: string; description: string; modifiedAt: string | null; private: boolean; mine: boolean; host: string | null; sourceSessionId: string | null;
}
const HARNESSES = ['claude-code', 'codex'];
const f = (field: string) => realmField('memory', field);
const identity = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
const validPath = (value: unknown): value is string => typeof value === 'string' && value.length <= 2048 && value.endsWith('.md') && !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..');
function fail(status: number, message: string): never {throw Object.assign(new Error(message), {status});}
function checkKey({userId, harness, path}: Partial<MemoryKey>) {
  if (!identity(userId) || !HARNESSES.includes(harness ?? '') || !validPath(path)) fail(400, 'Invalid memory');
  return {userId: userId!, harness: harness!, path: path!};
}
/** Frontmatter description, else the first line of prose. */
export function memoryDescription(text: string) {
  const frontmatter = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const described = frontmatter && /^description:\s*["']?(.+?)["']?\s*$/m.exec(frontmatter[1]!)?.[1];
  const body = frontmatter ? text.slice(frontmatter[0].length) : text;
  const line = described || body.split('\n').map(value => value.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
  return line.length > 240 ? line.slice(0, 239) + '…' : line;
}
/** Controls the indexer applies to a newly received snapshot. */
export function memoryControls(controls: ReturnType<typeof createControls>, owner: Principal, snapshot: StoredMemorySnapshot) {
  return controls.list(owner, 'memories', snapshot.harness);
}

/** Current captured memory files. Readable by the team unless private to their
 * owner; only the owner changes visibility or deletes. */
export function createMemoryLibrary({store, prefix, ...options}: RealmOptions & {store: ObjectStore; prefix: string}) {
  const resolve = createRealmResolver(options), controls = createControls({store, prefix});
  const reader = (principal: Principal) => {
    sessionScope(principal);
    if (principal.captureAccess !== undefined) fail(403, 'Memory read access required');
    return resolve(principal).collection('memory');
  };
  async function active(principal: Principal) {
    const result = await reader(principal).search(principal, {size: 10000, track_total_hits: true, query: {term: {[f('kind')]: 'snapshot'}}, _source: ['snapshotId']});
    if (result.hits.total?.relation !== 'eq' || result.hits.total.value > 10000) throw new Error('Memory inventory exceeds search window');
    return result.hits.hits.map(hit => hit._source.snapshotId as string);
  }
  const fileFilter = (key: MemoryKey) => [{term: {[f('userId')]: key.userId}}, {term: {[f('harness')]: key.harness}}, {term: {[f('path')]: key.path}}];
  async function owned(principal: Principal, key: MemoryKey) {
    const result = await reader(principal).search(principal, {size: 0, track_total_hits: 1, query: {bool: {filter: [{term: {[f('kind')]: 'passage'}}, ...fileFilter(key)]}}});
    return result.hits.total.value > 0;
  }
  return {
    async list(principal: Principal, {scope = 'all'}: {scope?: unknown} = {}) {
      const collection = reader(principal);
      if (!['all', 'mine'].includes(String(scope))) fail(400, 'Invalid memory list');
      const snapshots = await active(principal);
      if (!snapshots.length) return {memories: [], truncated: false};
      const filter: QueryBody[] = [{term: {[f('kind')]: 'passage'}}, {term: {[f('chunk')]: 0}}, {terms: {[f('snapshotId')]: snapshots}}, visibleTo('memory', principal),
        ...(scope === 'mine' ? [{term: {[f('userId')]: principal.userId}}] : [])];
      const result = await collection.search(principal, {size: 1000, track_total_hits: true, query: {bool: {filter}}, sort: [{[f('modifiedAt')]: 'desc'}, {id: 'asc'}]});
      const newest = new Map<string, MemorySummary>();
      for (const hit of result.hits.hits) {
        const d = hit._source;
        if (d.tenantId !== principal.tenantId || !identity(d.userId) || !HARNESSES.includes(String(d.harness)) || !validPath(d.path)) throw new Error('Invalid memory list response');
        const key = JSON.stringify([d.userId, d.harness, d.path]);
        if (newest.has(key)) continue; // Same file captured from another machine; sorted newest first.
        newest.set(key, {userId: d.userId!, harness: d.harness!, path: d.path, project: typeof d.project === 'string' ? d.project : '', description: memoryDescription(typeof d.text === 'string' ? d.text : ''),
          modifiedAt: typeof d.modifiedAt === 'string' ? d.modifiedAt : null, private: d.private === true, mine: d.userId === principal.userId,
          host: typeof d.host === 'string' ? d.host : null, sourceSessionId: typeof d.sourceSessionId === 'string' ? d.sourceSessionId : null});
      }
      return {memories: [...newest.values()], truncated: result.hits.total.value > result.hits.hits.length};
    },

    async read(principal: Principal, input: Partial<MemoryKey>) {
      const key = checkKey(input), collection = reader(principal);
      const snapshots = await active(principal);
      const result = snapshots.length ? await collection.search(principal, {size: 200, query: {bool: {filter: [{term: {[f('kind')]: 'passage'}}, {terms: {[f('snapshotId')]: snapshots}}, ...fileFilter(key), visibleTo('memory', principal)]}},
        sort: [{[f('modifiedAt')]: 'desc'}, {[f('snapshotId')]: 'asc'}, {[f('chunk')]: 'asc'}]}) : null;
      const hits = result?.hits.hits ?? [];
      if (!hits.length) fail(404, 'Memory not found');
      const snapshotId = hits[0]!._source.snapshotId, chunks = hits.filter(hit => hit._source.snapshotId === snapshotId);
      if (chunks.some((hit, index) => hit._source.chunk !== index)) throw new Error('Memory read is incomplete');
      const first = chunks[0]!._source;
      return {memory: {...key, project: typeof first.project === 'string' ? first.project : '', modifiedAt: typeof first.modifiedAt === 'string' ? first.modifiedAt : null,
        private: first.private === true, mine: key.userId === principal.userId, host: typeof first.host === 'string' ? first.host : null,
        sourceSessionId: typeof first.sourceSessionId === 'string' ? first.sourceSessionId : null}, text: chunks.map(hit => hit._source.text ?? '').join('')};
    },

    async setVisibility(principal: Principal, input: {harness?: unknown; path?: unknown; visibility?: unknown}) {
      const key = checkKey({userId: principal.userId, harness: input.harness as string, path: input.path as string});
      if (!['team', 'private'].includes(String(input.visibility))) fail(400, 'Choose team or private visibility');
      if (!await owned(principal, key)) fail(404, 'Only the person who captured a memory can change it');
      // Realms created before owner visibility gain the field before the first write.
      await resolve(principal).ensureIndex();
      const control = await controls.update(principal, 'memories', key.harness, key.path, current => ({visibility: input.visibility as 'team' | 'private', deletedAt: current?.deletedAt ?? null}));
      await reader(principal).byQuery(principal, 'update', {bool: {filter: fileFilter(key)}}, {lang: 'painless', source: 'ctx._source.memory.private = params.value', params: {value: control.visibility === 'private'}});
      return {...key, visibility: control.visibility};
    },

    async delete(principal: Principal, input: {harness?: unknown; path?: unknown}) {
      const key = checkKey({userId: principal.userId, harness: input.harness as string, path: input.path as string});
      if (!await owned(principal, key)) fail(404, 'Only the person who captured a memory can delete it');
      await controls.update(principal, 'memories', key.harness, key.path, current => ({visibility: current?.visibility ?? 'team', deletedAt: new Date().toISOString()}));
      const {changed} = await reader(principal).byQuery(principal, 'delete', {bool: {filter: [{term: {[f('kind')]: 'passage'}}, ...fileFilter(key)]}});
      return {...key, deleted: true, documents: changed};
    },
  };
}
