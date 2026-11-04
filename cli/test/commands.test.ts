import {test, expect} from 'bun:test';
import {resolve, join} from 'node:path';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';

test('agent command errors keep stdout JSON, stable exit codes and credential-free messages', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencrawl-commands-'));
  try {
    for (const args of [
      ['unknown'], ['status', '--unknown'], ['whoami', 'extra'],
      ['whoami', '--api', 'http://remote.example'],
      ['whoami', '--api', 'https://secret-user:secret-password@example.com'],
      ['whoami', '--api', ''], ['update', '--unknown'],
    ]) {
      const result = Bun.spawnSync(['bun', resolve(import.meta.dir, '../src/cli.ts'), ...args, '--json'], {env: {...process.env, OPENCRAWL_CONFIG_HOME: directory}, stdout: 'pipe', stderr: 'pipe'});
      expect(result.exitCode).toBe(64);
      const output = result.stdout.toString();
      expect(JSON.parse(output)).toMatchObject({schemaVersion: 1, error: {code: 'INVALID_USAGE'}});
      expect(output).not.toContain('secret');
      expect(result.stderr.toString()).toBe('');
    }
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
