import {readdirSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
const dist = resolve(import.meta.dir, '../dist');
const folders = readdirSync(dist).filter(name => name !== 'cli').sort().concat('cli');
if (folders.length !== 6) throw new Error('Build all five platform packages before publishing.');
for (const folder of folders) {
  const directory = join(dist, folder);
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const existing = Bun.spawnSync(['npm', 'view', `${pkg.name}@${pkg.version}`, 'version', '--registry=https://registry.npmjs.org'], {stdout: 'pipe', stderr: 'pipe'});
  if (existing.exitCode === 0) {
    if (folder === 'cli') throw new Error('This CLI version is already published. Increment cli/package.json.');
    console.log(`Keeping already-published immutable platform ${pkg.name}@${pkg.version}`);
    continue;
  }
  if (!existing.stderr.toString().includes('E404')) throw new Error(`Could not determine publication state for ${pkg.name}.`);
  const result = Bun.spawnSync(['npm', 'publish', '--access', 'public', '--registry=https://registry.npmjs.org'], {cwd: directory, stdio: ['inherit', 'inherit', 'inherit']});
  if (result.exitCode) throw new Error(`Publication failed for ${pkg.name}; the launcher has not been promoted.`);
}
