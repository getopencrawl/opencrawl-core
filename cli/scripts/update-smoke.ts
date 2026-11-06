// Prove a real npm-installed N launcher adopts a fully installed N+1 launcher
// and native binary, using a disposable loopback registry and cache.
import {readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, cpSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {standaloneCapture} from '../../src/sessions/standalone.mjs';
import {createSessionIngest} from '../../src/sessions/ingest.mjs';
import {createLocalSessionStore} from '../../src/sessions/local-store.mjs';
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
let captureServer: ReturnType<typeof createServer> | undefined;
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
    // Preserve an existing personal-scope installation and offline queue through
    // the real npm update. The updated binary must recover without collect install.
    const principal={tenantId:'org_team',userId:'human',name:'Human'};
    const store=createLocalSessionStore(join(scratch,'objects'));
    const token='upgrade-fixture-token-at-least-32-characters';
    captureServer=createServer(standaloneCapture({token,principal,store}));
    await new Promise<void>(r=>captureServer!.listen(0,'127.0.0.1',r));
    const api='http://127.0.0.1:'+(captureServer.address() as any).port;
    Object.assign(env,{OPENCRAWL_SESSIONS_TOKEN:token});
    const capture=join(env.OPENCRAWL_CONFIG_HOME,'opencrawl','capture');
    mkdirSync(join(capture,'queue'),{recursive:true});mkdirSync(join(capture,'state'));
    const config={schemaVersion:1,api,installationId:'existing-install',owner:{...principal,tenantId:'personal:human'},
      installedAt:'2026-01-01T00:00:00Z',roots:{'claude-code':join(scratch,'claude'),codex:join(scratch,'codex')},command:[nodeExecutable,launcher]};
    const batch={schemaVersion:1,owner:config.owner,installationId:config.installationId,sessionId:'queued-session',harness:'codex',origin:'cli',events:[{id:'event',kind:'message',data:{role:'user',content:'synthetic upgrade fixture'}}],attachments:[]};
    writeFileSync(join(capture,'config.json'),JSON.stringify(config));
    writeFileSync(join(capture,'queue','before-update.json'),JSON.stringify(batch));
    writeFileSync(join(capture,'state','cursor.json'),'{"offset":42}');
    const worker = join(scratch, 'update.cjs');
    writeFileSync(worker, `const cli=require(${JSON.stringify(launcher)}); cli.update({force:true, root:${JSON.stringify(installedRoot)}, fetcher:async()=>new Response(JSON.stringify({name:'@getopencrawl/cli',version:${JSON.stringify(version)}})), install:v=>cli.installRelease(v,{registry:${JSON.stringify(server.url.origin)}})}).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e);process.exitCode=1});`);
    const receipt = JSON.parse(await asyncRun(['node', worker]));
    if (!receipt.updated || receipt.version !== version) throw new Error('Upgrade was not promoted');
    if (sync(['node', launcher, '--version']) !== version) throw new Error('Original launcher did not adopt the updated launcher and binary');
    const flushed=JSON.parse(await asyncRun(['node',launcher,'collect','flush','--json']));
    if(flushed.data?.uploaded!==1)throw new Error('Updated collector did not recover its queued upload');
    const status=JSON.parse(await asyncRun(['node',launcher,'collect','status','--json'])).data;
    if(status.queued!==0||status.owner.tenantId!==principal.tenantId||status.installationId!==config.installationId)throw new Error('Updated capture status is inconsistent');
    if(readFileSync(join(capture,'state','cursor.json'),'utf8')!=='{"offset":42}')throw new Error('Upgrade changed capture cursor');
    const stored=await createSessionIngest({store}).getBatch(principal,{...batch,batchId:status.lastUpload.batchId});
    if(stored?.owner.userId!==principal.userId||stored?.owner.tenantId!==principal.tenantId||stored?.events[0].data.content!=='synthetic upgrade fixture')throw new Error('Upgrade lost attribution or queued content');
    console.log(`Real npm upgrade ${original.version} → ${version}, original-command reuse and queued capture recovery without reinstall verified.`);
  } finally { server.stop(true); }
} finally { if(captureServer)await new Promise<void>(r=>captureServer!.close(()=>r()));rmSync(scratch, {recursive: true, force: true}); }
