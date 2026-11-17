import {searchWorkspace, searchInput, formatSearch, fetchWorkspace, fetchInput, formatFetch} from './search.ts';
import {boardCommand, boardInput, writeBoardOutput} from './board.ts';
import {fetchMany} from './fetch-many.ts';
import {commandHelp} from './help.ts';
import {upgradeCaptureHooks} from './capture/install.ts';
import {scheduleDaemonUpgrade} from './capture/daemon-upgrade-launch.ts';
import {collectCommand} from './capture/command.ts';
import {readCaptureConfig} from './capture/runtime.ts';
import {scheduleMemoryRefresh} from './capture/memory.ts';
import {scheduleCliUpdate,updateCli} from './update.ts';
import {spawn} from 'node:child_process';
import {parseArgs, stripVTControlCharacters} from 'node:util';
import {CliError, apiOrigin, discover, startDevice, pollDevice, jsonRequest, DEFAULT_API_ORIGIN} from './oauth.ts';
import {readSession, saveSession, accessToken, logout, selectOrganization, exitAfterCredentialRotation} from './session.ts';
import {filesystemError} from './filesystem.ts';
import {agentSkills} from './skills.ts';
import {refreshManagedSkills} from './skill-activation.ts';
import {withEnvironmentTokenOrigin} from './environment-token.ts';
import {configuredToken, workspaceIdentityEnabled} from './workspace-identity.ts';
import {tokenCommand} from './token.ts';
import {version,delegateToNewest,installBinary,compiled,cacheRoot,read as readDistributionState} from './distribution.ts';
import {migrateLegacyLauncher,findLegacyLaunchers} from './legacy-migration.ts';
import {join} from 'node:path';
import {atomicJson} from './session.ts';
import {sessionStartCommand} from './session-start.ts';
import {applyDaemonEnvironment} from './capture/daemon-environment.ts';
import {hasPluginContext} from './setup/plugin-context.ts';
import {setupCommand,localSetupStatus,setupHookStatus,formatSetupOutput} from './setup/command.ts';
import {wakeApprovedHistory} from './setup/history-worker.ts';
import {verifyInstallation,formatInstallationVerification} from './verify-installation.ts';
import {searchContextCommand} from './search-context.ts';

const help = `opencrawl — OpenCrawl CLI

Usage: opencrawl <command> [--json] [--api <https-origin>]

  setup       Sign in, choose plugins and recording, and import history in the background
  verify-installation  Prove a selected client's fresh session is searchable
  login       Sign in with a browser approval and device code
  logout      Remove this deployment's credentials from this machine
  whoami      Verify your saved session or environment token with the service
  status      Show installation, sign-in and index availability
  search      Search session history and indexed workspace connectors
  mcp         Serve the configured OpenCrawl MCP over stdio
  workload    Connect a cloud organization with one-time admin approval
  fetch       Read the indexed passage behind a search result
  collect     Install and manage Claude Code, Codex, Cursor, Antigravity and Grok Bot session capture
  board       Register, subscribe, publish and receive board deliveries
  skills      Install or inspect the OpenCrawl skill for detected agent clients
  session     Bootstrap a native SessionStart hook (session start --harness NAME)
  token       Create or revoke an agent access token for machines created per task
  install     Install this native executable in your user bin directory
  update      Install the latest CLI for your next invocation

Options:
  --organization <org_ID>  Select a workspace with login using your saved sign-in
  --no-browser   Print the sign-in URL without opening a browser (SSH/agents)
  --json         Versioned JSON on stdout; instructions on stderr
  --api <url>    Server (overrides OPENCRAWL_API_URL and saved capture config)
  --version      Print the CLI version
  --help         Show this help

Capture controls:
  collect install [--yes]              Review recording scope before enabling
  collect install --harness cursor     Capture new Cursor conversations
  collect install --harness grok-bot   Capture Grok Bot; run on the Bot's cloud computer
  collect titles                      Refresh names of already captured sessions
  collect exclude --project /path     Block a project and its subdirectories
  collect exclude --session-id ID     Block a session and its subagents
  collect uninstall                   Stop collection; preserve pending data
  collect purge --yes                  Delete local capture data after uninstall
Uploaded data is unchanged by uninstall or local purge.

History import (optional, asks during collect install):
  collect install --backfill skip       Set up future collection without history
  collect backfill                     Choose history sources interactively
  collect flush --retry-rejected       Retry held HTTP 413 batches after fixing the receiver limit
  collect backfill --dry-run --json     Preview local transcript counts; no upload
  collect backfill --harness all --yes  Import after the user approves
  --harness claude-code|codex|antigravity|all  Limit the history import to chosen sources
  --concurrency 1..4                    History upload workers (default: 4)
  --batch-delay-ms 0..60000              Minimum gap between batch starts (default: 0)
  collect install --backfill claude-code|codex|antigravity|all  Explicit setup import choice
Agents: ask the user to choose Claude, Codex, Antigravity, all, or skip before importing.
History includes messages, tool arguments/results and available attachments.

Search: opencrawl search "words" --json
  On supporting servers, defaults exclude tool output and the identified current chat.
  Missing data.searchContext leaves defaults and current-chat exclusion unconfirmed.
  The three context options below require server support.
  --include-tool-outputs            Include tool/command output for debugging and verification
  --include-current-session         Include the calling chat
  --current-session JSON            Exact {"harness":"codex","sessionId":"native-chat-id"}
  --source all|sessions|connectors|memories   Default: all
  --match any|all|phrase                    Default: any; all requires every term
  --limit 1..40                     Default: 10
  --session-id ID                   Narrow a sessions-only query
  --filters JSON                   Exact roles/authors/kinds/providers/repositories/harnesses/origins/sessionIds/projects/paths
  --role user|assistant             Session role filter
  --after ISO --before ISO          Original message/memory time bounds
  --order relevance|newest|oldest    Empty query allowed with time order
  --facets source,kind,provider     Counts over authorized candidates, not the whole corpus
  --select title,provenance         Omit text for cheap discovery; fetch selected IDs
  --group-by resource|session|none  Default: resource
  --excerpt-chars 100..2000         Default: 800
  --cursor TOKEN                    Next live page; repeat the same arguments
  --no-dedupe                       Show all equivalent passage occurrences
Search returns compact verbatim excerpts. Expand with opencrawl fetch ID [ID ...].
  --concurrency 1..8                Fetch independent references (default: 8, max 40)
Run opencrawl fetch --help for paging and partial-failure output.
Run opencrawl board fetch --help for message/session references and JSON examples.
  --offset N --length 1..16000       Read a passage in parts (default length: 6000)
  --content-version VERSION         Detect changes between fetch pages
Environment tokens use OpenCrawl cloud by default. Use --api or OPENCRAWL_API_URL
to send them to a self-hosted deployment. Without a token, the CLI uses saved login.

Replicas workspaces (an OpenCrawl admin connects the organization once):
  Agent setup > Install on Replicas   Copy the prompt into the intended workspace
  OPENCRAWL_API_URL=<origin> OPENCRAWL_AUTH=replicas-workspace
New environments and personal forks use the same approved organization connection.
No per-environment approval or permanent API key is required.
Remove shared OPENCRAWL_TOKEN and OPENCRAWL_SESSIONS_TOKEN from that environment.
The CLI renews workspace identity in memory; configure native workspace_identity
for the Replicas MCP separately. Workloads read shared team data, not human private data.

Other machines created per task (use a personal environment):
  token create [--env-file PATH]     One-year token for search, the board, MCP and uploads
  token revoke ID                    End a token; needs your own sign-in, like create
Store OPENCRAWL_API_URL, OPENCRAWL_TOKEN and OPENCRAWL_SESSIONS_TOKEN in the platform's
environment secrets instead of signing in on every new machine. --env-file writes them
to a new private file and prints no secret.
Updates are checked opportunistically every 3–6 hours, including capture hooks and workers.
OPENCRAWL_NO_UPDATE=1 disables automatic updates.

Board: board register --session ID --name codex:unique-name --task "Current work"
  board profile --session ID --name NAME --task "Current work"  Name a bootstrapped session
  board directory [--after N]                   Discover taggable agents
  board fetch --id REF                          Expand selected discovery content
  --field firstUserMessage|lastUserMessage|latestAssistantMessage|context
  --offset N --length 1..8000 --content-version VERSION   Page selected text
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
  --mention NAME                               Explicit recipient on publish
  --workspace ID                               Require the selected workspace
Listeners require a native harness monitor/notification bridge to reach context.

Skills: skills install [--client NAME] [--json]
  skills status                 Inspect without changing skill files
  skills refresh                Regenerate the CLI-owned opencrawl skill
  --client NAME                 Select explicitly; repeat for multiple clients
  Clients: codex, claude-code, antigravity, cursor, gemini, opencode, copilot
Default: detect installed clients and install once per shared skill directory.
CLI updates regenerate opencrawl, replacing local edits and stale files. Other named skills are separate.
No authentication is required.
`;

function openBrowser(url: string) {
  const command = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler', url] : ['xdg-open', url];
  const child = spawn(command[0], command.slice(1), {stdio: 'ignore', detached: true, shell: false});
  child.on('error', () => {});
  child.unref();
}

function organizationRequired(api: string, value: unknown) {
  const workspaces: NonNullable<CliError['workspaces']> = [];
  if (Array.isArray(value)) for (const entry of value.slice(0, 100) as unknown[]) {
    if (!entry || typeof entry !== 'object' || !('id' in entry) || !('name' in entry) || typeof entry.id !== 'string' || !/^org_[A-Za-z0-9]+$/.test(entry.id)
      || !(typeof entry.name === 'string' || entry.name === null) || workspaces.some(item => item.id === entry.id)) continue;
    const name = typeof entry.name === 'string' ? stripVTControlCharacters(entry.name).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 200) : null;
    workspaces.push({id: entry.id, name});
  }
  const message = workspaces.length
    ? `Choose a workspace for this CLI:\n${workspaces.map(workspace => `${workspace.name || workspace.id} (${workspace.id}): opencrawl login --organization ${workspace.id} --api ${api}`).join('\n')}`
    : `Open ${api}/organizations in your browser to create or join a team, then run opencrawl whoami --api ${api}. If you already belong to several teams, select one with opencrawl login --organization org_ID --api ${api}.`;
  const error = new CliError('ORGANIZATION_REQUIRED', message, 2);
  if (Array.isArray(value)) error.workspaces = workspaces;
  return error;
}

export async function identity(api: string, fetcher = fetch, initialToken?: string): Promise<{
  user: {id: string; email: string | null}; workspace?: {id: string; name: string | null};
}> {
  let token = initialToken ?? await accessToken(api, undefined, fetcher);
  let result = await jsonRequest(`${api}/api/cli/me`, {headers: {authorization: `Bearer ${token}`}}, fetcher);
  if (result.response.status === 401 && (!initialToken || workspaceIdentityEnabled())) {
    token = workspaceIdentityEnabled() ? (await configuredToken('OPENCRAWL_TOKEN', api, token))! : await accessToken(api, token, fetcher);
    result = await jsonRequest(`${api}/api/cli/me`, {headers: {authorization: `Bearer ${token}`}}, fetcher);
  }
  if (result.response.status === 401) throw new CliError('AUTH_REQUIRED', 'Your session expired. Run opencrawl login again.', 2);
  if (result.response.status === 403) {
    if (result.body.schemaVersion === 1 && result.body.error?.code === 'ORGANIZATION_REQUIRED') throw organizationRequired(api, result.body.error.workspaces);
    if (result.body.error?.code === 'EMAIL_VERIFICATION_REQUIRED') throw new CliError('AUTH_FORBIDDEN', 'Verify your email address before using the CLI.', 2);
    throw new CliError('AUTH_FORBIDDEN', 'This account cannot access the deployment. Open it in your browser to check access.', 2);
  }
  if (!result.response.ok || result.body.schemaVersion !== 1 || typeof result.body.data?.user?.id !== 'string') throw new CliError('INVALID_RESPONSE', 'Could not verify your session with this deployment.');
  const user = {id: result.body.data.user.id, email: typeof result.body.data.user.email === 'string' ? result.body.data.user.email : null};
  // Display only the workspace resolved by the server; older deployments may
  // omit it, and a missing display name does not invalidate a verified ID.
  const workspace: unknown = result.body.data.workspace;
  if (workspace && typeof workspace === 'object' && 'id' in workspace && typeof workspace.id === 'string' && workspace.id.trim()
    && 'name' in workspace && (typeof workspace.name === 'string' || workspace.name === null)) {
    return {user, workspace: {id: workspace.id, name: workspace.name}};
  }
  return {user};
}

export async function loginIdentity(api:string,options:{organizationId?:string;noBrowser?:boolean}={}) {
  const organizationId=options.organizationId;
  if(organizationId&&readSession(api))return selectOrganization(api,organizationId,token=>identity(api,fetch,token));
      const auth = await discover(api);
      const device = await startDevice(auth);
      const url = device.verification_uri_complete ?? device.verification_uri;
      process.stderr.write(`Open ${url}\nConfirm code: ${device.user_code}\nWaiting for browser approval (expires in ${device.expires_in} seconds)…\n`);
      if (!options.noBrowser && process.stdin.isTTY && !process.env.SSH_CONNECTION && !process.env.SSH_TTY) openBrowser(url);
      const tokens = await pollDevice(auth, device);
      let verified: Awaited<ReturnType<typeof identity>> | undefined;
      try { verified = await identity(api, fetch, tokens.accessToken); }
      catch (error) {
        // The service verifies the account and session before returning this
        // specific setup requirement. Retain that sign-in without claiming
        // workspace access or repeating device approval after browser setup.
        if (error instanceof CliError && error.code === 'ORGANIZATION_REQUIRED') {
          if (!organizationId) {
            await saveSession(api, {auth, ...tokens});
            error.message = `Your sign-in is saved on this machine; workspace setup is still required. ${error.message}`;
            throw error;
          }
        } else throw error;
      }
      if (organizationId) verified = await selectOrganization(api, organizationId, token => identity(api, fetch, token), {auth, ...tokens});
      if (!verified) throw new CliError('INVALID_RESPONSE', 'Could not verify the selected workspace.');
      if (!organizationId) await saveSession(api, {auth, ...tokens});
  return verified;
}

const hasLocalFlag=(args:string[])=>args.some(arg=>arg==='--local'||arg.startsWith('--local='));

export async function main(args = process.argv.slice(2)) {
  if(args[0]==='workload'){applyDaemonEnvironment(args);return (await import('./workload-enrollment.ts')).workloadCommand(args.slice(1));}
  if(args[0]==='mcp'){applyDaemonEnvironment(args);return (await import('./mcp.ts')).mcpCommand(args.slice(1));}
  if(args[0]==='search-context'){applyDaemonEnvironment(args);return searchContextCommand(args.slice(1));}
  if (args[0] === 'session' && args[1] === 'start' && !hasLocalFlag(args)) {
    applyDaemonEnvironment(args);
    if(!hasPluginContext()&&readCaptureConfig()?.hookOwnership!=='plugin'){
      await automaticNativeMigration();
      try{scheduleDaemonUpgrade();}catch{}
      try{wakeApprovedHistory();}catch{}
    }
    return sessionStartCommand(args.slice(2));
  }
  // Process-owned work overlaps commands and async hooks. It is cancelled when
  // the command ends, so quick commands never wait and no orphan worker exists.
  const memoryJob:{current?:ReturnType<typeof scheduleMemoryRefresh>}={};
  let updateJob:ReturnType<typeof scheduleCliUpdate>|undefined;
  let installingBinary=false;
  let informational=hasLocalFlag(args);
  let json = args.includes('--json');
  const emit = (data: unknown, human: string) => process.stdout.write(json ? JSON.stringify({schemaVersion: 1, data}) + '\n' : human + '\n');
  try {
    applyDaemonEnvironment(args);
    let parsed: ReturnType<typeof parseArgs>;
    try { parsed = parseArgs({args, allowPositionals: true, options: {context:{type:'boolean'},'current-session':{type:'string'},'include-current-session':{type:'boolean'},'include-tool-outputs':{type:'boolean'},'worker-environment':{type:'string'},local:{type:'boolean'},plugins:{type:'string'},forward:{type:'string'},history:{type:'string'},'plan-id':{type:'string'},'scope-key':{type:'string'},'installation-id':{type:'string'},organization:{type:'string'},'env-file':{type:'string'},filters:{type:'string'},before:{type:'string'},role:{type:'string'},order:{type:'string'},facets:{type:'string'},select:{type:'string'},'group-by':{type:'string'},'excerpt-chars':{type:'string'},field:{type:'string'},client:{type:'string',multiple:true},compact:{type:'boolean'},project:{type:'string'},'notify-only':{type:'boolean'},workspace:{type:'string'},session:{type:'string'},name:{type:'string'},task:{type:'string'},topic:{type:'string',multiple:true},mention:{type:'string',multiple:true},id:{type:'string'},text:{type:'string'},receipt:{type:'string'},after:{type:'string'},'timeout-ms':{type:'string'},'no-dedupe':{type:'boolean'},offset:{type:'string'},length:{type:'string'},'content-version':{type:'string'},source:{type:'string'},match:{type:'string'},limit:{type:'string'},'session-id':{type:'string'},cursor:{type:'string'},concurrency:{type:'string'},'batch-delay-ms':{type:'string'},backfill:{type:'string'},'dry-run':{type:'boolean'},'retry-rejected':{type:'boolean'},yes:{type:'boolean'},harness: {type:'string'}, event: {type:'string'}, 'no-background': {type:'boolean'}, managed:{type:'boolean'}, daemon:{type:'boolean'}, 'defer-auth':{type:'boolean'}, json: {type: 'boolean'}, 'no-browser': {type: 'boolean'}, api: {type: 'string'}, version: {type: 'boolean', short: 'v'}, help: {type: 'boolean', short: 'h'}}}); }
    catch { throw new CliError('INVALID_USAGE', 'Invalid arguments. Run opencrawl --help.', 64); }
    json = parsed.values.json === true;
    const command = parsed.positionals[0] ?? 'help';
    installingBinary=command==='install';
    if(parsed.values.local&&!(command==='setup'&&parsed.positionals[1]==='status'))throw new CliError('INVALID_USAGE','Use --local only with setup status.',64);
    const localHook=command==='collect'&&parsed.positionals[1]==='hook'&&!parsed.values.managed;
    // Metadata-only recovery and a history preview must not start an unrelated
    // memory upload while the foreground operation is inspecting local state.
    const localCollect=command==='collect'&&(['uninstall','titles'].includes(parsed.positionals[1]??'')||parsed.positionals[1]==='backfill'&&!parsed.values.yes);
    const manyFetch=command==='fetch'||command==='board'&&parsed.positionals[1]==='fetch';
    if (parsed.positionals.length > (manyFetch ? command==='board'?42:41 : command === 'token' ? 3 : ['collect','search','board','skills','setup'].includes(command) ? 2 : 1)) throw new CliError('INVALID_USAGE', 'Unexpected argument. Run opencrawl --help.', 64);
    informational=hasLocalFlag(args)||Boolean(parsed.values.help||parsed.values.version||command==='help'||command==='board'&&!parsed.positionals[1]);
    if (parsed.values.version) { emit({version}, version); return 0; }
    if (parsed.values.help || command === 'help' || command==='board'&&!parsed.positionals[1]) { const text=commandHelp(command,parsed.positionals[1])??help;emit({help:text}, text.trimEnd()); return 0; }
    if (!['login', 'logout', 'whoami', 'status', 'setup', 'verify-installation', 'install', 'update', 'collect', 'search', 'fetch','board','skills','token'].includes(command)) throw new CliError('INVALID_USAGE', 'Unknown command. Run opencrawl --help.', 64);
    if (['login','token'].includes(command) && workspaceIdentityEnabled()) throw new CliError('WORKLOAD_ACCOUNT_ACTION', 'Workspace identity cannot manage human sign-ins or credentials. Use your personal machine for account setup.', 2);
    const organizationId = parsed.values.organization as string | undefined;
    if (organizationId !== undefined && (command !== 'login' || !/^org_[A-Za-z0-9]+$/.test(organizationId))) throw new CliError('INVALID_USAGE', 'Use login --organization with an organization ID such as org_123.', 64);
    if (organizationId && process.env.OPENCRAWL_TOKEN?.trim()) throw new CliError('ENVIRONMENT_TOKEN_ACTIVE', 'Unset OPENCRAWL_TOKEN before selecting a workspace with your saved sign-in. Environment tokens remain bound to the workspace that issued them.', 2);
    if (parsed.values.client && !['skills','setup','verify-installation'].includes(command)) throw new CliError('INVALID_USAGE', 'Use --client with skills or installation verification.', 64);
    if(parsed.values.local){const data=localSetupStatus((parsed.values.api as string|undefined)??process.env.OPENCRAWL_API_URL);emit(data,formatSetupOutput(data));return 0;}
    if(command==='setup'&&parsed.positionals[1]==='hooks'){const data=await setupHookStatus((parsed.values.api as string|undefined)??process.env.OPENCRAWL_API_URL);emit(data,formatSetupOutput(data));return 0;}
    if(command==='setup'||command==='verify-installation'){
      const api=apiOrigin((parsed.values.api as string|undefined)??process.env.OPENCRAWL_API_URL??readCaptureConfig()?.api??DEFAULT_API_ORIGIN);
      return await withEnvironmentTokenOrigin((parsed.values.api as string|undefined)??process.env.OPENCRAWL_API_URL,async()=>{
        if(command==='verify-installation'){
          const client=parsed.values.client as string[]|undefined,installationId=parsed.values['installation-id'] as string|undefined;
          if(client?.length!==1)throw new CliError('INVALID_USAGE','Use verify-installation --client CLIENT [--installation-id ID].',64);
          const data=installationId?await verifyInstallation(api,{installationId,client:client[0]}):await setupCommand('verify',api,parsed.values);
          if(data!==null)emit(data,'proof' in data?formatInstallationVerification(data):formatSetupOutput(data));return 0;
        }
        const data=await setupCommand(parsed.positionals[1]??'run',api,parsed.values,{login:()=>loginIdentity(api,{noBrowser:parsed.values['no-browser']===true})});
        if(data!==null)emit(data,formatSetupOutput(data));return 0;
      });
    }
    const captureHandoff=command==='collect'&&['hook','daemon','upgrade-daemon'].includes(parsed.positionals[1]??'');
    if(command!=='install'&&!captureHandoff)await automaticNativeMigration();
    // Installing the executable does not enroll or refresh native integrations.
    if(command==='install'){if(!compiled())throw new CliError('INSTALL_UNAVAILABLE','Run install from a released executable.');const data=await installBinary();emit(data,`Installed opencrawl ${data.version} at ${data.path}. Add its directory to PATH if needed.`);return 0;}
    if(command==='update'){const data=await updateCli();emit(data,data.updated?`Installed opencrawl ${data.version}. Your next invocation will use it.`:`opencrawl ${data.version} is current.`);return 0;}
    if(!['setup','logout','install','skills','verify-installation'].includes(command)&&!(command==='collect'&&parsed.positionals[1]!=='hook'))try{scheduleDaemonUpgrade();}catch{}
    const pluginHookInvocation=captureHandoff||hasPluginContext();
    if(!pluginHookInvocation)updateJob=scheduleCliUpdate();
    const api = apiOrigin((parsed.values.api as string | undefined) ?? process.env.OPENCRAWL_API_URL
      ?? readCaptureConfig()?.api
      ?? DEFAULT_API_ORIGIN);
    if(!['login','logout','status','whoami','skills','collect'].includes(command))try{wakeApprovedHistory();}catch{}
    if(command!=='collect'&&command!=='skills'&&process.env.OPENCRAWL_NO_UPDATE!=='1'&&!hasPluginContext()&&readCaptureConfig()?.hookOwnership!=='plugin')await refreshManagedSkills(api);
    if (command === 'skills') {
      const data = await agentSkills(parsed.positionals[1] ?? 'status', api, {clients: parsed.values.client as string[] | undefined});
      emit(data, JSON.stringify(data, null, 2));
      return data.results.some(result => ['conflict', 'error'].includes(result.status)) ? 1 : 0;
    }
    return await withEnvironmentTokenOrigin((parsed.values.api as string|undefined) ?? process.env.OPENCRAWL_API_URL, async () => {
    if(!pluginHookInvocation&&!organizationId&&command!=='skills'&&command!=='logout'&&!localCollect&&!parsed.values['dry-run']&&!localHook)memoryJob.current=scheduleMemoryRefresh();
    if (command === 'board') {
      if(parsed.positionals[1]==='fetch'&&parsed.positionals.length>2){
        if(parsed.values.id)throw new CliError('INVALID_USAGE','Use positional references or --id, not both. See opencrawl board fetch --help.',64);
        const ids=parsed.positionals.slice(2);
        for(const id of ids)boardInput('fetch',{...parsed.values,id});
        if(ids.length===1){await boardCommand('fetch',api,{...parsed.values,id:ids[0]},data=>writeBoardOutput(data,json));return 0;}
        const result=await fetchMany(ids,parsed.values.concurrency,async id=>{
          let value:unknown;
          await boardCommand('fetch',api,{...parsed.values,id},data=>{value=data;});
          return value;
        });
        await writeBoardOutput(result,json);return result.partial?1:0;
      }
      await boardCommand(parsed.positionals[1] ?? 'directory', api, parsed.values, data => writeBoardOutput(data, json));
      return 0;
    }
    if (command === 'fetch') {
      if(parsed.positionals.length>2){
        const inputs=parsed.positionals.slice(1).map(id=>fetchInput(id,parsed.values));
        const result=await fetchMany(inputs.map(input=>input.id),parsed.values.concurrency,id=>fetchWorkspace(api,fetchInput(id,parsed.values)));
        emit(result,JSON.stringify(result,null,2));return result.partial?1:0;
      }
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
    if (command === 'token') {
      const result = await tokenCommand(parsed.positionals[1], api, parsed.positionals[2], parsed.values);
      emit(result.data, result.human);
      return 0;
    }
    if (command === 'logout') { await logout(api); emit({api, authenticated: false, localCredentialsRemoved: true}, 'Removed saved credentials from this machine.'); return 0; }
    if (command === 'login') {
      const verified=await loginIdentity(api,{organizationId,noBrowser:parsed.values['no-browser']===true});
      emit({api,authenticated:true,...verified},`Signed in${verified.user.email?` as ${verified.user.email}`:''}${organizationId?` to workspace ${organizationId}`:''}. Use opencrawl search to query indexed workspace knowledge.`);
      return 0;
    }
    // A machine created for one task has no saved sign-in, only the token its platform injected.
    // A token the service does not accept here leaves the saved sign-in to decide, as before.
    let configured: string | undefined;
    try { configured = await configuredToken('OPENCRAWL_TOKEN', api); } catch (error) {if(workspaceIdentityEnabled())throw error;}
    if (configured) {
      let verified: Awaited<ReturnType<typeof identity>> | null = null;
      try { verified = await identity(api, fetch, configured); }
      catch (error) { if (workspaceIdentityEnabled() || !(error instanceof CliError) || !['AUTH_REQUIRED', 'AUTH_FORBIDDEN', 'ORGANIZATION_REQUIRED'].includes(error.code)) throw error; }
      if (verified) {
        const {user} = verified;
        emit({api, version, authenticated: true, credential: workspaceIdentityEnabled() ? 'workspace-identity' : 'environment-token', ...verified, ...(command === 'status' ? {index: {available: null}} : {})},
          command === 'status' ? `opencrawl ${version}\nSigned in${user.email ? ` as ${user.email}` : ''} with ${workspaceIdentityEnabled() ? "workspace identity" : "OPENCRAWL_TOKEN"}.\nUse opencrawl search to check indexed workspace knowledge.` : user.email ?? user.id);
        return 0;
      }
    }
    if (command === 'status' && !readSession(api)) {
      emit({api, version, authenticated: false, index: {available: null}}, `opencrawl ${version}\nNot signed in. Run opencrawl login.\nUse opencrawl search to check indexed workspace knowledge.`);
      return 0;
    }
    const verified = await identity(api), {user} = verified;
    emit({api, version, authenticated: true, ...verified, ...(command === 'status' ? {index: {available: null}} : {})}, command === 'status' ? `opencrawl ${version}\nSigned in${user.email ? ` as ${user.email}` : ''}.\nUse opencrawl search to check indexed workspace knowledge.` : user.email ?? user.id);
    return 0;
    });
  } catch (error) {
    const failure = filesystemError(error);
    const known = failure instanceof CliError;
    const code = known ? failure.code : 'CLI_ERROR';
    const message = known ? failure.message : ['install','update'].includes(args[0]??'')
      ? 'The CLI installation or update failed. Retry the native installer, keeping your existing configuration and capture data.'
      : 'The command failed. Retry, or run opencrawl login to repair your session.';
    if (json) process.stdout.write(JSON.stringify({schemaVersion: 1, error: {code, message, ...(known && failure.workspaces ? {workspaces: failure.workspaces} : {})}}) + '\n');
    else process.stderr.write(`opencrawl: ${message}\n`);
    const exit = known ? failure.exitCode : 1;
    // Harnesses read a hook's exit code 2 as "block this action".
    return exit === 2 && args[0] === 'collect' && args[1] === 'hook' ? 1 : exit;
  } finally {
    memoryJob.current?.stop();
    await updateJob?.stop();
    // Upgrade only our hook settings locally; never launch an unowned process.
    if(!informational && !installingBinary && args[0]!=='collect' && args[0]!=='logout' && args[0]!=='skills' && args[0]!=='setup' && args[0]!=='verify-installation')try{if(!hasPluginContext()&&readCaptureConfig()?.hookOwnership!=='plugin')await upgradeCaptureHooks();}catch{}
  }
}

async function automaticNativeMigration(){
  if(!compiled()||process.env.OPENCRAWL_NO_UPDATE==='1'||hasPluginContext())return;
  let attention=false;
  try{
    const config=readCaptureConfig();
    if(config?.hookOwnership==='plugin')return;
    const launchers=findLegacyLaunchers([process.env.OPENCRAWL_LAUNCHER,config?.command.find(part=>part.endsWith('/opencrawl.cjs')||part.endsWith('\\opencrawl.cjs'))]);
    if(!launchers.length)return;
    let changed=false;
    for(const launcher of launchers){
      try{const result=await migrateLegacyLauncher({launcher});if(result){changed=true;attention||=!result.complete;}}
      catch(error){if(!(error instanceof CliError&&error.code==='SESSION_BUSY'))attention=true;}
    }
    if(!changed&&!attention)return;
    // Existing capture enrollment is retained. These operations refresh only
    // CLI-owned hooks/skills and never enroll a new capture installation.
    await upgradeCaptureHooks();
    await agentSkills('refresh',apiOrigin(config?.api??DEFAULT_API_ORIGIN),{});
  }catch(error){
    if(error instanceof CliError&&error.code==='SESSION_BUSY')return;
    attention=true;
  } // A protected prefix must not interrupt capture.
  if(attention){
    const file=join(cacheRoot(),'native-migration-notice.json'),previous=readDistributionState(file);
    if(previous?.version===version&&previous.checkedAt>Date.now()-15*60_000)return;
    try{atomicJson(file,{version,checkedAt:Date.now()});}catch{}
    process.stderr.write('opencrawl: Automatic native migration preserved a customized or protected command. Use the native installer to finish migration; your credentials and capture data are unchanged.\n');
  }
}

if (import.meta.main) {
  // Supervisor profile selection must precede native version delegation.
  try{applyDaemonEnvironment(process.argv.slice(2));}catch(error){process.stderr.write((error instanceof Error?error.message:'Invalid worker environment')+'\n');process.exit(64);}
  // Local inspection cannot delegate to a native child or run an update.
  const delegated=hasLocalFlag(process.argv.slice(2))||process.argv[2]==='search-context'?undefined:delegateToNewest(process.argv.slice(2));
  if(delegated!==undefined)process.exit(delegated);
  // Once a one-use refresh has left, save its response before honoring a
  // cooperative shutdown. The request itself has a bounded deadline.
  process.on('SIGINT', () => exitAfterCredentialRotation(130));
  process.on('SIGTERM', () => exitAfterCredentialRotation(143));
  process.exitCode = await main();
}
