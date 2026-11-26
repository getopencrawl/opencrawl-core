import {filePage, type FileView} from '../application/file-links.mjs';
import {workspaceLinkHint} from '../state/workspace-link.mjs';
import {failure, git, gitRpc} from './git.mjs';
import type {SharedFilesStore} from './store.mjs';

const previewBytes = 128 * 1024;
const timeoutMs = 8000;

/** Preserve trailing whitespace and terminate Git once the requested preview is full. */
function preview(dir: string, args: string[], limit: number) {
  const child = gitRpc(dir, args, {});
  return new Promise<{bytes: Buffer; truncated: boolean}>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0, truncated = false, timedOut = false;
    const timer = setTimeout(() => {timedOut = true; child.kill();}, timeoutMs);
    child.once('error', error => {clearTimeout(timer); reject(error);});
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut || (code !== 0 && !truncated)) return reject(failure(503, 'Git preview unavailable'));
      resolve({bytes: Buffer.concat(chunks), truncated});
    });
    child.stdout.on('data', (bytes: Buffer) => {
      if (truncated) return;
      const count = Math.min(bytes.length, limit - length);
      chunks.push(bytes.subarray(0, count));
      length += count;
      if (count < bytes.length) {truncated = true; child.kill();}
    });
    child.stdin.end();
  });
}

function utf8(bytes: Buffer) {
  try {return new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(bytes);} catch {return null;}
}

export async function readFileView(store: Pick<SharedFilesStore, 'open'>,
  principal: {tenantId: string; userId?: string; captureAccess?: unknown}, pathname: string): Promise<FileView> {
  if (!principal?.userId || !principal.tenantId || principal.captureAccess !== undefined)
    throw failure(403, 'Workspace membership required');
  const workspace = workspaceLinkHint(principal.tenantId);
  const link = filePage(pathname);
  if (pathname !== '/files' && (!link || workspace !== link.workspace)) throw failure(404, 'Revision not found');
  const dir = await store.open(principal.tenantId);
  const control = (args: string[]) => git(dir, args, {}, undefined, timeoutMs);
  const revision = link?.revision ?? await control(['rev-parse', 'refs/heads/main']);
  try {
    if (await control(['cat-file', '-t', revision]) !== 'commit') throw failure(404, 'Revision not found');
    await control(['merge-base', '--is-ancestor', revision, 'refs/heads/main']);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (Number(code) === 1 || Number(code) === 128) throw failure(404, 'Revision not found');
    throw error;
  }

  const header = await preview(dir, ['show', '--no-patch', '--no-show-signature', '--format=%P%x00%an%x00%aI%x00%s', revision], 16384);
  const [parentIds = '', author = '', time = '', title = ''] = header.bytes.toString('utf8').trimEnd().split('\0');
  const commit = {workspace, commit:revision, parents:parentIds.split(' ').filter(Boolean), author, time, title};
  if (link?.path === undefined) {
    const tree = await preview(dir, ['ls-tree', '-rz', revision], 64 * 1024);
    const files: string[] = [];
    let start = 0, end: number;
    while (files.length <= 500 && (end = tree.bytes.indexOf(0, start)) >= 0) {
      const record = tree.bytes.subarray(start, end);
      const tab = record.indexOf(9);
      if (tab >= 0 && record.subarray(0, tab).toString('ascii').split(' ')[1] === 'blob') {
        const name = utf8(record.subarray(tab + 1));
        if (name !== null) files.push(name);
      }
      start = end + 1;
    }
    return {...commit, kind:'commit', files:files.slice(0, 500), truncated:tree.truncated || files.length > 500};
  }
  const entry = await preview(dir, ['--literal-pathspecs', 'ls-tree', '-z', revision, '--', link.path], 16384);
  const record = entry.bytes.toString('utf8');
  const tab = record.indexOf('\t');
  const [, type, oid] = record.slice(0, tab).split(' ');
  if (tab < 0 || type !== 'blob' || !oid || record.slice(tab + 1, -1) !== link.path)
    throw failure(404, 'File not found at this revision');
  const bytes = Number(await control(['cat-file', '-s', oid]));
  const large = bytes > previewBytes;
  let text: string | null = null;
  if (!large) {
    const content = await preview(dir, ['cat-file', 'blob', oid], previewBytes);
    if (!content.bytes.includes(0)) text = utf8(content.bytes);
  }
  return {...commit, kind:'file', path:link.path, bytes, large, text};
}
