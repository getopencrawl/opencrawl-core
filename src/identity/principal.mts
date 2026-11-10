import type {IdentityDirectory, HostedUser, DirectoryMembership as Membership, Principal} from './types.mjs';
/** Current memberships, including all pages; never infer authority from email domains. */
export async function activeMemberships(directory: IdentityDirectory, userId: string, organizationId?: string) {
  const result = await directory.userManagement.listOrganizationMemberships({userId,
    ...(organizationId ? {organizationId} : {}), statuses: ['active'], limit: 100});
  const rows = result.autoPagination ? await result.autoPagination() : result.data;
  return rows.filter(m => m.userId === userId && /^org_[A-Za-z0-9]+$/.test(m.organizationId || '') && m.status === 'active' && (!organizationId || m.organizationId === organizationId));
}

const validClaim = (organizationId: unknown) => organizationId == null || (typeof organizationId === 'string' && /^org_[A-Za-z0-9]+$/.test(organizationId));

/** The memberships a principal is resolved from; null when the organization claim is malformed. */
export function principalMemberships(directory: IdentityDirectory, userId: string, organizationId?: unknown) {
  return validClaim(organizationId) ? activeMemberships(directory, userId, (organizationId ?? undefined) as string | undefined) : Promise.resolve(null);
}

/** Org-less device tokens can resolve one unambiguous membership, never pick from several. */
export function membershipPrincipal(user: Pick<HostedUser, 'id'>, memberships: Membership[] | null): Principal | null {
  if (memberships?.length !== 1) return null;
  return {tenantId: memberships[0].organizationId, userId: user.id};
}

/** Only pass a verified identity and a signed organization claim. No personal tenants. */
export async function userPrincipal(directory: IdentityDirectory, user: Pick<HostedUser, 'id'>, organizationId?: unknown) {
  return membershipPrincipal(user, await principalMemberships(directory, user.id, organizationId));
}

/** Fixed-organization deployments never enumerate or select another workspace. */
export function singleOrganizationPrincipal(directory: IdentityDirectory, organizationId: string) {
  if (!/^org_[A-Za-z0-9]+$/.test(organizationId)) throw new Error('Configure one organization');
  return async (user: Pick<HostedUser, 'id'>, claimedOrganization?: unknown): Promise<Principal | null> => {
    if (claimedOrganization != null && claimedOrganization !== organizationId) return null;
    return membershipPrincipal(user, await activeMemberships(directory, user.id, organizationId));
  };
}
