import {mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, rmSync} from 'node:fs';
import {resolve, join} from 'node:path';
const root = resolve(import.meta.dir, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('A stable version is required.');
const targets = [
  ['darwin', 'arm64', 'bun-darwin-arm64'], ['darwin', 'x64', 'bun-darwin-x64'],
  ['linux', 'arm64', 'bun-linux-arm64'], ['linux', 'x64', 'bun-linux-x64-baseline'],
  ['win32', 'x64', 'bun-windows-x64-baseline'],
] as const;
const selected = process.argv.includes('--current') ? targets.filter(([os, arch]) => os === process.platform && arch === process.arch) : targets;
const dist = join(root, 'dist');
const optionalDependencies: Record<string, string> = {};
// Keep React's JSX transform and runtime in production mode together.
const bundleOptions={entrypoints:[join(root,'src/cli.ts')],target:'bun' as const,jsx:{runtime:'automatic' as const,development:false},define:{OPENCRAWL_VERSION:JSON.stringify(pkg.version),'process.env.NODE_ENV':'"production"','process.env.DEV':'"false"'}};
async function copyReleaseFiles(directory:string) {
  for(const name of ['README.md','LICENSE','THIRD_PARTY_NOTICES.txt'])copyFileSync(join(root,name),join(directory,name));
  mkdirSync(join(directory,'runtime'),{recursive:true});
  const result=await Bun.build(bundleOptions);
  if(!result.success||result.outputs.length!==1)throw new AggregateError(result.logs,'Could not build the replaceable-runtime application bundle.');
  await Bun.write(join(directory,'runtime/opencrawl.js'),result.outputs[0]);
}
for (const [os, arch, target] of selected) {
  const name = `${pkg.name}-${os}-${arch}`;
  const directory = join(dist, `${os}-${arch}`);
  mkdirSync(join(directory, 'bin'), {recursive: true});
  // Preserve the extensionless native entry identity used by generated hooks.
  const result=await Bun.build({...bundleOptions,define:{...bundleOptions.define,OPENCRAWL_STANDALONE_ENTRY:'true'},minify:true,naming:'[name]',compile:{...(process.argv.includes('--current')?{}:{target}),outfile:join(directory,'bin',os==='win32'?'opencrawl.exe':'opencrawl')}});
  if(!result.success)throw new AggregateError(result.logs,`Build failed for ${target}`);
  if (os === 'darwin') {
    if (process.platform !== 'darwin') throw new Error('Build release macOS binaries on macOS so their signatures can be repaired.');
    const binary = join(directory, 'bin/opencrawl');
    if (Bun.spawnSync(['codesign', '--force', '--sign', '-', binary]).exitCode !== 0 || Bun.spawnSync(['codesign', '--verify', '--strict', binary]).exitCode !== 0) throw new Error('macOS signing failed.');
  }
  writeFileSync(join(directory, 'package.json'), JSON.stringify({name, version: pkg.version, opencrawlGuidedSetup: os !== 'win32', ...(pkg.opencrawlRevision?{opencrawlRevision:pkg.opencrawlRevision}:{}), description: `OpenCrawl CLI binary for ${os}/${arch}. Installed automatically by @getopencrawl/cli.`, license: pkg.license, repository: pkg.repository, homepage: pkg.homepage, bugs: pkg.bugs, os: [os], cpu: [arch], files: [os === 'win32' ? 'bin/opencrawl.exe' : 'bin/opencrawl','runtime','README.md','LICENSE','THIRD_PARTY_NOTICES.txt'], publishConfig: pkg.publishConfig}, null, 2) + '\n');
  await copyReleaseFiles(directory);
  writeFileSync(join(directory, 'README.md'), `# ${name}\n\nPlatform binary for [OpenCrawl CLI](https://www.npmjs.com/package/@getopencrawl/cli). Installed automatically for ${os}/${arch}.\n\nInstall OpenCrawl:\n\n\`\`\`sh\nnpm install -g @getopencrawl/cli\n\`\`\`\n`);
  optionalDependencies[name] = pkg.version;
}
const launcher = join(dist, 'cli');
rmSync(launcher,{recursive:true,force:true});
mkdirSync(join(launcher, 'bin'), {recursive: true});
const {scripts, devDependencies, ...published} = pkg;
// Legacy automatic updaters reject any additional archive paths. Keep the npm
// installer inside the existing bridge and create the executable before npm links
// commands. The downloaded archive must retain the pre-native file layout.
writeFileSync(join(launcher, 'package.json'), JSON.stringify({...published, scripts:{preinstall:'node bin/opencrawl.cjs --internal-npm-install'}, optionalDependencies}, null, 2) + '\n');
copyFileSync(join(root,'bin/opencrawl.cjs'),join(launcher,'bin/opencrawl.cjs'));
chmodSync(join(launcher, 'bin/opencrawl.cjs'), 0o755);
await copyReleaseFiles(launcher);
console.log(`Prepared ${selected.length} platform packages and ${pkg.name}@${pkg.version} in cli/dist.`);
