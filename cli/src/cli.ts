import {searchWorkspace, searchInput, formatSearch, fetchWorkspace, fetchInput, formatFetch} from './search.ts';
import {upgradeCaptureHooks} from './capture/install.ts';
import {collectCommand} from './capture/command.ts';
import {spawn} from 'node:child_process';
import {parseArgs} from 'node:util';
import {CliError, apiOrigin, discover, startDevice, pollDevice, jsonRequest} from './oauth.ts';
import {readSession, saveSession, accessToken, logout} from './session.ts';

declare const OPENCRAWL_VERSION: string;
const version = typeof OPENCRAWL_VERSION === 'string' ? OPENCRAWL_VERSION : '0.2.0-dev';
const help = `opencrawl — OpenCrawl CLI

Usage: opencrawl <command> [--json] [--api <https-origin>]

  login       Sign in with a browser approval and device code
  logout      Remove this deployment's credentials from this machine
  whoami      Verify your saved session with the service
  status      Show installation, sign-in and index availability
  search      Search session history and indexed workspace connectors
  fetch       Read the indexed passage behind a search result
  collect     Install and manage Claude/Codex session capture
  update      Install the latest CLI for your next invocation

Options:
  --no-browser   Print the sign-in URL without opening a browser (SSH/agents)
  --json         Versioned JSON on stdout; instructions on stderr
  --api <url>    Deployment (or OPENCRAWL_API_URL)
  --version      Print the CLI version
  --help         Show this help

History import (optional, asks during collect install):
  collect install --backfill skip       Set up future collection without history
  collect backfill                     Choose history sources interactively
  collect backfill --dry-run --json     Preview local transcript counts; no upload
  collect backfill --harness all --yes  Import after the user approves
  --harness claude-code|codex|all        Limit the history import to chosen sources
  collect install --backfill claude-code|codex|all  Explicit setup import choice
Agents: ask the user to choose Claude, Codex, both, or skip before importing.
History includes messages, tool arguments/results and available attachments.

Search: opencrawl search "words" --json
  --source all|sessions|connectors   Default: all
  --match any|all|phrase                    Default: any; all requires every term
  --limit 1..40                     Default: 10
  --session-id ID                   Narrow a sessions-only query
  --cursor TOKEN                    Next live page; repeat the same arguments
  --no-dedupe                       Show all equivalent passage occurrences
Search returns compact verbatim excerpts. Expand with opencrawl fetch <result-id>.
  --offset N --length 1..16000       Read a passage in parts (default length: 6000)
  --content-version VERSION         Detect changes between fetch pages
Use OPENCRAWL_TOKEN for a self-hosted bearer token; otherwise uses saved login.
Updates run automatically before ordinary commands, at most once per day.
OPENCRAWL_NO_UPDATE=1 disables automatic updates.
`;

function openBrowser(url: string) {
  const command = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler', url] : ['xdg-open', url];
  const child = spawn(command[0], command.slice(1), {stdio: 'ignore', detached: true, shell: false});
  child.on('error', () => {});
  child.unref();
}

export async function identity(api: string, fetcher = fetch, initialToken?: string) {
  let token = initialToken ?? await accessToken(api, undefined, fetcher);
  let result = await jsonRequest(`${api}/api/cli/me`, {headers: {authorization: `Bearer ${token}`}}, fetcher);
  if (result.response.status === 401 && !initialToken) {
    token = await accessToken(api, token, fetcher);
    result = await jsonRequest(`${api}/api/cli/me`, {headers: {authorization: `Bearer ${token}`}}, fetcher);
  }
  if (result.response.status === 401) throw new CliError('AUTH_REQUIRED', 'Your session expired. Run opencrawl login again.', 2);
  if (result.response.status === 403) {
    if (result.body.error?.code === 'ORGANIZATION_REQUIRED') throw new CliError('ORGANIZATION_REQUIRED', `Create or join a team at ${api}/organizations, then run opencrawl login again.`, 2);
    if (result.body.error?.code === 'EMAIL_VERIFICATION_REQUIRED') throw new CliError('AUTH_FORBIDDEN', 'Verify your email address before using the CLI.', 2);
    throw new CliError('AUTH_FORBIDDEN', 'This account cannot access the deployment. Open it in your browser to check access.', 2);
  }
  if (!result.response.ok || result.body.schemaVersion !== 1 || typeof result.body.data?.user?.id !== 'string') throw new CliError('INVALID_RESPONSE', 'Could not verify your session with this deployment.');
  return {id: result.body.data.user.id, email: typeof result.body.data.user.email === 'string' ? result.body.data.user.email : null};
}

export async function main(args = process.argv.slice(2)) {
  let json = args.includes('--json');
  const emit = (data: unknown, human: string) => process.stdout.write(json ? JSON.stringify({schemaVersion: 1, data}) + '\n' : human + '\n');
  try {
    let parsed: ReturnType<typeof parseArgs>;
    try { parsed = parseArgs({args, allowPositionals: true, options: {'no-dedupe':{type:'boolean'},offset:{type:'string'},length:{type:'string'},'content-version':{type:'string'},source:{type:'string'},match:{type:'string'},limit:{type:'string'},'session-id':{type:'string'},cursor:{type:'string'},backfill:{type:'string'},'dry-run':{type:'boolean'},yes:{type:'boolean'},harness: {type:'string'}, 'no-background': {type:'boolean'}, managed:{type:'boolean'}, 'defer-auth':{type:'boolean'}, json: {type: 'boolean'}, 'no-browser': {type: 'boolean'}, api: {type: 'string'}, version: {type: 'boolean', short: 'v'}, help: {type: 'boolean', short: 'h'}}}); }
    catch { throw new CliError('INVALID_USAGE', 'Invalid arguments. Run opencrawl --help.', 64); }
    json = parsed.values.json === true;
    const command = parsed.positionals[0] ?? 'help';
    if (parsed.positionals.length > (['collect','search','fetch'].includes(command) ? 2 : 1)) throw new CliError('INVALID_USAGE', 'Unexpected argument. Run opencrawl --help.', 64);
    if (parsed.values.version) { emit({version}, version); return 0; }
    if (parsed.values.help || command === 'help') { emit({help}, help.trimEnd()); return 0; }
    if (!['login', 'logout', 'whoami', 'status', 'update', 'collect', 'search', 'fetch'].includes(command)) throw new CliError('INVALID_USAGE', 'Unknown command. Run opencrawl --help.', 64);
    if (command === 'update') throw new CliError('UPDATE_UNAVAILABLE', 'Run update through the npm-installed opencrawl command.');
    const api = apiOrigin((parsed.values.api as string | undefined) ?? process.env.OPENCRAWL_API_URL ?? 'https://app.getopencrawl.com');
    if (command === 'fetch') {
      const data = await fetchWorkspace(api, fetchInput(parsed.positionals[1], parsed.values));
      emit(data, formatFetch(data));
      return 0;
    }
    if (command === 'search') {
      const input = searchInput(parsed.positionals[1], parsed.values);
      const data = await searchWorkspace(api, input);
      emit(data, formatSearch(data));
      return data.partial || data.coverage.every((c: any) => c.state !== 'ready') ? 1 : 0;
    }
    if(command === 'collect') {
      const data=await collectCommand(parsed.positionals[1]??'status',api,parsed.values);
      if(data!==null)emit(data,JSON.stringify(data,null,2));
      return 0;
    }
    if (command === 'logout') { await logout(api); emit({api, authenticated: false, localCredentialsRemoved: true}, 'Removed saved credentials from this machine.'); return 0; }
    if (command === 'login') {
      const auth = await discover(api);
      const device = await startDevice(auth);
      const url = device.verification_uri_complete ?? device.verification_uri;
      process.stderr.write(`Open ${url}\nConfirm code: ${device.user_code}\nWaiting for browser approval (expires in ${device.expires_in} seconds)…\n`);
      if (!parsed.values['no-browser'] && process.stdin.isTTY && !process.env.SSH_CONNECTION && !process.env.SSH_TTY) openBrowser(url);
      const tokens = await pollDevice(auth, device);
      const user = await identity(api, fetch, tokens.accessToken);
      await saveSession(api, {auth, ...tokens});
      emit({api, authenticated: true, user}, `Signed in${user.email ? ` as ${user.email}` : ''}. Use opencrawl search to query indexed workspace knowledge.`);
      return 0;
    }
    if (command === 'status' && !readSession(api)) {
      emit({api, version, authenticated: false, index: {available: null}}, `opencrawl ${version}\nNot signed in. Run opencrawl login.\nUse opencrawl search to check indexed workspace knowledge.`);
      return 0;
    }
    const user = await identity(api);
    emit({api, version, authenticated: true, user, ...(command === 'status' ? {index: {available: null}} : {})}, command === 'status' ? `opencrawl ${version}\nSigned in${user.email ? ` as ${user.email}` : ''}.\nUse opencrawl search to check indexed workspace knowledge.` : user.email ?? user.id);
    return 0;
  } catch (error) {
    const known = error instanceof CliError;
    const code = known ? error.code : 'CLI_ERROR';
    const message = known ? error.message : 'The command failed. Retry, or run opencrawl login to repair your session.';
    if (json) process.stdout.write(JSON.stringify({schemaVersion: 1, error: {code, message}}) + '\n');
    else process.stderr.write(`opencrawl: ${message}\n`);
    return known ? error.exitCode : 1;
  } finally {
    // Upgrade only our hook settings locally; never launch an unowned process.
    if(args[0]!=='collect' && args[0]!=='logout')try{await upgradeCaptureHooks();}catch{}
  }
}

if (import.meta.main) {
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
  process.exitCode = await main();
}
