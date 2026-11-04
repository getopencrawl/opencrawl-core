// Prove a real npm-installed N launcher adopts a fully installed N+1 launcher
// and native binary, using a disposable loopback registry and cache.
import {readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, cpSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const nodeExecutable = Bun.which('node');
if (!nodeExecutable) throw new Error('Node is required for the npm upgrade smoke test.');
const npmCommand = [nodeExecutable, createRequire(import.meta.url)('../bin/opencrawl.cjs').npmCli(nodeExecutable)];
const root = resolve(import.meta.dir, '..');
const original = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const next = original.version.split('.').map(Number); next[2]++;
const version = next.join('.');
const platform = `${process.platform}-${process.arch}`;
const scratch = mkdtempSync(join(tmpdir(), 'opencrawl-upgrade-'));
const env = {...process.env, OPENCRAWL_NO_UPDATE: '1', OPENCRAWL_CONFIG_HOME: join(scratch, 'config'), XDG_CACHE_HOME: join(scratch, 'cache')};
const packages = new Map<string, Map<string, {pkg: any; bytes: Buffer}>>();
function sync(command: string[], cwd?: string) {
  if (command[0] === 'npm') command = [...npmCommand, ...command.slice(1)];
  const child = Bun.spawnSync(command, {cwd, env, stdout: 'pipe', stderr: 'pipe'});
  if (child.exitCode) throw new Error(`${command[0]} failed: ${child.stderr.toString()}`);
  return child.stdout.toString().trim();
}
async function asyncRun(command: string[], cwd?: string) {
  if (command[0] === 'npm') command = [...npmCommand, ...command.slice(1)];
  const child = Bun.spawn(command, {cwd, env, stdout: 'pipe', stderr: 'pipe'});
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(`${command[0]} failed: ${stderr}`);
  return stdout.trim();
}
function pack(directory: string) {
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const file = JSON.parse(sync(['npm', 'pack', '--json', '--pack-destination', scratch], directory))[0].filename;
  if (!packages.has(pkg.name)) packages.set(pkg.name, new Map());
  packages.get(pkg.name)!.set(pkg.version, {pkg, bytes: readFileSync(join(scratch, file))});
}
try {
  for (const folder of [platform, 'cli']) {
    pack(join(root, 'dist', folder));
    const directory = join(scratch, folder);
    cpSync(join(root, 'dist', folder), directory, {recursive: true});
    const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    pkg.version = version;
    if (folder === 'cli') pkg.optionalDependencies = {[`${original.name}-${platform}`]: version};
    else {
      const binary = join(directory, 'bin', process.platform === 'win32' ? 'opencrawl.exe' : 'opencrawl');
      sync(['bun', 'build', '--compile', '--minify', '--define', `OPENCRAWL_VERSION=${JSON.stringify(version)}`, join(root, 'src/cli.ts'), '--outfile', binary]);
      if (process.platform === 'darwin') sync(['codesign', '--force', '--sign', '-', binary]);
    }
    writeFileSync(join(directory, 'package.json'), JSON.stringify(pkg));
    pack(directory);
  }
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch(request): Response {
    const path = decodeURIComponent(new URL(request.url).pathname);
    for (const [name, releases] of packages) {
      for (const [release, item] of releases) if (path === `/${name}/${release}.tgz`) return new Response(Uint8Array.from(item.bytes));
      if (path === `/${name}`) return Response.json({name, 'dist-tags': {latest: version}, versions: Object.fromEntries([...releases].map(([release, item]) => [release, {...item.pkg, dist: {tarball: `${server.url.origin}/${name}/${release}.tgz`, integrity: 'sha512-' + createHash('sha512').update(item.bytes).digest('base64')}}]))});
    }
    return new Response('Not found', {status: 404});
  }});
  try {
    const install = join(scratch, 'installed');
    mkdirSync(install);
    writeFileSync(join(install, 'package.json'), '{"private":true}');
    await asyncRun(['npm', 'install', '--prefix', install, '--ignore-scripts', '--no-audit', '--no-fund', `--registry=${server.url.origin}`, `${original.name}@${original.version}`], install);
    const installedRoot = join(install, 'node_modules/@getopencrawl/cli');
    const launcher = join(installedRoot, 'bin/opencrawl.cjs');
    if (sync(['node', launcher, '--version']) !== original.version) throw new Error('Initial installation mismatch');
    const worker = join(scratch, 'update.cjs');
    writeFileSync(worker, `const cli=require(${JSON.stringify(launcher)}); cli.update({force:true, root:${JSON.stringify(installedRoot)}, fetcher:async()=>new Response(JSON.stringify({name:'@getopencrawl/cli',version:${JSON.stringify(version)}})), install:v=>cli.installRelease(v,{registry:${JSON.stringify(server.url.origin)}})}).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e);process.exitCode=1});`);
    const receipt = JSON.parse(await asyncRun(['node', worker]));
    if (!receipt.updated || receipt.version !== version) throw new Error('Upgrade was not promoted');
    if (sync(['node', launcher, '--version']) !== version) throw new Error('Original launcher did not adopt the updated launcher and binary');
    console.log(`Real npm upgrade ${original.version} → ${version}, atomic promotion and original-command reuse verified.`);
  } finally { server.stop(true); }
} finally { rmSync(scratch, {recursive: true, force: true}); }
