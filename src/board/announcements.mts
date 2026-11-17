import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {ApplicationState} from '../state/types.mjs';
import {announcementChannel, systemIdentity, visibleMessage} from './channels.mjs';

const inputSchema = z.strictObject({id: z.string().trim().min(1).max(80), text: z.string().trim().min(1)});
const fail = (message: string, status: number) => Object.assign(new Error(message), {status});

/** Internal application capability. Construct from trusted server scope and state,
 * never from client request fields or an ordinary user/admin/session principal.
 * Keep this object out of client HTTP/MCP services. The application owns its
 * database access; no additional announcement credential or client role grants it.
 */
export function createBoardAnnouncementWriter({state, tenantId, now = Date.now}: {
  state: Pick<ApplicationState,'board'>; tenantId: string; now?: () => number;
}) {
  if (!state?.board || typeof tenantId !== 'string' || !tenantId.trim()) throw fail('Explicit application state and system writer scope required', 503);
  const scope = createHash('sha256').update(tenantId).digest('hex');
  return Object.freeze({
    async publish(input: unknown) {
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
