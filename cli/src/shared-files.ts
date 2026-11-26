import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {promisify} from 'node:util';
import {commandForSelf, readCaptureConfig} from './capture/runtime.ts';
import {setupCommandForSelf} from './setup/invocation.ts';
import {nativeId} from './context-check-events.ts';
import {literal} from './hook-runner.ts';
import {sessionPrivate} from './incognito-state.ts';
import {apiOrigin, CliError, jsonRequest} from './oauth.ts';
import {accessToken, atomicFile, atomicJson, configDir, withSessionLock} from './session.ts';
import {configuredToken, workspaceIdentityEnabled} from './workspace-identity.ts';

import {workspaceLinkHint} from '../../src/state/workspace-link.mts';
import {filePage, filePath} from '../../src/application/file-links.mts';

const git = promisify(execFile);
const identity = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 512 && !/[\x00-\x1f\x7f]/.test(s);
const remotePathPattern = /^\/api\/files\/[a-f0-9]{64}\.git$/;
const clonePathPattern = /^\/git\/(?:[A-Za-z0-9_-]+|~[a-f0-9]{64})\/files\.git$/;
type Repo = {tenantId: string; userId: string; remotePath: string; clonePath?:string};
type Binding = Repo & {api: string; session: string; scratch: string};

function bindingKey(api: string, repo: Repo, session: string) {
  return createHash('sha256').update(JSON.stringify([api, repo.tenantId, repo.userId, repo.remotePath, session])).digest('hex');
}
function recordFile(key: string) {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new CliError('INVALID_USAGE', 'Invalid file session.');
  return join(configDir(), 'files', key + '.json');
}
function loadBinding(key: string): Binding | null {
  let content: string;
  try { content = readFileSync(recordFile(key), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const b = JSON.parse(content) as Binding;
  if (apiOrigin(b.api) !== b.api || !identity(b.tenantId) || !identity(b.userId) || !nativeId(b.session) ||
      !remotePathPattern.test(b.remotePath) || !isAbsolute(b.scratch) || bindingKey(b.api, b, b.session) !== key)
    throw new CliError('FILES_SESSION_INVALID', 'Invalid saved file session.');
  return b;
}
function checkPrivacy(api: string, session?: string) {
  const config = readCaptureConfig();
  const ids = [session, process.env.OPENCRAWL_SESSION_ID, process.env.CODEX_THREAD_ID, process.env.CLAUDE_CODE_SESSION_ID];
  if (config?.api === api && ids.some(id => id && ['codex','claude-code','cursor','antigravity','devin'].some(harness => sessionPrivate(config, {harness, sessionId: id}))))
    throw new CliError('SESSION_INCOGNITO', 'This private session cannot use shared files.', 2);
}
async function discoverRepo(api: string, signal?: AbortSignal) {
  const configured = await configuredToken('OPENCRAWL_TOKEN', api, undefined, signal);
  let token = configured || await accessToken(api, undefined, fetch, signal);
  const request = () => jsonRequest(api + '/api/files', {headers: {authorization: 'Bearer ' + token},signal});
  let result = await request();
  if (result.response.status === 401 && (!configured || workspaceIdentityEnabled())) {
    token = await configuredToken('OPENCRAWL_TOKEN', api, token, signal) || await accessToken(api, token, fetch, signal);
    result = await request();
  }
  if (!result.response.ok) throw new CliError('FILES_UNAVAILABLE', `Shared files unavailable (HTTP ${result.response.status}). Check this deployment and your sign-in.`, 2);
  const repo = result.body.data as Repo | undefined;
  if (result.body.schemaVersion !== 1 || !repo || !identity(repo.tenantId) || !identity(repo.userId) ||
      typeof repo.remotePath !== 'string' || !remotePathPattern.test(repo.remotePath) ||
      (repo.clonePath !== undefined && (typeof repo.clonePath !== 'string' || !clonePathPattern.test(repo.clonePath))))
    throw new CliError('FILES_PROTOCOL_ERROR', 'Invalid shared-files discovery response.', 2);
  return {repo, token};
}
export async function sharedFilesUrl(api:string) {
  checkPrivacy(api);
  const {repo} = await discoverRepo(api);
  await repairFilesGit(api);
  return api + (repo.clonePath ?? repo.remotePath);
}
/** Create a browser link only for a published revision of the current workspace repository. */
export async function sharedFilesPermalink(api: string, path?: string, revision?: string) {
  checkPrivacy(api);
  const {repo} = await discoverRepo(api);
  const env = gitEnvironment();
  const read = async (args: string[]) => (await git('git', args, {env, timeout: 10000})).stdout.trimEnd();
  const remote = await read(['config', '--local', '--get', 'remote.origin.url']).catch(() => '');
  if (![repo.remotePath, repo.clonePath].some(item => item && api+item === remote))
    throw new CliError('FILES_CLONE_CHANGED', 'Run files link in a clone of the selected workspace repository.', 2);
  if (revision !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision))
    throw new CliError('INVALID_USAGE', 'Pass a full commit ID with --revision.', 64);
  const commit = revision ?? await read(['rev-parse', '--verify', 'HEAD']);
  const href = filePath({workspace:workspaceLinkHint(repo.tenantId), revision:commit, path});
  if (!filePage(href)) throw new CliError('INVALID_USAGE', 'Use a file path relative to the root of the workspace repository.', 64);
  try {
    if (await read(['cat-file','-t',commit]) !== 'commit') throw Error();
    await read(['merge-base','--is-ancestor',commit,'refs/remotes/origin/main']);
    if (path && await read(['cat-file','-t',commit+':'+path]) !== 'blob') throw Error();
  } catch {throw new CliError('FILES_REVISION_UNAVAILABLE', 'The file or commit is unavailable on origin/main. Push or fetch the published revision first.', 2);}
  return api + href;
}
export async function availableFiles(api:string, session?:string, owner?:{tenantId:string;userId:string}, signal=AbortSignal.timeout(1000)) {
  try {
    checkPrivacy(api, session);
    const {repo} = await discoverRepo(api, signal);
    checkPrivacy(api, session);
    return !owner || (owner.tenantId === repo.tenantId && owner.userId === repo.userId);
  } catch { return false; }
}
export function sharedFilesInstruction(api:string, session:string) {
  return `For file handoffs, use opencrawl files open --session ${session} --api ${api}. It prints a directory outside your project. Put the handoff file in that directory, commit it there, and run git -C <printed-dir> push origin main. After the push succeeds, run opencrawl files link <repo-relative-path> in the checkout and share the browser URL with your teammate. To read a handoff, fetch origin and read the file at that commit.`;
}
function credentialCommand(target:string, command=commandForSelf()) {
  // Git runs shell credential helpers through sh, including on Windows.
  const entry = command.map(word => process.platform === 'win32' ? word.replaceAll('\\', '/') : word);
  return [...entry, 'files-credential', target].map(word => literal(word, false)).join(' ');
}

export async function setupFilesGit(api:string, command=setupCommandForSelf(), signal=AbortSignal.timeout(2500)) {
  checkPrivacy(api);
  const name = createHash('sha256').update(api).digest('hex') + '.gitconfig';
  const file = resolve(configDir(), 'files', name);
  // Git may run in a new shell. Bind the setup profile and workload identity,
  // while letting the CLI obtain and refresh credentials when Git asks.
  const profile = resolve(dirname(configDir()));
  const env = ['OPENCRAWL_CONFIG_HOME=' + literal(profile, false)];
  if (workspaceIdentityEnabled()) {
    env.push('OPENCRAWL_AUTH=' + literal(process.env.OPENCRAWL_AUTH!, false), 'OPENCRAWL_API_URL=' + literal(api, false));
  }
  const helper = JSON.stringify('!' + [...env, credentialCommand(api, command)].join(' '));
  const config = ['/git/', '/api/files/'].map(prefix => {
    const scope = JSON.stringify(api + prefix);
    return ['[credential ' + scope + ']', '  useHttpPath = true', '  helper =', '  helper = ' + helper,
      '[http ' + scope + ']', '  extraHeader =', '  followRedirects = false'].join('\n');
  }).join('\n') + '\n';
  // On an upgraded installation this runs at confirmed startup. Preserve file
  // timestamps and unrelated user configuration when the helper is current.
  const current = exists(file);
  if (!current?.isFile() || current.size !== Buffer.byteLength(config) || readFileSync(file, 'utf8') !== config) atomicFile(file, config);
  const include = process.platform === 'win32' ? file.replaceAll('\\','/') : file;
  const options = {env:gitEnvironment(), signal, windowsHide:true};
  let matches = '';
  try { matches = (await git('git', ['config','--global','--fixed-value','--get-all','include.path',include], options)).stdout; }
  catch (error) { if ((error as {code?:unknown}).code !== 1) throw error; }
  if (matches.trimEnd() !== include)
    await git('git', ['config','--global','--fixed-value','--replace-all','include.path',include,include], options);
  return {api,config:file};
}
// No network or login here. Call only after this agent's current, authenticated
// server response enabled files. Board participation survives absent/locked Git.
export async function repairFilesGit(api:string, session?:string) {
  try {
    checkPrivacy(api, session);
    await setupFilesGit(api, undefined, AbortSignal.timeout(500));
  } catch { /* Retry on the next confirmed startup. */ }
}
function contains(root: string, path: string) {
  const diff = relative(root, path);
  return diff === '' || !(diff === '..' || diff.startsWith('..' + sep) || isAbsolute(diff));
}
function exists(path: string) {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function gitEnvironment() {
  const env: NodeJS.ProcessEnv = {...process.env, GIT_TERMINAL_PROMPT: '0'};
  for (const key of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_COMMON_DIR','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_CONFIG_COUNT','GIT_CONFIG_PARAMETERS']) delete env[key];
  return env;
}
// Check the filesystem marker, including the .git file used by linked worktrees.
// This also works when Git rejects a checkout owned by a different OS account.
function enclosingCheckout(path: string): string | undefined {
  let outermost: string | undefined;
  for (let directory = path; ; directory = dirname(directory)) {
    if (exists(join(directory, '.git'))) outermost = directory;
    if (dirname(directory) === directory) return outermost;
  }
}
function freshScratch(project: string) {
  const temp = realpathSync.native(tmpdir());
  if (!contains(project, temp) && !enclosingCheckout(temp)) return mkdtempSync(join(temp, 'opencrawl-files-'));
  const home = realpathSync.native(homedir());
  const fallback = join(home, '.cache', 'opencrawl', 'scratch');
  if (!contains(project, fallback) && !enclosingCheckout(home)) {
    mkdirSync(fallback, {recursive:true,mode:0o700});
    const directory = realpathSync.native(fallback);
    if (!contains(project, directory) && !enclosingCheckout(directory)) return mkdtempSync(join(directory, 'opencrawl-files-'));
  }
  throw new CliError('FILES_SCRATCH_UNAVAILABLE', 'Set TMPDIR to a writable directory outside the project.', 2);
}

export async function openSharedFiles(api: string, rawSession: unknown) {
  const session = rawSession ?? process.env.OPENCRAWL_SESSION_ID ?? process.env.CODEX_THREAD_ID ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (!nativeId(session)) throw new CliError('INVALID_USAGE', 'Pass --session with this agent session’s stable ID.', 64);
  checkPrivacy(api, session);
  const {repo} = await discoverRepo(api);
  await repairFilesGit(api, session);
  const key = bindingKey(api, repo, session);
  const remote = api + repo.remotePath;
  const cwd = realpathSync.native(process.cwd());
  const project = enclosingCheckout(cwd) ?? cwd;
  return withSessionLock('files:' + key, async () => {
    let binding = loadBinding(key);
    if (!binding || !exists(binding.scratch)) {
      binding = {remotePath:repo.remotePath, userId:repo.userId, tenantId:repo.tenantId, api, session, scratch:freshScratch(project)};
      atomicJson(recordFile(key), binding);
    }
    const {scratch} = binding;
    const directory = exists(scratch);
    if (!directory?.isDirectory() || (process.getuid && (directory.uid !== process.getuid() || (directory.mode & 0o077) !== 0)))
      throw new CliError('FILES_SCRATCH_UNSAFE', 'The file session directory is no longer private.', 2);
    const path = join(scratch, 'repo');
    if ((contains(project, path) && project !== path) || enclosingCheckout(realpathSync.native(scratch)))
      throw new CliError('FILES_SCRATCH_UNSAFE', 'The saved clone is inside a working project at ' + path + '. Your draft is preserved. Open a different file session.', 2);
    const hooks = join(scratch, 'hooks');
    mkdirSync(hooks, {mode:0o700, recursive:true});
    if (!exists(hooks)?.isDirectory()) throw new CliError('FILES_SCRATCH_UNSAFE', 'The private hooks directory was replaced.', 2);
    const hook = join(hooks, 'pre-push');
    atomicFile(hook, [
      '#!/bin/sh',
      '[ "$2" = ' + literal(remote, false) + ' ] || { echo "Use the enrolled shared-files remote." >&2; exit 1; }',
      'while read -r local_ref local_oid remote_ref remote_oid; do',
      '  if [ "$remote_ref" != refs/heads/main ] || [ "$local_ref" = "(delete)" ]; then',
      '    echo "Shared files accepts updates to main only." >&2; exit 1',
      '  fi',
      'done',
      ''
    ].join('\n'));
    chmodSync(hook, 0o700);
    if (exists(path)) {
      if (!exists(path)?.isDirectory() || !exists(join(path, '.git'))?.isDirectory())
        throw new CliError('FILES_CLONE_CHANGED', 'The original file session checkout was moved or replaced. Its files were preserved.', 2);
      const origin = await git('git', ['-C',path,'config','--local','--get','remote.origin.url'], {env:gitEnvironment()});
      if (origin.stdout.trimEnd() !== remote) throw new CliError('FILES_CLONE_CHANGED', 'The shared-files origin was changed. Restore its URL before reopening this session.', 2);
      return {path, remote, session, reused:true};
    }
    const stage = mkdtempSync(join(scratch, 'clone-'));
    const helper = '!' + credentialCommand(key);
    const config = ['credential.helper=', 'credential.helper=' + helper, 'credential.useHttpPath=true',
      'http.extraHeader=', 'http.followRedirects=false', 'core.hooksPath=' + hooks, 'core.symlinks=false',
      'user.name=OpenCrawl ' + session, 'user.email=agent-' + key.slice(0,16) + '@opencrawl.invalid'];
    if (process.platform === 'win32') config.push('core.longpaths=true');
    const env: NodeJS.ProcessEnv = {...gitEnvironment(), OPENCRAWL_API_URL:api};
    try {
      await git('git', ['clone', '--template=', ...config.flatMap(value => ['--config', value]), '--quiet',
        '--no-tags','--single-branch','--branch','main','--no-recurse-submodules','--',remote,stage],
        {cwd:scratch,env});
      renameSync(stage, path);
    } catch (error) {
      const unavailable = (error as NodeJS.ErrnoException).code === 'ENOENT';
      throw new CliError('FILES_CLONE_FAILED', unavailable ? 'Install Git to open shared files.' : 'Git could not clone the shared files. Check server access and retry.', 2);
    } finally { rmSync(stage, {force:true,recursive:true}); }
    return {path, remote, session, reused:false};
  }, 130000);
}

// Git's credential protocol sends a blank-line-terminated request. Store/erase
// are deliberate no-ops: the enrolled CLI owns token storage and renewal.
export async function sharedFileCredential(args: string[]) {
  if (args.length !== 2) return 1;
  if (args[1] === 'store' || args[1] === 'erase') return 0;
  if (args[1] !== 'get') return 1;
  try {
    // The origin comes from the installed Git configuration, never from the request on stdin.
    const target = args[0]!;
    const binding = /^[a-f0-9]{64}$/.test(target) ? loadBinding(target) : null;
    const api = binding?.api ?? apiOrigin(target);
    if (!binding && api !== target) return 1;
    let input = '';
    for await (const bytes of process.stdin) {
      input += bytes.toString();
      if (input.length > 16384) return 1;
    }
    const fields = new URLSearchParams();
    for (const line of input.split(/\r?\n/)) {
      if (!line) break;
      const at = line.indexOf('=');
      if (at < 1) return 1;
      const key = line.slice(0, at);
      if (!['host', 'protocol', 'path'].includes(key)) continue;
      if (fields.has(key)) return 1;
      fields.set(key, line.slice(at + 1));
    }
    const url = new URL(api);
    const path = '/' + (fields.get('path') ?? '');
    if (fields.get('host') !== url.host || fields.get('protocol') !== url.protocol.slice(0,-1) ||
        !(remotePathPattern.test(path) || clonePathPattern.test(path)) ||
        (binding && path !== binding.remotePath)) return 1;
    checkPrivacy(api, binding?.session);
    const {repo,token} = await discoverRepo(api);
    if (path !== repo.remotePath && path !== repo.clonePath) return 1;
    if (binding && bindingKey(api, repo, binding.session) !== target) return 1;
    if (/[\r\n\x00]/.test(token)) return 1;
    process.stdout.write('username=opencrawl\npassword=' + token + '\n\n');
    return 0;
  } catch { return 1; }
}
