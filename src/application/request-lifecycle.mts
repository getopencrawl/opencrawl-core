import type {IncomingMessage, ServerResponse} from 'node:http';
import type {Log} from '../integrations/ports.mjs';
type DrainResult = {status: string; reason: string};
export interface ShutdownReport extends DrainResult {protocol: number; phase: string; activeHandlers: number; acceptedHandlers: number; completedHandlers: number; rejectedHandlers: number; elapsedMs: number; exitCode: number}
interface LifecycleOptions {analytics?: {close(): Promise<void>} | null; log?: Log; drainTimeoutMs?: number; exit?: (code: number) => unknown}
import {createServer} from 'node:http';

/** Track application work, not sockets: an aborted client can leave a write pending. */
export function createDrainableServer(handler: (req: IncomingMessage, res: ServerResponse) => unknown, {analytics, log = () => {}, drainTimeoutMs = 15000, exit = code => process.exit(code)}: LifecycleOptions = {}) {
  if (typeof handler !== 'function' || !Number.isInteger(drainTimeoutMs) || drainTimeoutMs < 1 || drainTimeoutMs > 15000) throw new Error('Invalid request lifecycle configuration');
  const active = new Set<Promise<unknown>>();
  let stopping = false, accepted = 0, completed = 0, rejected = 0;
  let shutdownPromise: Promise<ShutdownReport> | undefined;
  const unavailable = (res: ServerResponse) => {
    if (res.destroyed || res.writableEnded) return;
    if (!res.headersSent) res.writeHead(503, {'Content-Type':'text/plain', 'Connection':'close', 'Cache-Control':'no-store'});
    res.end('Service temporarily unavailable');
  };
  const server = createServer((req, res) => {
    if (stopping) return unavailable(res);
    accepted++;
    const task = Promise.resolve().then(() => handler(req, res)).catch(() => {
      rejected++; unavailable(res);
    }).finally(() => { completed++; active.delete(task); });
    active.add(task);
  });

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    shutdownPromise = (async () => {
      const started = performance.now();
      let deadline: NodeJS.Timeout | undefined;
      let expired = false, phase = 'handlers';
      const transportClosed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      const drain = (async () => {
        // Closing the HTTP listener prevents new ingress. The promise snapshot
        // includes handlers whose clients disconnected before the signal.
        await Promise.all([transportClosed, Promise.allSettled([...active])]);
        if (expired) return {status:'failed', reason:'deadline'};
        phase = 'analytics';
        await analytics?.close();
        return {status:'drained', reason:'complete'};
      })().catch(() => ({status:'failed', reason:phase + '_failed'}));
      const result = await Promise.race([drain, new Promise<DrainResult>(resolve => {
        deadline = setTimeout(() => { expired = true; resolve({status:'failed', reason:'deadline'}); }, drainTimeoutMs);
      })]);
      clearTimeout(deadline);
      const report = {...result, protocol:1, phase, activeHandlers:active.size, acceptedHandlers:accepted,
        completedHandlers:completed, rejectedHandlers:rejected, elapsedMs:Math.round(performance.now() - started)};
      if (result.status !== 'drained') server.closeAllConnections();
      try { Promise.resolve(log('http.shutdown', report)).catch(() => {}); } catch {}
      const exitCode = result.status === 'drained' ? 0 : 75;
      exit(exitCode);
      return {...report, exitCode};
    })();
    return shutdownPromise;
  }
  return {server, shutdown};
}
