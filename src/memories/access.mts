import type {Principal} from '../sessions/types.mjs';
import type {SearchDocument} from '../search/types.mjs';
import {createControls} from '../sessions/controls.mjs';
import {sessionScope} from '../sessions/event-identity.mjs';

/** An index projection cannot override a later owner visibility change or delete. */
export async function authorizedMemoryDocuments<T extends SearchDocument>(controls: ReturnType<typeof createControls> | null, principal: Principal, documents: T[]): Promise<T[]> {
  sessionScope(principal);
  if (principal.captureAccess !== undefined) throw Object.assign(new Error('Memory read access required'), {status: 403});
  if (!controls) throw Object.assign(new Error('Memory reads require authoritative resource controls'), {status: 503});
  const key = (document: SearchDocument) => JSON.stringify([document.userId, document.harness, document.path]);
  const resources = new Map<string, T>();
  for (const document of documents) {
    if (document.tenantId !== principal.tenantId || typeof document.userId !== 'string' || !document.userId ||
      !['codex', 'claude-code'].includes(document.harness ?? '') || typeof document.path !== 'string' || !document.path.endsWith('.md') ||
      document.path.length > 2048 || document.path.includes('\\') || document.path.split('/').some(part => !part || part === '.' || part === '..') ||
      !Number.isFinite(Date.parse(document.modifiedAt ?? ''))) throw new Error('Invalid memory ownership or file identity');
    resources.set(key(document), document);
  }
  const current = new Map<string, Awaited<ReturnType<typeof controls.read>>>(), entries = [...resources];
  for (let start = 0; start < entries.length; start += 8) await Promise.all(entries.slice(start, start + 8).map(async ([identity, document]) => {
    current.set(identity, await controls.read({...principal, userId: document.userId!}, 'memories', document.harness!, document.path!));
  }));
  return documents.flatMap(document => {
    const control = current.get(key(document)), privateFile = control ? control.visibility === 'private' : document.private === true;
    if (privateFile && document.userId !== principal.userId || control?.deletedAt && !(Date.parse(document.modifiedAt!) > Date.parse(control.deletedAt))) return [];
    return [{...document, private: privateFile}];
  });
}
