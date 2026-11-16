/** Portable application-state composition. Runtimes authenticate and explicitly
 * supply the operator-owned database; importing core never starts services. */
export {createApplicationDatabase,requireApplicationStateReady} from './state/postgres.mjs';
export type {ApplicationDatabase} from './state/postgres.mjs';
export {createApplicationState} from './state/application.mjs';
export type {ApplicationState} from './state/types.mjs';
