// Exercise real packaged installs with a disposable local npm registry. The
// registry serves exactly the artifacts built by build.ts; nothing is published.
import {readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const root = resolve(import.meta.dir, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const scratch = mkdtempSync(join(tmpdir(), 'opencrawl-install-'));
const platform = `${process.platform}-${process.arch}`;
const artifacts = new Map<string, {bytes: Buffer; pkg: any}>();
function run(command: string[], cwd?: string, env: Record<string, string | undefined> = {}) {
  const result = Bun.spawnSync(command, {cwd, env: {...process.env, OPENCRAWL_NO_UPDATE: '1', OPENCRAWL_CONFIG_HOME: join(scratch, 'config'), XDG_CACHE_HOME: join(scratch, 'cache'), ...env}, stdout: 'pipe', stderr: 'pipe'});
  if (result.exitCode) throw new Error(`${command[0]} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}
try {
  for (const folder of [platform, 'cli']) {
    const directory = join(root, 'dist', folder);
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    const packed = JSON.parse(run(['npm', 'pack', '--json', '--pack-destination', scratch], directory))[0];
    artifacts.set(manifest.name, {pkg: manifest, bytes: readFileSync(join(scratch, packed.filename))});
  }
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname);
    for (const [name, artifact] of artifacts) {
      if (path === `/${name}/tarball.tgz`) return new Response(artifact.bytes);
      if (path === `/${name}`) return Response.json({name, 'dist-tags': {latest: pkg.version}, versions: {[pkg.version]: {...artifact.pkg, dist: {tarball: `${server.url.origin}/${name}/tarball.tgz`, integrity: 'sha512-' + createHash('sha512').update(artifact.bytes).digest('base64')}}}});
    }
    return new Response('Not found', {status: 404});
  }});
  // npm is async here so this process can keep serving the local registry.
  try {
    const install = join(scratch, 'install');
    mkdirSync(install);
    writeFileSync(join(install, 'package.json'), '{"private":true}');
    const result = Bun.spawn(['npm', 'install', '--prefix', install, '--ignore-scripts', '--no-audit', '--no-fund', `--registry=${server.url.origin}`, `@opencrawl/cli@${pkg.version}`], {cwd: install, env: {...process.env, npm_config_registry: server.url.origin}, stdout: 'pipe', stderr: 'pipe'});
    const stderr = await new Response(result.stderr).text();
    if (await result.exited) throw new Error(`Packaged install failed: ${stderr}`);
    const command = ['node', join(install, 'node_modules/@opencrawl/cli/bin/opencrawl.cjs')];
    if (run([...command, '--version']).trim() !== pkg.version) throw new Error('Installed version mismatch');
    const status = JSON.parse(run([...command, 'status', '--json']));
    if (status.data.authenticated !== false || status.data.index.available !== false) throw new Error('Incorrect initial status');
    const fail = Bun.spawnSync([...command, 'whoami', '--json'], {env: {...process.env, OPENCRAWL_NO_UPDATE: '1', OPENCRAWL_CONFIG_HOME: join(scratch, 'config')}, stdout: 'pipe', stderr: 'pipe'});
    if (fail.exitCode !== 2 || JSON.parse(fail.stdout.toString()).error.code !== 'AUTH_REQUIRED') throw new Error('Invalid authentication exit code');
    console.log('Packaged npm install, native binary, JSON status and auth-required exit verified.');
  } finally { server.stop(true); }
} finally { rmSync(scratch, {recursive: true, force: true}); }
