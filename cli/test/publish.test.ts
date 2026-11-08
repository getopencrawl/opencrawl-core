import {test, expect} from 'bun:test';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {publish} from '../scripts/publish.ts';

async function registryFixture(check: (fixture: ReturnType<typeof registry>) => Promise<void>) {
  const dist = mkdtempSync(join(tmpdir(), 'opencrawl-publish-'));
  try { await check(registry(dist)); }
  finally { rmSync(dist, {recursive: true, force: true}); }
}
function registry(dist: string) {
  const names = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64', 'cli'];
  const cli = '@getopencrawl/cli';
  for (const folder of names) {
    mkdirSync(join(dist, folder));
    writeFileSync(join(dist, folder, 'package.json'), JSON.stringify({name: folder === 'cli' ? cli : `${cli}-${folder}`, version: '1.0.0'}));
  }
  const state = {
    tags: {next: '0.9.0'} as Record<string, string>,
    published: new Set<string>(), downloaded: new Set<string>(),
    publishCalls: [] as string[], promotions: [] as string[],
    blocked: new Set<string>(), clock: 0, onSleep: () => {}, failPromotion: false,
  };
  const result = (exitCode: number, stdout = '', stderr = '') => ({exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr)});
  const run = ((args: string[], options: {cwd?: string}) => {
    if (args[1] === 'pack') return result(0, JSON.stringify([{files: ['LICENSE', 'THIRD_PARTY_NOTICES.txt', 'runtime/opencrawl.js'].map(path => ({path}))}]));
    // The repository's GitHub Packages scope must never override these commands.
    expect(args).toContain('--registry=https://registry.npmjs.org');
    expect(args).toContain('--@getopencrawl:registry=https://registry.npmjs.org');
    if (args[1] === 'view') {
      if (args[3] === 'dist-tags') return result(0, JSON.stringify(state.tags));
      const name = args[2].slice(0, args[2].lastIndexOf('@'));
      return state.published.has(name) ? result(0, '1.0.0') : result(1, '', 'E404');
    }
    if (args[1] === 'publish') {
      const pkg = JSON.parse(readFileSync(join(options.cwd!, 'package.json'), 'utf8'));
      expect(state.published.has(pkg.name)).toBe(false); // immutable versions are never republished
      state.published.add(pkg.name);
      state.publishCalls.push(pkg.name);
      if (pkg.name === cli) {
        expect(state.downloaded.size).toBe(5);
        expect(args[args.indexOf('--tag') + 1]).toBe('next-pending');
        state.tags['next-pending'] = pkg.version;
      }
      return result(0);
    }
    if (args[1] === 'dist-tag') {
      expect(state.downloaded.size).toBe(6); // metadata alone is insufficient
      if (state.failPromotion) return result(1, '', 'temporary registry failure');
      state.promotions.push(args[3]);
      state.tags[args[4]] = '1.0.0';
      return result(0);
    }
    throw new Error(`Unexpected npm operation ${args[1]}`);
  }) as typeof Bun.spawnSync;
  const fetcher = (async (url: string, options?: RequestInit) => {
    const name = url.replace('https://registry.npmjs.org/', '').replace(/\/1\.0\.0$/, '');
    if (options?.method === 'HEAD') {
      if (state.blocked.has(name)) return new Response('', {status: 404});
      state.downloaded.add(name);
      return new Response('');
    }
    if (!state.published.has(name)) return new Response('', {status: 404});
    return Response.json({dist: {tarball: `https://registry.npmjs.org/${name}`}});
  }) as typeof fetch;
  const execute = (dryRun = false) => publish({dist, channel: 'next', dryRun, run, fetcher, now: () => state.clock, sleep: async () => { state.onSleep(); state.clock += 20 * 60_000; }});
  return {state, execute, cli};
}

test('launcher remains staged until its own tarball is downloadable', () => registryFixture(async ({state, execute, cli}) => {
  state.blocked.add(cli);
  state.onSleep = () => {
    expect(state.tags.next).toBe('0.9.0');
    expect(state.tags['next-pending']).toBe('1.0.0');
    expect(state.promotions).toEqual([]);
    state.blocked.delete(cli);
  };
  await execute();
  expect(state.promotions).toEqual([`${cli}@1.0.0`]);
  expect(state.tags.next).toBe('1.0.0');
}));

test('availability timeout leaves channel unchanged and a rerun resumes immutable packages', () => registryFixture(async ({state, execute, cli}) => {
  state.blocked.add(cli);
  await expect(execute()).rejects.toThrow('not downloadable');
  expect(state.tags.next).toBe('0.9.0');
  expect(state.publishCalls.length).toBe(6);
  state.blocked.clear();
  await execute();
  expect(state.publishCalls.length).toBe(6);
  expect(state.promotions.length).toBe(1);
  await execute(); // already promoted is idempotent
  expect(state.promotions.length).toBe(1);
}));

test('a native tarball timeout cannot publish or promote the launcher', () => registryFixture(async ({state, execute, cli}) => {
  state.blocked.add(`${cli}-linux-x64`);
  await expect(execute()).rejects.toThrow('not downloadable');
  expect(state.publishCalls).not.toContain(cli);
  expect(state.promotions).toEqual([]);
}));

test('rerunning an older release cannot downgrade the update channel', () => registryFixture(async ({state, execute}) => {
  state.tags.next = '1.1.0';
  await expect(execute()).rejects.toThrow('downgrade');
  expect(state.publishCalls).toEqual([]);
}));

test('a failed promotion can resume without republishing packages', () => registryFixture(async ({state, execute}) => {
  state.failPromotion = true;
  await expect(execute()).rejects.toThrow('promotion failed');
  expect(state.tags.next).toBe('0.9.0');
  state.failPromotion = false;
  await execute();
  expect(state.publishCalls.length).toBe(6);
  expect(state.promotions.length).toBe(1);
}));

test('an existing launcher outside the current release is rejected', () => registryFixture(async ({state, execute, cli}) => {
  state.published.add(cli);
  await expect(execute()).rejects.toThrow('outside this release');
  expect(state.promotions).toEqual([]);
}));

test('dry run never touches registry state', () => registryFixture(async ({state, execute}) => {
  await execute(true);
  expect(state.publishCalls).toEqual([]);
  expect(state.downloaded.size).toBe(0);
  expect(state.promotions).toEqual([]);
}));
