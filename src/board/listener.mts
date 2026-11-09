import type {ConditionalStore, Principal, StoreVersion} from '../sessions/types.mjs';
import {parseJson} from '../sessions/types.mjs';
import {createHash, randomBytes} from 'node:crypto';
import {z} from 'zod';

/**
 * Single-use listener tickets and the session-bound listener tokens they redeem for.
 *
 * A signed-in agent (normally through MCP, whose OAuth grant never enters the
 * agent's container) asks for a ticket for one board session. The ticket lives
 * for a minute and redeems once. The resulting token can only run board
 * participation for that same tenant, user and session: never search, fetch,
 * board reads beyond its own deliveries, credential management, or another
 * session. Leaking either is therefore bounded by access the issuing agent
 * already had. Only hashes are stored.
 */
export const listenerTicketSchema = z.strictObject({
  session: z.string().trim().min(1).max(200).describe('This agent session’s stable ID, the same one passed to board register.'),
});
export const isListenerTicket = (value: unknown): value is string => typeof value === 'string' && /^oclt1_[a-f0-9]{64}$/.test(value);
export const isListenerToken = (value: unknown): value is string => typeof value === 'string' && /^ocl1_[a-f0-9]{64}$/.test(value);
export const ticketTtlMs = 60_000, tokenTtlMs = 12 * 3600_000;

interface Grant {schemaVersion: 1; kind: 'ticket' | 'token'; principal: Principal & {boardSession: string}; expiresAt: number; redeemedAt?: number; revokedAt?: number}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const fail = (message: string, status: number) => Object.assign(new Error(message), {status});

export function createBoardListeners({store, prefix, now = Date.now}: {store: ConditionalStore; prefix: string; now?: () => number}) {
  if (!store?.readVersion || !store?.compareAndSet || !prefix || /(^|\/)\.\.(\/|$)/.test(prefix)) throw new Error('Board listeners require a conditional store and prefix');
  const key = (kind: Grant['kind'], secret: string) => `${prefix}/_listeners/${kind}s/${digest(secret)}.json`;
  async function load(kind: Grant['kind'], secret: string): Promise<{version: StoreVersion | null; grant: Grant | null}> {
    const {version, data} = await store.readVersion(key(kind, secret), {maxBytes: 4096});
    if (!data) return {version, grant: null};
    const grant = parseJson<Grant>(data);
    return {version, grant: grant.schemaVersion === 1 && grant.kind === kind ? grant : null};
  }
  const save = (kind: Grant['kind'], secret: string, version: StoreVersion | null, grant: Grant) =>
    store.compareAndSet(key(kind, secret), version, Buffer.from(JSON.stringify(grant)));
  const live = (grant: Grant | null): grant is Grant => Boolean(grant && !grant.revokedAt && Number.isFinite(grant.expiresAt) && grant.expiresAt > now());

  return {
    /** Requires a full interactive principal; delegated credentials cannot mint further access. */
    async issue(principal: Principal, input: unknown) {
      const {session} = listenerTicketSchema.parse(input);
      if (!principal?.tenantId || !principal?.userId || principal.captureAccess !== undefined || principal.boardSession !== undefined) throw fail('Listener tickets require a signed-in workspace member', 403);
      const ticket = 'oclt1_' + randomBytes(32).toString('hex'), expiresAt = now() + ticketTtlMs;
      const owner = {tenantId: principal.tenantId, userId: principal.userId, name: principal.name ?? null, email: principal.email ?? null, boardSession: session};
      if (!await save('ticket', ticket, null, {schemaVersion: 1, kind: 'ticket', principal: owner, expiresAt})) throw fail('Ticket collision; retry', 503);
      return {ticket, session, expiresAt: new Date(expiresAt).toISOString()};
    },
    /** Single use: concurrent redemptions race on one conditional write and only one wins. */
    async redeem(ticket: unknown, session?: unknown) {
      if (!isListenerTicket(ticket)) throw fail('Invalid listener ticket', 401);
      const {version, grant} = await load('ticket', ticket);
      if (!live(grant) || grant.redeemedAt) throw fail('Listener ticket expired or already used; request a new one', 401);
      // A mismatched session is refused without consuming the ticket.
      if (session !== undefined && session !== grant.principal.boardSession) throw fail('This ticket was issued for another session', 403);
      if (!await save('ticket', ticket, version, {...grant, redeemedAt: now()})) throw fail('Listener ticket expired or already used; request a new one', 401);
      const token = 'ocl1_' + randomBytes(32).toString('hex'), expiresAt = now() + tokenTtlMs;
      if (!await save('token', token, null, {schemaVersion: 1, kind: 'token', principal: grant.principal, expiresAt})) throw fail('Token collision; retry', 503);
      return {token, principal: grant.principal, session: grant.principal.boardSession, expiresAt: new Date(expiresAt).toISOString()};
    },
    async authenticate(token: unknown): Promise<(Principal & {boardSession: string}) | null> {
      if (!isListenerToken(token)) return null;
      const {grant} = await load('token', token);
      return live(grant) ? {...grant.principal} : null;
    },
    async revoke(token: unknown) {
      if (!isListenerToken(token)) return;
      for (let attempt = 0; attempt < 4; attempt++) {
        const {version, grant} = await load('token', token);
        if (!grant || grant.revokedAt) return;
        if (await save('token', token, version, {...grant, revokedAt: now()})) return;
      }
    },
  };
}
export type BoardListeners = ReturnType<typeof createBoardListeners>;
