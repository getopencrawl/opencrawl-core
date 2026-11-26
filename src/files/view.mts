import {amendmentsRefPrefix, isAllowedBranchRef, mainBranchRef} from './refs.mjs';
import {failure, git, gitRpc} from './git.mjs';
import type {SharedFilesStore} from './store.mjs';

const previewBytes = 128 * 1024;
const timeoutMs = 8000;

export interface FileViewPrincipal {
  tenantId: string;
  userId?: string;
  captureAccess?: unknown;
}

export interface FileViewOptions {
  ref?: string;
  revision?: string;
  path?: string;
}

export interface AmendmentBranch {
  id: string;
  ref: string;
  head: string;
}

export type FileView =
  | {
      ref: string;
      commit: string;
      parents: string[];
      author: string;
      time: string;
      title: string;
      kind: 'commit';
      files: string[];
      truncated: boolean;
    }
  | {
      ref: string;
      commit: string;
      parents: string[];
      author: string;
      time: string;
      title: string;
      kind: 'file';
      path: string;
      bytes: number;
      large: boolean;
      text: string | null;
    };

function assertPrincipal(principal: FileViewPrincipal) {
  if (!principal?.userId || !principal.tenantId || principal.captureAccess !== undefined)
    throw failure(403, 'Workspace membership required');
}

function isValidPath(path: string): boolean {
  return Boolean(
    path &&
      !path.includes('\0') &&
      !path.startsWith('/') &&
      !path.endsWith('/') &&
      !path.split('/').some((part) => !part || part === '.' || part === '..')
  );
}

/** Preserve trailing whitespace and terminate Git once the requested preview is full. */
function preview(dir: string, args: string[], limit: number) {
  const child = gitRpc(dir, args, {});
  return new Promise<{bytes: Buffer; truncated: boolean}>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0,
      truncated = false,
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut || (code !== 0 && !truncated)) return reject(failure(503, 'Git preview unavailable'));
      resolve({bytes: Buffer.concat(chunks), truncated});
    });
    child.stdout.on('data', (bytes: Buffer) => {
      if (truncated) return;
      const count = Math.min(bytes.length, limit - length);
      chunks.push(bytes.subarray(0, count));
      length += count;
      if (count < bytes.length) {
        truncated = true;
        child.kill();
      }
    });
    child.stdin.end();
  });
}

function utf8(bytes: Buffer) {
  try {
    return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
  } catch {
    return null;
  }
}

export async function listAmendmentBranches(
  store: Pick<SharedFilesStore, 'open'>,
  principal: FileViewPrincipal
): Promise<AmendmentBranch[]> {
  assertPrincipal(principal);
  const dir = await store.open(principal.tenantId);
  const out = await git(
    dir,
    ['for-each-ref', '--format=%(objectname)%00%(refname)', amendmentsRefPrefix],
    {},
    undefined,
    timeoutMs
  );
  if (!out) return [];
  const branches: AmendmentBranch[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [head, ref] = line.split('\0');
    if (head && ref && isAllowedBranchRef(ref))
      branches.push({id: ref.slice(amendmentsRefPrefix.length), ref, head});
  }
  return branches;
}

export async function readFileView(
  store: Pick<SharedFilesStore, 'open'>,
  principal: FileViewPrincipal,
  options: FileViewOptions = {}
): Promise<FileView> {
  assertPrincipal(principal);
  const ref = options.ref ?? mainBranchRef;
  if (!isAllowedBranchRef(ref)) throw failure(400, 'Unsupported shared files branch');
  if (options.revision !== undefined && !/^[0-9a-f]{40}$/.test(options.revision))
    throw failure(404, 'Revision not found');
  if (options.path !== undefined && !isValidPath(options.path))
    throw failure(404, 'File not found at this revision');
  const dir = await store.open(principal.tenantId);
  const control = (args: string[]) => git(dir, args, {}, undefined, timeoutMs);
  let tip: string;
  try {
    tip = await control(['rev-parse', '--verify', ref]);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (Number(code) === 1 || Number(code) === 128) throw failure(404, 'Revision not found');
    throw error;
  }
  const revision = options.revision ?? tip;
  try {
    if ((await control(['cat-file', '-t', revision])) !== 'commit') throw failure(404, 'Revision not found');
    await control(['merge-base', '--is-ancestor', revision, tip]);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (Number(code) === 1 || Number(code) === 128) throw failure(404, 'Revision not found');
    throw error;
  }

  const header = await preview(
    dir,
    ['show', '--no-patch', '--no-show-signature', '--format=%P%x00%an%x00%aI%x00%s', revision],
    16384
  );
  const [parentIds = '', author = '', time = '', title = ''] = header.bytes
    .toString('utf8')
    .trimEnd()
    .split('\0');
  const commit = {
    ref,
    commit: revision,
    parents: parentIds.split(' ').filter(Boolean),
    author,
    time,
    title
  };
  if (options.path === undefined) {
    const tree = await preview(dir, ['ls-tree', '-rz', revision], 64 * 1024);
    const files: string[] = [];
    let start = 0,
      end: number;
    while (files.length <= 500 && (end = tree.bytes.indexOf(0, start)) >= 0) {
      const record = tree.bytes.subarray(start, end);
      const tab = record.indexOf(9);
      if (tab >= 0 && record.subarray(0, tab).toString('ascii').split(' ')[1] === 'blob') {
        const name = utf8(record.subarray(tab + 1));
        if (name !== null) files.push(name);
      }
      start = end + 1;
    }
    return {...commit, kind: 'commit', files: files.slice(0, 500), truncated: tree.truncated || files.length > 500};
  }
  const entry = await preview(dir, ['--literal-pathspecs', 'ls-tree', '-z', revision, '--', options.path], 16384);
  const record = entry.bytes.toString('utf8');
  const tab = record.indexOf('\t');
  const [, type, oid] = record.slice(0, tab).split(' ');
  if (tab < 0 || type !== 'blob' || !oid || record.slice(tab + 1, -1) !== options.path)
    throw failure(404, 'File not found at this revision');
  const bytes = Number(await control(['cat-file', '-s', oid]));
  const large = bytes > previewBytes;
  let text: string | null = null;
  if (!large) {
    const content = await preview(dir, ['cat-file', 'blob', oid], previewBytes);
    if (!content.bytes.includes(0)) text = utf8(content.bytes);
  }
  return {...commit, kind: 'file', path: options.path, bytes, large, text};
}
