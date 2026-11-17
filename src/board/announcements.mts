import {createHash, timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import type {ApplicationState} from '../state/types.mjs';
import {announcementChannel, systemIdentity, visibleMessage} from './channels.mjs';

const inputSchema = z.strictObject({id: z.string().trim().min(1).max(80), text: z.string().trim().min(1)});
const fail = (message: string, status: number) => Object.assign(new Error(message), {status});

/** Privileged, tenant-bound capability. Never attach this object to client HTTP/MCP services.
 * The operator supplies a separate high-entropy bearer credential's SHA-256 digest.
 * Ordinary user/admin/session principals, names and request fields cannot grant it.
 * Construct per invocation (or replace on rotation) from protected operator configuration.
 */
export function createBoardAnnouncementWriter({state, tenantId, credentialSha256, now = Date.now}: {
  state: ApplicationState; tenantId: string; credentialSha256: string; now?: () => number;
}) {
  if (!state?.board || !tenantId?.trim() || !/^[a-f0-9]{64}$/.test(credentialSha256)) throw fail('Explicit system writer scope and credential digest required', 503);
  const scope = createHash('sha256').update(tenantId).digest('hex'), digest = Buffer.from(credentialSha256, 'hex');
  return Object.freeze({
    async publish(credential: string, input: unknown) {
      if (typeof credential !== 'string' || credential.length < 43 || credential.length > 1024 || !timingSafeEqual(digest, createHash('sha256').update(credential).digest())) throw fail('System writer credential required', 403);
      const args = inputSchema.parse(input);
      return state.board.transaction(scope, async tx => {
        const duplicate = await tx.publication({userId: systemIdentity.author, agent: systemIdentity.agent, name: systemIdentity.name, requestId: args.id, registered: false});
        if (duplicate) {
          if (!duplicate.system || duplicate.topic !== announcementChannel || duplicate.threadId !== undefined || duplicate.text !== args.text) throw fail('Retry id already used for different content', 409);
          return visibleMessage(duplicate);
        }
        return visibleMessage(await tx.append({...systemIdentity, timestamp: now(), topic: announcementChannel, text: args.text, requestId: args.id, system: true}));
      });
    },
  });
}
