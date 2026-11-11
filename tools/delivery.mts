import {readFileSync, writeFileSync, appendFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';

export interface Run {id: number; path: string; event: string; head_branch: string; head_sha: string; conclusion: string | null; status: string; head_repository?: {full_name: string}}
const required = ['.github/workflows/ci.yml', '.github/workflows/security.yml', '.github/workflows/self-host.yml', '.github/workflows/plugins.yml'];
export function ready(runs: Run[], revision: string, repository: string): boolean {
  const trusted = runs.filter(run => run.head_sha === revision && run.head_branch === 'main' && run.event === 'push' && run.head_repository?.full_name === repository);
  const gates = trusted.some(run => run.path === '.github/workflows/cli.yml') ? [...required, '.github/workflows/cli.yml'] : required;
  return gates.every(path => {
    const run = trusted.filter(run => run.path === path).sort((a, b) => b.id - a.id)[0];
    return run?.status === 'completed' && run.conclusion === 'success';
  });
}
export function continuousVersion(base: string, count: string, revision: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(base) || !/^[1-9]\d*$/.test(count) || !/^[a-f0-9]{40}$/.test(revision)) throw Error('Invalid core publication identity');
  return `${base}-cd.${count}.g${revision.slice(0, 12)}`;
}
export function cliVersion(base: string, published?: string): string {
  const parse = (value: string) => {if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw Error('Invalid CLI release version'); return value.split('.').map(BigInt);};
  const wanted = parse(base);
  if (!published) return base;
  const previous = parse(published);
  for (let i = 0; i < 3; i++) {if (wanted[i]! > previous[i]!) return base; if (wanted[i]! < previous[i]!) break;}
  return `${previous[0]}.${previous[1]}.${previous[2]! + 1n}`;
}
export const cliPackages=['@getopencrawl/cli',...['darwin-arm64','darwin-x64','linux-arm64','linux-x64','win32-x64'].map(platform=>'@getopencrawl/cli-'+platform)];
/** A partially published platform reserves its version even when the launcher
 * has not reached the update channel. Never allocate from that channel alone. */
export function allocateCliVersion(base:string,published:string[]):string {
  let highest:string|undefined;
  for(const version of published){
    cliVersion(version);
    if(!highest){highest=version;continue;}
    const candidate=version.split('.').map(BigInt),previous=highest.split('.').map(BigInt);
    for(let i=0;i<3;i++){
      if(candidate[i]!>previous[i]!){highest=version;break;}
      if(candidate[i]!<previous[i]!)break;
    }
  }
  return cliVersion(base,highest);
}
export function pinCli(source: string, version: string): string {
  cliVersion(version);
  const pattern = /@getopencrawl\/cli@\d+\.\d+\.\d+/g;
  if ([...source.matchAll(pattern)].length !== 1) throw Error('Expected exactly one pinned cloud CLI installation');
  return source.replace(pattern, '@getopencrawl/cli@' + version);
}
async function api(path: string): Promise<unknown> {
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${path}`, {headers: {authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json'}, signal: AbortSignal.timeout(30_000)});
  if (!response.ok) throw Error(`GitHub ${path}: ${response.status}`);
  return response.json();
}
function output(name: string, value: string): void {appendFileSync(process.env.GITHUB_OUTPUT!, `${name}=${value}\n`);}
if (import.meta.main) {
  const mode = process.argv[2];
  if (mode === 'gate') {
    const revision = process.env.SOURCE_REVISION!;
    if (!/^[a-f0-9]{40}$/.test(revision)) throw Error('Invalid source revision');
    const head = await api('git/ref/heads/main') as {object: {sha: string}};
    const runs = await api(`actions/runs?head_sha=${revision}&event=push&branch=main&per_page=100`) as {total_count: number; workflow_runs: Run[]};
    if (runs.total_count > 100) throw Error('Incomplete release check inventory');
    let eligible = head.object.sha === revision && ready(runs.workflow_runs, revision, process.env.GITHUB_REPOSITORY!);
    if (eligible) {
      const response = await fetch('https://registry.npmjs.org/@getopencrawl%2fcli/next', {signal: AbortSignal.timeout(30_000)});
      if (!response.ok) throw Error(`Published CLI channel unavailable: ${response.status}`);
      const cli = await response.json() as {version: string; opencrawlRevision?: string};
      cliVersion(cli.version);
      const requiredCli = execFileSync('git', ['log', '-1', '--format=%H', '--', 'cli', 'tools/delivery.mts', '.github/workflows/cli.yml'], {encoding: 'utf8'}).trim();
      if (!cli.opencrawlRevision || !/^[a-f0-9]{40}$/.test(cli.opencrawlRevision)) eligible = false;
      else try {execFileSync('git', ['merge-base', '--is-ancestor', requiredCli, cli.opencrawlRevision], {stdio: 'ignore'});} catch {eligible = false;}
      if (eligible) output('cli_version', cli.version);
    }
    output('ready', String(eligible));
    console.log(eligible ? `All core release gates passed for ${revision}` : 'Waiting for all current-main release gates; no publication');
  } else if (mode === 'prepare') {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
    const count = execFileSync('git', ['rev-list', '--count', 'HEAD'], {encoding: 'utf8'}).trim();
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    pkg.version = continuousVersion(pkg.version, count, revision);
    pkg.opencrawlRevision = revision;
    const cli = process.env.RELEASE_CLI_VERSION!;
    cliVersion(cli);
    pkg.opencrawlCliVersion = cli;
    const setup = 'src/sessions/cloud-setup.mts';
    writeFileSync(setup, pinCli(readFileSync(setup, 'utf8'), cli));
    writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    lock.version = lock.packages[''].version = pkg.version;
    writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
    writeFileSync('revision.json', JSON.stringify({revision, cliVersion: cli}) + '\n');
    output('version', pkg.version);
  } else if (mode === 'cli-version') {
    const pkg = JSON.parse(readFileSync('cli/package.json', 'utf8'));
    if (process.env.RELEASE_VERSION) pkg.version = process.env.RELEASE_VERSION;
    else if (process.env.GITHUB_EVENT_NAME === 'push') {
      const inventories=await Promise.all(cliPackages.map(async name=>{
        const response=await fetch('https://registry.npmjs.org/'+encodeURIComponent(name),{signal:AbortSignal.timeout(30_000)});
        if(response.status===404)return [];
        if(!response.ok)throw Error(`CLI registry inventory unavailable: ${response.status}`);
        const metadata=await response.json() as {versions?:Record<string,unknown>};
        if(!metadata.versions||typeof metadata.versions!=='object'||Array.isArray(metadata.versions))throw Error('Invalid CLI registry inventory');
        return Object.keys(metadata.versions).filter(version=>/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version));
      }));
      pkg.version=allocateCliVersion(pkg.version,inventories.flat());
    }
    cliVersion(pkg.version);
    pkg.opencrawlRevision = process.env.GITHUB_SHA;
    writeFileSync('cli/package.json', JSON.stringify(pkg, null, 2) + '\n');
    output('version', pkg.version);
    console.log(`CLI release: ${pkg.version}`);
  } else throw Error('Unknown delivery operation');
}
