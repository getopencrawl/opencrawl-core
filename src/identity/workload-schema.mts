import {z} from 'zod';

export type WorkloadProvider = 'replicas' | 'devin';
export const workloadOrganization = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
// Cloud's signed org_id uses org-<32 hex>; the public OIDC reference also
// documents UUID organizations. Both are provider identities, never tenant IDs.
export const devinOrganization = z.string().regex(/^(?:org-[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/);
export const workloadOrganizationSchema = (provider: WorkloadProvider) => provider === 'devin' ? devinOrganization : workloadOrganization;
export const workloadScope = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
export const workloadLabel = (provider: WorkloadProvider) => provider === 'replicas' ? 'Replicas' : 'Devin Cloud';
export function workloadConnectionSchema(provider: WorkloadProvider) {
  const installation = z.object({id: workloadScope, tenantId: workloadScope,
    userId: z.string().regex(new RegExp('^workload_' + provider + '_[a-f0-9]{64}$')),
    name: z.literal(workloadLabel(provider))}).strict();
  return z.object({schemaVersion: z.literal(1), organizationId: workloadOrganizationSchema(provider), tenantId: workloadScope,
    approvedBy: workloadScope, approvedAt: z.string().datetime(), revokedAt: z.string().datetime().nullable(),
    installations: z.array(installation).max(100)}).strict();
}
export type WorkloadConnection = z.infer<ReturnType<typeof workloadConnectionSchema>>;
export const replicasClaimSchema = z.object({organizationId: workloadOrganization, environmentId: workloadOrganization, workspaceId: workloadOrganization}).strict();
export const devinClaimSchema = z.object({organizationId: devinOrganization, sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)}).strict();
const challenge = {schemaVersion: z.literal(1), tenantId: workloadScope, userId: workloadScope, issuedAt: z.number().int(), expiresAt: z.number().int()};
export const replicasChallengeSchema = z.object({...challenge, claim: replicasClaimSchema.nullable()}).strict();
export const devinChallengeSchema = z.object({...challenge, claim: devinClaimSchema.nullable()}).strict();
export type ReplicasChallenge = z.infer<typeof replicasChallengeSchema>;
export type DevinChallenge = z.infer<typeof devinChallengeSchema>;
export type WorkloadChallenge = ReplicasChallenge | DevinChallenge;
