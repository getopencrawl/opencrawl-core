import {appendFileSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync} from 'node:fs';
import {basename, join} from 'node:path';
import {atomicFile, atomicJson, withSessionLock} from '../session.ts';
import {readTranscript, userItems, userMessages, recordText, afterCompaction, EVENT_KINDS, RECORD_HEADING, type TranscriptEvent, type UserItem} from '../transcript.ts';
import {captureExcluded, type CaptureExclusions} from './policy.ts';
import {hash} from './parse.ts';
import {redactText, SECRET_MASK} from './redact.ts';

/** Claude Code replaces a full context with a summary, and a summary loses the
 * exact things a person said. This gives the agent the person's own words
 * back, from the session's transcript on this machine:
 *
 *   SessionStart, source "compact"  writes the complete record of the person's
 *                                   messages to a file and puts the record, or
 *                                   an index of it and its path, in the context;
 *   PostToolUse, once after it      adds the lines of the person's messages
 *                                   whose exact details the summary dropped;
 *   PostCompact                     measures how many exact details the summary
 *                                   kept (the drift meter, logged only).
 *
 * Order of events in a compaction (Claude Code 2.1.321): the summary is
 * generated, SessionStart hooks run, PostCompact hooks run, and only then are
 * the boundary and the summary appended to the transcript. So what a summary
 * dropped can be read from the transcript at the first tool result, not before.
 *
 * Claude Code inlines hook context only up to 10,000 characters; longer text
 * is replaced by a 2 KB preview and a file path. Whatever is put in the
 * context here therefore stays under this cap. */
export const INLINE_CAP = 9_500;
/** Most of one re-shown line. */
const LINE_CAP = 1_500;
/** A record is rewritten at every compaction of its session and removed this long after the last one. */
const RECORD_DAYS = 30;
/** A comparison nobody collected (the session ended, or only subagents ran tools) is dropped after this long. */
const PENDING_MS = 15 * 60_000;
/** A comparison that is owed is one small file named after its session, in a
 * directory that exists only while some comparison is owed. The installed
 * PostToolUse hook tests for it in the shell before it starts anything. */
export const PENDING_DIRECTORY = 'pending';
const DRIFT_FILE = 'drift.jsonl', DRIFT_MAX_BYTES = 1024 * 1024, DRIFT_MAX_LOST = 200;

/** The after-compaction policy, in one place. `start` is what SessionStart puts
 * in the context: the whole record, an index with a pointer to the record
 * file, or an index with the instruction to read that file now. `dropped` asks
 * for the lines the summary dropped at the first tool result afterwards. To
 * change what an agent is given after a compaction, change this function. */
export type AfterCompaction = {start: 'whole' | 'pointer' | 'read-now'; dropped: boolean};
export function afterCompactionPolicy({wholeFits}: {wholeFits: boolean}): AfterCompaction {
  return wholeFits ? {start: 'whole', dropped: false} : {start: 'pointer', dropped: true};
}

/** Exact details a summary either keeps or loses: code spans, numbers of three
 * or more digits, dotted versions, identifiers containing `_`, and hyphenated
 * identifiers that contain a digit or a capital. Ordinary hyphenated words
 * (well-known, long-running) are not details. */
export function anchors(text: string): string[] {
  const found = new Set<string>();
  for (const line of text.split('\n')) {
    // Code spans are the odd segments between the backticks on one line.
    const segments = line.split('`');
    for (let index = 1; index < segments.length - 1; index += 2) {
      const span = segments[index]!.trim();
      if (span.length >= 2 && span.length <= 80) found.add(span);
    }
  }
  // 2,400,000; then a dotted version, tried before a plain number so that
  // 2024.06 stays whole, with a pre-release tag that has a digit (3.8.1-rc2);
  // then any number of three or more digits.
  for (const match of text.matchAll(/\b\d{1,3}(?:,\d{3})+\b|(?<![\w.])v?(\d+(?:\.\d+)+(?:-(?=[A-Za-z0-9.]*\d)[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)?)\b|\b\d{3,}\b/g)) found.add(match[1] ?? match[0]);
  for (const [word] of text.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)+\b/g)) if (word.includes('_') || /[0-9A-Z]/.test(word)) found.add(word);
  return [...found].filter(anchor => anchor.length >= 3).sort();
}

/** Whether a text lacks a detail. A number is the same number with or without
 * thousands separators: 2,400,000 and 2400000. */
export function detailsMissingFrom(text: string) {
  let plain: string | undefined;
  return (anchor: string) => {
    if (text.includes(anchor)) return false;
    if (!/^\d{1,3}(?:,\d{3})+$|^\d{3,}$/.test(anchor)) return true;
    plain ??= text.replace(/(?<=\d),(?=\d{3})/g, '');
    return !plain.includes(anchor.replaceAll(',', ''));
  };
}

const RECALL = ' For anything else from before the compaction that you need exactly (your own decisions and the reasons for them, values, error messages, command output), '
  + 'run `opencrawl recall "<a few distinctive words>"`: it searches the full transcript of this session and prints the matching passages verbatim.';
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
/** One line per message: the first message and as many of the newest as fit. */
function index(items: UserItem[], budget: number) {
  const entry = ({number, message}: UserItem) => `[message ${number}${message.ts ? `, ${message.ts}` : ''}] ${message.text.split('\n', 1)[0]!.slice(0, 100)}`;
  const note = (left: number) => `\n(${plural(left, 'earlier message')} not listed here; the complete record has ${left === 1 ? 'it' : 'them'})`;
  const listed = new Set([0]);
  let used = entry(items[0]!).length + note(items.length).length;
  for (let at = items.length - 1; at > 0 && used + entry(items[at]!).length + 1 <= budget; at--) {listed.add(at); used += entry(items[at]!).length + 1;}
  const left = items.length - listed.size;
  return items.filter((_, at) => listed.has(at)).map(entry).join('\n') + (left ? note(left) : '');
}
/** Where the complete record is: its file, or the command that prints it when no file could be kept. */
const record = (text: string, path: string | null) => `The complete word-for-word record of the user's messages (${text.length} characters) is `
  + (path ? `in the file ${path}` : 'printed by `opencrawl recall --user`');

/** What SessionStart puts in the context right after a compaction. Nothing here
 * claims to know what the summary kept: that summary is not in the transcript yet. */
export function startContext(items: UserItem[], path: string | null, policy = afterCompactionPolicy, cap = INLINE_CAP): {text: string; dropped: boolean} {
  const HEAD = 'OpenCrawl verbatim record. Your context was just compacted into a summary, and summaries lose detail. ';
  const full = recordText(items);
  const whole = HEAD + 'Below is every message the user sent in this session, word for word, oldest first. '
    + 'Where the summary and these messages disagree, these messages are right, and a later message overrides an earlier one.' + RECALL + '\n\n' + full;
  const {start, dropped} = policy({wholeFits: whole.length <= cap});
  if (start === 'whole' && whole.length <= cap) return {text: whole, dropped};
  const source = path ? 'the file' : 'that record';
  const where = record(full, path) + (start === 'read-now'
    ? `. ${path ? 'Read that file in full' : 'Run it'} now, before you continue: it is the authority on what was asked, and where the summary disagrees with it, ${source} is right. A later message overrides an earlier one.`
    : `. ${path ? 'Read it' : 'Run it'} when you need a message in full; where the summary disagrees with it, ${source} is right.`) + RECALL;
  const top = HEAD + `The user has sent ${plural(items.length, 'message')} in this session:\n`;
  const text = top + index(items, cap - top.length - where.length - 2) + '\n\n' + where;
  return {text: text.length <= cap ? text : (HEAD + where).slice(0, cap), dropped};
}

/** What the first tool result after a compaction adds: the lines of the
 * person's messages, word for word, that hold an exact detail found neither in
 * the new summary nor in the records the harness kept word for word. A message
 * sent after the compaction, or kept by the harness, is still in the context
 * and is not compared. Over budget, the newest lines are kept. */
export function droppedContext(items: UserItem[], state: NonNullable<ReturnType<typeof afterCompaction>>, path: string | null, cap = INLINE_CAP): string {
  const HEAD = 'OpenCrawl verbatim record. Your context was compacted into a summary a moment ago. OpenCrawl compared that summary with what the user actually wrote. ';
  const where = ' ' + record(recordText(items), path) + `; ${path ? 'read' : 'run'} it when you need a message in full.` + RECALL;
  const missing = detailsMissingFrom(state.summary + '\n' + state.preservedText);
  const lines: {number: number; line: string}[] = [], seen = new Set<string>();
  let details = 0;
  for (const {number, message} of items) {
    if (message.i > state.boundary || message.uuid !== undefined && state.preserved.has(message.uuid)) continue;
    // One line is one list item or one paragraph.
    for (const raw of message.text.split('\n')) {
      const line = raw.trim();
      if (!line || seen.has(line)) continue;
      const gone = anchors(line).filter(missing).length;
      if (!gone) continue;
      seen.add(line); details += gone;
      lines.push({number, line: line.length > LINE_CAP ? line.slice(0, LINE_CAP) + ' [...]' : line});
    }
  }
  if (!lines.length) return HEAD + `The summary kept every exact detail (names, numbers, code) of the user's ${plural(items.length, 'message')}.` + where;
  const intro = (left: number) => `The summary dropped or changed ${plural(details, 'exact detail')} of the user's messages. The lines that hold them follow, word for word, oldest first`
    + (left ? ` (${plural(left, 'older line')} left out for length; the complete record has ${left === 1 ? 'it' : 'them'})` : '')
    + '. Where the summary and these lines disagree, the lines are right, and a later message overrides an earlier one.';
  // Consecutive lines of one message share its label.
  const label = (number: number) => `\n\n[from message ${number}]`;
  let budget = cap - HEAD.length - intro(lines.length).length - where.length - 1;
  const shown: typeof lines = [];
  for (let at = lines.length - 1; at >= 0; at--) {
    const {number, line} = lines[at]!, cost = (shown[0]?.number === number ? 0 : label(number).length) + 1 + line.length;
    if (cost > budget) continue;
    shown.unshift(lines[at]!); budget -= cost;
  }
  const body = shown.map(({number, line}, at) => (shown[at - 1]?.number === number ? '\n' : label(number) + '\n') + line).join('');
  const text = HEAD + intro(lines.length - shown.length) + body + '\n\n' + where.trimStart();
  return shown.length && text.length <= cap ? text : (HEAD + `The summary dropped or changed ${plural(details, 'exact detail')} of the user's messages.` + where).slice(0, cap);
}

/** The complete record of the person's messages, one private file per session,
 * replaced whole at every compaction. Returns its path, or null if it could
 * not be written: the context then points at `opencrawl recall --user`. */
export function writeRecord(directory: string, session: string, text: string, now = Date.now()): string | null {
  try {
    // Session IDs are UUIDs; anything else gets a name that is safe on every filesystem.
    const file = join(directory, 'records', (/^[\w.-]{1,120}$/.test(session) ? session : hash(session).slice(0, 32)) + '.md');
    atomicFile(file, RECORD_HEADING + '\n\n' + text + '\n');
    for (const name of readdirSync(join(directory, 'records'))) {
      const other = join(directory, 'records', name);
      try {if (other !== file && now - statSync(other).mtimeMs > RECORD_DAYS * 86_400_000) unlinkSync(other);} catch {}
    }
    return file;
  } catch {return null;}
}

export type Drift = {anchors: number; kept: number; lost: string[]};
/** How many exact details of what the person said appear in a summary. A
 * recognised credential is never a detail: it is not written down again. */
export function drift(events: TranscriptEvent[], summary: string): Drift {
  const said = userMessages(events).map(message => redactText(message.text)).join('\n');
  const all = anchors(said).filter(anchor => !anchor.includes(SECRET_MASK));
  const lost = all.filter(detailsMissingFrom(summary));
  return {anchors: all.length, kept: all.length - lost.length, lost};
}

export type DriftRecord = {ts: string; session: string | null; trigger: string | null; anchors: number; kept: number; lost: string[]; summaryChars: number};
/** One line per compaction, private to this user. The file keeps its newest half when it passes a mebibyte. */
export async function recordDrift(directory: string, record: DriftRecord) {
  const file = join(directory, DRIFT_FILE);
  await withSessionLock('capture:drift', async () => {
    appendFileSync(file, JSON.stringify(record) + '\n', {mode: 0o600});
    if (statSync(file).size <= DRIFT_MAX_BYTES) return;
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    atomicFile(file, lines.slice(Math.ceil(lines.length / 2)).join('\n') + '\n');
  }, 2000);
}

/** The latest measurement as counts. What was lost is the person's own words,
 * so status reports how many, never which. */
export function latestDrift(directory: string) {
  let lines: string[];
  try {lines = readFileSync(join(directory, DRIFT_FILE), 'utf8').trimEnd().split('\n');} catch {return null;}
  for (let at = lines.length - 1; at >= 0; at--) {
    try {
      const {ts, session, trigger, anchors, kept, summaryChars} = JSON.parse(lines[at]!);
      if (typeof ts === 'string' && Number.isFinite(anchors) && Number.isFinite(kept)) return {ts, session, trigger, anchors, kept, lost: anchors - kept, summaryChars};
    } catch {}
  }
  return null;
}

type Enrollment = {config: {disabled?: boolean; exclusions?: CaptureExclusions} | null; directory: string; until?: number; now?: number; env?: NodeJS.ProcessEnv};
/** A Claude Code hook payload for a session this installation may act on. */
function claudeSession(payload: any, config: Enrollment['config']) {
  // Hooks already loaded by a running session outlive an uninstall.
  if (!config || config.disabled) return null;
  // Cursor-format runtimes also load Claude Code hook files; theirs is not a Claude Code transcript.
  if (!payload || typeof payload !== 'object' || typeof payload.cursor_version === 'string') return null;
  const transcript = payload.transcript_path;
  if (typeof transcript !== 'string' || !transcript.endsWith('.jsonl')) return null;
  const id = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : null;
  // An excluded project or session is read back to its own agent, but nothing about it is stored.
  return {transcript, id, name: id ?? basename(transcript, '.jsonl'), excluded: () => captureExcluded(config, {sessionId: id ?? undefined, cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined})};
}

/** The file that says a comparison is owed. Its name is what the shell test of
 * the installed hook looks for: the session ID Claude Code exports to hook
 * commands, else the one in the payload. */
function pendingFile(directory: string, session: {id: string | null}, env: NodeJS.ProcessEnv) {
  const key = env.CLAUDE_CODE_SESSION_ID || session.id;
  return key && /^\w[\w.-]{0,119}$/.test(key) ? join(directory, PENDING_DIRECTORY, key) : null;
}
/** Drop comparisons nobody collected, and the directory with the last one. */
function sweepPending(directory: string, now: number) {
  const pending = join(directory, PENDING_DIRECTORY);
  let names: string[];
  try {names = readdirSync(pending);} catch {return;}
  for (const name of names) try {if (now - statSync(join(pending, name)).mtimeMs > PENDING_MS) unlinkSync(join(pending, name));} catch {}
  try {rmdirSync(pending);} catch {}
}

/** The first tool result after a compaction: what the summary dropped, as
 * PostToolUse context, or nothing. The installed hook reaches this only when
 * its shell test found a comparison owed; where there is no such test, an
 * absent file is the common case and costs one failed open. */
export function compactionFollowUp(payload: any, {config, directory, until = Infinity, now = Date.now(), env = process.env}: Enrollment): string {
  // A subagent's tool result belongs to the subagent's context, not to the agent that was compacted.
  if (payload?.hook_event_name !== 'PostToolUse' || typeof payload.agent_id === 'string') return '';
  const session = claudeSession(payload, config), marker = session && pendingFile(directory, session, env);
  if (!session || !marker) return '';
  let since: number;
  try {since = Date.parse(JSON.parse(readFileSync(marker, 'utf8')).at);} catch {sweepPending(directory, now); return '';}
  const clear = () => {try {unlinkSync(marker);} catch {} sweepPending(directory, now);};
  if (!(now - since < PENDING_MS) || session.excluded()) {clear(); return '';}
  const {events} = readTranscript(session.transcript, {kinds: [...EVENT_KINDS, 'boundary'], until});
  const state = afterCompaction(events), items = userItems(events);
  // Not in the transcript yet, or still the compaction before this one: try at the next tool result.
  if (!state || state.at !== null && Date.parse(state.at) < since - 120_000) return '';
  const text = items.length ? droppedContext(items, state, writeRecord(directory, session.name, recordText(items), now)) : '';
  clear();
  return text && JSON.stringify({hookSpecificOutput: {hookEventName: 'PostToolUse', additionalContext: text}}) + '\n';
}

/** What a compaction hook prints for the harness: context for the agent, or
 * nothing. `until` is a Date.now() deadline for reading the transcript. */
export async function compactionHookOutput(payload: any, {config, directory, until = Infinity, now = Date.now(), env = process.env}: Enrollment): Promise<string> {
  if (payload?.hook_event_name === 'PostToolUse') return compactionFollowUp(payload, {config, directory, until, now, env});
  const session = claudeSession(payload, config);
  if (!session) return '';
  if (payload.hook_event_name === 'SessionStart' && payload.source === 'compact') {
    const items = userItems(readTranscript(session.transcript, {kinds: ['user', 'queued'], until}).events);
    if (!items.length) return '';
    const path = session.excluded() ? null : writeRecord(directory, session.name, recordText(items), now);
    const {text, dropped} = startContext(items, path);
    // The comparison needs the summary, which the harness has not written yet.
    const marker = pendingFile(directory, session, env);
    if (marker) try {
      if (!path || !dropped) unlinkSync(marker);
      // Another hook may remove the directory as it empties: once more, then.
      else try {atomicJson(marker, {at: new Date(now).toISOString()});} catch {atomicJson(marker, {at: new Date(now).toISOString()});}
    } catch {}
    sweepPending(directory, now);
    return JSON.stringify({hookSpecificOutput: {hookEventName: 'SessionStart', additionalContext: text}}) + '\n';
  }
  if (payload.hook_event_name === 'PostCompact' && typeof payload.compact_summary === 'string' && payload.compact_summary && !session.excluded()) {
    const measured = drift(readTranscript(session.transcript, {kinds: ['user', 'queued'], until}).events, payload.compact_summary);
    await recordDrift(directory, {ts: new Date().toISOString(), session: session.id, trigger: typeof payload.trigger === 'string' ? payload.trigger : null,
      ...measured, lost: measured.lost.slice(0, DRIFT_MAX_LOST), summaryChars: payload.compact_summary.length});
  }
  return '';
}
