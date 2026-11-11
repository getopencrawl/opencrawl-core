import {readdirSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {createRequire} from 'node:module';
const launcher = createRequire(import.meta.url)('../bin/opencrawl.cjs');
const registryArgs = ['--registry=https://registry.npmjs.org', '--@getopencrawl:registry=https://registry.npmjs.org'];
export async function publish({
  dist = resolve(import.meta.dir, '../dist'), channel = launcher.channel as string,
  dryRun = false, run = Bun.spawnSync, fetcher = fetch,
  sleep = (ms: number) => Bun.sleep(ms), now = Date.now,
} = {}) {
  const folders = readdirSync(dist).filter(name => name !== 'cli').sort().concat('cli');
  if (folders.length !== 6) throw new Error('Build all five platform packages before publishing.');
  const cli = JSON.parse(readFileSync(join(dist, 'cli/package.json'), 'utf8'));
  const integrities=new Map<string,string>();
  if(!dryRun&&!/^[a-f0-9]{40}$/.test(cli.opencrawlRevision||''))throw new Error('CLI source provenance is required before publication.');
  for(const folder of folders){
    const pkg=JSON.parse(readFileSync(join(dist,folder,'package.json'),'utf8'));
    if(pkg.name!==(folder==='cli'?cli.name:cli.name+'-'+folder)||pkg.version!==cli.version||pkg.opencrawlRevision!==cli.opencrawlRevision)throw new Error('CLI artifact set has mixed package names, versions or source revisions.');
    if(folder!=='cli'&&cli.optionalDependencies?.[pkg.name]!==cli.version)throw new Error('CLI launcher dependency does not match the platform artifact.');
  }
  const stagingTag = `${channel}-pending`;
  let tags: Record<string, string> = {};
  if (!dryRun) {
    const result = run(['npm', 'view', cli.name, 'dist-tags', '--json', ...registryArgs], {stdout: 'pipe', stderr: 'pipe'});
    if (result.exitCode === 0) tags = JSON.parse(result.stdout.toString());
    else if (!result.stderr.toString().includes('E404')) throw new Error('Could not determine CLI release channel.');
    if (tags[channel] && launcher.compare(tags[channel], cli.version) > 0) throw new Error('Refusing to downgrade the CLI release channel.');
  }
  // npm acknowledges publication before its malware scan makes a version installable.
  // Stage the launcher too: its own tarball can lag behind version metadata.
  async function waitForAvailability(names: string[]) {
    if (dryRun) return;
    const pending = new Set(names);
    const deadline = now() + 20 * 60_000;
    while (pending.size) {
      await Promise.all([...pending].map(async folder => {
        const pkg = JSON.parse(readFileSync(join(dist, folder, 'package.json'), 'utf8'));
        try {
          const response = await fetcher(`https://registry.npmjs.org/${pkg.name}/${pkg.version}`, {signal: AbortSignal.timeout(15_000)});
          if (!response.ok) return;
          const metadata = await response.json() as {version?:string;opencrawlRevision?:string;dist?: {tarball?: string;integrity?:string}};
          if(metadata.version!==pkg.version||metadata.opencrawlRevision!==cli.opencrawlRevision||metadata.dist?.integrity!==integrities.get(folder))throw new Error('Published package source mismatch: '+pkg.name);
          if (!metadata.dist?.tarball) return;
          const tarball = await fetcher(metadata.dist.tarball, {method: 'HEAD', signal: AbortSignal.timeout(15_000)});
          if (tarball.ok) pending.delete(folder);
        } catch(error) {if(error instanceof Error&&error.message.startsWith('Published package source mismatch:'))throw error; /* Registry/network delays are retried within the deadline. */ }
      }));
      if (!pending.size) return;
      if (now() >= deadline) throw new Error(`Published packages are not downloadable: ${[...pending].join(', ')}. Check npm scanning status before promoting this release.`);
      console.log(`Waiting for npm availability: ${[...pending].join(', ')}`);
      await sleep(15_000);
    }
  }
  for (const folder of folders) {
    if (folder === 'cli') await waitForAvailability(folders.filter(name => name !== 'cli'));
    const directory = join(dist, folder);
    const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    const packed=run(['npm','pack','--dry-run','--json','--ignore-scripts'],{cwd:directory,stdout:'pipe',stderr:'pipe'});
    if(packed.exitCode)throw new Error('Package inspection failed for '+pkg.name);
    const inspection=JSON.parse(packed.stdout.toString())[0];
    if(!dryRun&&(typeof inspection.integrity!=='string'||!inspection.integrity.startsWith('sha512-')))throw new Error('Package inspection omitted integrity for '+pkg.name);
    integrities.set(folder,inspection.integrity);
    const files=inspection.files.map((entry:any)=>entry.path);
    for(const required of ['LICENSE','THIRD_PARTY_NOTICES.txt','runtime/opencrawl.js'])if(!files.includes(required))throw new Error(pkg.name+' omits '+required);
    const existing = dryRun ? null : run(['npm', 'view', `${pkg.name}@${pkg.version}`, '--json', ...registryArgs], {stdout: 'pipe', stderr: 'pipe'});
    if (existing?.exitCode === 0) {
      const metadata=JSON.parse(existing.stdout.toString());
      if(metadata.version!==pkg.version||metadata.opencrawlRevision!==cli.opencrawlRevision||!inspection.integrity?.startsWith('sha512-')||metadata.dist?.integrity!==inspection.integrity)throw new Error('Existing immutable package differs from this source or artifact: '+pkg.name);
      if (folder === 'cli' && tags[stagingTag] !== cli.version && tags[channel] !== cli.version) throw new Error('This CLI version is already published outside this release. Increment cli/package.json.');
      console.log(`Keeping already-published immutable package ${pkg.name}@${pkg.version}`);
      continue;
    }
    if (existing && !existing.stderr.toString().includes('E404')) throw new Error(`Could not determine publication state for ${pkg.name}.`);
    const result = run(dryRun ? ['npm', 'pack', '--dry-run'] : ['npm', 'publish', '--tag', folder === 'cli' ? stagingTag : channel, '--access', 'public', ...registryArgs], {cwd: directory, stdio: ['inherit', 'inherit', 'inherit']});
    if (result.exitCode) throw new Error(`Publication failed for ${pkg.name}; the launcher has not been promoted.`);
  }

  await waitForAvailability(['cli']);
  if (!dryRun && tags[channel] !== cli.version) {
    const promoted = run(['npm', 'dist-tag', 'add', `${cli.name}@${cli.version}`, channel, ...registryArgs], {stdio: ['inherit', 'inherit', 'inherit']});
    if (promoted.exitCode) throw new Error('CLI download is ready but channel promotion failed; rerun publication to resume.');
  }
}

if (import.meta.main) await publish({dryRun: process.argv.includes('--dry-run')});
