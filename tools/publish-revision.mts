import assert from 'node:assert/strict';
import {appendFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {ready, cliVersion, type Run} from './delivery.mjs';

export function validateRevision(revision: string, mainline: boolean, runs: Run[], repository: string): void {
  assert(/^[a-f0-9]{40}$/.test(revision), 'Expected an immutable full source revision');
  assert(mainline, 'Source must belong to the mainline history');
  // CLI is a separate artifact. Its build/check jobs are verified below; an
  // unrelated npm upload cannot block core using an already-published client.
  assert(ready(runs.filter(run => run.path !== '.github/workflows/cli.yml'), revision, repository), 'Source has not passed every required mainline core release gate');
}

interface Job {name: string; status: string; conclusion: string | null}
export function validateCliChecks(jobs: Job[]): void {
  for (const name of ['build', 'checks (macos-15)', 'checks (ubuntu-24.04)', 'checks (windows-2025)']) {
    const matches = jobs.filter(job => job.name === name);
    assert(matches.length === 1 && matches[0]!.status === 'completed' && matches[0]!.conclusion === 'success', `CLI source check has not passed: ${name}`);
  }
}

interface CliMetadata {version: string; opencrawlRevision?: string}
export function validateCli(metadata: CliMetadata): string {
  cliVersion(metadata.version);
  assert(metadata.opencrawlRevision && /^[a-f0-9]{40}$/.test(metadata.opencrawlRevision), 'Published CLI is missing source provenance');
  return metadata.version;
}

if (import.meta.main) {
  const requested = process.env.REQUESTED_REVISION;
  const selectedCli = process.env.SELECTED_CLI_VERSION;
  if (selectedCli) {assert(requested, 'A CLI selection requires an explicit core revision'); cliVersion(selectedCli);}
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
    const cliRun = result.workflow_runs.filter(run => run.path === '.github/workflows/cli.yml' && run.event === 'push' && run.head_branch === 'main' && run.head_sha === requested && run.head_repository?.full_name === repository).sort((a, b) => b.id - a.id)[0];
    if (cliRun) {
      const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${cliRun.id}/jobs?per_page=100`, {
        headers: {authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json'}, signal: AbortSignal.timeout(30_000),
      });
      assert(response.ok, `Cannot verify CLI checks: ${response.status}`);
      const result = await response.json() as {total_count: number; jobs: Job[]};
      assert(result.total_count <= 100, 'Incomplete CLI check inventory');
      validateCliChecks(result.jobs);
    }
    const published = await fetch(`https://registry.npmjs.org/@getopencrawl%2fcli/${selectedCli || 'next'}`, {signal: AbortSignal.timeout(30_000)});
    assert(published.ok, `Cannot verify published CLI: ${published.status}`);
    const cli = await published.json() as CliMetadata;
    const version = validateCli(cli);
    if (selectedCli) assert.equal(version, selectedCli, 'Published CLI version mismatch');
    git('merge-base', '--is-ancestor', cli.opencrawlRevision!, requested);
    git('checkout', '--detach', requested);
    output('cli_version', version);
    output('revision', requested);
  }
}
