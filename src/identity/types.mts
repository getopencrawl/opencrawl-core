import type {WorkOS, User, OrganizationMembership} from '@workos-inc/node';
export type Workos = WorkOS;
export type HostedUser = Pick<User, 'id' | 'email'> & Partial<Pick<User, 'firstName' | 'lastName' | 'emailVerified'>>;
export type Membership = OrganizationMembership;
export type {Principal} from '../sessions/types.mjs';
export {errorInfo} from '../errors.mjs';
export interface IdentitySettings {clientId: string; url: string; authOrigin: string; organizationId?: string}

/** Membership fields that authorization reads. WorkOS memberships satisfy this shape. */
export interface DirectoryMembership {id: string; userId: string; organizationId: string; status: string; role?: {slug: string}; roles?: Array<{slug: string}>; directoryManaged?: boolean}
export interface DirectorySession {id: string; userId: string; status: string; endedAt: string | Date | null; expiresAt: string | Date}
type Listing<T> = {data: T[]; autoPagination?: () => Promise<T[]>};
/**
 * The account directory that core authorization reads: current users, memberships,
 * sessions, invitations and the organization name. The WorkOS SDK satisfies it for
 * the hosted shell; self-host supplies a Better Auth implementation.
 */
export interface IdentityDirectory {
  userManagement: {
    getUser(id: string): Promise<HostedUser>;
    listOrganizationMemberships(options: {userId?: string; organizationId?: string; statuses?: Array<'active' | 'inactive' | 'pending'>; limit?: number}): Promise<Listing<DirectoryMembership>>;
    listSessions(userId: string, options?: {limit?: number; order?: 'asc' | 'desc'; after?: string}): Promise<{data: DirectorySession[]; listMetadata: {after?: string | null}}>;
    updateOrganizationMembership(id: string, options: {roleSlug: string}): Promise<DirectoryMembership>;
    listInvitations(options: {organizationId: string; limit?: number}): Promise<{data: Array<{email: string; state: string; organizationId?: string | null}>}>;
    sendInvitation(options: {organizationId: string; email: string; inviterUserId: string; roleSlug: string}): Promise<{id: string; email: string; acceptInvitationUrl?: string}>;
  };
  organizations: {
    getOrganization(id: string): Promise<{id: string; name: string}>;
    updateOrganization(options: {organization: string; name: string}): Promise<{id: string; name: string}>;
  };
}
