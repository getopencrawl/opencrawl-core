import {readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';

type NativeTitle = {title: string; timestamp: string};
const indexes = new Map<string, {signature: string; titles: Map<string, NativeTitle>}>();

/** Codex writes names outside the transcript. Never infer them from tool text. */
export function codexTitle(root: string, sessionId: string): NativeTitle | null {
  const path = join(root, 'session_index.jsonl');
  try {
    const st = statSync(path), signature = `${st.ino}:${st.size}:${st.mtimeMs}`;
    let cached = indexes.get(path);
    if (cached?.signature !== signature) {
      if (st.size > 32 * 1024 * 1024) return null;
      const titles = new Map<string, NativeTitle>();
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        let record: unknown; try {record = JSON.parse(line);} catch {continue;}
        if (!record || typeof record !== 'object') continue;
        const value = record as Record<string, unknown>;
        if (typeof value.id !== 'string' || typeof value.thread_name !== 'string' || !value.thread_name.trim() ||
          typeof value.updated_at !== 'string' || !Number.isFinite(Date.parse(value.updated_at))) continue;
        const previous = titles.get(value.id), timestamp = new Date(value.updated_at).toISOString();
        if (!previous || timestamp >= previous.timestamp) titles.set(value.id, {title: value.thread_name.trim(), timestamp});
      }
      cached = {signature, titles};
      if (indexes.size >= 4) indexes.delete(indexes.keys().next().value!);
      indexes.set(path, cached);
    }
    return cached.titles.get(sessionId) ?? null;
  } catch {return null;} // Optional native display metadata must not stop capture.
}

export function codexTitleSignature(root: string) {
  try {const st = statSync(join(root, 'session_index.jsonl')); return `${st.ino}:${st.size}:${st.mtimeMs}`;} catch {return '';}
}
