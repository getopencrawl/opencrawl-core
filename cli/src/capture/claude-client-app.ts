import {Database} from 'bun:sqlite';
import {homedir} from 'node:os';
import {join} from 'node:path';

/** One lookup per native SDK session in a transcript scan. A later scan retries
 * if Conductor has since committed the session or its database was unavailable. */
export function claudeClientAppResolver(databasePath = process.platform === 'darwin'
  ? join(homedir(), 'Library', 'Application Support', 'com.conductor.app', 'conductor.db')
  : undefined) {
  let lastSession: string | undefined;
  let matched = false;
  return (sessionId: string, entrypoint: string): 't3-code' | 'conductor' | undefined => {
    if (entrypoint === 't3-code') return 't3-code';
    if (entrypoint !== 'sdk-ts' || !databasePath) return;
    if (lastSession !== sessionId) {
      lastSession = sessionId;
      matched = false;
      let db: Database | undefined;
      try {
        db = new Database(databasePath, {readonly: true});
        matched = Boolean(db.query("SELECT 1 FROM sessions WHERE claude_session_id = ? AND agent_type = 'claude' LIMIT 1").get(sessionId));
      } catch {
        // Attribution is optional. A missing, locked or newer database must allow capture to continue.
      } finally {
        db?.close();
      }
    }
    return matched ? 'conductor' : undefined;
  };
}
