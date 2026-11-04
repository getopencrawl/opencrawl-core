import {test, expect} from 'bun:test';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
const launcher = createRequire(import.meta.url)('../bin/opencrawl.cjs');

test('stable versions cannot become paths or downgrade; unsupported targets fail', () => {
  expect(launcher.compare('0.10.0', '0.9.9')).toBe(1);
  expect(launcher.stable('../0.2.0')).toBe(false);
  expect(launcher.stable('0.2.0-beta')).toBe(false);
  expect(() => launcher.target('win32', 'arm64')).toThrow();
});

test('updates switch only after installation, serialize, throttle, and preserve working copy on failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencrawl-update-'));
  const previous = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = directory;
  const root = join(directory, 'installed');
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({name: '@getopencrawl/cli', version: '0.1.0'}));
  let requests = 0;
  const fetcher = async () => { requests++; return new Response(JSON.stringify({name: '@getopencrawl/cli', version: '0.2.0'})); };
  const pointer = join(directory, 'opencrawl/current.json');
  try {
    await expect(launcher.update({root, fetcher, force: true, install: async () => { throw new Error('offline'); }})).rejects.toThrow('offline');
    expect(existsSync(pointer)).toBe(false);
    let release: () => void = () => {};
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const first = launcher.update({root, fetcher, force: true, install: async () => { expect(existsSync(pointer)).toBe(false); await blocked; }});
    await new Promise(resolve => setTimeout(resolve, 10));
    expect((await launcher.update({root, fetcher, force: true})).busy).toBe(true);
    release();
    expect((await first).version).toBe('0.2.0');
    expect(JSON.parse(readFileSync(pointer, 'utf8')).version).toBe('0.2.0');
    const before = requests;
    await launcher.update({root, fetcher});
    expect(requests).toBe(before);
    expect(launcher.activeRoot(root)).toBe(root); // damaged/missing cached release falls back
  } finally {
    if (previous === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previous;
    rmSync(directory, {recursive: true, force: true});
  }
});
