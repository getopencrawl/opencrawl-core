import {createHash} from 'node:crypto';
import {createRemoteJWKSet, decodeJwt, jwtVerify, errors} from 'jose';
import type {JWTVerifyGetKey} from 'jose';
import type {Principal} from './types.mjs';

export type ReplicasIdentityKey = JWTVerifyGetKey;

export const REPLICAS_ISSUER = 'https://api.replicas.dev';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export interface ReplicasBinding {organizationId: string; environmentId: string; tenantId: string; onboardingWorkspaceId?: string}
export interface ReplicasIdentity {
  organizationId: string; environmentId: string; workspaceId: string;
  creatorId: string | null; creatorEmail: string | null; expiresAt: number;
}
export type WorkloadResult = {status: 200; user: {id: string; email: null}; principal: Principal; workload: ReplicasIdentity} | {status: 401 | 403 | 503; code?: string};

/** Operator-controlled admission only. No email/domain or creator grants access. */
export function replicasBindings(value: string | undefined, tenantId?: string): ReplicasBinding[] {
  const parsed: unknown = value ? JSON.parse(value) : [];
  if (!Array.isArray(parsed)) throw new Error('Replicas bindings must be an array');
  const seen = new Set<string>();
  return parsed.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid Replicas binding');
    const row = entry as Record<string, unknown>;
    const tenant = tenantId ?? row.tenantId;
    if (typeof row.organizationId !== 'string' || !uuid.test(row.organizationId) ||
        typeof row.environmentId !== 'string' || !uuid.test(row.environmentId) ||
        typeof tenant !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(tenant) ||
        tenantId !== undefined && row.tenantId !== undefined && row.tenantId !== tenantId) throw new Error('Invalid Replicas binding');
    const key = row.organizationId + ':' + row.environmentId;
    if (seen.has(key)) throw new Error('A Replicas environment may bind to only one tenant');
    seen.add(key);
    if (row.onboardingWorkspaceId !== undefined && (typeof row.onboardingWorkspaceId !== 'string' || !uuid.test(row.onboardingWorkspaceId))) throw new Error('Invalid Replicas onboarding workspace');
    return {organizationId: row.organizationId, environmentId: row.environmentId, tenantId: tenant, ...(typeof row.onboardingWorkspaceId === 'string' ? {onboardingWorkspaceId: row.onboardingWorkspaceId} : {})};
  });
}

/** Untrusted routing hint only; identify always verifies the signature and claims. */
export function isReplicasToken(token: string | undefined): token is string {
  if (!token || token.length > 16384) return false;
  try {return decodeJwt(token).iss === REPLICAS_ISSUER;} catch {return false;}
}
export const isWorkloadPrincipal = (principal: Principal) => principal.userId.startsWith('workload_replicas_');

export function replicasOwnerId(organizationId: string, environmentId: string, workspaceId: string) {
  return 'workload_replicas_' + createHash('sha256').update(REPLICAS_ISSUER + '\n' + `org:${organizationId}:env:${environmentId}:workspace:${workspaceId}`).digest('hex');
}

/** Operator approval names the one workspace whose real setup receipts enroll the team. */
export function replicasSharedInstallations(bindings: readonly ReplicasBinding[]) {
  return bindings.flatMap(row => row.onboardingWorkspaceId ? [{id: row.environmentId, tenantId: row.tenantId,
    userId: replicasOwnerId(row.organizationId, row.environmentId, row.onboardingWorkspaceId), name: 'Replicas'}] : []);
}

export type ReplicasVerification = {status: 200; workload: ReplicasIdentity} | {status: 401 | 503};

/** Credential verification is separate from organization enrollment. A valid token
 * alone never grants product access or chooses a tenant. */
export function createReplicasVerifier({audience, key = createRemoteJWKSet(new URL(REPLICAS_ISSUER + '/.well-known/jwks.json'), {timeoutDuration: 5000}), now = Date.now}: {
  audience: string; key?: JWTVerifyGetKey; now?: () => number;
}) {
  const origin = new URL(audience);
  if (origin.origin !== audience || !['https:', 'http:'].includes(origin.protocol) || origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw new Error('Invalid workload audience');
  return async (token: string): Promise<ReplicasVerification> => {
    if (!token || token.length > 16384) return {status: 401};
    let payload;
    try {
      ({payload} = await jwtVerify(token, key, {issuer: REPLICAS_ISSUER, audience, algorithms: ['RS256'], requiredClaims: ['sub', 'iat', 'exp'], maxTokenAge: 900, currentDate: new Date(now())}));
    } catch (error) {return {status: error instanceof errors.JOSEError && !(error instanceof errors.JWKSTimeout) ? 401 : 503};}
    const org = payload.organization_id, env = payload.environment_id, workspace = payload.workspace_id;
    if (payload.aud !== audience || typeof org !== 'string' || !uuid.test(org) || typeof env !== 'string' || !uuid.test(env) ||
        typeof workspace !== 'string' || !uuid.test(workspace) || payload.sub !== `org:${org}:env:${env}:workspace:${workspace}` ||
        typeof payload.iat !== 'number' || typeof payload.exp !== 'number' || payload.exp - payload.iat > 900 || payload.exp <= payload.iat || payload.iat * 1000 > now()) return {status: 401};
    return {status: 200, workload: {organizationId: org, environmentId: env, workspaceId: workspace,
      creatorId: typeof payload.creator_id === 'string' && uuid.test(payload.creator_id) ? payload.creator_id : null,
      creatorEmail: typeof payload.creator_email === 'string' ? payload.creator_email : null, expiresAt: payload.exp * 1000}};
  };
}

/** A shared workspace never impersonates a creator or message author. The runtime
 * resolves its verified organization through the product connection registry.
 * Legacy bindings exist only for a staged migration; an explicit resolver is
 * authoritative on string/null. Undefined means no migrated record yet, so the
 * deployment may retain legacy admission during its verified cutover. */
export function createReplicasWorkloads({audience, bindings = () => [], resolveOrganization, key, now = Date.now}: {
  audience: string; bindings?: () => readonly ReplicasBinding[] | Promise<readonly ReplicasBinding[]>;
  resolveOrganization?: (organizationId: string) => Promise<string | null | undefined>;
  key?: JWTVerifyGetKey; now?: () => number;
}) {
  const verify = createReplicasVerifier({audience, key, now});
  const admitted = new WeakMap<Principal, ReplicasIdentity>();
  const tenant = async (identity: ReplicasIdentity) => {
    if (resolveOrganization) {
      const resolved = await resolveOrganization(identity.organizationId);
      if (resolved !== undefined) return resolved;
      // Only a missing migration record may retain the old admission path.
      // A present revoked connection returns null and can never fall back.
    }
    const matches = (await bindings()).filter(row => row.organizationId === identity.organizationId && row.environmentId === identity.environmentId);
    return matches.length === 1 ? matches[0]!.tenantId : null;
  };
  async function revalidate(principal: Principal, requested?: unknown): Promise<Principal> {
    const identity = admitted.get(principal);
    if (!identity || identity.expiresAt <= now() || requested !== undefined && requested !== principal.tenantId) throw Object.assign(new Error('Workload access denied'), {status: 403});
    if (await tenant(identity) !== principal.tenantId) throw Object.assign(new Error('Replicas organization connection revoked'), {status: 403});
    return principal;
  }
  return {
    revalidate, verify,
    async identify(token: string): Promise<WorkloadResult> {
      const verified = await verify(token);
      if (verified.status !== 200) return verified;
      const workload = verified.workload;
      let tenantId;
      try {tenantId = await tenant(workload);} catch {return {status: 503};}
      if (!tenantId) return {status: 403, code: 'REPLICAS_NOT_CONNECTED'};
      const {organizationId, environmentId, workspaceId} = workload;
      const principal: Principal = {tenantId,
        userId: replicasOwnerId(organizationId, environmentId, workspaceId),
        name: 'Replicas workspace ' + workspaceId, email: null,
        owner: {kind: 'shared', provider: 'replicas', organizationId, environmentId, workspaceId}};
      admitted.set(principal, workload);
      return {status: 200, principal, user: {id: principal.userId, email: null}, workload};
    },
  };
}
