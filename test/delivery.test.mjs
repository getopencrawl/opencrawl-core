import test from 'node:test';
import assert from 'node:assert/strict';
import {ready, continuousVersion, cliVersion, pinCli, allocateCliVersion} from '../tools/delivery.mts';
const revision = 'a'.repeat(40), repository = 'example/core';
const runs = ['ci', 'security', 'self-host', 'plugins'].map((name, i) => ({id: i + 1, path: `.github/workflows/${name}.yml`, event: 'push', head_branch: 'main', head_sha: revision, conclusion: 'success', status: 'completed', head_repository: {full_name: repository}}));
test('publication requires the latest successful run of every trusted main gate', () => {
  assert(ready(runs, revision, repository));
  for (const field of [{conclusion: 'failure'}, {status: 'in_progress'}, {event: 'pull_request'}, {head_branch: 'fork'}, {head_sha: 'b'.repeat(40)}, {head_repository: {full_name: 'fork/core'}}]) assert(!ready([{...runs[0], ...field}, ...runs.slice(1)], revision, repository));
  assert(!ready(runs.slice(1), revision, repository));
  assert(!ready([...runs, {...runs[0], id: 99, conclusion: 'cancelled'}], revision, repository));
  const cli = {...runs[0], id: 100, path: '.github/workflows/cli.yml'};
  assert(ready([...runs, cli], revision, repository));
  assert(!ready([...runs, {...cli, conclusion: 'failure'}], revision, repository));
});
test('generated cloud installations retain an exact released CLI pin', () => {
  assert.equal(pinCli("const CLOUD_CLI_VERSION='next';", '0.4.34'), "const CLOUD_CLI_VERSION='0.4.34';");
  assert.throws(() => pinCli("const CLOUD_CLI_VERSION='0.4.29';", 'next'));
  assert.throws(() => pinCli("const CLOUD_CLI_VERSION='invalid';", '0.4.34'));
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
test('a platform-only partial release reserves its immutable version',()=>{
  assert.equal(allocateCliVersion('0.4.33',['0.4.34','0.4.35']),'0.4.36');
  assert.equal(allocateCliVersion('0.4.33',['0.4.35','0.4.9','0.4.34']),'0.4.36');
  assert.equal(allocateCliVersion('0.5.0',['0.4.35']),'0.5.0');
  assert.equal(allocateCliVersion('0.4.33',['0.5.0','0.4.99']),'0.5.1');
  assert.equal(allocateCliVersion('0.4.33',[]),'0.4.33');
  assert.throws(()=>allocateCliVersion('0.4.33',['next']));
});
