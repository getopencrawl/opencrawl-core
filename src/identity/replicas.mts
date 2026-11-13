import {createHash} from 'node:crypto';
import {createRemoteJWKSet, decodeJwt, jwtVerify, errors} from 'jose';
import type {JWTVerifyGetKey} from 'jose';
import type {Principal} from './types.mjs';

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

/** A workspace is its own principal. It never impersonates its creator or reads
 * a member's private resources. Creator and per-message sender are provenance,
 * not authority. Only the agent read/board/upload routes admit this identity.
 */
export function createReplicasWorkloads({audience, bindings, key = createRemoteJWKSet(new URL(REPLICAS_ISSUER + '/.well-known/jwks.json'), {timeoutDuration: 5000}), now = Date.now}: {
  audience: string; bindings: () => readonly ReplicasBinding[] | Promise<readonly ReplicasBinding[]>;
  key?: JWTVerifyGetKey; now?: () => number;
}) {
  const origin = new URL(audience);
  if (origin.origin !== audience || !['https:', 'http:'].includes(origin.protocol) || origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw new Error('Invalid workload audience');
  const admitted = new WeakMap<Principal, ReplicasIdentity>();
  async function revalidate(principal: Principal, requested?: unknown): Promise<Principal> {
    const identity = admitted.get(principal);
    if (!identity || identity.expiresAt <= now() || requested !== undefined && requested !== principal.tenantId) throw Object.assign(new Error('Workload access denied'), {status: 403});
    const matches = (await bindings()).filter(row => row.organizationId === identity.organizationId && row.environmentId === identity.environmentId);
    if (matches.length !== 1 || matches[0]!.tenantId !== principal.tenantId) throw Object.assign(new Error('Workload binding revoked'), {status: 403});
    return principal;
  }
  return {
    revalidate,
    async identify(token: string): Promise<WorkloadResult> {
      let payload;
      try {
        ({payload} = await jwtVerify(token, key, {issuer: REPLICAS_ISSUER, audience, algorithms: ['RS256'], requiredClaims: ['sub', 'iat', 'exp'], maxTokenAge: 900, currentDate: new Date(now())}));
      } catch (error) {return {status: error instanceof errors.JOSEError && !(error instanceof errors.JWKSTimeout) ? 401 : 503};}
      const org = payload.organization_id, env = payload.environment_id, workspace = payload.workspace_id;
      if (payload.aud !== audience || typeof org !== 'string' || !uuid.test(org) || typeof env !== 'string' || !uuid.test(env) ||
          typeof workspace !== 'string' || !uuid.test(workspace) || payload.sub !== `org:${org}:env:${env}:workspace:${workspace}` ||
          typeof payload.iat !== 'number' || typeof payload.exp !== 'number' || payload.exp - payload.iat > 900 || payload.exp <= payload.iat || payload.iat * 1000 > now()) return {status: 401};
      let matches;
      try {matches = (await bindings()).filter(row => row.organizationId === org && row.environmentId === env);} catch {return {status: 503};}
      if (matches.length !== 1) return {status: 403};
      const principal: Principal = {tenantId: matches[0]!.tenantId,
        userId: replicasOwnerId(org, env, workspace),
        name: 'Replicas workspace ' + workspace, email: null,
        owner: {kind: 'shared', provider: 'replicas', organizationId: org, environmentId: env, workspaceId: workspace}};
      const workload: ReplicasIdentity = {organizationId: org, environmentId: env, workspaceId: workspace,
        creatorId: typeof payload.creator_id === 'string' && uuid.test(payload.creator_id) ? payload.creator_id : null,
        creatorEmail: typeof payload.creator_email === 'string' ? payload.creator_email : null, expiresAt: payload.exp * 1000};
      admitted.set(principal, workload);
      return {status: 200, principal, user: {id: principal.userId, email: null}, workload};
    },
  };
}
