#!/usr/bin/env node
'use strict';
// npm owns the bootstrap. Updates live in a private per-user cache so global
// install permissions and running processes never prevent the next upgrade.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createRequire} = require('node:module');
const {spawnSync} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const {parseArgs} = require('node:util');
const ROOT = path.resolve(__dirname, '..');
const PACKAGE = '@getopencrawl/cli';
const REGISTRY = 'https://registry.npmjs.org';
const CHANNEL = 'next';
const DAY = 24 * 60 * 60 * 1000;
const cacheRoot = () => path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'opencrawl');
const stable = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
function compare(a, b) {
  if (!stable(a) || !stable(b)) throw new Error('Invalid release version.');
  const left = a.split('.').map(BigInt), right = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
function read(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function write(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(value) + '\n', {mode: 0o600, flag: 'wx'}); fs.renameSync(tmp, file); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}
function target(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  if (!['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'].includes(key)) throw new Error(`No OpenCrawl binary for ${key}.`);
  return key;
}
function binary(root) {
  const key = target();
  const localRequire = createRequire(path.join(root, 'package.json'));
  let manifest;
  try { manifest = localRequire.resolve(`${PACKAGE}-${key}/package.json`); }
  catch { throw new Error('Missing platform package. Reinstall with npm install -g @getopencrawl/cli@next --include=optional.'); }
  const pkg = read(manifest);
  if (pkg?.name !== `${PACKAGE}-${key}` || pkg.version !== read(path.join(root, 'package.json'))?.version) throw new Error('The platform package version does not match the CLI.');
  const file = path.join(path.dirname(manifest), 'bin', process.platform === 'win32' ? 'opencrawl.exe' : 'opencrawl');
  if (!fs.existsSync(file)) throw new Error('The OpenCrawl platform binary is missing. Reinstall @getopencrawl/cli.');
  return file;
}
function releaseRoot(version) {
  return path.join(cacheRoot(), 'releases', version, 'node_modules', '@getopencrawl', 'cli');
}
function validRelease(root, version) {
  try {
    const pkg = read(path.join(root, 'package.json'));
    return pkg?.name === PACKAGE && pkg.version === version &&
      fs.statSync(path.join(root, 'bin/opencrawl.cjs')).isFile() && fs.statSync(binary(root)).isFile();
  } catch { return false; }
}
function activeRoot(root = ROOT) {
  const installed = read(path.join(root, 'package.json'))?.version;
  if (!stable(installed)) return root;
  let versions;
  try { versions = fs.readdirSync(path.join(cacheRoot(), 'releases')).filter(stable).sort((a, b) => compare(b, a)); }
  catch { return root; }
  // Complete release directories are immutable publications. The mutable legacy
  // pointer can be stale or overwritten by an older updater; it grants no priority.
  for (const version of versions) {
    if (compare(version, installed) <= 0) break;
    const cached = releaseRoot(version);
    if (validRelease(cached, version)) return cached;
  }
  return root;
}
function npmCli(nodeExecutable = process.execPath) {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(nodeExecutable), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(nodeExecutable), '../lib/node_modules/npm/bin/npm-cli.js')];
  for (const directory of (process.env.PATH || '').split(path.delimiter)) candidates.push(path.join(directory, 'npm'));
  for (const file of candidates) {
    if (!file) continue;
    try { const resolved = fs.realpathSync(file); if (path.basename(resolved) === 'npm-cli.js') return resolved; } catch {}
  }
  throw new Error('npm is required for updates. Install Node.js with npm and retry.');
}
async function update({force = false, root = ROOT, fetcher = fetch, install = installRelease} = {}) {
  const stateFile = path.join(cacheRoot(), 'update.json');
  const state = read(stateFile);
  const current = read(path.join(activeRoot(root), 'package.json')).version;
  if (!force && state?.checkedAt > Date.now() - DAY) return {updated: false, version: current};
  const response = await fetcher(`${REGISTRY}/@getopencrawl%2fcli/${CHANNEL}`, {redirect: 'error', signal: AbortSignal.timeout(10_000)});
  if (!response.ok) throw new Error('The npm registry could not check for updates.');
  const latest = await response.json();
  if (latest.name !== PACKAGE || !stable(latest.version)) throw new Error('The registry returned invalid release metadata.');
  if (compare(latest.version, current) <= 0) { write(stateFile, {checkedAt: Date.now()}); return {updated: false, version: current}; }
  await install(latest.version);
  if (!validRelease(releaseRoot(latest.version), latest.version)) throw new Error('The installed update is incomplete.');
  const selected = read(path.join(activeRoot(root), 'package.json')).version;
  // Keep old npm-installed bootstraps able to delegate to the cached launcher.
  // New launchers select the maximum complete release, even if this hint races.
  write(path.join(cacheRoot(), 'current.json'), {version: selected});
  write(stateFile, {checkedAt: Date.now()});
  return {updated: compare(selected, current) > 0, version: selected};
}
async function installRelease(version, {registry = REGISTRY} = {}) {
  if (!stable(version)) throw new Error('Invalid release version.');
  const origin = new URL(registry);
  if (registry !== REGISTRY && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname))) throw new Error('Invalid release registry.');
  const releases = path.join(cacheRoot(), 'releases');
  fs.mkdirSync(releases, {recursive: true, mode: 0o700});
  const destination = path.join(releases, version);
  // Reuse a fully staged version if pointer publication was interrupted.
  if (fs.existsSync(destination)) {
    if (!validRelease(releaseRoot(version), version)) throw new Error('The cached update is incomplete.');
    return;
  }
  const stage = fs.mkdtempSync(path.join(releases, '.stage-'));
  try {
    fs.writeFileSync(path.join(stage, 'package.json'), '{"private":true}\n');
    fs.writeFileSync(path.join(stage, '.npmrc'), `@getopencrawl:registry=${registry}\n`);
    const args = [npmCli(), 'install', '--prefix', stage, '--ignore-scripts', '--include=optional', '--no-audit', '--no-fund', '--no-package-lock', `--registry=${registry}`, `${PACKAGE}@${version}`];
    const result = spawnSync(process.execPath, args, {cwd: stage, stdio: 'pipe', timeout: 180_000, windowsHide: true});
    if (result.status !== 0) throw new Error('Could not install the update. The existing CLI is unchanged.');
    const installed = path.join(stage, 'node_modules/@getopencrawl/cli');
    const pkg = read(path.join(installed, 'package.json'));
    if (pkg?.name !== PACKAGE || pkg.version !== version) throw new Error('The installed release does not match the requested version.');
    if (!validRelease(installed, version)) throw new Error('The installed update is incomplete.');
    try { fs.renameSync(stage, destination); }
    catch (error) {
      // Another installer may have published this exact immutable release while
      // npm was running. Validate its complete result and discard only our stage.
      if (!validRelease(releaseRoot(version), version)) throw error;
    }
  } finally { fs.rmSync(stage, {recursive: true, force: true}); }
}
async function automaticUpdate() {
  if (process.env.OPENCRAWL_NO_UPDATE === '1') return;
  try { await update(); }
  catch { try { write(path.join(cacheRoot(), 'update.json'), {checkedAt: Date.now() - DAY + 15 * 60_000}); } catch {} }
}
function refreshSkills(root, {force = false, run = spawnSync} = {}) {
  const version = read(path.join(root, 'package.json'))?.version;
  const stateFile = path.join(cacheRoot(), 'skills-update.json'), previous = read(stateFile);
  if (!force && previous?.version === version && (previous.complete || previous.checkedAt > Date.now() - 15 * 60_000)) return {...previous.result, checked: false};
  let result = {status: 'unavailable', updated: 0, conflicts: 0, errors: 1};
  try {
    // Run the selected release's native installer, never this bootstrap's old
    // skill text. Refresh preserves each managed destination's saved API.
    const child = run(binary(root), ['skills', 'refresh', '--json'], {
      encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 15_000,
      env: {...process.env, OPENCRAWL_NO_UPDATE: '1'},
    });
    const output = JSON.parse(child.stdout || '{}');
    if (output.schemaVersion === 1 && Array.isArray(output.data?.results)) {
      const rows = output.data.results;
      const conflicts = rows.filter(row => row.status === 'conflict').length;
      const errors = rows.filter(row => row.status === 'error').length;
      if ([0, 1].includes(child.status) && rows.every(row => ['updated', 'unchanged', 'skipped', 'conflict', 'error'].includes(row.status))) {
        result = {status: conflicts || errors ? 'attention_required' : 'current', updated: rows.filter(row => row.status === 'updated').length, conflicts, errors};
      }
    }
  } catch {} // A skill conflict, denied directory or old binary cannot break CLI use.
  try {write(stateFile, {version, checkedAt: Date.now(), complete: result.status === 'current' || result.conflicts > 0 && !result.errors, result});} catch {}
  return {...result, checked: true};
}
async function main(args = process.argv.slice(2)) {
  if (args[0] === '--internal-update') {
    try { await update(); refreshSkills(activeRoot()); } catch { write(path.join(cacheRoot(), 'update.json'), {checkedAt: Date.now() - DAY + 15 * 60_000}); }
    return 0;
  }
  const selected = activeRoot();
  // Delegate the launcher too, so later releases can fix bootstrap behavior.
  if (selected !== ROOT) {
    process.env.OPENCRAWL_LAUNCHER ||= __filename;
    process.env.OPENCRAWL_NODE = process.execPath;
    return require(path.join(selected, 'bin/opencrawl.cjs')).main(args);
  }
  let parsed;
  try { parsed = parseArgs({args, allowPositionals: true, options: {json: {type: 'boolean'}, 'no-browser': {type: 'boolean'}, api: {type: 'string'}, version: {type: 'boolean', short: 'v'}, help: {type: 'boolean', short: 'h'}}}); }
  catch {} // The native parser produces the public, versioned usage error.
  if (parsed?.positionals.length === 1 && parsed.positionals[0] === 'update' && !parsed.values.help && !parsed.values.version) {
    try {
      const data = await update({force: true});
      const skills = refreshSkills(activeRoot(), {force: true});
      process.stdout.write(args.includes('--json') ? JSON.stringify({schemaVersion: 1, data: {...data, skills}}) + '\n' : (data.updated ? `Installed opencrawl ${data.version}. Your next invocation will use it.\n` : `opencrawl ${data.version} is current.\n`) + `Managed skills: ${skills.updated} updated, ${skills.conflicts} conflicts, ${skills.errors} errors.\n`);
      return 0;
    } catch (error) {
      // Older npm bootstraps call this exported main and otherwise replace a
      // rejected promise with their own generic reinstall error.
      return reportFailure(error, args);
    }
  }
  if (!(args[0] === 'collect' && ['hook','worker'].includes(args[1]))) await automaticUpdate();
  const root = activeRoot();
  if (process.env.OPENCRAWL_NO_UPDATE !== '1' && !(args[0] === 'collect' && ['hook', 'worker'].includes(args[1]))) {
    const skills = refreshSkills(root);
    if (skills.checked && skills.status !== 'current') process.stderr.write('opencrawl: Managed skill refresh needs attention; run opencrawl skills refresh --json to inspect preserved conflicts or directory access.\n');
  }
  const result = spawnSync(binary(root), args, {stdio: 'inherit', windowsHide: true, env: {...process.env, OPENCRAWL_LAUNCHER: process.env.OPENCRAWL_LAUNCHER || __filename, OPENCRAWL_NODE: process.execPath}});
  if (result.error) throw new Error('Could not start the OpenCrawl binary. Reinstall @getopencrawl/cli.');
  if (result.signal === 'SIGINT') return 130;
  return result.status ?? 1;
}
function reportFailure(error, args) {
  const denied = ['EPERM', 'EACCES', 'EROFS'].includes(error?.code);
  const code = denied ? 'PERMISSION_DENIED' : 'LAUNCHER_ERROR';
  const message = denied
    ? `Permission denied (${error.code}) while updating OpenCrawl. Allow write access to the OpenCrawl cache directory, or run opencrawl update outside the sandbox.`
    : 'Could not run or update OpenCrawl. Retry, or reinstall with npm install -g @getopencrawl/cli@next --include=optional.';
  if (args.includes('--json')) process.stdout.write(JSON.stringify({schemaVersion: 1, error: {code, message}}) + '\n');
  else process.stderr.write(`opencrawl: ${message}\n`);
  return 1;
}
module.exports = {channel: CHANNEL, target, stable, compare, activeRoot, update, installRelease, refreshSkills, binary, npmCli, main};
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => { process.exitCode = reportFailure(error, process.argv.slice(2)); });
