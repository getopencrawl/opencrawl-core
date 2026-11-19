/** Store a directory prefix with one trailing slash. The empty prefix is the bucket root. */
export function normalizeS3Prefix(value = ''): string {
  if (!value) return '';
  const path = value.endsWith('/') ? value.slice(0, -1) : value;
  if (path.split('/').some(part => !part || part === '.' || part === '..') ||
      /[\\\u0000-\u001f\u007f]/u.test(path) || !path.isWellFormed() || Buffer.byteLength(path) >= 1024) {
    throw new Error('Enter a bucket prefix such as teams/engineering, with a name between each slash.');
  }
  return path + '/';
}

export const xmlText = (s:string) => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const entities: Record<string,string> = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
export function unescapeXml(s:string) {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, (_, entity:string) =>
    entities[entity] ?? String.fromCodePoint(entity.startsWith('#x') ? parseInt(entity.slice(2),16) : Number(entity.slice(1))));
}

// Only S3 metadata envelopes carry key names. Object contents and opaque pagination tokens pass through.
export async function relativeS3Metadata(response:Response, root:string, encoded:boolean) {
  const chunks:Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body!) {
    length += chunk.length;
    if (length > 4 * 1024 * 1024) throw new Error('Unexpected S3 metadata size');
    chunks.push(chunk);
  }
  const xml = Buffer.concat(chunks).toString().replace(/<(Key|Prefix|Marker|NextMarker|KeyMarker|NextKeyMarker|StartAfter)>([^<]+)<\/\1>/g,
    (_, tag:string, text:string) => {
      const key = encoded ? decodeURIComponent(unescapeXml(text).replaceAll('+',' ')) : unescapeXml(text);
      if (!key.startsWith(root)) throw new Error('Unexpected S3 key outside the configured prefix');
      const relative = key.slice(root.length);
      return '<'+tag+'>'+xmlText(encoded ? encodeURIComponent(relative) : relative)+'</'+tag+'>';
    });
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(xml, {status:response.status, headers});
}
