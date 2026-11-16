import type {Principal} from './types.mjs';
import type {ApplicationState} from '../state/types.mjs';

/** An authorized deletion intent held in PostgreSQL until Temporal completes erasure. */
export interface SessionDeletionRequest {
  schemaVersion: 1;
  owner: Pick<Principal, 'tenantId' | 'userId'>;
  harness: string;
  sessionId: string;
}
export function createSessionDeletionRequests({state,prefix}:{state:ApplicationState;prefix:string}){
  if(!state?.deletionRequests)throw new Error('Authoritative application state is required');
  return state.deletionRequests(prefix);
}
