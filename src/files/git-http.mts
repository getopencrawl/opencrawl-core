import type {IncomingMessage, ServerResponse} from 'node:http';
import {createHash} from 'node:crypto';
import {availableParallelism} from 'node:os';
import {once} from 'node:events';
import {pipeline} from 'node:stream/promises';
import {createGunzip} from 'node:zlib';
import {errorInfo} from '../errors.mjs';
import type {SharedFilesStore} from './store.mjs';
import {failure, gitRpc} from './git.mjs';
import {pushAuthorization} from './push-authorization.mjs';

/** Stock Git invokes a credential helper after a Basic challenge. Translate only
 * this service's fixed username at its own route; membership is still verified. */
export function sharedFilesAuthorization(header?: string): string | undefined {
  if (header?.startsWith('Bearer ')) return header;
  const match = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(header ?? '');
  if (!match || match[1].length > 24000) return undefined;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const token = /^opencrawl:([A-Za-z0-9_.-]{1,16384})$/.exec(decoded)?.[1];
  return token ? 'Bearer ' + token : undefined;
}

export function sharedFilesLimits(env: NodeJS.ProcessEnv) {
  const number = (key: string, fallback: number) => {
    if (env[key] === undefined) return fallback;
    const value = Number(env[key]);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Expected a positive integer for ' + key);
    return value;
  };
  const total = number('OPENCRAWL_FILES_MAX_TRANSFERS', Math.max(12, availableParallelism() * 2));
  return {
    total,
    network: number('OPENCRAWL_FILES_MAX_NETWORK_TRANSFERS', Math.max(4, Math.ceil(total / 2))),
    pushBytes: env.OPENCRAWL_FILES_MAX_PUSH_BYTES ? number('OPENCRAWL_FILES_MAX_PUSH_BYTES', 0) : 0
  };
}
const services = ['git-upload-pack', 'git-receive-pack'] as const;
export function createSharedFilesHandler({
  store,
  limits = sharedFilesLimits(process.env)
}: {
  store: SharedFilesStore;
  limits?: ReturnType<typeof sharedFilesLimits>;
}) {
  const active = new Map<string, number>();
  let running = 0;
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    principal: {tenantId: string; userId: string; captureAccess?: unknown},
    revalidate: () => Promise<void> = async () => {}
  ) => {
    const reply = (status: number, data: string, type = 'text/plain; charset=utf-8') => {
      res
        .writeHead(status, {
          'Content-Type': type,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        })
        .end(data);
    };
    if (
      !principal?.tenantId ||
      !principal.userId ||
      principal.captureAccess !== undefined ||
      req.headers.origin
    )
      return reply(403, 'Network membership required');
    const {tenantId, userId} = principal;
    const digest = createHash('sha256').update(tenantId).digest('hex');
    const remotePath = '/api/files/' + digest + '.git';
    const segment = /^[A-Za-z0-9_-]+$/.test(tenantId) ? tenantId : '~' + digest;
    const clonePath = '/git/' + segment + '/files.git';
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/files') {
      if (req.method !== 'GET') return reply(405, 'Use GET');
      return reply(
        200,
        JSON.stringify({schemaVersion: 1, data: {remotePath, clonePath, tenantId, userId}}),
        'application/json'
      );
    }
    // Both public names address the same authorized network. Existing clones keep their origin.
    const base = url.pathname.startsWith('/git/') ? clonePath : remotePath;
    const advertise = url.pathname === base + '/info/refs';
    const service = services.find((s) =>
      advertise ? url.searchParams.get('service') === s : url.pathname === base + '/' + s
    );
    if (!service) return reply(404, 'Unknown Git endpoint');
    if (req.method !== (advertise ? 'GET' : 'POST')) return reply(405, 'Unsupported Git method');
    if (!advertise && req.headers['content-type'] !== 'application/x-' + service + '-request')
      return reply(415, 'Expected a Git request');
    const encoding = req.headers['content-encoding'];
    if (encoding && encoding !== 'identity' && encoding !== 'gzip')
      return reply(415, 'Unsupported content encoding');
    const count = active.get(tenantId) ?? 0;
    if (running >= limits.total || count >= limits.network) {
      res.setHeader('Retry-After', '1');
      return reply(429, 'Git server busy; retry shortly');
    }
    running++;
    active.set(tenantId, count + 1);
    const lifecycle = new AbortController();
    const disconnect = () => {
      if (!res.writableFinished) lifecycle.abort();
    };
    res.once('close', disconnect);
    try {
      const dir = await store.open(tenantId);
      const push = !advertise && service === 'git-receive-pack';
      const check = async () => {
        lifecycle.signal.throwIfAborted();
        await revalidate();
        lifecycle.signal.throwIfAborted();
      };
      const gate = push ? await pushAuthorization(check) : undefined;
      try {
        await check();
        const env: NodeJS.ProcessEnv = {
          ...gate?.env,
          GIT_COMMITTER_EMAIL: Buffer.from(userId).toString('base64url') + '@opencrawl.invalid'
        };
        const v2 = service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2';
        if (v2) env.GIT_PROTOCOL = 'version=2';
        const args = limits.pushBytes ? ['-c', 'receive.maxInputSize=' + limits.pushBytes] : [];
        args.push(service.slice(4), '--stateless-rpc');
        if (advertise) args.push('--advertise-refs');
        const child = gitRpc(dir, [...args, '.'], env);
        const stop = () => {
          if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
          try {
            if (process.platform === 'win32') child.kill('SIGKILL');
            else process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        };
        const completed = once(child, 'close').then(([code]) => {
          if (code !== 0) throw failure(400, 'Git rejected the transfer');
        });
        // Attach a handler immediately: spawn or input failure can precede the first output chunk.
        void completed.catch(() => {});
        lifecycle.signal.addEventListener('abort', stop, {once: true});
        try {
          const input = advertise
            ? Promise.resolve(child.stdin.end())
            : encoding === 'gzip'
              ? pipeline(req, createGunzip(), child.stdin)
              : pipeline(req, child.stdin);
          void input.catch(stop);
          let started = false;
          const begin = async () => {
            await check();
            res.writeHead(200, {
              'Content-Type': 'application/x-' + service + (advertise ? '-advertisement' : '-result'),
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff'
            });
            if (advertise && !v2) {
              const line = '# service=' + service + '\n';
              res.write((Buffer.byteLength(line) + 4).toString(16).padStart(4, '0') + line + '0000');
            }
            started = true;
          };
          for await (const chunk of child.stdout) {
            if (!started) await begin();
            if (!res.write(chunk)) await once(res, 'drain', {signal: lifecycle.signal});
          }
          await Promise.all([completed, input]);
          if (push) await store.syncAudit(tenantId, dir);
          if (!started) await begin();
          res.end();
        } finally {
          lifecycle.signal.removeEventListener('abort', stop);
          stop();
        }
      } finally {
        gate?.close();
      }
    } catch (error) {
      if (!res.destroyed) {
        if (res.headersSent) res.destroy();
        else {
          const info = errorInfo(error);
          const status = info.status ?? 503;
          reply(status, status >= 500 ? 'Shared files service unavailable' : info.message);
        }
      }
    } finally {
      res.off('close', disconnect);
      running--;
      const remaining = active.get(tenantId)! - 1;
      if (remaining) active.set(tenantId, remaining);
      else active.delete(tenantId);
    }
  };
}
