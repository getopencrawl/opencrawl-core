import type {IncomingMessage} from 'node:http';
/** A small JSON request body (an API key at most); anything else is empty. */
export async function smallJson(req: IncomingMessage, limit = 4096): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    if ((size += chunk.length) > limit) throw Object.assign(new Error('That request was too large.'), {status: 400, expose: true});
    chunks.push(chunk);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}
