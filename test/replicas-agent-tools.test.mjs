import assert from 'node:assert/strict';
import test from 'node:test';
import {withHooks, pins, release} from '../deploy/replicas/agent-tools.mjs';
import {pluginRelease} from '../src/sessions/plugin-release.mts';

test('Replicas installs only startup, prompt suggestions and MCP validation, once per client', () => {
  const foreign = {matcher:'other', hooks:[{type:'command',command:'custom-hook'}]};
  for (const client of ['claude-code','codex']) {
    const config = {permissions:{}, hooks:{SessionStart:[foreign],Stop:[foreign]}};
    const result = withHooks(config,client);
    assert.deepEqual(withHooks(result,client), result);
    assert.deepEqual(result.permissions, {});
    assert.deepEqual(result.hooks.Stop,[foreign]);
    assert.deepEqual(result.hooks.SessionStart[0],foreign);
    assert.deepEqual(Object.keys(result.hooks).sort(),['SessionStart','Stop','PreToolUse','UserPromptSubmit'].sort());
    for (const [event,action] of Object.entries({SessionStart:'start',UserPromptSubmit:'suggest',PreToolUse:'search'})) {
      assert.ok(result.hooks[event].at(-1).hooks[0].command.endsWith(' hook '+client+' '+action));
    }
    const match = new RegExp(result.hooks.PreToolUse[0].matcher);
    assert.ok(match.test('mcp__opencrawl__opencrawl_search_v1'));
    assert.ok(!match.test('mcp__other__opencrawl_search_v1'));
  }
  for (const invalid of [{disableAllHooks:true},{hooks:[]},{hooks:{UserPromptSubmit:'invalid'}}]) {
    assert.throws(()=>withHooks(invalid,'codex'));
  }
});

test('image digests match the verified CLI release for each supported Linux target', () => {
  for (const [client,platforms] of Object.entries(pins)) {
    const pkg = pluginRelease.packages.find(p=>p.harness===client);
    assert.equal(release,pkg.version);
    for (const [arch,digest] of Object.entries(platforms)) assert.equal(digest,pkg.archives['linux-'+arch].sha256);
  }
});
