import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRevision, validateCli, validateCliChecks} from '../dist/tools/publish-revision.mjs';
const revision = 'a'.repeat(40), repository = 'example/core';
const runs = ['ci', 'security', 'self-host', 'plugins', 'cli'].map((name, i) => ({id: i + 1, path: `.github/workflows/${name}.yml`, event: 'push', head_branch: 'main', head_sha: revision, conclusion: 'success', status: 'completed', head_repository: {full_name: repository}}));

test('historical publication requires an immutable mainline source with completed trusted gates', () => {
  validateRevision(revision, true, runs, repository);
  assert.throws(() => validateRevision('main', true, runs, repository), /immutable/);
  assert.throws(() => validateRevision(revision, false, runs, repository), /mainline/);
  assert.throws(() => validateRevision(revision, true, runs.slice(1), repository), /gate/);
  assert.throws(() => validateRevision(revision, true, runs.map(run => ({...run, event: 'pull_request'})), repository), /gate/);
  assert.throws(() => validateRevision(revision, true, [...runs, {...runs[0], id: 99, status: 'in_progress', conclusion: null}], repository), /gate/);
});

test('core may retain a published CLI after an upload failure, but every CLI source check still must pass', () => {
  validateRevision(revision, true, [...runs, {...runs[4], id: 99, conclusion: 'failure'}], repository);
  const checks = ['build', 'checks (macos-15)', 'checks (ubuntu-24.04)', 'checks (windows-2025)'].map(name => ({name, status: 'completed', conclusion: 'success'}));
  validateCliChecks([...checks, {name: 'publish', status: 'completed', conclusion: 'failure'}]);
  assert.throws(() => validateCliChecks(checks.slice(1)), /CLI source check/);
  assert.throws(() => validateCliChecks(checks.map(job => job.name === 'checks (ubuntu-24.04)' ? {...job, conclusion: 'failure'} : job)), /CLI source check/);
  assert.throws(() => validateCliChecks([...checks, checks[0]]), /CLI source check/);
});

test('historical publication retains an exact released CLI with source provenance', () => {
  assert.equal(validateCli({version: '0.4.35', opencrawlRevision: revision}), '0.4.35');
  assert.throws(() => validateCli({version: 'next', opencrawlRevision: revision}));
  assert.throws(() => validateCli({version: '0.4.35'}), /provenance/);
});
