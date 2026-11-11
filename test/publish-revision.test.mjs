import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRevision, validateCli} from '../dist/tools/publish-revision.mjs';
const revision = 'a'.repeat(40), repository = 'example/core';
const runs = ['ci', 'security', 'self-host', 'plugins', 'cli'].map((name, i) => ({id: i + 1, path: `.github/workflows/${name}.yml`, event: 'push', head_branch: 'main', head_sha: revision, conclusion: 'success', status: 'completed', head_repository: {full_name: repository}}));

test('historical publication requires an immutable mainline source with completed trusted gates', () => {
  validateRevision(revision, true, runs, repository);
  assert.throws(() => validateRevision('main', true, runs, repository), /immutable/);
  assert.throws(() => validateRevision(revision, false, runs, repository), /mainline/);
  assert.throws(() => validateRevision(revision, true, runs.slice(1), repository), /gate/);
  assert.throws(() => validateRevision(revision, true, runs.map(run => ({...run, event: 'pull_request'})), repository), /gate/);
  assert.throws(() => validateRevision(revision, true, [...runs, {...runs[4], id: 99, status: 'in_progress', conclusion: null}], repository), /gate/);
});

test('historical publication retains an exact released CLI with source provenance', () => {
  assert.equal(validateCli({version: '0.4.35', opencrawlRevision: revision}), '0.4.35');
  assert.throws(() => validateCli({version: 'next', opencrawlRevision: revision}));
  assert.throws(() => validateCli({version: '0.4.35'}), /provenance/);
});
