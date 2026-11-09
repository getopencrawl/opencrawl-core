import {createHash} from 'node:crypto';
import {currentBrowserUser, type BrowserIdentity} from './auth.mjs';
import {activeMemberships} from './principal.mjs';
import {isAdmin} from './team.mjs';
import type {Workos, Principal, Membership, HostedUser} from './types.mjs';
export type OrganizationAdmission = {status: 200; user: HostedUser; member: Membership; principal: Principal; cacheScope: string} | {status: 401 | 403 | 503};
/** Runtime identity boundary: one configured organization, many current members. */
export function singleOrganizationIdentity(workos: Workos, organizationId: string) {
  if (!/^org_[A-Za-z0-9]+$/.test(organizationId)) throw new Error('Configure one WorkOS organization');
  return async (identity: BrowserIdentity & {organizationId?: unknown}): Promise<OrganizationAdmission> => {
    if (identity.organizationId != null && identity.organizationId !== organizationId) return {status: 403};
    const current = await currentBrowserUser(workos, identity);
    if (current.status !== 200) return current;
    try {
      const memberships = await activeMemberships(workos, current.user.id, organizationId);
      if (memberships.length !== 1) return {status: 403};
      const member = memberships[0]!;
      const principal = {tenantId: organizationId, userId: current.user.id, email: current.user.email};
      const cacheScope = createHash('sha256').update(JSON.stringify([organizationId, principal.userId, identity.sessionId, isAdmin(member) ? 'admin' : 'member'])).digest('hex');
      return {status: 200, user: current.user, member, principal, cacheScope};
    } catch {return {status: 503};}
  };
}
