import {test, expect} from 'bun:test';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, statSync, chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {agentSkills, skillTargets, skillFiles} from '../src/skills.ts';
import {startupHooks} from '../src/startup-install.ts';

test('managed startup is reported without adding user hooks or asking for trust', () => fixture(async home => {
  const directory = join(home, 'managed'), requirementsFile = join(home, 'requirements.toml');
  mkdirSync(directory); mkdirSync(join(home, '.codex'));
  const binary = join(directory, 'opencrawl-0.4.55' + (process.platform === 'win32' ? '.exe' : ''));
  writeFileSync(binary, 'fixture'); chmodSync(binary, 0o755);
  const command = JSON.stringify(binary) + ' session start --harness codex';
  const policy = `[hooks]\nmanaged_dir = ${JSON.stringify(directory)}\nwindows_managed_dir = ${JSON.stringify(directory)}\n[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\nstatusMessage = "OpenCrawl session startup"\ncommand = ${JSON.stringify(command)}\ntimeout = 7\n`;
  writeFileSync(requirementsFile, policy);
  const userFile = join(home, '.codex/hooks.json'), userHooks = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"keep"}]}]}}';
  writeFileSync(userFile, userHooks);
  const options = {home, env: {}, which: () => null, clients: ['codex'], requirementsFile};
  for (const action of ['install', 'status', 'refresh']) {
    const result = await agentSkills(action, 'https://self-host.example', options);
    const row = result.results[0]!;
    expect('startupHooks' in row && row.startupHooks?.[0]).toEqual({client: 'codex', status: 'managed', file: requirementsFile, managed: true});
    expect(result.hookReview).toBeUndefined();
    expect(readFileSync(userFile, 'utf8')).toBe(userHooks);
    expect(readFileSync(requirementsFile, 'utf8')).toBe(policy);
    expect(existsSync(join(home, 'config/opencrawl/startup/runner.cjs'))).toBe(false);
  }
  // Policy may force hooks on; without that requirement, preserve a local opt-out.
  writeFileSync(join(home, '.codex/config.toml'), '[features]\nhooks = false\n');
  expect(startupHooks(['codex'], 'install', options)[0]!.status).toBe('disabled');
  writeFileSync(requirementsFile, '[features]\nhooks = true\n' + policy);
  expect(startupHooks(['codex'], 'install', options)[0]!.status).toBe('managed');
  expect(readFileSync(userFile, 'utf8')).toBe(userHooks);
}));

test('managed restrictions and invalid policy never cause a user hook installation', () => fixture(async home => {
  const requirementsFile = join(home, 'requirements.toml'), options = {home, env: {}, requirementsFile};
  for (const policy of ['[features]\nhooks = false\n', 'allow_managed_hooks_only = true\n']) {
    writeFileSync(requirementsFile, policy);
    expect(startupHooks(['codex'], 'install', options)[0]!.status).toBe('disabled');
    expect(existsSync(join(home, '.codex/hooks.json'))).toBe(false);
    expect(readFileSync(requirementsFile, 'utf8')).toBe(policy);
  }
  writeFileSync(requirementsFile, 'hooks = [');
  expect(startupHooks(['codex'], 'install', options)[0]!.status).toBe('error');
  expect(existsSync(join(home, '.codex/hooks.json'))).toBe(false);
}));

test('a matching label alone cannot establish managed startup readiness', () => fixture(async home => {
  const requirementsFile = join(home, 'requirements.toml');
  for (const command of ['echo session start --harness codex', 'opencrawl session start --harness codex', '/tmp/opencrawl session start --harness claude-code']) {
    writeFileSync(requirementsFile, `[hooks]\nmanaged_dir = "/tmp"\n[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\nstatusMessage = "OpenCrawl session startup"\ncommand = ${JSON.stringify(command)}\n`);
    expect(startupHooks(['codex'], 'status', {home, env: {}, requirementsFile})[0]!.status).toBe('missing');
    expect(existsSync(join(home, '.codex/hooks.json'))).toBe(false);
  }
}));

async function fixture(run: (home: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'opencrawl-skills-')), saved = {...process.env};
  process.env.OPENCRAWL_CONFIG_HOME = join(home, 'config');
  try {await run(home);} finally {process.env = saved; rmSync(home, {recursive: true, force: true});}
}

test('detects only available clients, honors custom roots and deduplicates shared skill paths', () => {
  const home = mkdtempSync(join(tmpdir(), 'opencrawl-skill-targets-'));
  try {
    expect(skillTargets({home, env: {}, which: () => null})).toEqual([]);
    mkdirSync(join(home, 'custom-claude'));
    mkdirSync(join(home, 'custom-codex'));
    const targets = skillTargets({home, env: {CLAUDE_CONFIG_DIR: join(home, 'custom-claude'), CODEX_HOME: join(home, 'custom-codex')}, which: name => ['cursor','gemini','opencode','copilot'].includes(name) ? '/bin/client' : null});
    expect(targets).toHaveLength(2);
    expect(targets[0]).toEqual({directory: join(home, '.agents/skills/opencrawl'), clients: ['codex','cursor','gemini','opencode','copilot']});
    expect(targets[1]).toEqual({directory: join(home, 'custom-claude/skills/opencrawl'), clients: ['claude-code']});
    expect(() => skillTargets({home, clients: ['../unrecognized']})).toThrow('Use --client');
  } finally {rmSync(home, {recursive: true, force: true});}
});

test('CLI owns the reserved skill, replaces edits and stale files, and leaves other named skills alone', () => fixture(async home => {
  const options = {home, env: {}, which: () => null, clients: ['codex', 'claude-code']};
  const first = await agentSkills('install', 'http://127.0.0.1:8093', options);
  expect(first.results.map(r => r.status)).toEqual(['installed','installed']);
  const directory = first.results[0]!.directory, file = join(directory, 'SKILL.md');
  expect(readFileSync(file, 'utf8')).toBe(skillFiles()['SKILL.md']);
  const before = statSync(file).mtimeMs;
  expect((await agentSkills('install', 'https://different.example', options)).results.map(r => r.status)).toEqual(['unchanged','unchanged']);
  expect(statSync(file).mtimeMs).toBe(before);
  const other = join(directory, '../opencrawl-custom'); mkdirSync(other); writeFileSync(join(other, 'SKILL.md'), 'keep');
  writeFileSync(file, 'local edit');
  writeFileSync(join(directory, 'my-notes.md'), 'stale');
  writeFileSync(join(directory, 'references/participation.md'), 'custom rules');
  expect((await agentSkills('refresh', 'https://new.example', options)).results.map(r => r.status)).toEqual(['updated','unchanged']);
  for (const [name, content] of Object.entries(skillFiles())) expect(readFileSync(join(directory, name), 'utf8')).toBe(content);
  expect(existsSync(join(directory, 'my-notes.md'))).toBe(false);
  expect(readFileSync(join(other, 'SKILL.md'), 'utf8')).toBe('keep');
  const manifest = JSON.parse(readFileSync(join(directory, '.opencrawl-skill.json'), 'utf8'));
  expect(manifest.schemaVersion).toBe(2); expect(manifest.revision).toBe(7); expect(manifest.api).toBeUndefined();
  expect(JSON.stringify(skillFiles())).not.toContain('https://new.example');
}));

test('adopts any skill with the reserved name and repairs links without changing their targets', () => fixture(async home => {
  const options = {home, env: {}, which: () => null, clients: ['claude-code']};
  const directory = skillTargets(options)[0]!.directory;
  mkdirSync(directory, {recursive: true}); writeFileSync(join(directory, 'SKILL.md'), 'Unmanaged OpenCrawl skill');
  expect((await agentSkills('install', 'https://self-host.example', options)).results[0]!.status).toBe('updated');
  expect(readFileSync(join(directory, 'SKILL.md'), 'utf8')).toBe(skillFiles()['SKILL.md']);
  if (process.platform !== 'win32') {
    const outside = join(home, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'keep'), 'untouched');
    rmSync(directory, {recursive: true}); symlinkSync(outside, directory);
    expect((await agentSkills('refresh', 'https://self-host.example', options)).results[0]!.status).toBe('updated');
    expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('untouched');
    expect(existsSync(join(outside, 'SKILL.md'))).toBe(false);
    rmSync(join(directory, 'references'), {recursive: true}); symlinkSync(outside, join(directory, 'references'));
    expect((await agentSkills('refresh', 'https://self-host.example', options)).results[0]!.status).toBe('updated');
    expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('untouched');
    expect(existsSync(join(outside, 'participation.md'))).toBe(false);
    rmSync(directory, {recursive: true}); symlinkSync(join(home, 'missing'), directory);
    expect((await agentSkills('refresh', 'https://self-host.example', options)).results[0]!.status).toBe('updated');
    expect(existsSync(join(home, 'missing'))).toBe(false);
  }
  // A directory in place of an expected file must not count as current.
  rmSync(join(directory, 'SKILL.md')); mkdirSync(join(directory, 'SKILL.md'));
  expect((await agentSkills('refresh', 'https://self-host.example', options)).results[0]!.status).toBe('updated');
  expect(readFileSync(join(directory, 'SKILL.md'), 'utf8')).toBe(skillFiles()['SKILL.md']);
}));

test('CLI skill status is read-only and does not require login or capture enrollment', () => fixture(async home => {
  const r = Bun.spawnSync(['bun', resolve(import.meta.dir, '../src/cli.ts'), 'skills', 'status', '--client', 'claude-code', '--api', 'http://127.0.0.1:8093', '--json'], {
    env: {...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, 'claude')}, stdout: 'pipe', stderr: 'pipe',
  });
  expect(r.exitCode).toBe(0);
  expect(JSON.parse(r.stdout.toString()).data.results[0].status).toBe('missing');
  expect(existsSync(join(home, 'claude'))).toBe(false);
  expect(existsSync(join(home, 'config/opencrawl/capture/config.json'))).toBe(false);
}));

test('refresh repairs existing skills but never creates a first installation', () => fixture(async home => {
  const options = {home, env: {}, which: () => null};
  const directory = join(home, '.agents/skills/opencrawl');
  mkdirSync(directory, {recursive: true}); writeFileSync(join(directory, 'SKILL.md'), 'old');
  const result = await agentSkills('refresh', 'https://app.getopencrawl.com', options);
  expect(result.results.map(row => row.status)).toEqual(['updated']);
  expect(readFileSync(join(directory, 'SKILL.md'), 'utf8')).toBe(skillFiles()['SKILL.md']);
  rmSync(directory, {recursive: true}); mkdirSync(join(home, '.codex'));
  expect((await agentSkills('refresh', 'https://app.getopencrawl.com', options)).results[0]!.status).toBe('skipped');
  expect(existsSync(directory)).toBe(false);
  expect((await agentSkills('install', 'https://app.getopencrawl.com', options)).results[0]!.status).toBe('installed');
}));

test('CLI server precedence is flag, environment, saved config, hosted default without changing config', () => fixture(async home => {
  const env: NodeJS.ProcessEnv = {...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, 'claude')};
  delete env.OPENCRAWL_API_URL;
  const run = (args: string[] = [], variables = env) => {
    const child = Bun.spawnSync(['bun', resolve(import.meta.dir, '../src/cli.ts'), 'skills', 'status', '--client', 'claude-code', '--json', ...args], {env: variables, stdout: 'pipe', stderr: 'pipe'});
    expect(child.exitCode).toBe(0); return JSON.parse(child.stdout.toString()).data.api;
  };
  expect(run()).toBe('https://app.getopencrawl.com');
  const directory = join(home, 'config/opencrawl/capture'); mkdirSync(directory, {recursive: true});
  const config = JSON.stringify({schemaVersion: 1, api: 'https://saved.example', installationId: 'existing', owner: {tenantId: 'local', userId: 'human'}});
  writeFileSync(join(directory, 'config.json'), config);
  expect(run()).toBe('https://saved.example');
  const overridden = {...env, OPENCRAWL_API_URL: 'https://environment.example'};
  expect(run([], overridden)).toBe('https://environment.example');
  expect(run(['--api', 'https://flag.example'], overridden)).toBe('https://flag.example');
  expect(readFileSync(join(directory, 'config.json'), 'utf8')).toBe(config);
}));

test('approved capture setup installs skills without replacing existing hooks or requiring runtime credentials', () => fixture(async home => {
  // homedir may be cached by the runtime: isolate HOME before process startup.
  const claude = join(home, 'claude');
  const env: NodeJS.ProcessEnv = {...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: join(home, 'codex')};
  delete env.OPENCRAWL_SESSIONS_TOKEN; delete env.CLAUDE_CODE_REMOTE;
  mkdirSync(claude);
  const settings = join(claude, 'settings.json');
  writeFileSync(settings, JSON.stringify({hooks: {Stop: [{hooks: [{type: 'command', command: 'echo existing'}]}]}}));
  const child = Bun.spawnSync(['bun', resolve(import.meta.dir, '../src/cli.ts'), 'collect', 'install', '--yes', '--harness', 'claude-code', '--defer-auth', '--backfill', 'skip', '--api', 'http://127.0.0.1:8093', '--json'], {env, stdout: 'pipe', stderr: 'pipe'});
  expect(child.exitCode).toBe(0);
  const result = JSON.parse(child.stdout.toString()).data;
  expect(result.skills.results.every((r: any) => r.directory.startsWith(home))).toBe(true);
  expect(result.skills.results.some((r: any) => r.clients.includes('claude-code') && r.status === 'installed')).toBe(true);
  expect(readFileSync(join(home, 'claude/skills/opencrawl/SKILL.md'), 'utf8')).toBe(skillFiles()['SKILL.md']);
  expect(JSON.parse(readFileSync(settings, 'utf8')).hooks.Stop[0].hooks[0].command).toBe('echo existing');
  expect(result.backfill.status).toBe('skipped');
}));
