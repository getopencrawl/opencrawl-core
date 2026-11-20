import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {dirname, isAbsolute, join, relative, sep} from 'node:path';
import {promisify} from 'node:util';
import {commandForSelf, readCaptureConfig} from './capture/runtime.ts';
import {nativeId} from './context-check-events.ts';
import {literal} from './hook-runner.ts';
import {sessionPrivate} from './incognito-state.ts';
import {apiOrigin, CliError, jsonRequest} from './oauth.ts';
import {accessToken, atomicFile, atomicJson, configDir, withSessionLock} from './session.ts';
import {configuredToken, workspaceIdentityEnabled} from './workspace-identity.ts';

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
async function discoverRepo(api: string) {
  const configured = await configuredToken('OPENCRAWL_TOKEN', api);
  let token = configured || await accessToken(api);
  const request = () => jsonRequest(api + '/api/files', {headers: {authorization: 'Bearer ' + token}});
  let result = await request();
  if (result.response.status === 401 && (!configured || workspaceIdentityEnabled())) {
    token = await configuredToken('OPENCRAWL_TOKEN', api, token) || await accessToken(api, token);
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
  const {repo} = await discoverRepo(api);
  return api + (repo.clonePath ?? repo.remotePath);
}
function credentialCommand(target:string) {
  // Git runs shell credential helpers through sh, including on Windows.
  const entry = commandForSelf().map(word => process.platform === 'win32' ? word.replaceAll('\\', '/') : word);
  return '!' + [...entry, 'files-credential', target].map(word => literal(word, false)).join(' ');
}

export async function setupFilesGit(api:string) {
  const name = createHash('sha256').update(api).digest('hex') + '.gitconfig';
  const file = join(configDir(), 'files', name);
  const helper = JSON.stringify(credentialCommand(api));
  const config = ['/git/', '/api/files/'].map(prefix => {
    const scope = JSON.stringify(api + prefix);
    return ['[credential ' + scope + ']', '  useHttpPath = true', '  helper =', '  helper = ' + helper,
      '[http ' + scope + ']', '  extraHeader =', '  followRedirects = false'].join('\n');
  }).join('\n') + '\n';
  atomicFile(file, config);
  const include = process.platform === 'win32' ? file.replaceAll('\\','/') : file;
  await git('git', ['config','--global','--fixed-value','--replace-all','include.path',include,include], {env:gitEnvironment()});
  return {api,config:file};
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
    const helper = credentialCommand(key);
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

