import assert from 'node:assert/strict';
import {appendFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {ready, cliVersion, type Run} from './delivery.mts';

export function validateRevision(revision: string, mainline: boolean, runs: Run[], repository: string): void {
  assert(/^[a-f0-9]{40}$/.test(revision), 'Expected an immutable full source revision');
  assert(mainline, 'Source must belong to the mainline history');
  assert(ready(runs, revision, repository), 'Source has not passed every required mainline release gate');
}

interface CliMetadata {version: string; opencrawlRevision?: string}
export function validateCli(metadata: CliMetadata): string {
  cliVersion(metadata.version);
  assert(metadata.opencrawlRevision && /^[a-f0-9]{40}$/.test(metadata.opencrawlRevision), 'Published CLI is missing source provenance');
  return metadata.version;
}

if (import.meta.main) {
  const requested = process.env.REQUESTED_REVISION;
  const git = (...args: string[]) => execFileSync('git', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const output = (key: string, value: string) => appendFileSync(process.env.GITHUB_OUTPUT!, `${key}=${value}\n`);
  if (!requested) output('revision', git('rev-parse', 'HEAD'));
  else {
    assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Select historical sources only from the main workflow');
    assert(/^[a-f0-9]{40}$/.test(requested), 'Expected an immutable full source revision');
    let mainline = false;
    try {git('merge-base', '--is-ancestor', requested, 'origin/main'); mainline = true;} catch { /* Fail closed below. */ }
    const repository = process.env.GITHUB_REPOSITORY!;
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs?head_sha=${requested}&event=push&branch=main&per_page=100`, {
      headers: {authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json'}, signal: AbortSignal.timeout(30_000),
    });
    assert(response.ok, `Cannot verify source checks: ${response.status}`);
    const result = await response.json() as {total_count: number; workflow_runs: Run[]};
    assert(result.total_count <= 100, 'Incomplete release check inventory');
    validateRevision(requested, mainline, result.workflow_runs, repository);
    const published = await fetch('https://registry.npmjs.org/@getopencrawl%2fcli/next', {signal: AbortSignal.timeout(30_000)});
    assert(published.ok, `Cannot verify published CLI: ${published.status}`);
    const cli = await published.json() as CliMetadata;
    const version = validateCli(cli);
    const requiredCli = git('log', '-1', '--format=%H', requested, '--', 'cli', 'tools/delivery.mts', '.github/workflows/cli.yml');
    git('merge-base', '--is-ancestor', requiredCli, cli.opencrawlRevision!);
    git('checkout', '--detach', requested);
    // The selected source prepares the same source-bound package as continuous
    // delivery. The isolated tag never advances latest or continuous.
    execFileSync(process.execPath, ['tools/delivery.mts', 'prepare'], {stdio: 'inherit', env: {...process.env, RELEASE_CLI_VERSION: version}});
    output('revision', requested);
  }
}
