import {createHash} from 'node:crypto';
import {isWorkloadUserId} from './types.mjs';
import {historyActor} from '../integrations/replicas-senders.mjs';
import type {SessionBatch, SessionEvent} from './types.mjs';
import {capturedActor} from './actors.mjs';
import {replicasProjection} from './replicas-record.mjs';

/** Display/filter identities never grant resource ownership or permissions. */
export interface SessionParticipant {id: string; name?: string}
export const validParticipant = (value: unknown): value is string => typeof value === 'string' && /^(?:user:[A-Za-z0-9_.:-]{1,200}|replicas:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value);
/** Tenant-local join key for usage reporting. Display names never establish a match. */
export function memberEmailKey(tenantId: string, email?: string | null) {
  const normalized = email?.trim().toLowerCase();
  if (!normalized || !/^[^\s@]+@[^\s@]+$/.test(normalized)) return null;
  return createHash('sha256').update(JSON.stringify([tenantId, normalized])).digest('hex');
}
export function participantProjection(event: SessionEvent, batch: SessionBatch) {
  const actor=historyActor(event,batch)??capturedActor(event,batch);
  event=replicasProjection(event);
  const version = {participantVersion: 1};
  if (!(event.kind === 'message' && event.data?.role === 'user' || event.kind === 'user_message' && batch.harness !== 'codex')) return version;
  if (actor?.kind === 'human') {
    const shared = batch.owner?.userId.startsWith('workload_replicas_');
    const emailKey = shared && memberEmailKey(batch.owner!.tenantId, actor.email);
    return {participantVersion: shared ? 2 : 1, participantId: 'replicas:' + actor.userId!.toLowerCase(),
      participantName: actor.name || actor.email || actor.userId, ...(emailKey ? {participantEmailKey: emailKey} : {})};
  }
  if (actor || event.actor || batch.owner && isWorkloadUserId(batch.owner.userId)) return {...version, participantUnknown: true};
  return {...version, participantId: 'user:' + batch.owner!.userId};
}
