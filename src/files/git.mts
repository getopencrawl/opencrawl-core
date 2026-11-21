import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

export function failure(status: number, message: string) {
  return Object.assign(new Error(message), {status});
}
const hooks = fileURLToPath(new URL('./hooks/', import.meta.url)).replaceAll('\\', '/');
const environment: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  // Git for Windows also recognizes the Git spelling of the null device.
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_AUTHOR_NAME: 'OpenCrawl',
  GIT_AUTHOR_EMAIL: 'files@opencrawl.invalid',
  GIT_COMMITTER_NAME: 'OpenCrawl',
  GIT_COMMITTER_EMAIL: 'service@localhost'
};
const config = [
  ...(process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : []),
  '-c',
  'core.hooksPath=' + hooks,
  '-c',
  'core.fsync=committed',
  '-c',
  'receive.denyDeletes=true',
  '-c',
  'receive.denyNonFastForwards=true',
  '-c',
  'receive.fsckObjects=true',
  '-c',
  'receive.advertisePushOptions=false',
  '-c',
  'gc.autoDetach=false',
  '-c',
  'maintenance.autoDetach=false'
];

function nativeGit(args: string[], pushBytes?: number) {
  const gitArgs = [...config, ...args];
  // Keep a native index-pack's largest staging file bounded, even for a thin
  // pack which appends its delta bases. sh uses 512- or 1024-byte blocks.
  // The volume reserves for the larger size. All arguments are passed as argv.
  const bounded = pushBytes !== undefined && process.platform !== 'win32';
  const argv = bounded
    ? [
        '-c',
        'ulimit -c 0 && ulimit -f "$1" || exit 1; shift; exec git "$@"',
        'opencrawl-git',
        String(Math.ceil((pushBytes + 128 * 1024) / 512)),
        ...gitArgs
      ]
    : gitArgs;
  return {file: bounded ? 'sh' : 'git', argv};
}
// Only used for small control replies. All pack transfers use the streaming RPC.
export async function git(dir: string, args: string[], extra: NodeJS.ProcessEnv = {}, pushBytes?: number) {
  const {file, argv} = nativeGit(args, pushBytes);
  const task = promisify(execFile)(file, argv, {
    cwd: dir,
    env: {...environment, ...extra},
    encoding: 'utf8'
  });
  task.child.stdin?.end();
  return (await task).stdout.trim();
}
export function gitRpc(dir: string, args: string[], extra: NodeJS.ProcessEnv, pushBytes?: number) {
  const {file, argv} = nativeGit(args, pushBytes);
  return spawn(file, argv, {
    cwd: dir,
    env: {...environment, ...extra},
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: process.platform !== 'win32',
    windowsHide: true
  });
}
export async function seedRepository(dir: string) {
  const date = '2000-01-01T00:00:00Z';
  // Preserve the initial commit ID used by existing clones.
  const seedEnv = {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
    GIT_COMMITTER_EMAIL: 'files@opencrawl.invalid'
  };
  const tree = await git(dir, ['hash-object', '-w', '-t', 'tree', '--stdin'], seedEnv);
  const head = await git(dir, ['commit-tree', tree, '-m', 'Initialize shared files'], seedEnv);
  await git(dir, ['update-ref', 'refs/heads/main', head]);
}
