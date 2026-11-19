import {isWorkloadUserId} from './types.mjs';
import {historyActor} from '../integrations/replicas-senders.mjs';
import type {SessionBatch, SessionEvent} from './types.mjs';
import {capturedActor} from './actors.mjs';
import {replicasProjection} from './replicas-record.mjs';

/** Display/filter identities never grant resource ownership or permissions. */
export interface SessionParticipant {id: string; name?: string}
export const validParticipant = (value: unknown): value is string => typeof value === 'string' && /^(?:user:[A-Za-z0-9_.:-]{1,200}|replicas:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value);
export function participantProjection(event: SessionEvent, batch: SessionBatch) {
  const actor=historyActor(event,batch)??capturedActor(event,batch);
  event=replicasProjection(event);
  const version = {participantVersion: 1};
  if (!(event.kind === 'message' && event.data?.role === 'user' || event.kind === 'user_message' && batch.harness !== 'codex')) return version;
  if (actor?.kind === 'human') return {...version, participantId: 'replicas:' + actor.userId!.toLowerCase(), participantName: actor.name || actor.email || actor.userId};
  if (actor || event.actor || batch.owner && isWorkloadUserId(batch.owner.userId)) return {...version, participantUnknown: true};
  return {...version, participantId: 'user:' + batch.owner!.userId};
}
