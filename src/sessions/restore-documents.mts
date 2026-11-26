import type {DocumentItem, SearchCollection} from '../search/types.mjs';
import type {ResourceControl, ResourceControls} from './controls.mjs';
import {applySessionControl, type SessionKey} from './library.mjs';

/** Write a full search projection under its caller's durable session fences.
 * A backup can predate a privacy change. Preserve older private documents
 * without a control, and reconcile any control changed during the index write. */
export async function writeCurrentSessionDocuments(
  controls: ResourceControls,
  collection: SearchCollection,
  tenantId: string,
  documents: DocumentItem[],
  write: (documents: DocumentItem[]) => Promise<unknown>,
) {
  const sessions = new Map<string, {key: SessionKey; before: ResourceControl | null}>();
  const projected: DocumentItem[] = [];
  for (const item of documents) {
    const {userId, harness, sessionId} = item.document;
    if (item.document.tenantId !== tenantId || typeof userId !== 'string' || typeof harness !== 'string' || typeof sessionId !== 'string')
      throw new Error('Invalid session projection scope');
    const id = JSON.stringify([userId, harness, sessionId]);
    let session = sessions.get(id);
    if (!session) {
      const before = await controls.read({tenantId, userId}, 'sessions', harness, sessionId);
      if (before?.deletedAt) throw Object.assign(new Error('Deleted session cannot be copied or restored'), {status: 403, writeOutcome: 'not-applied'});
      session = {key: {userId, harness, sessionId}, before};
      sessions.set(id, session);
    }
    projected.push(session.before ? {...item, document: {...item.document, private: session.before.visibility === 'private'}} : item);
  }
  await write(projected);
  for (const {key, before} of sessions.values()) {
    const owner = {tenantId, userId: key.userId};
    const current = await controls.read(owner, 'sessions', key.harness, key.sessionId);
    if (current && (current.deletedAt || current.visibility !== before?.visibility))
      await applySessionControl(collection, owner, key, current);
  }
}
