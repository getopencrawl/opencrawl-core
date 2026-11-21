import {z} from 'zod';
import {sessionScope} from '../sessions/event-identity.mjs';
import type {Principal} from '../sessions/types.mjs';
import {SETUP_CLIENTS,SETUP_PLUGIN_STATES} from './types.mjs';

/** Private durable evidence. Never return this record from a public status API. */
const identifier=z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const text=z.string().min(1);
const date=text.refine(value=>Number.isFinite(Date.parse(value)));
const proof=z.strictObject({state:z.enum(['not_selected','pending','waiting_capture','waiting_index','verified','expired']),
  id:z.string().regex(/^[a-f0-9]{32}$/).optional(),marker:text.optional(),issuedAt:date.optional(),expiresAt:date.optional(),verifiedAt:date.optional(),
  sessionId:text.optional(),eventId:text.optional(),passageId:text.optional()});
const evidence=z.strictObject({proof,
  capture:z.strictObject({sessionId:text,eventId:text,timestamp:date,observedAt:date}).optional(),
  mcpCall:z.strictObject({receipt:text,issuedAt:date}).optional(),
  nativeCalls:z.array(z.strictObject({callId:text,sessionId:text})).max(8).optional(),
  nativeResults:z.array(z.strictObject({callId:text,sessionId:text,eventId:text,observedAt:date})).max(8).optional(),
  mcpNative:z.strictObject({sessionId:text,eventId:text,observedAt:date}).optional()});
const client=z.strictObject({client:z.enum(SETUP_CLIENTS),installed:z.boolean(),pluginState:z.enum(SETUP_PLUGIN_STATES).optional(),forward:z.boolean(),history:z.enum(['skip','import']),
  historyProgress:z.strictObject({state:z.enum(['not_started','running','complete','failed']),completed:z.number().int().nonnegative(),total:z.number().int().nonnegative().optional(),error:z.string().max(240).optional()}),
  hookTrust:z.enum(['unknown','pending','trusted','not_required']),forwardSince:date.optional(),captureObservedAt:date.optional(),lastSeenAt:date.optional(),evidence:evidence.optional()});
const installation=z.strictObject({installationId:identifier,machine:z.strictObject({id:identifier,label:z.string().min(1).max(100)}),updatedAt:date,
  clients:z.array(client).max(SETUP_CLIENTS.length).refine(values=>new Set(values.map(value=>value.client)).size===values.length,'Duplicate setup clients')});
export const setupStateSchema=z.strictObject({schemaVersion:z.literal(1),scope:z.strictObject({tenantId:identifier,userId:identifier}),pluginStateSupported:z.literal(true).optional(),
  firstWin:z.strictObject({installationId:identifier,client:z.enum(SETUP_CLIENTS),verifiedAt:date}).nullable(),
  installations:z.array(installation).max(32).refine(values=>new Set(values.map(value=>value.installationId)).size===values.length,'Duplicate setup installations')});
export type SetupStateRecord=z.infer<typeof setupStateSchema>;
export type SetupEvidence=z.infer<typeof evidence>;
export type SetupStoredClient=z.infer<typeof client>;
export type SetupScope=Pick<Principal,'tenantId'|'userId'>;
export const MAX_SETUP_STATE_BYTES=256*1024;
export function validateSetupState(input:unknown,scope?:SetupScope):SetupStateRecord {
  if(Buffer.byteLength(JSON.stringify(input),'utf8')>MAX_SETUP_STATE_BYTES)throw Object.assign(new Error('Setup status limit reached. Remove unused local observations before adding more.'),{status:409,expose:true});
  const value=setupStateSchema.parse(input);sessionScope(value.scope);
  if(scope){sessionScope(scope);if(value.scope.tenantId!==scope.tenantId||value.scope.userId!==scope.userId)throw new Error('Invalid setup storage scope');}
  return value;
}
