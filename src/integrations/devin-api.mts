import {z} from 'zod';
import type {DevinFetch} from './devin-events-client.mjs';
import {devinOrganization} from '../identity/devin-schema.mjs';
import {authorizedDevinFetch, DevinRateLimitError} from './devin-events-client.mjs';
import type {SessionEvent} from '../sessions/types.mjs';
import {maskPatterns} from '../sessions/credential-patterns.mjs';

const cursor = z.string().min(1).max(4096);
const timestamp = z.number().int().nonnegative().refine(value => Number.isFinite(new Date(value * 1000).getTime()));
const sessionId = z.string().regex(/^(?:devin-)?[a-f0-9]{32}$/).transform(value =>
  value.startsWith('devin-') ? value : 'devin-' + value);
const message = z.object({
  event_id: z.string().regex(/^event-[A-Za-z0-9_-]{1,160}$/),
  source: z.enum(['user', 'devin']),
  message: z.string(),
  created_at: timestamp,
});
const session = z.object({
  session_id: sessionId,
  org_id: devinOrganization.nullable(),
  created_at: timestamp,
  updated_at: timestamp,
  status: z.string().min(1),
});

function pageOf<T>(item: z.ZodType<T>) {
  return z.object({
    items: z.array(item).max(200),
    has_next_page: z.boolean(),
    end_cursor: cursor.nullish(),
  }).refine(page => !page.has_next_page || !!page.end_cursor);
}
const sessionsPage = pageOf(session);
const messagesPage = pageOf(message);

export type DevinSession = z.infer<typeof session>;
export type DevinMessage = z.infer<typeof message>;

export class DevinReadError extends Error {
  constructor(readonly status: number) {
    super('Devin returned HTTP ' + status + ' while reading session data.');
  }
}

/** Read with the organization obtained from Devin's verified service-user identity. */
export function devinSessionApi(key: string, organizationId: string, fetcher: DevinFetch = fetch) {
  const root = 'https://api.devin.ai/v3/organizations/' + devinOrganization.parse(organizationId) + '/sessions';
  async function read<T>(url: URL, schema: z.ZodType<T>) {
    const request = authorizedDevinFetch(url.href, 8 * 1024 * 1024, key, AbortSignal.timeout(20000), fetcher);
    const response = await request(url, {method:'GET', headers:{accept:'application/json'}});
    if (!response.ok) {
      if (response.status === 429) throw new DevinRateLimitError(response.headers.get('retry-after'));
      throw new DevinReadError(response.status);
    }
    const body: unknown = await response.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new Error('Devin returned an incomplete session page.');
    return parsed.data;
  }
  return {
    async sessions(input: {createdAfter: number; updatedAfter?: number; updatedBefore?: number; after?: string}) {
      const url = new URL(root);
      url.searchParams.set('first', '100');
      url.searchParams.set('created_after', String(timestamp.parse(input.createdAfter)));
      if (input.updatedAfter !== undefined) url.searchParams.set('updated_after', String(timestamp.parse(input.updatedAfter)));
      if (input.updatedBefore !== undefined) url.searchParams.set('updated_before', String(timestamp.parse(input.updatedBefore)));
      if (input.after) url.searchParams.set('after', cursor.parse(input.after));
      const result = await read(url, sessionsPage);
      if (result.items.some(item => item.org_id !== null && item.org_id !== organizationId)) throw new Error('Devin session organization mismatch.');
      // Detached sessions belong to their creator, outside organization consent.
      return {...result,items:result.items.filter(item => item.org_id === organizationId)};
    },
    async messages(id: string, after?: string) {
      const url = new URL(root + '/' + sessionId.parse(id) + '/messages');
      url.searchParams.set('first', '32');
      if (after) url.searchParams.set('after', cursor.parse(after));
      return read(url, messagesPage);
    },
  };
}

export function devinConversationEvent(item: DevinMessage): SessionEvent {
  return {
    id: 'devin-event:' + item.event_id,
    nativeId: item.event_id,
    kind: 'message',
    timestamp: new Date(item.created_at * 1000).toISOString(),
    data: {role:item.source === 'devin' ? 'assistant' : 'user', content:[{type:'text', text:maskPatterns(item.message)}]},
  };
}
