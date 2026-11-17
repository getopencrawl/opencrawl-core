import test from 'node:test';
import assert from 'node:assert/strict';
import {validatedTree, runtimeChecksPassed} from '../tools/validated-tree.mts';

const repository = 'example/core', revision = 'a'.repeat(40), head = 'b'.repeat(40), tree = 'c'.repeat(40), tested = 'd'.repeat(40);
function fixture() {
  const pull = {number: 1, merged_at: '2026-11-17', merge_commit_sha: revision, base: {ref: 'main', repo: {full_name: repository}}, head: {sha: head, repo: {full_name: repository}}};
  const run = {id: 5, run_attempt: 1, head_sha: head, path: '.github/workflows/ci.yml', event: 'pull_request', status: 'completed', conclusion: 'success', head_repository: {full_name: repository}};
  const artifact = {id: 9, name: 'core-validation', expired: false};
  const proof = {repository, tree, revision: tested, head, run: 5, attempt: 1};
  const commit = {tree: {sha: tree}};
  const runs = [run];
  const api = (async (path) => {
    if (path.startsWith('commits/')) return [pull];
    if (path.startsWith('actions/workflows/')) return {total_count: runs.length, workflow_runs: runs};
    if (path.startsWith('actions/runs/')) return {total_count: 1, artifacts: [artifact]};
    assert.equal(path, `git/commits/${tested}`); return commit;
  });
  return {pull, run, runs, artifact, proof, commit, check: () => validatedTree(api, repository, revision, tree, async id => {assert.equal(id, 9); return proof;})};
}
test('reuse requires a merged same-repository PR and the exact tested Git tree', async () => {
  assert.equal(await fixture().check(), 5);
  for (const change of [
    (f) => {f.pull.merge_commit_sha = head;},
    (f) => {f.pull.base.ref = 'feature';},
    (f) => {f.pull.head.repo.full_name = 'fork/core';},
    (f) => {f.proof.tree = head;},
    (f) => {f.commit.tree.sha = head;},
    (f) => {f.proof.repository = 'fork/core';},
    (f) => {f.proof.head = tested;},
    (f) => {f.proof.run = 6;},
    (f) => {f.proof.attempt = 2;},
    (f) => {f.artifact.expired = true;},
    (f) => {f.run.event = 'workflow_dispatch';},
    (f) => {f.run.path = '.github/workflows/unrelated.yml';},
    (f) => {f.run.status = 'in_progress';},
    (f) => {f.run.conclusion = 'failure';},
  ]) {const f = fixture(); change(f); assert.equal(await f.check(), undefined);}
});
test('a later failed or unfinished run prevents reuse of an earlier success', async () => {
  for (const status of ['completed', 'in_progress']) {
    const f = fixture(); f.runs.push({...f.run, id: 6, status, conclusion: 'failure'});
    assert.equal(await f.check(), undefined);
  }
});

test('the protected aggregate rejects skipped, failed, incomplete and partial proof paths', () => {
  const lanes = ['unit', 'web', 'integration', 'cli'];
  const jobs = result => Object.fromEntries(['validation', ...lanes].map(name => [name, {result: name === 'validation' ? 'success' : result}]));
  assert.equal(runtimeChecksPassed(jobs('success'), false, 'pull_request'), true);
  assert.equal(runtimeChecksPassed(jobs('success'), false, 'push'), true);
  assert.equal(runtimeChecksPassed(jobs('skipped'), true, 'push'), true);
  assert.equal(runtimeChecksPassed(jobs('skipped'), true, 'pull_request'), false);
  assert.equal(runtimeChecksPassed(jobs('skipped'), true, 'workflow_dispatch'), false);
  assert.equal(runtimeChecksPassed(jobs('skipped'), false, 'push'), false);
  assert.equal(runtimeChecksPassed(jobs('success'), true, 'push'), false);
  for (const reuse of [true, false]) {
    const expected = reuse ? 'skipped' : 'success';
    for (const name of ['validation', ...lanes]) {
      const missing = jobs(expected); delete missing[name];
      assert.equal(runtimeChecksPassed(missing, reuse, 'push'), false);
      for (const result of ['failure', 'cancelled']) {
        const failed = jobs(expected); failed[name].result = result;
        assert.equal(runtimeChecksPassed(failed, reuse, 'push'), false);
      }
    }
    const added = jobs(expected); added.future = {result: 'failure'};
    assert.equal(runtimeChecksPassed(added, reuse, 'push'), false);
    added.future.result = expected;
    assert.equal(runtimeChecksPassed(added, reuse, 'push'), true);
    const partial = jobs(expected); partial.cli.result = reuse ? 'success' : 'skipped';
    assert.equal(runtimeChecksPassed(partial, reuse, 'push'), false);
  }
});
