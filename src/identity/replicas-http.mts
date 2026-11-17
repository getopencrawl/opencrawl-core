import type {IncomingMessage, ServerResponse} from 'node:http';
import type {createReplicasConnections} from './replicas-connections.mjs';
import {errorInfo} from '../errors.mjs';

/** Enrollment is authenticated by both the admin's one-time setup capability and
 * a freshly verified Replicas JWT. No tenant or organization is accepted in JSON. */
export function replicasConnectionHandler(connections: ReturnType<typeof createReplicasConnections>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const json = (status: number, value: unknown) => {res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(value));};
    if (req.method !== 'POST') return json(405, {error: 'Use POST.'});
    if (req.headers.origin || (req.url ?? '').includes('?')) return json(403, {error: 'Use the setup prompt inside Replicas.'});
    const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!token) return json(401, {error: 'Replicas workspace identity required.'});
    try {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of req) {length += chunk.length; if (length > 4096) return json(413, {error: 'Setup request too large.'}); chunks.push(Buffer.from(chunk));}
      let body: unknown;
      try {body = JSON.parse(Buffer.concat(chunks).toString());} catch {return json(400, {error: 'Invalid setup request.'});}
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !('code' in body) || typeof body.code !== 'string') return json(400, {error: 'A setup code is required.'});
      return json(200, await connections.claim(body.code, token));
    } catch (error) {
      const info = errorInfo(error);
      return json(info.expose && [400,401,403,409,503].includes(info.status ?? 0) ? info.status! : 503,
        {error: info.expose ? info.message : 'Replicas setup is temporarily unavailable. Retry the same prompt.'});
    }
  };
}
