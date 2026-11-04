#!/usr/bin/env node
// Collects agent session transcripts on this machine and sends them to an OpenCrawl receiver.
// Zero dependencies, one file, Node 20+. The receiver serves this file for one-line installs.
import { open, readFile, readdir, stat, writeFile, mkdir, copyFile, rename } from 'node:fs/promises';
import { existsSync, openSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import { join, relative, sep, extname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const USAGE = `Usage: node collector.mjs <command> [options]

  install                 Save settings, start the background collector and backfill every session
  status                  Show captured agents and what is still waiting to upload
  push                    Upload new transcript data once
  watch                   Upload new transcript data continuously (what the service runs)
  import <path>           Upload a ChatGPT or Claude.ai data export (conversations.json or its folder)
  mcp                     Run a stdio MCP server that forwards to the receiver
  uninstall               Stop the background collector (captured data stays in the store)

Options:
  --url <url>             Receiver URL (default http://127.0.0.1:7171)
  --token <token>         Bearer token, if the receiver requires one
  --machine <name>        Name for this machine in the store (default: host name)
  --exclude <text>        Skip transcripts whose path contains <text>; repeatable
  --agent <name>          Only push this agent (claude-code, codex, gemini-cli)
  --interval <seconds>    Poll interval for watch (default 30)
  --resync                Ignore the local cache and reconcile every file with the receiver`;

/**
 * Where each agent keeps its transcripts. Files ending in .jsonl are treated as append-only and
 * uploaded incrementally; anything else is uploaded whole when it changes. Add an agent here.
 * Apps that drive these CLIs (Conductor, Paradev, IDE extensions) write to the same places.
 */
export const AGENTS = [
  {
    agent: 'claude-code',
    // Paradev and other account switchers give each extra account its own ~/.claude-<name>.
    roots: async env => (await configDirs(env, '.claude', env.CLAUDE_CONFIG_DIR)).map(dir => join(dir, 'projects')),
    // <project>/<session>.jsonl, plus <project>/<session>/subagents/agent-<id>.jsonl
    match: rel => rel.endsWith('.jsonl'),
  },
  {
    agent: 'codex',
    roots: async env => (await configDirs(env, '.codex', env.CODEX_HOME)).flatMap(dir => [join(dir, 'sessions'), join(dir, 'archived_sessions')]),
    match: rel => /(^|\/)rollout-[^/]+\.jsonl$/.test(rel),
    // Archiving moves a rollout to archived_sessions/; its file name stays the same.
    session: rel => basename(rel, '.jsonl'),
  },
  {
    agent: 'gemini-cli',
    roots: async env => [join(env.HOME, '.gemini', 'tmp')],
    // <project-hash>/chats/session-<time>-<id>.json
    match: rel => /(^|\/)chats\/session-[^/]+\.jsonl?$/.test(rel),
  },
];

const SEGMENT_BYTES = 8 * 1024 * 1024;
const TAIL_BYTES = 256;
const DEFAULT_URL = 'http://127.0.0.1:7171';
const SERVICE = 'dev.opencrawl.agent-sessions';

const home = () => join(process.env.OPENCRAWL_HOME || join(homedir(), '.opencrawl'), 'agent-sessions');
const sha256 = data => createHash('sha256').update(data).digest('hex');
const safeName = text => text.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '').slice(0, 63) || 'machine';
const safeSession = rel => rel.split('/').map(part => part.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\./, '_')).join('/');

/** The agent's configuration directory (override first), plus per-account copies such as ~/.claude-work. */
async function configDirs(env, name, override) {
  const entries = await readdir(env.HOME, {withFileTypes: true}).catch(() => []);
  const accounts = entries.filter(e => e.isDirectory() && e.name.startsWith(`${name}-`)).map(e => join(env.HOME, e.name)).sort();
  return [...new Set([override, join(env.HOME, name), ...accounts].filter(Boolean))];
}

/** Lists transcript files for every agent that exists on this machine. */
export async function discover({env = {...process.env, HOME: homedir()}, agents = AGENTS, exclude = []} = {}) {
  const files = [];
  const seen = new Set();
  for (const def of agents) {
    for (const root of await def.roots(env)) {
      for await (const path of walk(root)) {
        const rel = relative(root, path).split(sep).join('/');
        if (!def.match(rel) || exclude.some(text => path.includes(text))) continue;
        const session = safeSession(def.session ? def.session(rel) : rel.slice(0, -extname(rel).length));
        // A copied config directory repeats sessions; the first location wins so two files never share one key.
        if (seen.has(`${def.agent}/${session}`)) continue;
        seen.add(`${def.agent}/${session}`);
        files.push({agent: def.agent, path, session, format: rel.endsWith('.jsonl') ? 'jsonl' : 'json'});
      }
    }
  }
  return files;
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, {withFileTypes: true});
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

export function createReceiverClient({url = DEFAULT_URL, token = '', machine, fetch: fetchImpl = globalThis.fetch}) {
  const base = url.replace(/\/+$/, '');
  const auth = token ? {Authorization: `Bearer ${token}`} : {};
  const sessionUrl = (agent, session, query = '') =>
    `${base}/v1/sessions/${agent}/${machine}/${session.split('/').map(encodeURIComponent).join('/')}${query}`;

  async function failure(res, what) {
    const body = await res.json().catch(() => ({}));
    return Object.assign(new Error(`${what} failed with ${res.status}${body.error ? `: ${body.error}` : ''}`), {status: res.status});
  }

  return {
    base,
    async health() {
      try {
        return (await fetchImpl(`${base}/health`)).ok;
      } catch {
        return false;
      }
    },
    /** Returns the receiver's manifest for a session, or null. */
    async manifest(agent, session) {
      const res = await fetchImpl(sessionUrl(agent, session), {headers: auth});
      if (res.status === 404) return null;
      if (!res.ok) throw await failure(res, `GET ${agent}/${session}`);
      return res.json();
    },
    /** Uploads raw[offset..]. Returns {length} on success or {conflict: length} if the receiver holds a different length. */
    async upload({agent, session, offset, raw, format, path}) {
      const res = await fetchImpl(sessionUrl(agent, session, `?offset=${offset}`), {
        method: 'PUT',
        headers: {
          ...auth,
          'Content-Type': 'application/gzip',
          'X-OpenCrawl-Format': format,
          ...(path && {'X-OpenCrawl-Source-Path': encodeURIComponent(path), 'X-OpenCrawl-Source-Host': encodeURIComponent(hostname())}),
        },
        body: gzipSync(raw),
      });
      if (res.status === 409) return {conflict: (await res.json()).length};
      if (!res.ok) throw await failure(res, `PUT ${agent}/${session}`);
      return {length: (await res.json()).length};
    },
    async mcp(message) {
      const res = await fetchImpl(`${base}/mcp`, {
        method: 'POST',
        headers: {...auth, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream'},
        body: message,
      });
      if (res.status === 202) return null;
      return res.text();
    },
  };
}

/**
 * Uploads whatever part of one transcript the receiver does not have yet.
 * The receiver accepts a segment only at the length it already holds, so a stale or lost local
 * cache, a second collector, or a wiped store all heal through its 409 reply.
 * Returns the number of source bytes sent.
 */
export async function syncFile(client, file, state, {resync = false} = {}) {
  let info;
  try {
    info = await stat(file.path);
  } catch {
    return 0; // deleted between discovery and upload
  }
  let entry = state.files[file.path];
  if (entry && !resync && entry.size === info.size && entry.mtimeMs === info.mtimeMs) return 0;
  const fh = await open(file.path, 'r');
  try {
    if (file.format !== 'jsonl') {
      const raw = await fh.readFile();
      const hash = sha256(raw);
      let sent = 0;
      if (raw.length && (entry?.hash !== hash || (resync && !(await client.manifest(file.agent, file.session))))) {
        await client.upload({...file, offset: 0, raw});
        sent = raw.length;
      }
      state.files[file.path] = {agent: file.agent, size: info.size, mtimeMs: info.mtimeMs, uploaded: raw.length, hash};
      return sent;
    }

    if (!entry || resync) {
      // Unknown to the cache: resume from whatever the receiver already has.
      const manifest = await client.manifest(file.agent, file.session);
      entry = {agent: file.agent, uploaded: await resumePoint(fh, info.size, manifest?.length ?? 0)};
      entry.tail = await tailHash(fh, entry.uploaded);
    } else if (info.size < entry.uploaded || (await tailHash(fh, entry.uploaded)) !== entry.tail) {
      entry = {agent: file.agent, uploaded: 0, tail: ''}; // rewritten, not appended: replace it
    }

    let sent = 0;
    for (;;) {
      const raw = await readLines(fh, entry.uploaded, info.size);
      if (!raw) break; // caught up, or only a partial line is waiting
      const result = await client.upload({...file, offset: entry.uploaded, raw});
      if (result.conflict !== undefined) {
        entry.uploaded = await resumePoint(fh, info.size, result.conflict);
      } else {
        entry.uploaded = result.length;
        sent += raw.length;
      }
      entry.tail = await tailHash(fh, entry.uploaded);
      state.files[file.path] = entry; // checkpoint without size, so an interrupted upload resumes next run
    }
    state.files[file.path] = {...entry, size: info.size, mtimeMs: info.mtimeMs};
    return sent;
  } finally {
    await fh.close();
  }
}

/** Trusts a receiver length only if it lands on a line boundary inside this file; otherwise starts over. */
async function resumePoint(fh, size, length) {
  if (length <= 0 || length > size) return 0;
  const {buffer} = await fh.read(Buffer.alloc(1), 0, 1, length - 1);
  return buffer[0] === 0x0a ? length : 0;
}

async function tailHash(fh, end) {
  const start = Math.max(0, end - TAIL_BYTES);
  const {buffer, bytesRead} = await fh.read(Buffer.alloc(end - start), 0, end - start, start);
  return sha256(buffer.subarray(0, bytesRead));
}

/** Reads up to SEGMENT_BYTES of complete lines from offset (more if one line is longer). Null if none. */
async function readLines(fh, offset, size) {
  let length = Math.min(SEGMENT_BYTES, size - offset);
  while (length > 0) {
    const {buffer, bytesRead} = await fh.read(Buffer.alloc(length), 0, length, offset);
    const end = buffer.lastIndexOf(0x0a, bytesRead - 1);
    if (end >= 0) return buffer.subarray(0, end + 1);
    if (offset + bytesRead >= size) return null;
    length = Math.min(length * 2, size - offset);
  }
  return null;
}

/** Splits a ChatGPT or Claude.ai export into one conversation each. */
export function splitExport(conversations) {
  if (!Array.isArray(conversations)) throw new Error('Expected conversations.json to hold an array');
  return conversations.map(item => {
    if (item.mapping) return {agent: 'chatgpt', id: item.conversation_id ?? item.id, title: item.title};
    if (item.chat_messages) return {agent: 'claude-ai', id: item.uuid, title: item.name};
    throw new Error('Unrecognized export: expected ChatGPT (mapping) or Claude.ai (chat_messages) conversations');
  }).map((meta, i) => ({...meta, session: safeSession(String(meta.id)), raw: Buffer.from(JSON.stringify(conversations[i]))}));
}

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function saveJson(path, value) {
  await mkdir(home(), {recursive: true, mode: 0o700});
  await writeFile(`${path}.tmp`, JSON.stringify(value), {mode: 0o600});
  await rename(`${path}.tmp`, path);
}

function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) (n /= 1024), i++;
  return `${n.toFixed(i && n < 10 ? 1 : 0)} ${units[i]}`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function main() {
  const {positionals, values: opts} = parseArgs({
    allowPositionals: true,
    options: {
      url: {type: 'string'},
      token: {type: 'string'},
      machine: {type: 'string'},
      exclude: {type: 'string', multiple: true},
      agent: {type: 'string'},
      interval: {type: 'string'},
      resync: {type: 'boolean'},
      help: {type: 'boolean', short: 'h'},
    },
  });
  const [command, arg] = positionals;
  if (!command || opts.help) {
    console.log(USAGE);
    process.exit(command || opts.help ? 0 : 1);
  }

  const configPath = join(home(), 'config.json');
  const statePath = join(home(), 'state.json');
  const saved = await loadJson(configPath, {});
  const config = {
    url: opts.url || process.env.OPENCRAWL_SESSIONS_URL || saved.url || DEFAULT_URL,
    token: opts.token ?? process.env.OPENCRAWL_SESSIONS_TOKEN ?? saved.token ?? '',
    machine: safeName(opts.machine || saved.machine || hostname()),
    exclude: opts.exclude || saved.exclude || [],
  };
  const client = createReceiverClient(config);
  const state = await loadJson(statePath, {files: {}, imports: {}});

  async function push({verbose = false} = {}) {
    const agents = opts.agent ? AGENTS.filter(a => a.agent === opts.agent) : AGENTS;
    if (!agents.length) fail(`Unknown agent ${opts.agent}. Known: ${AGENTS.map(a => a.agent).join(', ')}`);
    const files = await discover({agents, exclude: config.exclude});
    const totals = {};
    let lastSave = Date.now();
    for (const file of files) {
      const sent = await syncFile(client, file, state, {resync: opts.resync});
      if (!sent) continue;
      totals[file.agent] = (totals[file.agent] ?? 0) + sent;
      if (verbose) console.log(`${new Date().toISOString()} ${file.agent} ${file.session} +${formatBytes(sent)}`);
      if (Date.now() - lastSave > 5000) await saveJson(statePath, state), (lastSave = Date.now());
    }
    // Forget files that no longer exist.
    const live = new Set(files.map(f => f.path));
    for (const path of Object.keys(state.files)) {
      if (!live.has(path) && agents.some(a => a.agent === state.files[path].agent)) delete state.files[path];
    }
    await saveJson(statePath, state);
    return totals;
  }

  const commands = {
    async push() {
      if (!(await client.health())) fail(`No OpenCrawl receiver at ${client.base}. Start it with integrations/agent-sessions/local.sh up.`);
      const totals = await push();
      const lines = Object.entries(totals).map(([agent, bytes]) => `  ${agent.padEnd(12)} ${formatBytes(bytes)}`);
      console.log(lines.length ? `Sent to ${client.base}:\n${lines.join('\n')}` : 'Everything is already uploaded.');
    },

    async watch() {
      const interval = Number(opts.interval || 30) * 1000;
      console.log(`${new Date().toISOString()} collecting as ${config.machine} into ${client.base} every ${interval / 1000}s`);
      for (;;) {
        try {
          if (await client.health()) await push({verbose: true});
          else console.log(`${new Date().toISOString()} receiver unreachable at ${client.base}; retrying`);
        } catch (error) {
          console.error(`${new Date().toISOString()} ${error.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, interval));
      }
    },

    async status() {
      const files = await discover({exclude: config.exclude});
      const rows = {};
      for (const file of files) {
        const row = (rows[file.agent] ??= {sessions: 0, bytes: 0, pending: 0});
        const size = (await stat(file.path).catch(() => ({size: 0}))).size;
        row.sessions += 1;
        row.bytes += size;
        row.pending += Math.max(0, size - (state.files[file.path]?.uploaded ?? 0));
      }
      const up = await client.health();
      console.log(`Receiver  ${client.base} ${up ? '(up)' : '(unreachable)'}`);
      console.log(`Machine   ${config.machine}`);
      console.log(`Service   ${serviceStatus()}\n`);
      if (!files.length) return console.log('No agent transcripts found on this machine.');
      console.log(`${'Agent'.padEnd(12)} ${'Sessions'.padStart(8)} ${'Size'.padStart(9)} ${'Waiting'.padStart(9)}`);
      for (const [agent, row] of Object.entries(rows)) {
        console.log(`${agent.padEnd(12)} ${String(row.sessions).padStart(8)} ${formatBytes(row.bytes).padStart(9)} ${formatBytes(row.pending).padStart(9)}`);
      }
      // A trailing partial line stays waiting until the agent finishes writing it.
    },

    async import(path) {
      if (!path) fail('Usage: collector.mjs import <conversations.json | export folder>');
      if ((await stat(path).catch(() => null))?.isDirectory()) path = join(path, 'conversations.json');
      if (!existsSync(path)) fail(`${path} not found. Unzip the export first; it contains conversations.json.`);
      if (!(await client.health())) fail(`No OpenCrawl receiver at ${client.base}.`);
      const items = splitExport(JSON.parse(await readFile(path, 'utf8')));
      const exportClient = createReceiverClient({...config, machine: 'export'});
      let sent = 0;
      for (const item of items) {
        const key = `${item.agent}/${item.session}`;
        const hash = sha256(item.raw);
        if (state.imports[key] === hash) continue;
        await exportClient.upload({agent: item.agent, session: item.session, offset: 0, raw: item.raw, format: 'json'});
        state.imports[key] = hash;
        sent++;
      }
      await saveJson(statePath, state);
      console.log(`Imported ${sent} of ${items.length} ${items[0]?.agent ?? ''} conversations; the rest were already up to date.`);
    },

    async mcp() {
      const lines = createInterface({input: process.stdin});
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          const reply = await client.mcp(line);
          if (reply) process.stdout.write(`${reply.trim()}\n`);
        } catch (error) {
          const id = JSON.parse(line).id ?? null;
          process.stdout.write(`${JSON.stringify({jsonrpc: '2.0', id, error: {code: -32603, message: `OpenCrawl receiver: ${error.message}`}})}\n`);
        }
      }
    },

    async install() {
      if (!(await client.health())) {
        fail(`No OpenCrawl receiver at ${client.base}. Start it first (integrations/agent-sessions/local.sh up), or pass --url.`);
      }
      await saveJson(configPath, {url: config.url, token: config.token, machine: config.machine, exclude: config.exclude});
      const target = join(home(), 'collector.mjs');
      const self = fileURLToPath(import.meta.url);
      if (self !== target) await copyFile(self, target);
      const how = startService(target);
      const files = await discover({exclude: config.exclude});
      const agents = [...new Set(files.map(f => f.agent))];
      console.log(`Collector installed for ${config.machine}, sending to ${client.base}.`);
      console.log(`Background service: ${how}.`);
      console.log(files.length
        ? `Backfilling ${files.length} sessions from ${agents.join(', ')}. New sessions upload within 30 seconds.`
        : 'No transcripts yet; new sessions will upload within 30 seconds.');
      console.log(`Progress: node ${target} status`);
    },

    async uninstall() {
      stopService();
      console.log('Background collector stopped. Captured sessions remain in the store.');
      console.log(`Remove ${home()} to forget settings and upload progress.`);
    },
  };

  if (!commands[command]) fail(USAGE);
  await commands[command](arg);
}

// Background service: launchd on macOS, systemd --user on Linux, a detached process elsewhere.

function servicePaths() {
  return {
    plist: join(homedir(), 'Library', 'LaunchAgents', `${SERVICE}.plist`),
    unit: join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', 'opencrawl-agent-sessions.service'),
    pid: join(home(), 'collector.pid'),
    log: join(home(), 'collector.log'),
  };
}

const run = (cmd, args) => {
  try {
    execFileSync(cmd, args, {stdio: 'pipe'});
    return true;
  } catch {
    return false;
  }
};
const hasSystemd = () => platform() === 'linux' && run('systemctl', ['--user', 'show-environment']);

function startService(script) {
  const paths = servicePaths();
  const args = [process.execPath, script, 'watch'];
  stopService();
  if (platform() === 'darwin') {
    const xml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), {recursive: true});
    writeFileSync(paths.plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SERVICE}</string>
  <key>ProgramArguments</key><array>${args.map(a => `<string>${xml(a)}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>${xml(paths.log)}</string>
  <key>StandardErrorPath</key><string>${xml(paths.log)}</string>
</dict></plist>
`);
    execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, paths.plist]);
    return `launchd agent ${SERVICE} (log: ${paths.log})`;
  }
  if (hasSystemd()) {
    mkdirSync(join(paths.unit, '..'), {recursive: true});
    const quote = a => `"${a.replace(/(["\\])/g, '\\$1')}"`;
    writeFileSync(paths.unit, `[Unit]
Description=OpenCrawl agent session collector

[Service]
ExecStart=${args.map(quote).join(' ')}
Restart=always
RestartSec=10
Nice=10

[Install]
WantedBy=default.target
`);
    execFileSync('systemctl', ['--user', 'daemon-reload']);
    execFileSync('systemctl', ['--user', 'enable', '--now', 'opencrawl-agent-sessions.service']);
    return 'systemd user unit opencrawl-agent-sessions (journalctl --user -u opencrawl-agent-sessions)';
  }
  const log = openSync(paths.log, 'a');
  const child = spawn(args[0], args.slice(1), {detached: true, stdio: ['ignore', log, log]});
  child.unref();
  writeFileSync(paths.pid, String(child.pid));
  return `detached process ${child.pid}; it does not restart after reboot, so rerun install then (log: ${paths.log})`;
}

/** True if pid is our own collector, so a reused PID is never signalled. */
const isCollector = pid => pid > 1 && run('sh', ['-c', `ps -p ${pid} -o args= | grep -q 'collector.mjs watch'`]);
const savedPid = path => (existsSync(path) ? Number(readFileSync(path, 'utf8')) : 0);

function stopService() {
  const paths = servicePaths();
  if (platform() === 'darwin' && existsSync(paths.plist)) {
    run('launchctl', ['bootout', `gui/${process.getuid()}/${SERVICE}`]);
    rmSync(paths.plist, {force: true});
  } else if (existsSync(paths.unit)) {
    run('systemctl', ['--user', 'disable', '--now', 'opencrawl-agent-sessions.service']);
    rmSync(paths.unit, {force: true});
  } else if (existsSync(paths.pid)) {
    const pid = savedPid(paths.pid);
    if (isCollector(pid)) process.kill(pid);
    rmSync(paths.pid, {force: true});
  }
}

function serviceStatus() {
  const paths = servicePaths();
  if (platform() === 'darwin' && existsSync(paths.plist)) {
    return run('launchctl', ['print', `gui/${process.getuid()}/${SERVICE}`]) ? 'running (launchd)' : 'installed, not running';
  }
  if (existsSync(paths.unit)) {
    return run('systemctl', ['--user', 'is-active', '--quiet', 'opencrawl-agent-sessions.service']) ? 'running (systemd)' : 'installed, not running';
  }
  if (existsSync(paths.pid)) return isCollector(savedPid(paths.pid)) ? `running (pid ${savedPid(paths.pid)})` : 'stopped';
  return 'not installed (run: collector.mjs install)';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch(error => fail(error.message));
}
