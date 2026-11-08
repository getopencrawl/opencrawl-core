import {test, expect} from 'bun:test';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {agentSkills, skillTargets} from '../src/skills.ts';

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

test('offline self-host install is idempotent; managed updates preserve user edits and unrelated files', () => fixture(async home => {
  const options = {home, env: {}, which: () => null, clients: ['codex', 'claude-code']};
  const first = await agentSkills('install', 'http://127.0.0.1:8093', options);
  expect(first.results.map(r => r.status)).toEqual(['installed','installed']);
  const file = join(first.results[0]!.directory, 'SKILL.md');
  expect(readFileSync(file, 'utf8')).toContain('http://127.0.0.1:8093');
  const before = statSync(file).mtimeMs;
  expect((await agentSkills('install', 'http://127.0.0.1:8093', options)).results.map(r => r.status)).toEqual(['unchanged','unchanged']);
  expect(statSync(file).mtimeMs).toBe(before);
  const extra = join(first.results[0]!.directory, 'my-notes.md'); writeFileSync(extra, 'keep');
  expect((await agentSkills('install', 'https://self-host.example', options)).results.map(r => r.status)).toEqual(['updated','updated']);
  expect(readFileSync(extra, 'utf8')).toBe('keep');
  const ref = join(first.results[0]!.directory, 'references/participation.md');
  writeFileSync(ref, 'User-customized listener guidance');
  const original = readFileSync(file, 'utf8');
  expect((await agentSkills('install', 'https://new.example', options)).results.map(r => r.status)).toEqual(['conflict','updated']);
  expect(readFileSync(ref, 'utf8')).toBe('User-customized listener guidance');
  expect(readFileSync(file, 'utf8')).toBe(original);
}));

test('unmanaged skills and dangling skill-directory links are never overwritten', () => fixture(async home => {
  const options = {home, env: {}, which: () => null, clients: ['claude-code']};
  const directory = skillTargets(options)[0]!.directory;
  mkdirSync(directory, {recursive: true}); writeFileSync(join(directory, 'SKILL.md'), 'My own OpenCrawl skill');
  expect((await agentSkills('install', 'https://self-host.example', options)).results[0]!.status).toBe('conflict');
  expect(readFileSync(join(directory, 'SKILL.md'), 'utf8')).toBe('My own OpenCrawl skill');
  if (process.platform !== 'win32') {
    rmSync(directory, {recursive: true});
    const outside = join(home, 'missing-target'); symlinkSync(outside, directory);
    expect((await agentSkills('install', 'https://self-host.example', options)).results[0]!.status).toBe('conflict');
    expect(existsSync(outside)).toBe(false);
  }
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
  expect(readFileSync(join(home, 'claude/skills/opencrawl/SKILL.md'), 'utf8')).toContain('http://127.0.0.1:8093');
  expect(JSON.parse(readFileSync(settings, 'utf8')).hooks.Stop[0].hooks[0].command).toBe('echo existing');
  expect(result.backfill.status).toBe('skipped');
}));
