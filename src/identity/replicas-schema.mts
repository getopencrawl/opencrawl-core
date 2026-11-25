import {z} from 'zod';

export const uuid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
export const scope = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const installation = z.object({id: scope, tenantId: scope, userId: z.string().regex(/^workload_replicas_[a-f0-9]{64}$/), name: z.literal('Replicas')}).strict();
export const connectionSchema = z.object({schemaVersion: z.literal(1), organizationId: uuid, tenantId: scope,
  approvedBy: scope, approvedAt: z.string().datetime(), revokedAt: z.string().datetime().nullable(), installations: z.array(installation).max(100)}).strict();
export type ReplicasConnection = z.infer<typeof connectionSchema>;
export const challengeSchema = z.object({schemaVersion: z.literal(1), tenantId: scope, userId: scope, issuedAt: z.number().int(), expiresAt: z.number().int(),
  claim: z.object({organizationId: uuid, environmentId: uuid, workspaceId: uuid}).strict().nullable()}).strict();
export type ReplicasChallenge = z.infer<typeof challengeSchema>;
