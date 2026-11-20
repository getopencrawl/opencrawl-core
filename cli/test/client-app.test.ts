import {expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {clientAppResolver} from '../src/capture/client-app.ts';

test('Client attribution uses the native launcher or an exact Conductor harness and session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencrawl-client-app-'));
  const path = join(dir, 'conductor.db');
  try {
    const resolve = clientAppResolver(path);
    expect(resolve('claude-code', 'missing', 'sdk-ts')).toBeUndefined();
    expect(resolve('codex', 'missing', 'Codex Desktop')).toBeUndefined();
    expect(resolve('codex', 'missing', 'T3 Code')).toBe('t3-code');
    expect(existsSync(path)).toBe(false);
    expect(resolve('claude-code', 'missing', 't3-code')).toBe('t3-code');
    const db = new Database(path, {create: true});
    try {
      db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, claude_session_id TEXT, agent_type TEXT)");
      db.exec("INSERT INTO sessions VALUES ('chat', 'native-claude', 'claude'), ('other', 'native-codex', 'codex')");
    } finally { db.close(); }
    expect(resolve('claude-code', 'chat', 'sdk-ts')).toBeUndefined();
    expect(resolve('claude-code', 'native-codex', 'sdk-ts')).toBeUndefined();
    expect(resolve('claude-code', 'native-claude', 'sdk-ts')).toBe('conductor');
    expect(resolve('claude-code', 'native-claude', 'cli')).toBeUndefined();
    expect(resolve('claude-code', 'native-claude', 't3-code')).toBe('t3-code');
    expect(resolve('claude-code', 'unrelated', 'sdk-ts')).toBeUndefined();
    expect(resolve('codex', 'native-codex', 'Codex Desktop')).toBe('conductor');
    expect(resolve('claude-code', 'native-codex', 'sdk-ts')).toBeUndefined();
    expect(resolve('codex', 'native-codex', 'codex_sdk_ts')).toBe('conductor');
    expect(resolve('codex', 'other', 'Codex Desktop')).toBeUndefined();
    expect(resolve('codex', 'native-claude', 'Codex Desktop')).toBeUndefined();
    expect(resolve('codex', 'unrelated', 'codex_sdk_ts')).toBeUndefined();
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
