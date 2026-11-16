import type {Principal} from './types.mjs';
import {isSessionHarness} from './types.mjs';
import type {ApplicationState} from '../state/types.mjs';
import {digest,sessionScope} from './event-identity.mjs';

/** Authoritative owner controls live in application PostgreSQL. */
export interface ResourceControl {schemaVersion: 1; visibility: 'team' | 'private'; deletedAt: string | null; updatedAt: string; deletion?: {sessionId: string; state: 'pending' | 'complete'}}
export type ControlKind = 'sessions' | 'memories';
function fail(status:number,message:string):never{throw Object.assign(new Error(message),{status,permanent:status!==503});}

/** Legacy object identity retained for offline migration only. */
export function controlKey(prefix: string, owner: Principal, kind: ControlKind, harness: string, name: string) {
  if (!isSessionHarness(harness) || typeof name !== 'string' || !name || name.length > 2048) fail(400, 'Invalid control identity');
  return `${prefix}/${sessionScope(owner)}/controls/${kind}/${harness}/${digest(name)}.json`;
}

export function createControls({state}:{state:ApplicationState}){
  if(!state?.controls)fail(503,'Authoritative application state is required');
  return state.controls;
}

/** Private resources stay readable by their owner only. Documents indexed before
 * visibility existed have no private field and remain team-visible. */
export function visibleTo(corpus: 'session' | 'memory', principal: Principal) {
  return {bool: {must_not: [{bool: {filter: [{term: {[corpus + '.private']: true}}], must_not: [{term: {[corpus + '.userId']: principal.userId}}]}}]}};
}
