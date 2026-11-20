import {execFile} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {bundleLimit, type SharedHistory} from './store.mjs';

export function failure(status: number, message: string) {
  return Object.assign(new Error(message), {status});
}

const environment: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1',
  GIT_AUTHOR_NAME: 'OpenCrawl', GIT_AUTHOR_EMAIL: 'files@opencrawl.invalid',
  GIT_COMMITTER_NAME: 'OpenCrawl', GIT_COMMITTER_EMAIL: 'files@opencrawl.invalid',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};
const config = ['-c','gc.auto=0','-c','maintenance.auto=false','-c','receive.denyDeletes=true',
  '-c','receive.denyNonFastForwards=true','-c','receive.denyDeleteCurrent=true','-c','receive.fsckObjects=true',
  '-c','receive.advertisePushOptions=false','-c','receive.unpackLimit=0','-c','receive.maxInputSize='+bundleLimit,
  '-c','pack.threads=1','-c','pack.windowMemory=8m','-c','core.deltaBaseCacheLimit=8m'];

export function git(dir: string, args: string[], input?: Buffer, limit = 2 * bundleLimit): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', [...config, ...args], {
      cwd: dir, env: environment, encoding: 'buffer', maxBuffer: limit, timeout: 20000, killSignal: 'SIGKILL',
    }, (error, stdout) => {
      if (!error) return resolve(stdout);
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(failure(413,'Repository exceeds the transfer limit'));
      if (error.code === 'ENOENT') return reject(failure(503,'Git is unavailable on this server'));
      if (error.killed) return reject(failure(503,'Git operation timed out'));
      reject(failure(400,'Git rejected the transfer'));
    });
    child.stdin?.on('error', () => { /* Git may reject an input before reading the entire pack. */ });
    child.stdin?.end(input);
  });
}

export async function prepareRepository(dir: string, snapshot: SharedHistory | null) {
  await git(dir, ['init','--quiet','--bare','--object-format=sha1','--template=','--initial-branch=main','.']);
  if (snapshot) {
    const bundle = join(dir,'source.bundle');
    await writeFile(bundle,snapshot.bundle,{mode:0o600});
    await git(dir,['fetch','--quiet','--no-tags','--no-write-fetch-head',bundle,'refs/heads/main:refs/heads/main']);
  } else {
    const tree = (await git(dir,['mktree'])).toString().trim();
    const commit = (await git(dir,['commit-tree',tree,'-m','Initialize shared files'])).toString().trim();
    await git(dir,['update-ref','refs/heads/main',commit]);
  }
  const head = (await git(dir,['rev-parse','refs/heads/main'])).toString().trim();
  if (snapshot && head !== snapshot.head) throw failure(503,'Stored history failed verification');
  return head;
}

export async function exportHistory(dir: string, head: string): Promise<SharedHistory> {
  // Limit expanded history too. A small transfer can contain many compressed objects.
  const sizes = await git(dir,['cat-file','--batch-all-objects','--batch-check=%(objectsize)'],undefined,256*1024);
  let total = 0;
  for (const line of sizes.toString().trim().split('\n')) {
    const bytes = Number(line);
    total += bytes;
    if (!Number.isSafeInteger(bytes) || bytes > bundleLimit || total > 32 * 1024 * 1024) {
      throw failure(413,'Expanded file or repository exceeds the v0 size limit');
    }
  }
  const bundle = await git(dir,['bundle','create','-','refs/heads/main'],undefined,bundleLimit);
  return {head,bundle};
}
