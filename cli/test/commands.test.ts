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


test('identity distinguishes organization setup, email verification and denied access', async () => {
  const {identity}=await import('../src/cli.ts');
  for(const [code,message] of [
    ['ORGANIZATION_REQUIRED','Create or join a team at https://capture.example.com/organizations'],
    ['EMAIL_VERIFICATION_REQUIRED','Verify your email address'],
    ['UNKNOWN','This account cannot access the deployment'],
  ]) {
    const fetcher=(async()=>Response.json({schemaVersion:1,error:{code}},{status:403})) as unknown as typeof fetch;
    await expect(identity('https://capture.example.com',fetcher,'fixture-token')).rejects.toThrow(message);
  }
});
