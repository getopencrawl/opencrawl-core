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
function copyReleaseFiles(directory:string) {
  for(const name of ['README.md','LICENSE','THIRD_PARTY_NOTICES.txt'])copyFileSync(join(root,name),join(directory,name));
  mkdirSync(join(directory,'runtime'),{recursive:true});
  const result=Bun.spawnSync(['bun','build','--target=bun','--define',`OPENCRAWL_VERSION=${JSON.stringify(pkg.version)}`,join(root,'src/cli.ts'),'--outfile',join(directory,'runtime/opencrawl.js')],{stdio:['inherit','inherit','inherit']});
  if(result.exitCode)throw new Error('Could not build the replaceable-runtime application bundle.');
}
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
  writeFileSync(join(directory, 'package.json'), JSON.stringify({name, version: pkg.version, ...(pkg.opencrawlRevision?{opencrawlRevision:pkg.opencrawlRevision}:{}), description: `OpenCrawl binary for ${os}/${arch}`, license: pkg.license, repository: pkg.repository, os: [os], cpu: [arch], files: [os === 'win32' ? 'bin/opencrawl.exe' : 'bin/opencrawl','runtime','LICENSE','THIRD_PARTY_NOTICES.txt'], publishConfig: pkg.publishConfig}, null, 2) + '\n');
  copyReleaseFiles(directory);
  optionalDependencies[name] = pkg.version;
}
const launcher = join(dist, 'cli');
mkdirSync(join(launcher, 'bin'), {recursive: true});
const {scripts, devDependencies, ...published} = pkg;
writeFileSync(join(launcher, 'package.json'), JSON.stringify({...published, scripts:{postinstall:'node install.cjs'}, optionalDependencies}, null, 2) + '\n');
copyFileSync(join(root, 'bin/opencrawl.cjs'), join(launcher, 'bin/opencrawl.cjs'));
chmodSync(join(launcher, 'bin/opencrawl.cjs'), 0o755);
copyFileSync(join(root,'install.cjs'),join(launcher,'install.cjs'));
// No shebang: npm creates a direct executable shim on Windows too.
writeFileSync(join(launcher,'bin/opencrawl.exe'),'OpenCrawl native executable is missing. Run the native installer or npm rebuild @getopencrawl/cli.\n');
copyReleaseFiles(launcher);
console.log(`Prepared ${selected.length} platform packages and ${pkg.name}@${pkg.version} in cli/dist.`);
