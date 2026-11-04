import {mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync} from 'node:fs';
import {resolve, join} from 'node:path';
const root = resolve(import.meta.dir, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('A stable version is required.');
const targets = [
  ['darwin', 'arm64', 'bun-darwin-arm64'], ['darwin', 'x64', 'bun-darwin-x64'],
  ['linux', 'arm64', 'bun-linux-arm64'], ['linux', 'x64', 'bun-linux-x64-baseline'],
  ['win32', 'x64', 'bun-windows-x64-baseline'],
];
const selected = process.argv.includes('--current') ? targets.filter(([os, arch]) => os === process.platform && arch === process.arch) : targets;
const dist = join(root, 'dist');
const optionalDependencies: Record<string, string> = {};
for (const [os, arch, target] of selected) {
  const name = `${pkg.name}-${os}-${arch}`;
  const directory = join(dist, `${os}-${arch}`);
  mkdirSync(join(directory, 'bin'), {recursive: true});
  const targetArgs = process.argv.includes('--current') ? [] : [`--target=${target}`];
  const result = Bun.spawnSync(['bun', 'build', '--compile', ...targetArgs, '--minify', '--define', `OPENCRAWL_VERSION=${JSON.stringify(pkg.version)}`, join(root, 'src/cli.ts'), '--outfile', join(directory, 'bin', os === 'win32' ? 'opencrawl.exe' : 'opencrawl')], {stdio: ['inherit', 'inherit', 'inherit']});
  if (result.exitCode !== 0) throw new Error(`Build failed for ${target}`);
  if (os === 'darwin') {
    if (process.platform !== 'darwin') throw new Error('Build release macOS binaries on macOS so their signatures can be repaired.');
    const binary = join(directory, 'bin/opencrawl');
    if (Bun.spawnSync(['codesign', '--force', '--sign', '-', binary]).exitCode !== 0 || Bun.spawnSync(['codesign', '--verify', '--strict', binary]).exitCode !== 0) throw new Error('macOS signing failed.');
  }
  writeFileSync(join(directory, 'package.json'), JSON.stringify({name, version: pkg.version, description: `OpenCrawl binary for ${os}/${arch}`, license: pkg.license, repository: pkg.repository, os: [os], cpu: [arch], files: [os === 'win32' ? 'bin/opencrawl.exe' : 'bin/opencrawl'], publishConfig: pkg.publishConfig}, null, 2) + '\n');
  copyFileSync(join(root, 'README.md'), join(directory, 'README.md'));
  optionalDependencies[name] = pkg.version;
}
const launcher = join(dist, 'cli');
mkdirSync(join(launcher, 'bin'), {recursive: true});
const {scripts, devDependencies, ...published} = pkg;
writeFileSync(join(launcher, 'package.json'), JSON.stringify({...published, optionalDependencies}, null, 2) + '\n');
copyFileSync(join(root, 'bin/opencrawl.cjs'), join(launcher, 'bin/opencrawl.cjs'));
chmodSync(join(launcher, 'bin/opencrawl.cjs'), 0o755);
copyFileSync(join(root, 'README.md'), join(launcher, 'README.md'));
console.log(`Prepared ${selected.length} platform packages and ${pkg.name}@${pkg.version} in cli/dist.`);
