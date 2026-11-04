import {readdirSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {createRequire} from 'node:module';
const channel = createRequire(import.meta.url)('../bin/opencrawl.cjs').channel;
const dryRun = process.argv.includes('--dry-run');
const dist = resolve(import.meta.dir, '../dist');
const folders = readdirSync(dist).filter(name => name !== 'cli').sort().concat('cli');
if (folders.length !== 6) throw new Error('Build all five platform packages before publishing.');
// npm acknowledges publication before its malware scan makes a version installable.
// Do not advertise an update until every optional native dependency is downloadable.
async function waitForAvailability(names: string[]) {
  if (dryRun) return;
  const pending = new Set(names);
  const deadline = Date.now() + 20 * 60_000;
  while (pending.size) {
    await Promise.all([...pending].map(async folder => {
      const pkg = JSON.parse(readFileSync(join(dist, folder, 'package.json'), 'utf8'));
      try {
        const response = await fetch(`https://registry.npmjs.org/${pkg.name}/${pkg.version}`, {signal: AbortSignal.timeout(15_000)});
        if (!response.ok) return;
        const metadata = await response.json() as {dist?: {tarball?: string}};
        if (!metadata.dist?.tarball) return;
        const tarball = await fetch(metadata.dist.tarball, {method: 'HEAD', signal: AbortSignal.timeout(15_000)});
        if (tarball.ok) pending.delete(folder);
      } catch { /* Registry/network delays are retried within the deadline. */ }
    }));
    if (!pending.size) return;
    if (Date.now() >= deadline) throw new Error(`Published packages are not downloadable: ${[...pending].join(', ')}. Check npm scanning status before promoting this release.`);
    console.log(`Waiting for npm availability: ${[...pending].join(', ')}`);
    await Bun.sleep(15_000);
  }
}
for (const folder of folders) {
  if (folder === 'cli') await waitForAvailability(folders.filter(name => name !== 'cli'));
  const directory = join(dist, folder);
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const existing = dryRun ? null : Bun.spawnSync(['npm', 'view', `${pkg.name}@${pkg.version}`, 'version', '--registry=https://registry.npmjs.org'], {stdout: 'pipe', stderr: 'pipe'});
  if (existing?.exitCode === 0) {
    if (folder === 'cli') throw new Error('This CLI version is already published. Increment cli/package.json.');
    console.log(`Keeping already-published immutable platform ${pkg.name}@${pkg.version}`);
    continue;
  }
  if (existing && !existing.stderr.toString().includes('E404')) throw new Error(`Could not determine publication state for ${pkg.name}.`);
  const result = Bun.spawnSync(dryRun ? ['npm', 'pack', '--dry-run'] : ['npm', 'publish', '--tag', channel, '--access', 'public', '--registry=https://registry.npmjs.org'], {cwd: directory, stdio: ['inherit', 'inherit', 'inherit']});
  if (result.exitCode) throw new Error(`Publication failed for ${pkg.name}; the launcher has not been promoted.`);
}

await waitForAvailability(['cli']);
