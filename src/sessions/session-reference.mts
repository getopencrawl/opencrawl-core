export interface SessionKey {userId:string;harness:string;sessionId:string}
/** Presence from an older client may identify a chat without its installation or harness. */
export type SessionReference = [tenant: string, owner: string, harness: string | null, installation: string | null, session: string];
const validPart = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);

export function encodeSessionReference(parts: SessionReference) {
  return 'session:' + Buffer.from(JSON.stringify(parts)).toString('base64url');
}

export function parseSessionReference(id: string, allowIncomplete = false): SessionReference {
  if (id.startsWith('session:')) {
    try {
      const parts = JSON.parse(Buffer.from(id.slice(8), 'base64url').toString('utf8'));
      if (Array.isArray(parts) && parts.length === 5 && parts.every((part, i) =>
        validPart(part) || (allowIncomplete && part === null && (i === 2 || i === 3)))) {
        const tuple = parts as SessionReference;
        if (encodeSessionReference(tuple) === id) return tuple;
      }
    } catch { /* Invalid references have the same public error. */ }
  }
  throw Object.assign(new Error('Invalid session reference.'), {status: 400});
}
