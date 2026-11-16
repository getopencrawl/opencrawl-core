import type {ApplicationState} from '../state/types.mjs';
export type TeamRole='admin'|'member';
/** No lease expiry: an uncertain provider write remains held until verified. */
export function roleWriteGuard(state:ApplicationState){return state.accounts.roles.acquire;}
export type RoleWriteGuard=ReturnType<typeof roleWriteGuard>;
