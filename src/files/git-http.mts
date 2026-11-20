import type {IncomingMessage, ServerResponse} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import {errorInfo} from '../errors.mjs';
import {bundleLimit, type SharedFilesStore} from './store.mjs';
import {exportHistory, failure, git, prepareRepository} from './git.mjs';

const decompress = promisify(gunzip);
const hooks = fileURLToPath(new URL('./hooks/', import.meta.url));
const services = ['git-upload-pack','git-receive-pack'] as const;

/** Stock Git invokes a credential helper after a Basic challenge. Translate only
 * this service's fixed username at its own route; membership is still verified. */
export function sharedFilesAuthorization(header?: string): string | undefined {
  if (header?.startsWith('Bearer ')) return header;
  const match = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(header ?? '');
  if (!match || match[1].length > 24000) return undefined;
  const decoded = Buffer.from(match[1],'base64').toString('utf8');
  const token = /^opencrawl:([A-Za-z0-9_.-]{1,16384})$/.exec(decoded)?.[1];
  return token ? 'Bearer '+token : undefined;
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > bundleLimit) throw failure(413,'Git request exceeds the transfer limit');
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks);
  if (req.headers['content-encoding'] === 'gzip') {
    try {return await decompress(data,{maxOutputLength:bundleLimit});}
    catch {throw failure(400,'Invalid or oversized compressed Git request');}
  }
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
    throw failure(415,'Unsupported content encoding');
  }
  return data;
}

/** The caller authenticates and authorizes every discovery, fetch and push.
 * No filesystem path is derived from a request. Snapshots are private to an
 * individual RPC and a durable compare-and-swap publishes an accepted push. */
export function createSharedFilesHandler({store,root = tmpdir()}: {store: SharedFilesStore; root?: string}) {
  const active = new Map<string, number>();
  let running = 0;
  return async (req: IncomingMessage, res: ServerResponse, principal: {tenantId: string; userId: string; captureAccess?:unknown},
    revalidate: () => Promise<void> = async () => {}) => {
    const reply = (status: number, data: string | Buffer, type = 'text/plain; charset=utf-8') => {
      res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      res.end(data);
    };
    if (!principal?.tenantId || !principal.userId || principal.captureAccess !== undefined || req.headers.origin) {
      return reply(403,'Network membership required');
    }
    const {tenantId,userId} = principal;
    const seal = createHash('sha256').update(tenantId).digest('hex');
    const remotePath = '/api/files/'+seal+'.git';
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/files') {
      if (req.method !== 'GET') return reply(405,'Use GET');
      return reply(200,JSON.stringify({schemaVersion:1,data:{remotePath,tenantId,userId}}),'application/json');
    }
    const advertise = url.pathname === remotePath+'/info/refs';
    const service = services.find(name => advertise ? url.searchParams.get('service') === name : url.pathname === remotePath+'/'+name);
    if (!service) return reply(404,'Unknown Git endpoint');
    if (req.method !== (advertise ? 'GET' : 'POST')) return reply(405,'Unsupported Git method');
    if (!advertise && req.headers['content-type'] !== 'application/x-'+service+'-request') return reply(415,'Expected a Git request');
    const count = active.get(tenantId) ?? 0;
    if (running >= 12 || count >= 4) {
      res.setHeader('Retry-After','1');
      return reply(429,'Git server busy; retry shortly');
    }
    active.set(tenantId,count+1);
    running++;
    let dir: string | undefined;
    try {
      const input = advertise ? undefined : await body(req);
      if (req.aborted || res.destroyed) return;
      dir = await mkdtemp(join(root,'opencrawl-files-rpc-'));
      const snapshot = await store.read(tenantId);
      const previous = await prepareRepository(dir,snapshot);
      const operation = service === 'git-receive-pack' ? 'receive-pack' : 'upload-pack';
      const args = ['-c','core.hooksPath='+hooks,operation,'--stateless-rpc'];
      if (advertise) args.push('--advertise-refs');
      const wire = await git(dir,[...args,'.'],input);
      if (advertise) {
        const preamble = '# service='+service+'\n';
        const length = (Buffer.byteLength(preamble)+4).toString(16).padStart(4,'0');
        await revalidate();
        return reply(200,Buffer.concat([Buffer.from(length+preamble+'0000'),wire]),'application/x-'+service+'-advertisement');
      }
      if (operation === 'receive-pack') {
        const head = (await git(dir,['rev-parse','refs/heads/main'])).toString().trim();
        if (head !== previous) {
          const next = await exportHistory(dir,head);
          await revalidate();
          if (!await store.publish(tenantId,snapshot?.head ?? null,next,userId)) {
            return reply(409,'Another agent advanced main. Fetch, integrate your changes, and push again.');
          }
        }
      }
      await revalidate();
      return reply(200,wire,'application/x-'+service+'-result');
    } catch (error) {
      const info = errorInfo(error);
      const status = info.status ?? 503;
      return reply(status,status >= 500 ? 'Shared files service unavailable' : info.message);
    } finally {
      try {if (dir) await rm(dir,{recursive:true,force:true});}
      finally {
        running--;
        const remaining = active.get(tenantId)!-1;
        if (remaining) active.set(tenantId,remaining); else active.delete(tenantId);
      }
    }
  };
}
