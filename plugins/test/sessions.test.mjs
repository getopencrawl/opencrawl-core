import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, lstatSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

// The plugins the OpenCrawl CLI installs for Claude Code and Codex. Each
// directory is the only copy of its content, so these checks are the contract.
const base = fileURLToPath(new URL('../opencrawl-sessions/', import.meta.url));
const repository = fileURLToPath(new URL('../../', import.meta.url));
const endpoint = 'https://app.getopencrawl.com/mcp';
const hosts = {
  'claude-code': {manifest: '.claude-plugin/plugin.json', root: 'CLAUDE_PLUGIN_ROOT', events: ['PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']},
  codex: {manifest: '.codex-plugin/plugin.json', root: 'PLUGIN_ROOT', events: ['PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStop', 'UserPromptSubmit']},
};
const json = path => JSON.parse(readFileSync(path, 'utf8'));
function files(directory, prefix = '') {
  return readdirSync(join(directory, prefix)).flatMap(name => {
    const relative = prefix ? prefix + '/' + name : name, stat = lstatSync(join(directory, relative));
    assert(!stat.isSymbolicLink(), 'Symlink: ' + relative);
    return stat.isDirectory() ? files(directory, relative) : [relative];
  }).sort();
}

for (const [host, expected] of Object.entries(hosts)) {
  const directory = join(base, host);
  test(host + ' plugin contains exactly its skill, MCP server, hooks and runner', () => {
    assert.deepEqual(files(directory), [expected.manifest, '.mcp.json', 'LICENSE', 'assets/icon.png', 'hooks/hooks.json', 'scripts/opencrawl-hook.sh', 'skills/opencrawl/SKILL.md'].sort());
    const manifest = json(join(directory, expected.manifest));
    assert.equal(manifest.name, 'opencrawl-sessions');
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.equal(manifest.license, 'MIT');
    // Codex loads hooks and MCP only when its manifest names them.
    if (host === 'codex') assert.deepEqual([manifest.skills, manifest.mcpServers, manifest.hooks], ['./skills/', './.mcp.json', './hooks/hooks.json']);
    assert.deepEqual(json(join(directory, '.mcp.json')), {mcpServers: {opencrawl: {type: 'http', url: endpoint}}});
  });

  test(host + ' hooks only hand the native event to the CLI runner', () => {
    const {hooks} = json(join(directory, 'hooks/hooks.json'));
    assert.deepEqual(Object.keys(hooks).sort(), expected.events);
    const entries = Object.values(hooks).flat().flatMap(group => group.hooks);
    const prefix = '/bin/sh "$' + expected.root + '/scripts/opencrawl-hook.sh" ';
    for (const hook of entries) {
      assert.equal(hook.type, 'command');
      assert(hook.command.startsWith(prefix) && hook.command.endsWith(' --harness ' + host), hook.command);
      assert.match(hook.command.slice(prefix.length), /^(session start|collect hook|search-context) --harness [a-z-]+$/);
      // No server address, profile or credential is baked into a hook.
      assert.doesNotMatch(hook.command, /https?:|--api|TOKEN|CONFIG_HOME/);
    }
    assert.deepEqual(hooks.SessionStart[0].hooks.map(hook => hook.command.slice(prefix.length).split(' --')[0]), ['session start', 'collect hook']);
    assert.equal(hooks.SessionStart[0].hooks[0].async, undefined);
    const search = hooks.PreToolUse.filter(group => group.matcher);
    assert.equal(search.length, 1);
    const matcher = new RegExp(search[0].matcher);
    assert(matcher.test('mcp__opencrawl__opencrawl_search_v1') && !matcher.test('mcp__other__opencrawl_search_v1'));
    if (host === 'claude-code') assert(matcher.test('mcp__plugin_opencrawl-sessions_opencrawl__opencrawl_search'));
    const runner = readFileSync(join(directory, 'scripts/opencrawl-hook.sh'), 'utf8');
    assert(runner.startsWith('#!/bin/sh\n'));
    assert(runner.includes('[ -n "$cli" ] || exit 0'));
    assert.doesNotMatch(runner, /https?:/);
    // A token in the session shell never replaces the credentials setup saved.
    assert(runner.includes('\nunset OPENCRAWL_TOKEN OPENCRAWL_SESSIONS_TOKEN OPENCRAWL_AUTH\nexec "$cli" "$@"\n'));
    assert(lstatSync(join(directory, 'scripts/opencrawl-hook.sh')).mode & 0o100, 'Runner must be executable');
  });
}

test('both hosts ship the same skill, runner and version', () => {
  for (const name of ['skills/opencrawl/SKILL.md', 'scripts/opencrawl-hook.sh', 'LICENSE']) assert.equal(readFileSync(join(base, 'codex', name), 'utf8'), readFileSync(join(base, 'claude-code', name), 'utf8'), name);
  assert.equal(json(join(base, 'codex', hosts.codex.manifest)).version, json(join(base, 'claude-code', hosts['claude-code'].manifest)).version);
});

// The marketplace manifests live at the root of opencrawl-core, outside the
// exported plugins subtree.
test('the repository marketplaces select these directories', {skip: !existsSync(join(repository, '.claude-plugin/marketplace.json'))}, () => {
  const claude = json(join(repository, '.claude-plugin/marketplace.json')), codex = json(join(repository, '.agents/plugins/marketplace.json'));
  assert.equal(claude.name, 'opencrawl-core');
  assert.equal(codex.name, 'opencrawl-core');
  assert.deepEqual(claude.plugins.map(plugin => [plugin.name, plugin.source, plugin.version]), [['opencrawl-sessions', './plugins/opencrawl-sessions/claude-code', json(join(base, 'claude-code', hosts['claude-code'].manifest)).version]]);
  assert.deepEqual(codex.plugins.map(plugin => [plugin.name, plugin.source]), [['opencrawl-sessions', {source: 'local', path: './plugins/opencrawl-sessions/codex'}]]);
});
