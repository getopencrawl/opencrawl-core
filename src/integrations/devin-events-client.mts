import {Client, StreamableHTTPClientTransport, type FetchLike} from '@modelcontextprotocol/client';
import type {DevinEventRequest} from './devin-first-turn.mjs';
import {fail} from '../errors.mjs';

const endpoint = 'https://mcp.devin.ai/mcp';
const maxResponseBytes = 2 * 1024 * 1024;

/** Open on the first admitted request, and close even if permission changes
 * while a page is in flight. Service credentials never leave the provider origin. */
export async function withDevinEventClient<T>(key: string, operation: (read: (request: DevinEventRequest) => Promise<string>) => Promise<T>,
  fetcher: FetchLike = fetch): Promise<T> {
  if (!/^cog_[a-zA-Z0-9_-]{1,1024}$/.test(key)) fail(400, 'Invalid Devin service credential');
  const client = new Client({name:'opencrawl-devin-first-turn',version:'1'});
  const deadline = AbortSignal.timeout(30000);
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    onInsufficientScope:'throw',
    fetch: async (input, init) => {
      if (String(input instanceof Request ? input.url : input) !== endpoint) throw new Error('Invalid Devin destination');
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
          if (bytes > maxResponseBytes) throw new Error('Devin response exceeded the byte limit');
          controller.enqueue(chunk);
        }
      }));
      return new Response(bounded,{status:response.status, headers:response.headers});
    }
  });
  let connected: Promise<void> | undefined;
  try {
    return await operation(async request => {
      try {
        connected ??= client.connect(transport);
        await connected;
        const result = await client.callTool({name:'devin_session_events',arguments:request});
        const [block] = result.content;
        if (result.isError || result.content.length !== 1 || block?.type !== 'text') throw new Error('Invalid event response');
        return block.text;
      } catch {
        return fail(502, 'The Devin session event service is unavailable for this session');
      }
    });
  } finally {
    await client.close();
  }
}
