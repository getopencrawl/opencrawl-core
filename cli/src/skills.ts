import {existsSync, lstatSync, readFileSync, readdirSync, mkdirSync, rmSync, chmodSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {atomicFile, withSessionLock} from './session.ts';
import {CliError} from './oauth.ts';
import {participationInstructions} from './board.ts';
import {ANTIGRAVITY_SURFACES} from './capture/runtime.ts';
import {startupHooks, type StartupOptions} from './startup-install.ts';
import {retrievalInstruction} from './retrieval-instruction.ts';

export const skillRevision = 14;
const manifestName = '.opencrawl-skill.json';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function metadata(path: string) {
  try {return lstatSync(path);} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error;}
}
function hasAntigravityRoot(home: string, env: NodeJS.ProcessEnv) {
  if (env.ANTIGRAVITY_HOME && existsSync(env.ANTIGRAVITY_HOME)) return true;
  const root = env.ANTIGRAVITY_HOME || join(home, '.gemini');
  return ANTIGRAVITY_SURFACES.some(surface => existsSync(join(root, surface)));
}
type Options = StartupOptions & {which?: (name: string) => string | null; clients?: string[]; includeExisting?: boolean; lockWaitMs?: number; deadline?: number};

export function skillTargets({home = homedir(), env = process.env, which = Bun.which, clients: rawClients, includeExisting = false}: Options = {}) {
  const clients = rawClients?.map(client => client === 'agy' ? 'antigravity' : client);
  const shared = join(home, '.agents', 'skills', 'opencrawl');
  const agyBase = env.ANTIGRAVITY_HOME || join(home, '.gemini');
  const known = [
    {client: 'codex', command: 'codex', root: env.CODEX_HOME || join(home, '.codex'), directory: shared},
    {client: 'claude-code', command: 'claude', root: env.CLAUDE_CONFIG_DIR || join(home, '.claude'), directory: join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'skills', 'opencrawl')},
    {client: 'antigravity', command: 'agy', root: join(agyBase, 'antigravity-cli'), directory: join(agyBase, 'config', 'skills', 'opencrawl')},
    {client: 'cursor', command: 'cursor', root: env.CURSOR_CONFIG_DIR || join(home, '.cursor'), directory: join(env.CURSOR_CONFIG_DIR || join(home, '.cursor'), 'skills', 'opencrawl')},
    {client: 'gemini', command: 'gemini', root: join(home, '.gemini'), directory: shared},
    {client: 'opencode', command: 'opencode', root: join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode'), directory: shared},
    {client: 'copilot', command: 'copilot', root: join(home, '.copilot'), directory: shared},
  ];
  if (clients?.some(client => !known.some(entry => entry.client === client))) throw new CliError('INVALID_USAGE', `Use --client ${known.map(entry => entry.client).join('|')}.`, 64);
  const selected = known.filter(entry => clients ? clients.includes(entry.client) : (entry.client === 'antigravity' ? hasAntigravityRoot(home, env) : existsSync(entry.root)) || Boolean(which(entry.command)) || entry.client === 'cursor' && Boolean(which('cursor-agent')) || includeExisting && metadata(entry.directory) !== null || entry.client === 'claude-code' && env.CLAUDE_CODE_REMOTE === 'true');
  const groups = new Map<string, string[]>();
  for (const entry of selected) groups.set(entry.directory, [...(groups.get(entry.directory) ?? []), entry.client]);
  return [...groups].map(([directory, clients]) => ({directory, clients}));
}

export function startupInstruction() {
  return `${retrievalInstruction}\n\nUse the OpenCrawl SessionStart context and installed opencrawl skill for workspace knowledge and board participation. If startup context is missing or reports failure, follow the skill's registration fallback. If the skill is unavailable, run opencrawl board instructions.`;
}

export function skillFiles() {
  return {
    'SKILL.md': `---
name: opencrawl
description: Search shared workspace knowledge and coordinate with other agents. Use for substantive company or engineering work, prior context, and board notifications.
---

# OpenCrawl

OpenCrawl shares workspace sessions, decisions and documents across agents. Retrieve prior work before rediscovering it; coordinate when tasks affect each other.

## Retrieval

${retrievalInstruction}

Prefer authenticated MCP opencrawl_search_v1, otherwise the advertised search/fetch tools. Search is lexical: use 2–6 distinctive terms with match=all; shorten or try any on misses. Narrow with provenance/facets; use groupBy=session when one chat dominates. Fetch promising passages; follow nextOffset/version and adjacent IDs for context. Tool schemas describe filters and projection.

Session tool output and the identified calling chat are excluded by default. Enable includeToolOutputs for execution evidence, includeCurrentSession for this chat. Check searchContext and coverage before relying on exclusions or inferring absence.

CLI fallback: opencrawl search "terms" --json; opencrawl fetch <id>... --json.

${participationInstructions()}
## Continue setup

Continue in this same conversation using the native plugin's opencrawl-setup skill and its bound CLI command, profile and server. Read local setup status to reuse saved plugin, future-recording and history choices; preserve opt-outs and do not repeat the questionnaire. Complete only remaining native trust/MCP steps, then use that plugin's installation_status and verify_installation. A connection alone does not prove searchable capture.

## Maintenance

Use the configured server and approved access. CLI updates replace this managed skill; keep customization elsewhere. Preserve capture hooks, queues and cursors; history import requires user approval. Use opencrawl --help for setup and commands.
`,
  };
}

/** Compare only the reserved tree; never follow links into another skill. */
function currentTree(directory: string, files: Record<string, string>, relative = ''): boolean {
  const stat = metadata(directory);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return false;
  const entries = readdirSync(directory, {withFileTypes: true});
  const children = new Set(Object.keys(files).filter(name => name.startsWith(relative)).map(name => name.slice(relative.length).split('/')[0]));
  if (entries.length !== children.size) return false;
  return entries.every(entry => {
    const name = relative + entry.name, path = join(directory, entry.name);
    if (entry.isSymbolicLink()) return false;
    if (entry.isDirectory()) return Object.keys(files).some(file => file.startsWith(name + '/')) && currentTree(path, files, name + '/');
    return entry.isFile() && Object.hasOwn(files, name) && metadata(path)?.size === Buffer.byteLength(files[name]!) && readFileSync(path, 'utf8') === files[name];
  });
}

/** The reserved opencrawl directory belongs to the CLI, including stale files.
 * Replace links themselves rather than following/deleting their targets. */
function prepareTree(directory: string, files: Record<string, string>, relative = '') {
  const stat = metadata(directory);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) rmSync(directory, {recursive: true, force: true});
  mkdirSync(directory, {recursive: true, mode: 0o700});
  chmodSync(directory, 0o700);
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const name = relative + entry.name, path = join(directory, entry.name);
    if (Object.hasOwn(files, name)) {
      if (!entry.isFile() || entry.isSymbolicLink()) rmSync(path, {recursive: true, force: true});
    } else if (Object.keys(files).some(file => file.startsWith(name + '/'))) prepareTree(path, files, name + '/');
    else rmSync(path, {recursive: true, force: true});
  }
}

export async function agentSkills(action: string, api: string, options: Options = {}) {
  if (!['install', 'status', 'refresh'].includes(action)) throw new CliError('INVALID_USAGE', 'Use skills install, skills status or skills refresh.', 64);
  const targets = skillTargets({...options, includeExisting: true}), content = skillFiles();
  const files = {...content, [manifestName]: JSON.stringify({schemaVersion: 2, revision:skillRevision,
    files: Object.fromEntries(Object.entries(content).map(([name, text]) => [name, digest(text)]))}) + '\n'};
  const run = async () => {
    // A shared skill may belong to Cursor alone. Its existence must not install
    // hooks for every other client which happens to share that skill directory.
    const {home = homedir(), env = process.env, which = Bun.which} = options;
    const requestedClients = options.clients?.map(client => client === 'agy' ? 'antigravity' : client);
    const supportsStartup = (client: string) => requestedClients?.includes(client) ||
      client === 'codex' && (existsSync(env.CODEX_HOME || join(home, '.codex')) || Boolean(which('codex'))) ||
      client === 'claude-code' && (existsSync(env.CLAUDE_CONFIG_DIR || join(home, '.claude')) || Boolean(which('claude')) || env.CLAUDE_CODE_REMOTE === 'true') ||
      client === 'cursor' && (existsSync(env.CURSOR_CONFIG_DIR || join(home, '.cursor')) || Boolean(which('cursor')) || Boolean(which('cursor-agent'))) ||
      client === 'antigravity' && (hasAntigravityRoot(home, env) || Boolean(which('agy')));
    const results = targets.map(target => {
      try {
        if (options.deadline !== undefined && Date.now() >= options.deadline) return {...target, status:'deferred'};
        const existed = metadata(target.directory) !== null;
        // Background refresh updates an existing installation; first install is explicit.
        if (action === 'refresh' && !existed) return {...target, status: 'skipped'};
        const current = currentTree(target.directory, files);
        const hooks = startupHooks(target.clients.filter(supportsStartup), action === 'status' ? 'status' : 'install', {...options, preserveProfile: action === 'refresh'});
        if (action === 'status') return {...target, startupHooks: hooks, status: current ? 'current' : existed ? 'outdated' : 'missing'};
        if (hooks.some(hook => hook.status === 'error')) return {...target, startupHooks: hooks, status: 'error', message: 'Session startup installation failed; skill fallback remains available.'};
        if (current) return {...target, startupHooks: hooks, status: 'unchanged'};
        prepareTree(target.directory, files);
        for (const [name, text] of Object.entries(files)) atomicFile(join(target.directory, name), text);
        return {...target, startupHooks: hooks, status: existed ? 'updated' : 'installed'};
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return {...target, status: 'error', message: ['EACCES', 'EPERM', 'EROFS'].includes(code ?? '') ? 'Use the harness approval mechanism for access to this skill directory, then retry.' : 'Could not regenerate the CLI-owned opencrawl skill. Retry skills refresh.'};
      }
    });
    return {api, results, startupInstruction: startupInstruction(),
      ...(results.some(result => 'startupHooks' in result && result.startupHooks?.some(hook => hook.client === 'codex' && !['disabled', 'managed', 'preserved'].includes(hook.status)))
        ? {hookReview: 'Codex requires review of new or changed hooks in /hooks (desktop Settings > Hooks). Review OpenCrawl session startup and OpenCrawl search context there, then start a new session. Installation does not grant hook trust.'} : {}),
      ...(targets.length ? {} : {message: 'No supported client detected. Use --client to select a client explicitly.'})};
  };
  return action !== 'status' ? withSessionLock('skills:installation', run, options.lockWaitMs) : run();
}
