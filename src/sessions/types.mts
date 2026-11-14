import type {IncomingMessage, ServerResponse} from 'node:http';

export interface Principal {
  tenantId: string;
  userId: string;
  name?: string | null;
  email?: string | null;
  captureAccess?: string;
  /** Authenticated installation ownership; message authors remain independent. */
  owner?: {kind: 'shared'; provider: 'replicas'; organizationId: string; environmentId: string; workspaceId: string};
}
export type TenantPrincipal = Pick<Principal, 'tenantId' | 'captureAccess'>;
export type Authenticate = (request: IncomingMessage) => Promise<Principal | null>;
export type HttpHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;
export type JsonValue = null | boolean | number | string | JsonValue[] | {[key: string]: JsonValue};
export type JsonObject = {[key: string]: JsonValue};
export interface ServiceError extends Error {status?: number; httpStatus?: number; code?: string; type?: string; permanent?: boolean; writeOutcome?: string}
export function serviceError(value: unknown): ServiceError {return value instanceof Error ? value : Object.assign(new Error(String(value)), typeof value === 'object' && value !== null ? value : {});}
export function parseJson<T>(value: string | Uint8Array): T {return JSON.parse(typeof value === 'string' ? value : Buffer.from(value).toString('utf8')) as T;}
export type StoreVersion = string | number;
export interface ReadOptions {maxBytes?: number}
export interface ListOptions {delimiter?: string; continuationToken?: string | null; maxKeys?: number}
export interface StorePage {keys: string[]; prefixes?: string[]; nextToken: string | null}
export interface ConditionalStore {
  readVersion(key: string, options?: ReadOptions): Promise<{version: StoreVersion | null; data: Buffer | null}>;
  compareAndSet(key: string, version: StoreVersion | null, data: Uint8Array): Promise<boolean>;
}
export interface ObjectStore extends ConditionalStore {
  bucket?: string;
  put(key: string, bytes: Uint8Array, contentType?: string): Promise<void>;
  get(key: string, options?: ReadOptions): Promise<Buffer | null>;
  has?(key: string, options?: ReadOptions): Promise<boolean>;
  delete?(key: string): Promise<void>;
  /** Permanently remove every version, including hidden versions/delete markers.
   * Must verify absence and fail closed when version inventory is unavailable. */
  purgePrefix?(prefix: string, options?: {select?: (key: string) => boolean; selectVersion?: (key: string, read: () => Promise<Buffer>) => Promise<boolean>; beforeDelete?: (key: string, read: () => Promise<Buffer>) => Promise<void>}): Promise<number>;
  listPage(prefix: string, options?: ListOptions): Promise<StorePage>;
}
/** Capture clients with their own session namespace. Memory snapshots are
 * narrower: only harnesses that keep native memory files (see memories/). */
export const SESSION_HARNESSES = ['claude-code', 'codex', 'cursor', 'grok-bot'] as const;
export type SessionHarness = typeof SESSION_HARNESSES[number];
export const isSessionHarness = (value: unknown): value is SessionHarness => (SESSION_HARNESSES as readonly unknown[]).includes(value);
export interface Attachment {type?: string; status?: string; sha256?: string; size?: number; mimeType?: string; path?: string; objectKey?: string | null}
export interface EventData {[key: string]: unknown; role?: string | null; call_id?: string | null; tool_use_id?: string | null}
export interface SessionEvent {
  id: string; kind: string; data?: EventData; timestamp?: string | null; sequence?: number;
  nativeId?: string | null; parentId?: string | null; turnId?: string | null;
  actor?: unknown;
}
export interface SessionBatch {
  schemaVersion: number; installationId: string; sessionId: string; harness: string; origin: string;
  owner: Principal; events: SessionEvent[]; attachments: Attachment[]; captureMode?: string;
  host?: string | null; receivedAt?: string; title?: string;
  actorProfiles?: Record<string,unknown>;
}
export interface SessionIdentity {
  prefix: string; principal: Principal; harness: string; installationId: string; sessionId: string;
}
export interface EventIdentityStore {
  reserve(options: SessionIdentity & {store: ObjectStore; events: SessionEvent[]}): Promise<{reservedEvents: number}>;
  purgeSession(options: Pick<SessionIdentity,'prefix'|'principal'|'harness'|'sessionId'>): Promise<void>;
}
export interface EventReservationOptions extends SessionIdentity {store: ObjectStore; events: SessionEvent[]; eventIdentities?: EventIdentityStore; initialize?: boolean}
export interface SourceOptions {
  store: ObjectStore; prefix: string; principal?: Principal;
  resolvePrincipal?: (input: {key: string; batch: SessionBatch}) => Promise<Principal>;
  initialize?: boolean;
  eventIdentities?: EventIdentityStore;
}
export interface AwsCredentials {accessKeyId: string; secretAccessKey: string; sessionToken?: string; expiration?: number}
export type CredentialProvider = () => Promise<AwsCredentials>;
