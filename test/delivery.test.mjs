import test from 'node:test';
import assert from 'node:assert/strict';
import {ready, continuousVersion, cliVersion} from '../tools/delivery.mts';
const revision = 'a'.repeat(40), repository = 'example/core';
const runs = ['ci', 'security', 'self-host', 'plugins'].map((name, i) => ({id: i + 1, path: `.github/workflows/${name}.yml`, event: 'push', head_branch: 'main', head_sha: revision, conclusion: 'success', status: 'completed', head_repository: {full_name: repository}}));
test('publication requires the latest successful run of every trusted main gate', () => {
  assert(ready(runs, revision, repository));
  for (const field of [{conclusion: 'failure'}, {status: 'in_progress'}, {event: 'pull_request'}, {head_branch: 'fork'}, {head_sha: 'b'.repeat(40)}, {head_repository: {full_name: 'fork/core'}}]) assert(!ready([{...runs[0], ...field}, ...runs.slice(1)], revision, repository));
  assert(!ready(runs.slice(1), revision, repository));
  assert(!ready([...runs, {...runs[0], id: 99, conclusion: 'cancelled'}], revision, repository));
});
test('core publications are deterministic and bound to source history and revision', () => {
  assert.equal(continuousVersion('0.3.4', '123', revision), '0.3.4-cd.123.gaaaaaaaaaaaa');
  for (const values of [['latest', '123', revision], ['0.3.4', '0', revision], ['0.3.4', '123', 'main']]) assert.throws(() => continuousVersion(...values));
});
test('CLI merges allocate a stable patch without downgrading existing releases', () => {
  assert.equal(cliVersion('0.4.33', '0.4.32'), '0.4.33');
  assert.equal(cliVersion('0.4.31', '0.4.33'), '0.4.34');
  assert.equal(cliVersion('0.4.33', '0.4.33'), '0.4.34');
  assert.equal(cliVersion('1.0.0', '0.4.33'), '1.0.0');
  assert.equal(cliVersion('0.4.33'), '0.4.33');
  assert.throws(() => cliVersion('0.4.33', 'next'));
});
