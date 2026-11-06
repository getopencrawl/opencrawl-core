import {Worker} from 'node:worker_threads';
import {createHash} from 'node:crypto';

const MAX_BYTES = 20 * 1024 * 1024;
/** Extract API/document text layers only. Never fetch links, execute document code,
 * or OCR images. Parsing runs in a disposable thread with a bounded lifetime. */
export async function extractDocumentText(bytes, {mediaType, signal, timeoutMs = 60000} = {}) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_BYTES) throw new Error('Invalid document byte length');
  if (typeof mediaType !== 'string' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('Invalid document extraction options');
  signal?.throwIfAborted();
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
  const data = Uint8Array.from(bytes);
  const worker = new Worker(new URL('./document-text-worker.mjs', import.meta.url), {
    workerData: {bytes: data, mediaType: mediaType.split(';')[0].trim().toLowerCase()}, transferList: [data.buffer],
    resourceLimits: {maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32}, env: {},
    // Parser diagnostics can contain document text. Return only the explicit result.
    stdout: true, stderr: true,
  });
  worker.stdout.resume(); worker.stderr.resume();
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Document extraction timed out')), timeoutMs);
      const abort = () => reject(signal.reason || new Error('Document extraction aborted'));
      signal?.addEventListener('abort', abort, {once: true});
      if (signal?.aborted) abort();
      const cleanup = () => {clearTimeout(timer); signal?.removeEventListener('abort', abort);};
      worker.once('message', message => {cleanup(); message.error ? reject(new Error(message.error)) : resolve(message);});
      worker.once('error', () => {cleanup(); reject(new Error('Document parser failed'));});
      worker.once('exit', code => {cleanup(); reject(new Error('Document parser exited without a result'));});
    });
    return {sourceSha256, sourceBytes: bytes.byteLength, extractor: 'document-text-v1', ...result};
  } finally {await worker.terminate();}
}
