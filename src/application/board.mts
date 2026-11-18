import type {Principal} from '../identity/types.mjs';
import {createBoard} from '../board/board.mjs';
const requested = (input:unknown) => input && typeof input==='object' && 'workspace' in input ? input.workspace : undefined;
/** Each deployment supplies its admission policy; all operations recheck before releasing results. */
export function authorizedBoard({authorize, admit = authorize,...options}:Parameters<typeof createBoard>[0] & {
  authorize(principal:Principal,requested?:unknown):Promise<Principal>;
  /** May reuse admission from this request only. Final authorization remains live. */
  admit?(principal:Principal,requested?:unknown):Promise<Principal>;
}) {
  const board=createBoard(options),resolve=authorize;
  return {
    async searchCandidates(principal: Principal, query: string, limit: number) {
      const scope = await admit(principal);
      const result = await board.searchCandidates(scope, query, limit);
      await resolve(scope, scope.tenantId);
      return result;
    },
    agent:Object.fromEntries(Object.entries(board.agent).map(([name,operation])=>[name,async(principal:Principal,input:unknown)=>{
      const scope=await admit(principal,requested(input));const result=await operation(scope,input);await resolve(scope,scope.tenantId);return result;
    }])) as typeof board.agent,
    async participate(principal: Principal, operation: string, input: unknown) {
      const authorized = await admit(principal);
      const result = await board.participate(authorized, operation, input);
      await resolve(authorized, authorized.tenantId);
      return result;
    },
    async read(principal: Principal, input: unknown) {const scope=await admit(principal);const result=await board.read(scope,input);await resolve(scope,scope.tenantId);return result;},
    async search(principal: Principal, input: unknown) {const scope=await admit(principal, requested(input));const result=await board.search(scope,input);await resolve(scope,scope.tenantId);return result;},
    async channels(principal: Principal, input: unknown) {const scope=await admit(principal,requested(input));const result=await board.channels(scope,input);await resolve(scope,scope.tenantId);return result;},
    async thread(principal: Principal, input: unknown) {const scope=await admit(principal,requested(input));const result=await board.thread(scope,input);await resolve(scope,scope.tenantId);return result;},
    async topics(principal: Principal, input: unknown) {const scope=await admit(principal, requested(input));const result=await board.topics(scope,input);await resolve(scope,scope.tenantId);return result;},
    async fetch(principal: Principal, input: unknown) {
      const scope = await admit(principal, requested(input));
      const result = await board.fetch(scope, input);
      await resolve(scope, scope.tenantId);
      return result;
    },
    async post(principal:Principal,input:unknown){const scope=await admit(principal,requested(input));const result=await board.post(scope,input);await resolve(scope,scope.tenantId);return result;},
    async presence(principal:Principal,input:unknown){const scope=await admit(principal,requested(input));const result=await board.presence(scope,input);await resolve(scope,scope.tenantId);return result;},
    async sync(principal: Principal, input: unknown) {
      const authorized = await admit(principal, input && typeof input === 'object' && 'workspace' in input ? input.workspace : undefined);
      const result = await board.sync(authorized, input);
      // Session retrieval can take longer than a board read. Recheck membership
      // before releasing any transcript content; never switch the selected org.
      await resolve(authorized, authorized.tenantId);
      return result;
    },
  };
}
