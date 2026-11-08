import {Database} from 'bun:sqlite';
import {mkdirSync, chmodSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, statSync, fsyncSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {homedir} from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
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

// SQLite's kernel-backed transaction lock is released even on SIGKILL. Keeping
// one database per key avoids serializing unrelated credentials/transcripts.
// Never unlink these database files: replacing a locked inode breaks exclusion.
const heldLocks=new Set<()=>void>();
process.once('exit',()=>{for(const release of heldLocks)try{release();}catch{}});
const lockIdentity=(file:string)=>{const st=statSync(file,{bigint:true});return [st.dev,st.ino,st.birthtimeNs,st.ctimeNs].join(':');};
export async function withSessionLock<T>(api: string, operation: () => Promise<T>, waitMs = 20_000,signal?:AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const file = sessionFile(api) + '.lock',database=file+'.sqlite';
  mkdirSync(configDir(), {recursive: true, mode: 0o700});
  const db=new Database(database,{create:true});
  const deadline=Date.now()+waitMs;
  let transaction=false,identity:string|undefined,released=false;
  const release=()=>{
    if(released)return;released=true;heldLocks.delete(release);
    try {
      // PID files remain diagnostic and compatible with older clients. Never
      // delete a replacement file; SQLite owns exclusion for current clients.
      if(identity && lockIdentity(file)===identity && readFileSync(file,'utf8')===String(process.pid))unlinkSync(file);
    }catch(error:any){if(error.code!=='ENOENT')throw error;}
    finally{try{if(transaction)db.exec('ROLLBACK');}finally{db.close();}}
  };
  try {
    chmodSync(database,0o600);
    db.exec('PRAGMA busy_timeout=0');
    while(!transaction) {
      signal?.throwIfAborted();
      try{db.exec('BEGIN IMMEDIATE');transaction=true;}
      catch(error:any){
        if(!String(error.code??'').startsWith('SQLITE_BUSY')&&!String(error.code??'').startsWith('SQLITE_LOCKED'))throw error;
        if(Date.now()>=deadline)throw new CliError('SESSION_BUSY','Another opencrawl process is updating this session. Retry shortly.');
        await pause(50,undefined,{signal});
      }
    }
    // Bridge an older still-running CLI conservatively. Stale PID-file cleanup
    // is now serialized by the transaction, so concurrent recoveries cannot
    // unlink a newly acquired current-client lock or admit two uploaders.
    while(true) {
      signal?.throwIfAborted();
      try {
        const fd=openSync(file,'wx',0o600);
        try{writeFileSync(fd,String(process.pid));identity=lockIdentity(file);}finally{closeSync(fd);}
        break;
      }catch(error:any){
        if(error.code!=='EEXIST')throw error;
        try {
          const pid=Number(readFileSync(file,'utf8'));
          if(pid>0) {
            try{process.kill(pid,0);}
            catch(check:any){if(check.code==='ESRCH'){unlinkSync(file);continue;}}
          }else if(Date.now()-statSync(file).mtimeMs>60_000){unlinkSync(file);continue;}
        }catch(check:any){if(check.code==='ENOENT')continue;throw check;}
        // A reused live PID is never evicted based on elapsed time.
        if(Date.now()>=deadline)throw new CliError('SESSION_BUSY','Another opencrawl process is updating this session. Retry shortly.');
        await pause(50,undefined,{signal});
      }
    }
    heldLocks.add(release);
    return await operation();
  } finally{release();}
}

export async function saveSession(api: string, session: Session) {
  return withSessionLock(api, async () => atomicJson(sessionFile(api), session));
}

export async function logout(api: string) {
  return withSessionLock(api, async () => { try { unlinkSync(sessionFile(api)); } catch (error: any) { if (error.code !== 'ENOENT') throw error; } });
}

export async function accessToken(api: string, rejectedToken?: string, fetcher = fetch,signal?:AbortSignal): Promise<string> {
  return withSessionLock(api, async () => {
    signal?.throwIfAborted();
    const session = readSession(api);
    if (!session) throw new CliError('AUTH_REQUIRED', 'Run opencrawl login to sign in.', 2);
    if (session.expiresAt > Date.now() + 60_000 && (!rejectedToken || rejectedToken !== session.accessToken)) return session.accessToken;
    const cancellable=signal?((input:any,init:any)=>fetcher(input,{...init,signal:init?.signal?AbortSignal.any([signal,init.signal]):signal})) as typeof fetch:fetcher;
    const next = {...session, ...await refresh(session.auth, session.refreshToken, cancellable)};
    atomicJson(sessionFile(api), next);
    return next.accessToken;
  },20_000,signal);
}
