import {Client, StreamableHTTPClientTransport, type FetchLike} from '@modelcontextprotocol/client';
import type {DevinEventRequest} from './devin-first-turn.mjs';
import {fail} from '../errors.mjs';
import {devinOrganization} from '../identity/devin-schema.mjs';
export type {FetchLike as DevinFetch} from '@modelcontextprotocol/client';

const endpoint = 'https://mcp.devin.ai/mcp';
const identityEndpoint = 'https://api.devin.ai/v3/self';
const maxResponseBytes = 2 * 1024 * 1024;

export class DevinRateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(hint: string | null) {
    super('Devin has temporarily rate limited this connection.');
    const delay = hint && /^\d+$/.test(hint) ? Number(hint) * 1000 : Date.parse(hint ?? '') - Date.now();
    this.retryAfterMs = Number.isFinite(delay) && delay > 0 ? delay : 60000;
  }
}

export function authorizedDevinFetch(destination: string, byteLimit: number, key: string, deadline: AbortSignal, fetcher: FetchLike): FetchLike {
  const target = new URL(destination);
  if (target.username || target.password || target.hash ||
      (destination !== endpoint && !(target.origin === 'https://api.devin.ai' && target.pathname.startsWith('/v3/')))) {
    throw new Error('Invalid Devin destination');
  }
  return async (input, init) => {
    if (String(input instanceof Request ? input.url : input) !== destination) throw new Error('Invalid Devin destination');
    const headers = new Headers(init?.headers);
    headers.set('authorization','Bearer ' + key);
    const signal = init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline;
    const response = await fetcher(input,{...init, headers, signal, redirect:'error'});
    // Discard provider error bodies, which may echo inputs or account details.
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return new Response(null,{status:response.status, headers:response.headers});
    }
    let bytes = 0;
    const bounded = response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > byteLimit) throw new Error('Devin response exceeded the byte limit');
        controller.enqueue(chunk);
      }
    }));
    return new Response(bounded,{status:response.status, headers:response.headers});
  };
}

export async function identifyDevinServiceUser(key: string, fetcher: FetchLike = fetch, deadline = AbortSignal.timeout(15000)): Promise<string> {
  if (!/^cog_[a-zA-Z0-9_-]{1,1024}$/.test(key)) fail(400, 'Invalid Devin service credential');
  const response = await authorizedDevinFetch(identityEndpoint, 16384, key, deadline, fetcher)(identityEndpoint, {headers: {accept: 'application/json'}});
  if (response.status === 429) throw new DevinRateLimitError(response.headers.get('retry-after'));
  if (!response.ok) fail(response.status===401||response.status===403?403:502,'Could not verify the Devin service user');
  const identity: unknown = await response.json();
  if (!identity || typeof identity !== 'object' || !('principal_type' in identity) ||
      identity.principal_type !== 'service_user' || !('org_id' in identity)) {
    fail(403,'Use an organization-scoped Devin service user.');
  }
  const organization = devinOrganization.safeParse(identity.org_id);
  if (!organization.success) fail(403,'Use an organization-scoped Devin service user.');
  return organization.data;
}

export async function verifyDevinEventCredential(key: string, organizationId: string, fetcher: FetchLike = fetch, deadline = AbortSignal.timeout(15000)) {
  if (await identifyDevinServiceUser(key, fetcher, deadline) !== organizationId) {
    fail(403,'The Devin service user does not belong to this organization');
  }
}

function devinMcp(key:string,fetcher:FetchLike) {
  const client = new Client({name:'opencrawl-devin-first-turn',version:'1'});
  const deadline = AbortSignal.timeout(30000);
  const send = authorizedDevinFetch(endpoint, maxResponseBytes, key, deadline, fetcher);
  let rateLimit: DevinRateLimitError | undefined;
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    onInsufficientScope:'throw',
    fetch: async (url, init) => {
      const response = await send(url, init);
      if (response.status === 429) rateLimit = new DevinRateLimitError(response.headers.get('retry-after'));
      return response;
    },
  });
  return {client,transport,deadline,rateLimit: () => rateLimit};
}

/** Check that the recording service account can discover the events tool without reading a session. */
export async function verifyDevinRecording(key:string,organizationId:string,fetcher:FetchLike=fetch) {
  const {client,transport,deadline,rateLimit} = devinMcp(key,fetcher);
  try {
    await verifyDevinEventCredential(key,organizationId,fetcher,deadline);
    await client.connect(transport);
    let cursor:string|undefined;
    const seen=new Set<string>();
    do {
      deadline.throwIfAborted();
      const page = await client.listTools(cursor?{cursor}:{});
      if (page.tools.some(tool=>tool.name==='devin_session_events')) return true;
      cursor=page.nextCursor;
      if (cursor) {
        if (seen.has(cursor) || seen.size>=20) fail(502,'Could not verify the Devin tool list');
        seen.add(cursor);
      }
    } while (cursor);
    return false;
  } catch (error) {
    throw rateLimit() ?? error;
  } finally {
    await client.close();
  }
}

/** Open on the first admitted request, and close even if permission changes
 * while a page is in flight. Service credentials never leave the provider origin. */
export async function withDevinEventClient<T>(key: string, organizationId: string,
  operation: (read: (request: DevinEventRequest) => Promise<string>) => Promise<T>,
  fetcher: FetchLike = fetch): Promise<T> {
  if (!/^cog_[a-zA-Z0-9_-]{1,1024}$/.test(key)) fail(400, 'Invalid Devin service credential');
  const {client,transport,deadline,rateLimit} = devinMcp(key,fetcher);
  async function connect() {
    await verifyDevinEventCredential(key, organizationId, fetcher, deadline);
    await client.connect(transport);
  }
  let connected: Promise<void> | undefined;
  try {
    return await operation(async request => {
      try {
        connected ??= connect();
        await connected;
        const result = await client.callTool({name:'devin_session_events',arguments:request});
        const [block] = result.content;
        if (result.isError || result.content.length !== 1 || block?.type !== 'text') throw new Error('Invalid event response');
        return block.text;
      } catch (error) {
        if (error instanceof DevinRateLimitError) throw error;
        const limited = rateLimit();
        if (limited) throw limited;
        return fail(502, 'The Devin session event service is unavailable for this session');
      }
    });
  } finally {
    await client.close();
  }
}
