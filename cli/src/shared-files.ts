import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {isAbsolute, join, relative, sep} from 'node:path';
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
type Repo = {tenantId: string; userId: string; remotePath: string};
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
function checkPrivacy(api: string, session: string) {
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
      typeof repo.remotePath !== 'string' || !remotePathPattern.test(repo.remotePath))
    throw new CliError('FILES_PROTOCOL_ERROR', 'Invalid shared-files discovery response.', 2);
  return {repo, token};
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
  const env = {...process.env, GIT_TERMINAL_PROMPT: '0'};
  for (const key of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_COMMON_DIR','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete (env as NodeJS.ProcessEnv)[key];
  return env;
}
async function projectRoot() {
  const cwd = realpathSync(process.cwd());
  try { return realpathSync((await git('git', ['rev-parse','--show-toplevel'], {cwd,env:gitEnvironment()})).stdout.trimEnd()); }
  catch { return cwd; }
}
function freshScratch(project: string) {
  const temp = realpathSync(tmpdir());
  if (!contains(project, temp)) return mkdtempSync(join(temp, 'opencrawl-files-'));
  const home = realpathSync(homedir());
  const fallback = join(home, '.cache', 'opencrawl', 'scratch');
  if (!contains(project, fallback)) {
    mkdirSync(fallback, {recursive:true,mode:0o700});
    const directory = realpathSync(fallback);
    if (!contains(project, directory)) return mkdtempSync(join(directory, 'opencrawl-files-'));
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
  const project = await projectRoot();
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
    if (contains(project, path) && project !== path) throw new CliError('FILES_SCRATCH_UNSAFE', 'The saved file session is inside the working project.', 2);
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
    // Git invokes credential helpers with sh on every platform (including Git for Windows).
    const helper = '!' + [...commandForSelf(), 'files-credential', key].map(word => literal(word, false)).join(' ');
    const config = ['credential.helper=', 'credential.helper=' + helper, 'credential.useHttpPath=true',
      'http.followRedirects=false', 'core.hooksPath=' + hooks, 'core.symlinks=false',
      'user.name=OpenCrawl ' + session, 'user.email=agent-' + key.slice(0,16) + '@opencrawl.invalid'];
    const env: NodeJS.ProcessEnv = {...gitEnvironment(), OPENCRAWL_API_URL:api};
    try {
      await git('git', ['clone', ...config.flatMap(value => ['--config', value]), '--quiet',
        '--no-tags','--single-branch','--branch','main','--no-recurse-submodules','--',remote,stage],
        {cwd:scratch,env,timeout:120000});
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
    const b = loadBinding(args[0]!);
    if (!b) return 1;
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
    const url = new URL(b.api);
    if (fields.get('host') !== url.host || fields.get('protocol') !== url.protocol.slice(0,-1) ||
        fields.get('path') !== b.remotePath.slice(1)) return 1;
    checkPrivacy(b.api, b.session);
    const {repo,token} = await discoverRepo(b.api);
    if (bindingKey(b.api, repo, b.session) !== args[0] || /[\r\n\x00]/.test(token)) return 1;
    process.stdout.write('username=opencrawl\npassword=' + token + '\n\n');
    return 0;
  } catch { return 1; }
}

