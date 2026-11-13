// Exercise real packaged installs with a disposable local npm registry. The
// registry serves exactly the artifacts built by build.ts; nothing is published.
import {readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const nodeExecutable = Bun.which('node');
if (!nodeExecutable) throw new Error('Node is required for the npm install smoke test.');
const npmCommand = [nodeExecutable, createRequire(import.meta.url)('../bin/opencrawl.cjs').npmCli(nodeExecutable)];
const root = resolve(import.meta.dir, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const scratch = mkdtempSync(join(tmpdir(), 'opencrawl-install-'));
const environment={...process.env,HOME:scratch,USERPROFILE:scratch,XDG_DATA_HOME:join(scratch,'data'),XDG_CACHE_HOME:join(scratch,'cache'),OPENCRAWL_CONFIG_HOME:join(scratch,'config'),CLAUDE_CONFIG_DIR:join(scratch,'claude'),CODEX_HOME:join(scratch,'codex'),OPENCRAWL_NO_UPDATE:'1',OPENCRAWL_TOKEN:'',OPENCRAWL_SESSIONS_TOKEN:'',OPENCRAWL_AUTH:''};
const platform = `${process.platform}-${process.arch}`;
const artifacts = new Map<string, {bytes: Buffer; pkg: any}>();
function run(command: string[], cwd?: string, env: Record<string, string | undefined> = {}) {
  if (command[0] === 'npm') command = [...npmCommand, ...command.slice(1)];
  const result = Bun.spawnSync(command, {cwd, env: {...environment, ...env}, stdout: 'pipe', stderr: 'pipe'});
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
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch(request): Response {
    const path = decodeURIComponent(new URL(request.url).pathname);
    for (const [name, artifact] of artifacts) {
      if (path === `/${name}/tarball.tgz`) return new Response(Uint8Array.from(artifact.bytes));
      if (path === `/${name}`) return Response.json({name, 'dist-tags': {latest: pkg.version}, versions: {[pkg.version]: {...artifact.pkg, dist: {tarball: `${server.url.origin}/${name}/tarball.tgz`, integrity: 'sha512-' + createHash('sha512').update(artifact.bytes).digest('base64')}}}});
    }
    return new Response('Not found', {status: 404});
  }});
  // npm is async here so this process can keep serving the local registry.
  try {
    const install = join(scratch, 'install');
    mkdirSync(install);
    writeFileSync(join(install, 'package.json'), '{"private":true}');
    const result = Bun.spawn([...npmCommand, 'install', '--prefix', install, '--no-audit', '--no-fund', `--registry=${server.url.origin}`, `@getopencrawl/cli@${pkg.version}`], {cwd: install, env: {...environment, npm_config_registry: server.url.origin}, stdout: 'pipe', stderr: 'pipe'});
    const stderr = await new Response(result.stderr).text();
    if (await result.exited) throw new Error(`Packaged install failed: ${stderr}`);
    const command = [join(install, 'node_modules/@getopencrawl/cli/bin/opencrawl.exe')];
    if (run([...command, '--version']).trim() !== pkg.version) throw new Error('Installed version mismatch');
    const shim=join(install,'node_modules/.bin',process.platform==='win32'?'opencrawl.cmd':'opencrawl');
    const direct=process.platform==='win32'?[join(process.env.SystemRoot||'C:\\Windows','System32','cmd.exe'),'/d','/s','/c',`""${shim}" --version"`]:[shim,'--version'];
    if(run(direct,undefined,{PATH:join(scratch,'no-runtimes')}).trim()!==pkg.version)throw new Error('npm command shim still requires Node');
    if (run(['bun',join(install,'node_modules/@getopencrawl/cli/runtime/opencrawl.js'),'--version']).trim() !== pkg.version) throw new Error('Replaceable-runtime bundle version mismatch');
    const status = JSON.parse(run([...command, 'status', '--json']));
    if (status.data.authenticated !== false || status.data.index.available !== null) throw new Error('Incorrect initial status');
    const skillEnv = {CLAUDE_CONFIG_DIR: join(scratch, 'claude')};
    const skills = JSON.parse(run([...command, 'skills', 'install', '--client', 'claude-code', '--api', 'http://127.0.0.1:8093', '--json'], undefined, skillEnv));
    if (skills.data.results.length !== 1 || skills.data.results[0].status !== 'installed') throw new Error('Packaged skill installation failed');
    const skillRoot = join(scratch, 'claude/skills/opencrawl');
    if (!readFileSync(join(skillRoot, 'SKILL.md'), 'utf8').startsWith('---\nname: opencrawl\n') || readFileSync(join(skillRoot, 'references/participation.md'), 'utf8').includes('--api')) throw new Error('Packaged skill documents missing or contain a fixed deployment');
    const skillStatus = JSON.parse(run(['bun', join(install, 'node_modules/@getopencrawl/cli/runtime/opencrawl.js'), 'skills', 'status', '--client', 'claude-code', '--api', 'http://127.0.0.1:8093', '--json'], undefined, skillEnv));
    if (skillStatus.data.results[0].status !== 'current') throw new Error('Replaceable runtime could not read the installed skill');
    const fail = Bun.spawnSync([...command, 'whoami', '--json'], {env: environment, stdout: 'pipe', stderr: 'pipe'});
    if (fail.exitCode !== 2 || JSON.parse(fail.stdout.toString()).error.code !== 'AUTH_REQUIRED') throw new Error('Invalid authentication exit code');
    const requests: string[] = [];
    const api = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request) {
      if(request.headers.get('authorization')!=='Bearer smoke-search-token')return new Response('',{status:401});
      const path=new URL(request.url).pathname,input=await request.json() as any;requests.push(path);
      const hit={id:'sessions:smoke',source:'sessions',title:'Smoke',text:'verbatim evidence',provenance:{sessionId:'smoke'}};
      if(path==='/api/search'&&input.query==='evidence')return Response.json({schemaVersion:1,data:{results:[hit],coverage:[{source:'sessions',state:'ready'}],partial:false,next:null}});
      if(path==='/api/search/fetch'&&input.id===hit.id)return Response.json({schemaVersion:1,data:{...hit,offset:0,totalChars:hit.text.length,nextOffset:null,version:'a'.repeat(64)}});
      return new Response('',{status:400});
    }});
    try {
      for(const args of [['search','evidence'],['fetch','sessions:smoke']]) {
        const child=Bun.spawn([...command,...args,'--json','--api',api.url.origin],{env:{...environment,OPENCRAWL_TOKEN:'smoke-search-token'},stdout:'pipe',stderr:'pipe'});
        const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
        if(code||!out.includes('verbatim evidence'))throw new Error('Packaged search/fetch failed: '+err);
      }
      if(requests.join(',')!=='/api/search,/api/search/fetch')throw new Error('Packaged search/fetch routes mismatch');
    } finally {api.stop(true);}
    console.log('Packaged npm install, native binary, agent skill installation, JSON status and auth-required exit verified.');
  } finally { server.stop(true); }
} finally { rmSync(scratch, {recursive: true, force: true}); }
