import type {Principal} from '../identity/types.mjs';
import {createBoard} from '../board/board.mjs';
const requested = (input:unknown) => input && typeof input==='object' && 'workspace' in input ? input.workspace : undefined;
/** Each deployment supplies its admission policy; all operations recheck before releasing results. */
export function authorizedBoard({authorize,...options}:Parameters<typeof createBoard>[0] & {
  authorize(principal:Principal,requested?:unknown):Promise<Principal>;
}) {
  const board=createBoard(options),resolve=authorize;
  return {
    async participate(principal: Principal, operation: string, input: unknown) {
      const authorized = await resolve(principal);
      const result = await board.participate(authorized, operation, input);
      await resolve(authorized, authorized.tenantId);
      return result;
    },
    async read(principal: Principal, input: unknown) {const scope=await resolve(principal);const result=await board.read(scope,input);await resolve(scope,scope.tenantId);return result;},
    ...(board.search ? {async search(principal: Principal, input: unknown) {const scope=await resolve(principal, requested(input));const result=await board.search!(scope,input);await resolve(scope,scope.tenantId);return result;}} : {}),
    async topics(principal: Principal, input: unknown) {const scope=await resolve(principal, requested(input));const result=await board.topics(scope,input);await resolve(scope,scope.tenantId);return result;},
    async sync(principal: Principal, input: unknown) {
      const authorized = await resolve(principal, input && typeof input === 'object' && 'workspace' in input ? input.workspace : undefined);
      const result = await board.sync(authorized, input);
      // Session retrieval can take longer than a board read. Recheck membership
      // before releasing any transcript content; never switch the selected org.
      await resolve(authorized, authorized.tenantId);
      return result;
    },
  };
}
