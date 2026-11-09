import type {IncomingMessage, ServerResponse} from 'node:http';
import type {Principal} from '../sessions/types.mjs';
import type {Sources} from './service.mjs';

// Same paths as hosted OpenCrawl, so the shared web console adapter works against either.
const ACTION = /^\/api\/integrations\/([a-z_]+)\/(connect|retry|disconnect)$/;
const CALLBACK = /^\/integrations\/([a-z_]+)\/callback$/;
const MESSAGES: Record<string, string> = {
  connected: 'Connected. The first import starts within a minute; you can close this window.',
  done: 'This connection was already completed. You can close this window.',
  declined: 'Sign-in was cancelled or not approved. Close this window and connect again.',
  taken: 'This source is already connected for this deployment.',
  account: 'Signed in, but OpenCrawl couldn’t read the account. Disconnect and try again.',
  invalid: 'This sign-in link is not valid. Close this window and connect again.',
};

async function json(req: IncomingMessage, limit = 16384) {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request too large'), {status: 413, expose: true});
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; }
  catch { throw Object.assign(new Error('Invalid JSON'), {status: 400, expose: true}); }
}

/** Returns false for paths it does not own. API routes require the operator's bearer token. */
export function createSourcesHandler({sources, authenticate, log = () => {}}: {sources: Sources; authenticate: (req: IncomingMessage) => Promise<Principal | null>; log?: (event: string, data: Record<string, unknown>) => void}) {
  const send = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'});
    res.end(JSON.stringify(value));
  };
  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url || '/', 'http://local');
    const callback = CALLBACK.exec(url.pathname);
    const action = ACTION.exec(url.pathname);
    const owned = callback || action || ['/api/integrations', '/api/integrations/composio', '/api/onboarding/sources'].includes(url.pathname);
    if (!owned) return false;
    try {
      if (callback) {
        // The browser returns here from Composio; the one-time state authorizes it.
        if (req.method !== 'GET') return send(res, 405, {error: 'Method not allowed'}), true;
        const result = await sources.complete(callback[1], url.searchParams);
        log('sources.callback', {provider: callback[1], ok: result.ok, reason: result.reason});
        res.writeHead(result.ok ? 200 : 400, {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer'});
        res.end(MESSAGES[result.reason] || MESSAGES.invalid);
        return true;
      }
      if (!await authenticate(req)) return send(res, 401, {error: 'Unauthorized'}), true;
      if (url.pathname === '/api/onboarding/sources' && req.method === 'GET') {
        return send(res, 200, {items: sources.list().items.map(({id, name, state, auth, keyHelp}) => ({id, name, state, auth, keyHelp}))}), true;
      }
      if (url.pathname === '/api/integrations' && req.method === 'GET') return send(res, 200, sources.list()), true;
      if (url.pathname === '/api/integrations/composio' && req.method === 'PUT') return send(res, 200, await sources.setComposioKey((await json(req)).apiKey)), true;
      if (action && req.method === 'POST') {
        const [, provider, verb] = action;
        const body = await json(req);
        const result = verb === 'connect' ? await sources.connect(provider, {apiKey: body.apiKey}) : verb === 'retry' ? sources.retry(provider) : await sources.disconnect(provider);
        return send(res, 200, result), true;
      }
      return send(res, 405, {error: 'Method not allowed'}), true;
    } catch (error) {
      const {status = 503, expose = false, message} = error as Error & {status?: number; expose?: boolean};
      log('sources.error', {path: url.pathname, status, message: String(message).slice(0, 300)});
      send(res, expose ? status : status === 404 ? 404 : 503, {error: expose ? message : 'The source request failed. Check the server logs.'});
      return true;
    }
  };
}
