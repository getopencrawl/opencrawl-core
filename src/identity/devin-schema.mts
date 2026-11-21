import {z} from 'zod';

// Devin signs native org-<32 hex> IDs and also documents UUID organization IDs.
export const devinOrganization = z.string().regex(/^(?:org-[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/);
export const scope = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const installation = z.object({id: scope, tenantId: scope, userId: z.string().regex(/^workload_devin_[a-f0-9]{64}$/), name: z.literal('Devin Cloud')}).strict();
export const connectionSchema = z.object({schemaVersion: z.literal(1), organizationId: devinOrganization, tenantId: scope,
  approvedBy: scope, approvedAt: z.string().datetime(), revokedAt: z.string().datetime().nullable(), installations: z.array(installation).max(100)}).strict();
export type DevinConnection = z.infer<typeof connectionSchema>;
export const claimSchema = z.object({organizationId: devinOrganization, sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)}).strict();
export const challengeSchema = z.object({schemaVersion: z.literal(1), tenantId: scope, userId: scope,
  issuedAt: z.number().int(), expiresAt: z.number().int(), claim: claimSchema.nullable()}).strict();
export type DevinChallenge = z.infer<typeof challengeSchema>;
