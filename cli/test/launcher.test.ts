import {test, expect} from 'bun:test';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, renameSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
const require = createRequire(import.meta.url);
const launcher = require('../bin/opencrawl.cjs');
const {makePackage} = require('./fixtures/launcher-update.cjs');
const node = Bun.which('node')!;
const fixture = resolve(import.meta.dir, 'fixtures/launcher-update.cjs');

async function isolated(run: (directory: string, root: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'opencrawl-update-'));
  const previous = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = join(directory, 'cache');
  const root = join(directory, 'installed');
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({name: '@getopencrawl/cli', version: '0.1.0'}));
  try { await run(directory, root); }
  finally {
    if (previous === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previous;
    rmSync(directory, {recursive: true, force: true});
  }
}
const cache = (directory: string) => join(directory, 'cache/opencrawl');
const release = (directory: string, version: string, options?: object) => makePackage(join(cache(directory), 'releases', version), version, options);
const selected = (root: string) => JSON.parse(readFileSync(join(launcher.activeRoot(root), 'package.json'), 'utf8')).version;

async function children(directory: string, run: (start: (name: string, version: string, mode?: string) => void, wait: (name: string) => Promise<any>, allow: (name: string) => void) => Promise<void>) {
  mkdirSync(cache(directory), {recursive: true});
  writeFileSync(join(directory, 'npm-cli.js'), '// fixture only');
  const running: {child: ChildProcess; exited: Promise<unknown>}[] = [];
  const start = (name: string, version: string, mode = 'update') => {
    const child = spawn(node, [fixture, directory, name, version, mode], {env: {...process.env, npm_execpath: join(directory, 'npm-cli.js')}, stdio: 'ignore'});
    running.push({child, exited: new Promise(resolve => child.once('exit', resolve))});
  };
  const wait = async (name: string) => {
    const deadline = Date.now() + 15000;
    while (!existsSync(join(directory, name))) {
      if (Date.now() > deadline) throw new Error('Fixture timed out: ' + name);
      await Bun.sleep(10);
    }
    return JSON.parse(readFileSync(join(directory, name), 'utf8'));
  };
  const allow = (name: string) => writeFileSync(join(directory, name), 'true');
  try { await run(start, wait, allow); }
  finally {
    for (const {child} of running) if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.all(running.map(({exited}) => exited));
  }
}

test('stable versions cannot become paths or downgrade; unsupported targets fail', () => {
  expect(launcher.compare('0.10.0', '0.9.9')).toBe(1);
  expect(launcher.stable('../0.2.0')).toBe(false);
  expect(launcher.stable('0.2.0-beta')).toBe(false);
  expect(() => launcher.target('win32', 'arm64')).toThrow();
});

test('updates publish complete releases, throttle, and preserve the working copy on failure', async () => isolated(async (directory, root) => {
  let requests = 0;
  const fetcher = async (url: string) => { expect(url.endsWith('/next')).toBe(true); requests++; return new Response(JSON.stringify({name: '@getopencrawl/cli', version: '0.2.0'})); };
  const pointer = join(cache(directory), 'current.json');
  await expect(launcher.update({root, fetcher, force: true, install: async () => { throw new Error('offline'); }})).rejects.toThrow('offline');
  expect(existsSync(pointer)).toBe(false);
  await expect(launcher.update({root, fetcher, force: true, install: async () => {}})).rejects.toThrow('incomplete');
  expect(existsSync(pointer)).toBe(false);
  let finish: () => void = () => {};
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const first = launcher.update({root, fetcher, force: true, install: async () => { await blocked; release(directory, '0.2.0'); }});
  await Bun.sleep(10);
  expect(selected(root)).toBe('0.1.0');
  expect(existsSync(pointer)).toBe(false);
  finish();
  expect(await first).toEqual({updated: true, version: '0.2.0'});
  expect(JSON.parse(readFileSync(pointer, 'utf8')).version).toBe('0.2.0');
  const before = requests;
  expect(await launcher.update({root, fetcher})).toEqual({updated: false, version: '0.2.0'});
  expect(requests).toBe(before);
}));

test('selection uses the highest complete matching release despite stale pointers and partial stages', async () => isolated(async (directory, root) => {
  release(directory, '0.2.0'); release(directory, '0.10.0');
  release(directory, '0.11.0', {platformVersion: '0.1.0'});
  const missingLauncher = release(directory, '0.12.0');
  rmSync(join(missingLauncher, 'bin/opencrawl.cjs'));
  makePackage(join(cache(directory), 'releases/.stage-incomplete'), '9.0.0');
  writeFileSync(join(cache(directory), 'current.json'), JSON.stringify({version: '0.2.0'}));
  expect(selected(root)).toBe('0.10.0');
  writeFileSync(join(cache(directory), 'current.json'), 'invalid JSON');
  expect(selected(root)).toBe('0.10.0');
  rmSync(join(cache(directory), 'releases/0.10.0'), {recursive: true});
  expect(selected(root)).toBe('0.2.0');
  rmSync(join(cache(directory), 'releases/0.2.0'), {recursive: true});
  expect(launcher.activeRoot(root)).toBe(root);
}));

test('concurrent updates cannot downgrade a newer completed release', async () => isolated(async (directory, root) => {
  for (const version of ['0.4.0', '0.5.0', '0.6.0']) release(directory, version);
  // Hide the complete fixtures until each real cached-install path is reached.
  const releases = join(cache(directory), 'releases');
  for (const version of ['0.4.0', '0.5.0', '0.6.0']) {
    const from = join(releases, version), to = join(directory, version);
    renameSync(from, to);
  }
  await children(directory, async (start, wait, allow) => {
    start('A', '0.5.0'); start('B', '0.4.0');
    await Promise.all([wait('A.fetch-entered'), wait('B.fetch-entered')]);
    renameSync(join(directory, '0.5.0'), join(releases, '0.5.0'));
    allow('A.allow-fetch'); expect((await wait('A.result')).ok).toBe(true);
    expect(selected(root)).toBe('0.5.0');
    start('C', '0.6.0'); await wait('C.fetch-entered');
    renameSync(join(directory, '0.6.0'), join(releases, '0.6.0'));
    allow('C.allow-fetch'); expect((await wait('C.result')).ok).toBe(true);
    renameSync(join(directory, '0.4.0'), join(releases, '0.4.0'));
    allow('B.allow-fetch'); const delayed = await wait('B.result');
    expect(delayed).toEqual({ok: true, result: {updated: true, version: '0.6.0'}});
    expect(selected(root)).toBe('0.6.0');
    // A stale selection hint cannot lower the highest complete release.
    writeFileSync(join(cache(directory), 'current.json'), JSON.stringify({version: '0.4.0'}));
    expect(selected(root)).toBe('0.6.0');
  });
}), 30000);

test('same-version installers keep one complete publication and remove only their own stages', async () => isolated(async (directory, root) => {
  await children(directory, async (start, wait, allow) => {
    start('A', '0.2.0', 'install'); start('B', '0.2.0', 'install');
    await Promise.all([wait('A.stage-ready'), wait('B.stage-ready')]);
    expect(selected(root)).toBe('0.1.0');
    allow('A.allow-install'); expect((await wait('A.result')).ok).toBe(true);
    expect(selected(root)).toBe('0.2.0');
    const winner = join(cache(directory), 'releases/0.2.0/winner');
    writeFileSync(winner, 'first complete publication');
    allow('B.allow-install'); expect((await wait('B.result')).ok).toBe(true);
    expect(readdirSync(join(cache(directory), 'releases'))).toEqual(['0.2.0']);
    expect(readFileSync(winner, 'utf8')).toBe('first complete publication');
  });
}), 30000);

test('failed partial npm staging preserves the selected release and removes its stage', async () => isolated(async (directory, root) => {
  release(directory, '0.2.0');
  await children(directory, async (start, wait, allow) => {
    start('A', '0.3.0', 'failure'); await wait('A.stage-ready');
    expect(selected(root)).toBe('0.2.0');
    allow('A.allow-install'); expect((await wait('A.result')).ok).toBe(false);
    expect(selected(root)).toBe('0.2.0');
    expect(readdirSync(join(cache(directory), 'releases'))).toEqual(['0.2.0']);
  });
}), 30000);

test('the installed launcher delegates to the highest complete cached release', async () => isolated(async (directory, root) => {
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/opencrawl.cjs'), readFileSync(resolve(import.meta.dir, '../bin/opencrawl.cjs')));
  release(directory, '0.2.0', {launcher: readFileSync(resolve(import.meta.dir, '../bin/opencrawl.cjs'), 'utf8')});
  release(directory, '0.3.0', {launcher: 'module.exports.main = async () => {process.stdout.write("selected-current-fixture\\n"); return 0;};'});
  writeFileSync(join(cache(directory), 'current.json'), JSON.stringify({version: '0.2.0'}));
  const result = spawnSync(node, [join(root, 'bin/opencrawl.cjs'), '--version'], {env: {...process.env, OPENCRAWL_NO_UPDATE: '1'}, encoding: 'utf8'});
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe('selected-current-fixture');
}));

test('the exported launcher main preserves permission errors through a delegating caller', async () => isolated(async (directory, root) => {
  mkdirSync(join(root, 'bin'));
  const installedLauncher = join(root, 'bin/opencrawl.cjs');
  writeFileSync(installedLauncher, readFileSync(resolve(import.meta.dir, '../bin/opencrawl.cjs')));
  release(directory, '0.2.0', {launcher: readFileSync(installedLauncher, 'utf8')});
  const caller = join(directory, 'caller.cjs');
  writeFileSync(caller, `require(${JSON.stringify(installedLauncher)}).main(process.argv.slice(2)).then(code => {process.exitCode = code;}).catch(() => {process.stdout.write('unexpected caller fallback');process.exitCode = 2;});`);
  const preload = join(directory, 'denied-cache.cjs');
  writeFileSync(preload, `
    const fs = require('node:fs'), mkdir = fs.mkdirSync;
    global.fetch = async () => Response.json({name:'@getopencrawl/cli', version:'0.2.0'});
    fs.mkdirSync = function(file, ...args) {
      if (String(file) === ${JSON.stringify(cache(directory))}) throw Object.assign(new Error('never-print-secret-path'), {code:process.env.FIXTURE_DENIAL});
      return mkdir.call(this, file, ...args);
    };
  `);
  for (const code of ['EPERM', 'EACCES', 'EROFS']) {
    const result = spawnSync(node, ['--require', preload, caller, 'update', '--json'], {env: {...process.env, OPENCRAWL_NO_UPDATE:'1', FIXTURE_DENIAL:code}, encoding:'utf8'});
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({schemaVersion:1, error:{code:'PERMISSION_DENIED'}});
    expect(result.stdout).toContain(code);
    expect(result.stdout).not.toContain('never-print');
    expect(result.stderr).toBe('');
  }
}));
