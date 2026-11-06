import {mkdirSync, chmodSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, statSync, fsyncSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {homedir} from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {CliError, refresh, type AuthConfig, type Tokens} from './oauth.ts';

export type Session = Tokens & {auth: AuthConfig};
export const configDir = () => join(process.env.OPENCRAWL_CONFIG_HOME || process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencrawl');
export const sessionFile = (api: string) => join(configDir(), createHash('sha256').update(api).digest('hex') + '.json');

export function atomicFile(file: string, bytes: string|Buffer) {
  mkdirSync(dirname(file), {recursive: true, mode: 0o700});
  chmodSync(dirname(file), 0o700);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
    syncDirectory(dirname(file));
  } finally { try { unlinkSync(temp); } catch {} }
}

export function atomicJson(file: string, value: unknown) { atomicFile(file, JSON.stringify(value) + '\n'); }

// Windows does not expose directory fsync through node:fs. File flush + atomic
// rename still provide process-crash safety; POSIX additionally flushes the entry.
export function syncDirectory(directory: string) {
  if (process.platform === 'win32') return;
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function readSession(api: string): Session | null {
  try {
    const file = sessionFile(api);
    chmodSync(file, 0o600);
    const session = JSON.parse(readFileSync(file, 'utf8'));
    if (!session?.auth?.clientId || !session.auth.tokenEndpoint || !session.accessToken || !session.refreshToken || !Number.isFinite(session.expiresAt)) throw new Error();
    return session;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw new CliError('CREDENTIALS_ERROR', 'Could not read saved credentials. Run opencrawl logout, then login again.');
  }
}

// Serializes rotation and logout across agent processes. A dead owner can be
// reclaimed; a live owner is never evicted just because a request is slow.
export async function withSessionLock<T>(api: string, operation: () => Promise<T>, waitMs = 20_000): Promise<T> {
  const file = sessionFile(api) + '.lock';
  mkdirSync(configDir(), {recursive: true, mode: 0o700});
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
      break;
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(readFileSync(file, 'utf8'));
        if (pid > 0) {
          try { process.kill(pid, 0); }
          catch (check: any) { if (check.code === 'ESRCH') { unlinkSync(file); continue; } }
        } else if (Date.now() - statSync(file).mtimeMs > 60_000) { unlinkSync(file); continue; }
      } catch (check: any) { if (check.code === 'ENOENT') continue; }
      if (Date.now() >= deadline) throw new CliError('SESSION_BUSY', 'Another opencrawl process is updating this session. Retry shortly.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try { return await operation(); } finally { unlinkSync(file); }
}

export async function saveSession(api: string, session: Session) {
  return withSessionLock(api, async () => atomicJson(sessionFile(api), session));
}

export async function logout(api: string) {
  return withSessionLock(api, async () => { try { unlinkSync(sessionFile(api)); } catch (error: any) { if (error.code !== 'ENOENT') throw error; } });
}

export async function accessToken(api: string, rejectedToken?: string, fetcher = fetch): Promise<string> {
  return withSessionLock(api, async () => {
    const session = readSession(api);
    if (!session) throw new CliError('AUTH_REQUIRED', 'Run opencrawl login to sign in.', 2);
    if (session.expiresAt > Date.now() + 60_000 && (!rejectedToken || rejectedToken !== session.accessToken)) return session.accessToken;
    const next = {...session, ...await refresh(session.auth, session.refreshToken, fetcher)};
    atomicJson(sessionFile(api), next);
    return next.accessToken;
  });
}
