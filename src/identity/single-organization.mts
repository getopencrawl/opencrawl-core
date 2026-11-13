import {createHash} from 'node:crypto';
import {currentBrowserUser, type BrowserIdentity} from './auth.mjs';
import {activeMemberships} from './principal.mjs';
import {isAdmin} from './team.mjs';
import type {IdentityDirectory, Principal, DirectoryMembership as Membership, HostedUser} from './types.mjs';
export type OrganizationAdmission = {status: 200; user: HostedUser; member: Membership; principal: Principal; cacheScope: string} | {status: 401 | 403 | 503};
/** Runtime identity boundary: one configured organization, many current members. */
export function singleOrganizationIdentity(directory: IdentityDirectory, organizationId: string) {
  if (!/^org_[A-Za-z0-9]+$/.test(organizationId)) throw new Error('Configure one organization');
  return async (identity: BrowserIdentity & {organizationId?: unknown}): Promise<OrganizationAdmission> => {
    if (identity.organizationId != null && identity.organizationId !== organizationId) return {status: 403};
    if (identity.authenticated !== true || !identity.sessionId || !identity.user?.id) return {status:401};
    const [current, membershipRead] = await Promise.all([
      currentBrowserUser(directory, identity),
      activeMemberships(directory, identity.user.id, organizationId)
        .then(value => ({ok:true as const,value}), () => ({ok:false as const})),
    ]);
    if (current.status !== 200) return current;
    try {
      if (!membershipRead.ok) return {status:503};
      const memberships = membershipRead.value;
      if (memberships.length !== 1) return {status: 403};
      const member = memberships[0]!;
      const principal = {tenantId: organizationId, userId: current.user.id, email: current.user.email};
      const cacheScope = createHash('sha256').update(JSON.stringify([organizationId, principal.userId, identity.sessionId, isAdmin(member) ? 'admin' : 'member'])).digest('hex');
      return {status: 200, user: current.user, member, principal, cacheScope};
    } catch {return {status: 503};}
  };
}
