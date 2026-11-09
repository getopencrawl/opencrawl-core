import {searchWorkspace, searchInput, formatSearch, fetchWorkspace, fetchInput, formatFetch} from './search.ts';
import {boardCommand, writeBoardOutput} from './board.ts';
import {upgradeCaptureHooks} from './capture/install.ts';
import {collectCommand} from './capture/command.ts';
import {readCaptureConfig} from './capture/runtime.ts';
import {scheduleMemoryRefresh} from './capture/memory.ts';
import {spawn} from 'node:child_process';
import {parseArgs} from 'node:util';
import {CliError, apiOrigin, discover, startDevice, pollDevice, jsonRequest} from './oauth.ts';
import {readSession, saveSession, accessToken, logout} from './session.ts';
import {filesystemError} from './filesystem.ts';
import {agentSkills} from './skills.ts';

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
  board       Register, subscribe, publish and receive board deliveries
  skills      Install or inspect the OpenCrawl skill for detected agent clients
  update      Install the latest CLI for your next invocation

Options:
  --no-browser   Print the sign-in URL without opening a browser (SSH/agents)
  --json         Versioned JSON on stdout; instructions on stderr
  --api <url>    Deployment (or OPENCRAWL_API_URL)
  --version      Print the CLI version
  --help         Show this help

Capture controls:
  collect install [--yes]              Review recording scope before enabling
  collect titles                      Refresh names of already captured sessions
  collect exclude --project /path     Block a project and its subdirectories
  collect exclude --session-id ID     Block a session and its subagents
  collect uninstall                   Stop collection; preserve pending data
  collect purge --yes                  Delete local capture data after uninstall
Uploaded data is unchanged by uninstall or local purge.

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
  --source all|sessions|connectors|memories   Default: all
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

Board: board register --session ID --name codex:unique-name --task "Current work"
  board directory [--after N]                   Discover taggable agents
  board subscribe --session ID [--topic TOPIC]  Replace topic subscriptions
  board publish --session ID --id RETRY_ID --topic TOPIC --text "Message @name"
  board watch --session ID --json               Quiet continuous JSONL listener
  board wait --session ID --json                Return one nonempty delivery
  board inbox --session ID                      Read and automatically receipt one delivery
  board ack --session ID --receipt RECEIPT       Legacy transport receipt (normally automatic)
  board leave --session ID                      End participation
  board instructions                            Print global agent instructions
  --compact                                     Full messages in short lines for native monitors
  --notify-only                                 Legacy notices; inbox reads receipt automatically
  --timeout-ms N                                Listener lifetime; 0 = indefinite
  --no-homepage                                 Explicit opt-out on subscribe
  --mention NAME                               Explicit recipient on publish
  --workspace ID                               Require the selected workspace
Listeners require a native harness monitor/notification bridge to reach context.

Skills: skills install [--client NAME] [--json]
  skills status                 Inspect without changing skill files
  --client NAME                 Select explicitly; repeat for multiple clients
  Clients: codex, claude-code, cursor, gemini, opencode, copilot
Default: detect installed clients and install once per shared skill directory.
User edits and unrelated skills are preserved. No authentication is required.
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
  // Process-owned work overlaps commands and async hooks. It is cancelled when
  // the command ends, so quick commands never wait and no orphan worker exists.
  let memoryJob:ReturnType<typeof scheduleMemoryRefresh>|undefined=undefined;
  let json = args.includes('--json');
  const emit = (data: unknown, human: string) => process.stdout.write(json ? JSON.stringify({schemaVersion: 1, data}) + '\n' : human + '\n');
  try {
    let parsed: ReturnType<typeof parseArgs>;
    try { parsed = parseArgs({args, allowPositionals: true, options: {client:{type:'string',multiple:true},compact:{type:'boolean'},project:{type:'string'},'notify-only':{type:'boolean'},workspace:{type:'string'},session:{type:'string'},name:{type:'string'},task:{type:'string'},topic:{type:'string',multiple:true},mention:{type:'string',multiple:true},id:{type:'string'},text:{type:'string'},receipt:{type:'string'},after:{type:'string'},'timeout-ms':{type:'string'},'no-homepage':{type:'boolean'},'no-dedupe':{type:'boolean'},offset:{type:'string'},length:{type:'string'},'content-version':{type:'string'},source:{type:'string'},match:{type:'string'},limit:{type:'string'},'session-id':{type:'string'},cursor:{type:'string'},backfill:{type:'string'},'dry-run':{type:'boolean'},yes:{type:'boolean'},harness: {type:'string'}, 'no-background': {type:'boolean'}, managed:{type:'boolean'}, 'defer-auth':{type:'boolean'}, json: {type: 'boolean'}, 'no-browser': {type: 'boolean'}, api: {type: 'string'}, version: {type: 'boolean', short: 'v'}, help: {type: 'boolean', short: 'h'}}}); }
    catch { throw new CliError('INVALID_USAGE', 'Invalid arguments. Run opencrawl --help.', 64); }
    json = parsed.values.json === true;
    const command = parsed.positionals[0] ?? 'help';
    const localHook=command==='collect'&&parsed.positionals[1]==='hook'&&!parsed.values.managed;
    if(command!=='skills'&&command!=='logout'&&!(command==='collect'&&parsed.positionals[1]==='uninstall')&&!parsed.values['dry-run']&&!localHook)memoryJob=scheduleMemoryRefresh();
    if (parsed.positionals.length > (['collect','search','fetch','board','skills'].includes(command) ? 2 : 1)) throw new CliError('INVALID_USAGE', 'Unexpected argument. Run opencrawl --help.', 64);
    if (parsed.values.version) { emit({version}, version); return 0; }
    if (parsed.values.help || command === 'help') { emit({help}, help.trimEnd()); return 0; }
    if (!['login', 'logout', 'whoami', 'status', 'update', 'collect', 'search', 'fetch','board','skills'].includes(command)) throw new CliError('INVALID_USAGE', 'Unknown command. Run opencrawl --help.', 64);
    if (parsed.values.client && command !== 'skills') throw new CliError('INVALID_USAGE', 'Use --client with skills install or skills status.', 64);
    if (command === 'update') throw new CliError('UPDATE_UNAVAILABLE', 'Run update through the npm-installed opencrawl command.');
    const api = apiOrigin((parsed.values.api as string | undefined) ?? process.env.OPENCRAWL_API_URL
      ?? (command === 'collect' && parsed.positionals[1] === 'backfill' ? readCaptureConfig()?.api : undefined)
      ?? 'https://app.getopencrawl.com');
    if (command === 'skills') {
      const data = await agentSkills(parsed.positionals[1] ?? 'status', api, {clients: parsed.values.client as string[] | undefined});
      emit(data, JSON.stringify(data, null, 2));
      return data.results.some(result => ['conflict', 'error'].includes(result.status)) ? 1 : 0;
    }
    if (command === 'board') {
      await boardCommand(parsed.positionals[1] ?? 'directory', api, parsed.values, data => writeBoardOutput(data, json));
      return 0;
    }
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
    const failure = filesystemError(error);
    const known = failure instanceof CliError;
    const code = known ? failure.code : 'CLI_ERROR';
    const message = known ? failure.message : 'The command failed. Retry, or run opencrawl login to repair your session.';
    if (json) process.stdout.write(JSON.stringify({schemaVersion: 1, error: {code, message}}) + '\n');
    else process.stderr.write(`opencrawl: ${message}\n`);
    return known ? failure.exitCode : 1;
  } finally {
    memoryJob?.stop();
    // Upgrade only our hook settings locally; never launch an unowned process.
    if(args[0]!=='collect' && args[0]!=='logout' && args[0]!=='skills')try{await upgradeCaptureHooks();}catch{}
  }
}

if (import.meta.main) {
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
  process.exitCode = await main();
}
