import {Database} from 'bun:sqlite';
import {homedir} from 'node:os';
import {join} from 'node:path';

/** One lookup per native SDK session in a transcript scan. A later scan retries
 * if Conductor has since committed the session or its database was unavailable. */
export function clientAppResolver(databasePath = process.platform === 'darwin'
  ? join(homedir(), 'Library', 'Application Support', 'com.conductor.app', 'conductor.db')
  : undefined) {
  let lastSession: string | undefined;
  let matched = false;
  return (harness: 'codex' | 'claude-code', sessionId: string, launcher: unknown): 't3-code' | 'conductor' | undefined => {
    const codex = harness === 'codex';
    if (launcher === (codex ? 'T3 Code' : 't3-code')) return 't3-code';
    const candidate = codex ? launcher === 'Codex Desktop' || launcher === 'codex_sdk_ts' : launcher === 'sdk-ts';
    if (!candidate || !sessionId || !databasePath) return;
    const key = harness + '/' + sessionId;
    if (lastSession !== key) {
      lastSession = key;
      matched = false;
      let db: Database | undefined;
      try {
        db = new Database(databasePath, {readonly: true});
        matched = Boolean(db.query('SELECT 1 FROM sessions WHERE claude_session_id = ? AND agent_type = ? LIMIT 1').get(sessionId, codex ? 'codex' : 'claude'));
      } catch {
        // Attribution is optional. A missing, locked or newer database must allow capture to continue.
      } finally {
        db?.close();
      }
    }
    return matched ? 'conductor' : undefined;
  };
}
