import type {WorkOS, User, OrganizationMembership} from '@workos-inc/node';
export type Workos = WorkOS;
export type HostedUser = Pick<User, 'id' | 'email'> & Partial<Pick<User, 'firstName' | 'lastName' | 'emailVerified'>>;
export type Membership = OrganizationMembership;
export type {Principal} from '../sessions/types.mjs';
export {errorInfo} from '../errors.mjs';
export interface IdentitySettings {clientId: string; url: string; authOrigin: string; organizationId?: string}
