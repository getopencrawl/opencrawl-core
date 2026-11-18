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
  const revision='a'.repeat(40),integrity='sha512-fixture';
  for (const folder of names) {
    mkdirSync(join(dist, folder));
    writeFileSync(join(dist, folder, 'README.md'), '# OpenCrawl CLI\n\nCapture and search workspace knowledge.\n');
    writeFileSync(join(dist, folder, 'package.json'), JSON.stringify({name: folder === 'cli' ? cli : `${cli}-${folder}`, version: '1.0.0',opencrawlRevision:revision,license:'Apache-2.0',homepage:'https://getopencrawl.com',repository:{url:'https://github.com/getopencrawl/opencrawl-core.git',directory:'cli'},bugs:{url:'https://github.com/getopencrawl/opencrawl-core/issues'},...(folder==='cli'?{optionalDependencies:Object.fromEntries(names.filter(x=>x!=='cli').map(x=>[cli+'-'+x,'1.0.0']))}:{})}));
  }
  const state = {
    tags: {latest: '0.9.0', next: '0.9.0', 'next-pending': '0.9.0'} as Record<string, string>,
    packageTags: new Map<string, Record<string, string>>(),
    published: new Set<string>(), downloaded: new Set<string>(),
    publishCalls: [] as string[], promotions: [] as string[], uploadsInFlight: 0, peakUploads: 0,
    blocked: new Set<string>(), clock: 0, onSleep: () => {}, failPromotion: false, failAfterPromotions: Infinity,
    stalePackumentTags: false, tagResponse: undefined as string | undefined,
    metadata: new Map<string,Record<string,unknown>>(),
  };
  for (const folder of names) state.packageTags.set(folder === 'cli' ? cli : `${cli}-${folder}`, folder === 'cli' ? state.tags : {latest: '0.9.0', next: '0.9.0'});
  const result = (exitCode: number, stdout = '', stderr = '') => ({exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr)});
  const run = ((args: string[], options: {cwd?: string}) => {
    if (args[1] === 'pack') return result(0, JSON.stringify([{integrity,files: ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'runtime/opencrawl.js'].map(path => ({path}))}]));
    // The repository's GitHub Packages scope must never override these commands.
    expect(args).toContain('--registry=https://registry.npmjs.org');
    expect(args).toContain('--@getopencrawl:registry=https://registry.npmjs.org');
    if (args[1] === 'view') {
      if (args[3] === 'dist-tags') return result(0, JSON.stringify(state.stalePackumentTags ? {latest: '0.9.0', next: '0.9.0'} : state.packageTags.get(args[2])));
      const name = args[2].slice(0, args[2].lastIndexOf('@'));
      return state.published.has(name) ? result(0, JSON.stringify(state.metadata.get(name)??{version:'1.0.0',opencrawlRevision:revision,dist:{integrity}})) : result(1, '', 'E404');
    }
    if (args[1] === 'publish') {
      const pkg = JSON.parse(readFileSync(join(options.cwd!, 'package.json'), 'utf8'));
      expect(state.published.has(pkg.name)).toBe(false); // immutable versions are never republished
      state.published.add(pkg.name);
      state.publishCalls.push(pkg.name);
      expect(state.downloaded.size).toBe(0);
      expect(args[args.indexOf('--tag') + 1]).toBe('latest-pending');
      state.packageTags.get(pkg.name)!['latest-pending'] = pkg.version;
      return result(0);
    }
    if (args[1] === 'dist-tag') {
      if (args[2] === 'ls') return result(0, state.tagResponse ?? Object.entries(state.packageTags.get(args[3])!).map(([tag, version]) => `${tag}: ${version}`).join('\n'));
      expect(state.downloaded.size).toBe(6); // metadata alone is insufficient
      if (args[2] === 'rm') { delete state.packageTags.get(args[3])![args[4]]; return result(0); }
      if (state.failPromotion || state.promotions.length === state.failAfterPromotions) return result(1, '', 'temporary registry failure');
      const name = args[3].slice(0, args[3].lastIndexOf('@'));
      state.promotions.push(args[3] + ':' + args[4]);
      state.packageTags.get(name)![args[4]] = '1.0.0';
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
    return Response.json(state.metadata.get(name)??{version:'1.0.0',opencrawlRevision:revision,dist: {integrity,tarball: `https://registry.npmjs.org/${name}`}});
  }) as typeof fetch;
  const execute = (dryRun = false) => publish({dist, dryRun, run, fetcher,
    upload: async (args, directory) => {
      state.peakUploads = Math.max(state.peakUploads, ++state.uploadsInFlight);
      await Promise.resolve();
      try { return run(args, {cwd: directory}).exitCode; }
      finally { state.uploadsInFlight--; }
    },
    now: () => state.clock, sleep: async () => { state.onSleep(); state.clock += 20 * 60_000; }});
  return {state, execute, cli,dist,revision,integrity};
}

test('launcher remains staged until its own tarball is downloadable', () => registryFixture(async ({state, execute, cli}) => {
  state.blocked.add(cli);
  state.onSleep = () => {
    expect(state.tags.next).toBe('0.9.0');
    expect(state.tags['latest-pending']).toBe('1.0.0');
    expect(state.promotions).toEqual([]);
    state.blocked.delete(cli);
  };
  await execute();
  expect(state.promotions.length).toBe(12);
  for (const tags of state.packageTags.values()) expect(tags).toEqual({latest: '1.0.0', next: '1.0.0'});
  expect(state.tags.next).toBe('1.0.0');
}));

test('staging tags are removed even when package metadata lags behind tag writes', () => registryFixture(async ({state, execute}) => {
  state.stalePackumentTags = true;
  await execute();
  for (const tags of state.packageTags.values()) expect(tags).toEqual({latest: '1.0.0', next: '1.0.0'});
}));

test('unrecognized tag output fails before publishing', () => registryFixture(async ({state, execute}) => {
  for (const output of ['', 'unrecognized response', 'latest: 1.0.0\nlatest: 0.9.0']) {
    state.tagResponse = output;
    await expect(execute()).rejects.toThrow('Invalid CLI release tag response');
  }
  expect(state.publishCalls).toEqual([]);
}));

test('availability timeout leaves channel unchanged and a rerun resumes immutable packages', () => registryFixture(async ({state, execute, cli}) => {
  state.blocked.add(cli);
  await expect(execute()).rejects.toThrow('not downloadable');
  expect(state.tags.next).toBe('0.9.0');
  expect(state.publishCalls.length).toBe(6);
  state.blocked.clear();
  await execute();
  expect(state.publishCalls.length).toBe(6);
  expect(state.promotions.length).toBe(12);
  await execute(); // already promoted is idempotent
  expect(state.promotions.length).toBe(12);
}));

test('all six uploads are staged before the first availability wait, and one missing tarball prevents promotion', () => registryFixture(async ({state, execute, cli}) => {
  state.blocked.add(`${cli}-linux-x64`);
  await expect(execute()).rejects.toThrow('not downloadable');
  expect(state.publishCalls).toHaveLength(6);
  expect(state.peakUploads).toBe(6);
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
  expect(state.promotions.length).toBe(12);
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
test('an existing native package from another source cannot be reused',()=>registryFixture(async({state,execute,cli,integrity})=>{
  const name=cli+'-darwin-arm64';state.published.add(name);
  state.metadata.set(name,{version:'1.0.0',opencrawlRevision:'b'.repeat(40),dist:{integrity}});
  await expect(execute()).rejects.toThrow('differs from this source or artifact');
  expect(state.publishCalls).toEqual([]);expect(state.promotions).toEqual([]);
}));
test('same-source bytes must match the already-published immutable artifact',()=>registryFixture(async({state,execute,cli,revision})=>{
  const name=cli+'-darwin-arm64';state.published.add(name);
  state.metadata.set(name,{version:'1.0.0',opencrawlRevision:revision,dist:{integrity:'sha512-different'}});
  await expect(execute()).rejects.toThrow('differs from this source or artifact');
  expect(state.publishCalls).toEqual([]);expect(state.promotions).toEqual([]);
}));
test('mixed local platform provenance fails before publishing anything',()=>registryFixture(async({state,execute,dist})=>{
  const file=join(dist,'linux-arm64','package.json'),pkg=JSON.parse(readFileSync(file,'utf8'));
  writeFileSync(file,JSON.stringify({...pkg,opencrawlRevision:'b'.repeat(40)}));
  await expect(execute()).rejects.toThrow('mixed package names, versions or source revisions');
  expect(state.publishCalls).toEqual([]);
}));
test('registry source mismatches at availability cannot promote the launcher',()=>registryFixture(async({state,execute,cli,integrity})=>{
  state.metadata.set(cli+'-linux-arm64',{version:'1.0.0',opencrawlRevision:'b'.repeat(40),dist:{integrity,tarball:'https://registry.npmjs.org/fixture'}});
  await expect(execute()).rejects.toThrow('Published package source mismatch');
  expect(state.publishCalls).toHaveLength(6);expect(state.promotions).toEqual([]);
}));
test('a launcher pointing at another platform version is rejected before publishing',()=>registryFixture(async({state,execute,cli,dist})=>{
  const file=join(dist,'cli','package.json'),pkg=JSON.parse(readFileSync(file,'utf8'));
  pkg.optionalDependencies[cli+'-linux-arm64']='0.9.0';writeFileSync(file,JSON.stringify(pkg));
  await expect(execute()).rejects.toThrow('launcher dependency');expect(state.publishCalls).toEqual([]);
}));

test('a partially promoted release resumes every package and both install tags', () => registryFixture(async ({state, execute}) => {
  state.failAfterPromotions = 3;
  await expect(execute()).rejects.toThrow('promotion failed');
  expect(state.tags.latest).toBe('0.9.0');
  state.failAfterPromotions = Infinity;
  await execute();
  expect(state.publishCalls.length).toBe(6);
  expect(state.promotions.length).toBe(12);
  for (const tags of state.packageTags.values()) expect(tags).toEqual({latest: '1.0.0', next: '1.0.0'});
}));
test('a newer platform default prevents the whole release from downgrading', () => registryFixture(async ({state, execute, cli}) => {
  state.packageTags.get(cli + '-linux-x64')!.latest = '1.1.0';
  await expect(execute()).rejects.toThrow('downgrade');
  expect(state.publishCalls).toEqual([]);
}));
test('promotion rechecks channels after waiting for archive availability', () => registryFixture(async ({state, execute, cli}) => {
  state.blocked.add(cli);
  state.onSleep = () => { state.blocked.clear(); state.tags.latest = '1.1.0'; };
  await expect(execute()).rejects.toThrow('downgrade');
  expect(state.promotions).toEqual([]);
}));

test('incorrect repository metadata cannot reach npm', () => registryFixture(async ({state, execute, dist}) => {
  const file=join(dist,'cli','package.json'),pkg=JSON.parse(readFileSync(file,'utf8'));
  pkg.repository.url='https://github.com/1patch/OpenCrawl.git';writeFileSync(file,JSON.stringify(pkg));
  await expect(execute()).rejects.toThrow('Invalid public package metadata');
  expect(state.publishCalls).toEqual([]);
}));
test('README links must be absolute and product copy must stay short and current', () => registryFixture(async ({state, execute, dist}) => {
  for (const text of ['[Guide](../docs/guide.md)', '# OpenCrawl v2', 'legacy product', 'npm install @getopencrawl/cli@next', 'x'.repeat(4097)]) {
    writeFileSync(join(dist,'cli','README.md'),text);
    await expect(execute()).rejects.toThrow('Invalid public package README');
  }
  expect(state.publishCalls).toEqual([]);
}));
