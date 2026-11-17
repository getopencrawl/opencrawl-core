import assert from 'node:assert/strict';
import {appendFileSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
export interface Api {<T>(path: string): Promise<T>}
function githubApi(repository: string, token: string): Api {
  return async <T,>(path: string): Promise<T> => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {headers: {authorization: `Bearer ${token}`, accept: 'application/vnd.github+json'}, signal: AbortSignal.timeout(30_000)});
    if (!response.ok) throw Error(`GitHub ${path}: ${response.status}`);
    return await response.json() as T;
  };
}

const sha = /^[a-f0-9]{40}$/;
interface Pull {number: number; merged_at: string | null; merge_commit_sha: string; base: {ref: string; repo: {full_name: string}}; head: {sha: string; repo: {full_name: string}}}
interface Run {id: number; run_attempt: number; head_sha: string; path: string; event: string; status: string; conclusion: string | null; head_repository: {full_name: string}}
export interface Receipt {repository: string; tree: string; revision: string; head: string; run: number; attempt: number}
interface Artifact {id: number; name: string; expired: boolean}

/** Only reuse a completed PR workflow for the exact merged source tree. Missing
 * evidence falls back to ordinary checks; a source pin is part of that tree. */
export async function validatedTree(api: Api, repository: string, revision: string, tree: string, receipt: (artifact: number) => Promise<Receipt>): Promise<number | undefined> {
  assert(sha.test(revision) && sha.test(tree), 'Expected immutable Git identities');
  const pulls = await api<Pull[]>(`commits/${revision}/pulls?per_page=100`);
  const merged = pulls.filter(p => p.merged_at && p.merge_commit_sha === revision && p.base.ref === 'main' && p.base.repo.full_name === repository && p.head.repo.full_name === repository);
  if (merged.length !== 1) return;
  const pull = merged[0]!;
  const result = await api<{total_count: number; workflow_runs: Run[]}>(`actions/workflows/ci.yml/runs?event=pull_request&head_sha=${pull.head.sha}&per_page=100`);
  if (result.total_count > 100) return;
  const run = result.workflow_runs.filter(r => r.head_sha === pull.head.sha && r.event === 'pull_request' && r.head_repository.full_name === repository && r.path === '.github/workflows/ci.yml').sort((a, b) => b.id - a.id)[0];
  if (!run || run.status !== 'completed' || run.conclusion !== 'success') return;
  const artifacts = await api<{total_count: number; artifacts: Artifact[]}>(`actions/runs/${run.id}/artifacts?per_page=100`);
  if (artifacts.total_count > 100) return;
  const matches = artifacts.artifacts.filter(a => a.name === 'core-validation' && !a.expired);
  if (matches.length !== 1) return;
  const proof = await receipt(matches[0]!.id);
  if (proof.repository !== repository || proof.tree !== tree || proof.head !== pull.head.sha || proof.run !== run.id || proof.attempt !== run.run_attempt || !sha.test(proof.revision)) return;
  // The receipt names the synthetic merge commit actually checked, not just the
  // PR head. Verify its tree against GitHub as well as the protected merge.
  const tested = await api<{tree: {sha: string}}>(`git/commits/${proof.revision}`);
  return tested.tree.sha === tree ? run.id : undefined;
}

/** Accept every runtime lane, or exact main proof with every duplicate skipped. */
export function runtimeChecksPassed(jobs: Record<string, {result: string}>, reuse: boolean, event: string): boolean {
  if (jobs.validation?.result !== 'success' || reuse && event !== 'push') return false;
  const expected = reuse ? 'skipped' : 'success';
  return ['unit', 'web', 'integration', 'cli'].every(name => jobs[name]?.result === expected)
    && Object.entries(jobs).every(([name, job]) => name === 'validation' || job.result === expected);
}

if (import.meta.main) {
  const git = (...args: string[]) => execFileSync('git', args, {encoding: 'utf8'}).trim();
  const repository = process.env.GITHUB_REPOSITORY!;
  if (process.argv[2] === 'record') {
    const proof: Receipt = {repository, tree: git('rev-parse', 'HEAD^{tree}'), revision: git('rev-parse', 'HEAD'), head: process.env.PR_HEAD_SHA!, run: Number(process.env.GITHUB_RUN_ID), attempt: Number(process.env.GITHUB_RUN_ATTEMPT)};
    assert(process.env.GITHUB_EVENT_NAME === 'pull_request' && sha.test(proof.head), 'Only PR checks produce reusable validation');
    writeFileSync('validation.json', JSON.stringify(proof) + '\n');
  } else {
    let run: number | undefined;
    if (process.env.GITHUB_EVENT_NAME === 'push' && process.env.GITHUB_REF === 'refs/heads/main') {
      const scratch = mkdtempSync(join(tmpdir(), 'core-validation-'));
      try {
        const token = process.env.GH_TOKEN!;
        run = await validatedTree(githubApi(repository, token), repository, git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD^{tree}'), async id => {
          const response = await fetch(`https://api.github.com/repos/${repository}/actions/artifacts/${id}/zip`, {headers: {authorization: `Bearer ${token}`, accept: 'application/vnd.github+json'}, signal: AbortSignal.timeout(30_000)});
          assert(response.ok, 'Validation artifact is unavailable');
          const archive = join(scratch, 'validation.zip');
          writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
          return JSON.parse(execFileSync('unzip', ['-p', archive, 'validation.json'], {encoding: 'utf8', maxBuffer: 16_384})) as Receipt;
        });
      } catch (error) {
        console.log('Reusable validation unavailable; running all checks:', error instanceof Error ? error.message : 'unknown error');
      } finally {rmSync(scratch, {recursive: true, force: true});}
    }
    appendFileSync(process.env.GITHUB_OUTPUT!, `reuse=${Boolean(run)}\n`);
    console.log(run ? `Exact merged source tree already passed PR workflow ${run}` : 'Running ordinary core validation');
  }
}
