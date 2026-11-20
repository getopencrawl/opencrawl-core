import {expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {claudeClientAppResolver} from '../src/capture/claude-client-app.ts';

test('Claude client attribution uses the native entrypoint or an exact Conductor Claude session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencrawl-client-app-'));
  const path = join(dir, 'conductor.db');
  try {
    const resolve = claudeClientAppResolver(path);
    expect(resolve('missing', 'sdk-ts')).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    expect(resolve('missing', 't3-code')).toBe('t3-code');
    const db = new Database(path, {create: true});
    try {
      db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, claude_session_id TEXT, agent_type TEXT)");
      db.exec("INSERT INTO sessions VALUES ('chat', 'native-claude', 'claude'), ('other', 'native-codex', 'codex')");
    } finally { db.close(); }
    expect(resolve('chat', 'sdk-ts')).toBeUndefined();
    expect(resolve('native-codex', 'sdk-ts')).toBeUndefined();
    expect(resolve('native-claude', 'sdk-ts')).toBe('conductor');
    expect(resolve('native-claude', 'cli')).toBeUndefined();
    expect(resolve('native-claude', 't3-code')).toBe('t3-code');
    expect(resolve('unrelated', 'sdk-ts')).toBeUndefined();
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
