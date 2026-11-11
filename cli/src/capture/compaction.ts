import {appendFileSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync} from 'node:fs';
import {basename, join} from 'node:path';
import {atomicFile, atomicJson, withSessionLock} from '../session.ts';
import {readTranscript, readProject, projectItems, userMessages, recordText, recordHeading, spansSessions, afterCompaction, EVENT_KINDS,
  type EventKind, type TranscriptEvent, type UserItem, type Reach} from '../transcript.ts';
import {captureExcluded, type CaptureExclusions} from './policy.ts';
import {hash} from './parse.ts';
import {redactText, SECRET_MASK} from './redact.ts';

/** Claude Code replaces a full context with a summary, and a summary can lose
 * exact things a person said; a new session starts with none of what the
 * person said in the sessions before it. The transcripts on this machine still
 * hold every word. This gives the agent the person's own words back from them:
 *
 *   SessionStart, source "startup"  for a project that has earlier sessions,
 *                                   puts the record of the person's messages
 *                                   in those sessions, or an index of it and
 *                                   its path, in the context;
 *   SessionStart, source "compact"  the same after a compaction, for this
 *                                   session and the earlier ones;
 *   PostToolUse, once after that    adds the lines of the person's messages
 *                                   whose exact details the summary dropped,
 *                                   unless the person replaced them since;
 *   PostCompact                     measures how many exact details the summary
 *                                   kept (the drift meter, logged only).
 *
 * The complete record is always written to a file as well.
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
/** How everything put in the context here begins; it is also how the drift command tells it from other hooks' context. */
const RECORD_MARK = 'OpenCrawl verbatim record. ';
/** Most of one re-shown line. */
const LINE_CAP = 1_500;
/** What is compared after a compaction is bounded, because a harness waits for
 * it: a message of more lines than this is a paste and is compared at its
 * start and its end, and of all the lines the newest this many are compared. */
const MESSAGE_LINES = 400, COMPARED_LINES = 8_000;
/** A detail that comes up in more lines than this says nothing about which lines belong together. */
const RARE_LINES = 3;
/** How many later lines that mention a detail are looked at to see whether it was replaced. */
const LATER_LOOKED_AT = 40;
/** A record is rewritten at every compaction of its session and removed this long after the last one. */
const RECORD_DAYS = 30;
/** A comparison nobody collected (the session ended, or only subagents ran tools) is dropped after this long. */
const PENDING_MS = 15 * 60_000;
/** A comparison that is owed is one small file named after its session, in a
 * directory that exists only while some comparison is owed. The installed
 * PostToolUse hook tests for it in the shell before it starts anything. */
export const PENDING_DIRECTORY = 'pending';
const DRIFT_FILE = 'drift.jsonl', DRIFT_MAX_BYTES = 1024 * 1024, DRIFT_MAX_LOST = 200;

/** The policy, in one place: what an agent is given, and how far back the
 * record of a project goes. To change either, change this function.
 *  reach     the other sessions of the project that count: how many, how
 *            recently written, and how much transcript is read for them;
 *  start     what SessionStart puts in the context: the whole record, an
 *            index with a pointer to the record file, or an index with the
 *            instruction to read that file now;
 *  dropped   whether the first tool result after a compaction adds the lines
 *            the summary dropped;
 *  overflow  what to say when those lines do not all fit: read the record
 *            now, or only point at it. */
export type RecordPolicy = {reach: Reach; start: 'whole' | 'pointer' | 'read-now'; dropped: boolean; overflow: 'read-now' | 'pointer'};
export function recordPolicy(at: 'startup' | 'compact', wholeFits: boolean): RecordPolicy {
  return {
    reach: {sessions: 10, days: 30, megabytes: 64},
    start: wholeFits ? 'whole' : at === 'startup' ? 'read-now' : 'pointer',
    dropped: at === 'compact' && !wholeFits,
    overflow: 'read-now',
  };
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

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
/** The hint that ends everything put in the context: where the rest is. */
function recallHint(items: UserItem[], at: 'startup' | 'compact') {
  const project = spansSessions(items);
  const from = !project ? 'from before the compaction' : at === 'startup' ? 'from the earlier sessions' : 'from earlier in this session or from the earlier sessions';
  return ` For anything else ${from} that you need exactly (${project ? 'decisions that were made' : 'your own decisions'} and the reasons for them, values, error messages, command output), `
    + `run \`opencrawl recall "<a few distinctive words>"\`: it searches the full ${project ? "transcripts of this project's sessions" : 'transcript of this session'} and prints the matching passages verbatim.`;
}
/** One line per message: the first message and as many of the newest as fit. */
function index(items: UserItem[], budget: number) {
  const entry = ({number, message}: UserItem) => `[${message.session === undefined ? '' : `session ${message.session}, `}message ${number}${message.ts ? `, ${message.ts}` : ''}] ${message.text.split('\n', 1)[0]!.slice(0, 100)}`;
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

/** What SessionStart puts in the context: right after a compaction, or at the
 * start of a new session of a project that has earlier ones (`items` are then
 * the messages of those sessions; `omitted` says that older sessions lie
 * beyond the reach). Nothing here claims to know what a summary kept: the
 * summary of the compaction is not in the transcript yet. */
export function startContext(items: UserItem[], path: string | null, {at = 'compact', omitted = 0, policy = recordPolicy, cap = INLINE_CAP}:
  {at?: 'startup' | 'compact'; omitted?: number; policy?: typeof recordPolicy; cap?: number} = {}): {text: string; dropped: boolean} {
  const startup = at === 'startup', hint = recallHint(items, at), full = recordText(items);
  const head = startup
    ? RECORD_MARK + 'This project has earlier sessions, and every word of them is on record. What the user asked for in those sessions still holds unless a later message changed it. '
    : RECORD_MARK + 'Your context was just compacted into a summary, and summaries lose detail. ';
  const scope = !spansSessions(items) ? 'in this session' : omitted ? 'in the most recent sessions of this project (not every session is included)' : 'in this project, across all of its sessions';
  const whole = head + `Below is every message the user sent ${scope}, word for word, oldest first. `
    + `Where ${startup ? 'your assumptions' : 'the summary'} and these messages disagree, these messages are right, and a later message overrides an earlier one.` + hint + '\n\n' + full;
  const {start, dropped} = policy(at, whole.length <= cap);
  if (start === 'whole' && whole.length <= cap) return {text: whole, dropped};
  const source = path ? 'the file' : 'that record', before = startup ? 'before you do anything else' : 'before you continue';
  const where = record(full, path) + (start === 'read-now'
    ? `. ${path ? 'Read that file in full' : 'Run it'} now, ${before}: it is the authority on what was asked${startup ? '' : `, and where the summary disagrees with it, ${source} is right`}. A later message overrides an earlier one.`
    : `. ${path ? 'Read it' : 'Run it'} when you need a message in full; where the summary disagrees with it, ${source} is right.`) + hint;
  const top = head + `The user has sent ${plural(items.length, 'message')} ${scope}:\n`;
  const text = top + index(items, cap - top.length - where.length - 2) + '\n\n' + where;
  return {text: text.length <= cap ? text : (head + where).slice(0, cap), dropped};
}

type Compaction = NonNullable<ReturnType<typeof afterCompaction>>;
/** A detail as lines are compared by it: without the quotes or brackets around
 * it, in lower case, a number without its thousands separators; and for one
 * such as `gallery-2024.06` or `--port 7070` its version or number as well. */
const detailKeys = (detail: string) => {
  const plain = detail.replace(/^[`"'()[\]{} ]+|[`"'()[\]{} ]+$/g, '').toLowerCase().replace(/(?<=\d),(?=\d{3})/g, '');
  return [plain, ...(plain.match(/\d+(?:\.\d+)+|\d{3,}/g) ?? [])];
};
/** The lines of the person's messages in the order written. One line is one
 * list item or one paragraph. */
function userLines(items: UserItem[]) {
  let lines: {number: number; message: TranscriptEvent; text: string}[] = [], partial = false;
  for (const {number, message} of items) {
    let own = message.text.split('\n').map(line => line.trim()).filter(Boolean);
    if (own.length > MESSAGE_LINES) {partial = true; own = [...own.slice(0, MESSAGE_LINES / 2), ...own.slice(-MESSAGE_LINES / 2)];}
    for (const text of own) lines.push({number, message, text});
  }
  if (lines.length > COMPARED_LINES) {partial = true; lines = lines.slice(-COMPARED_LINES);}
  return {partial, lines: lines.map(line => {
    const details = anchors(line.text);
    return {...line, details, keys: new Set(details.flatMap(detailKeys))};
  })};
}

/** Which lines of the person's messages to give back after a compaction.
 *
 * A line is dropped when it holds an exact detail found neither in the new
 * summary nor in the records the harness kept word for word. A message of
 * this session that was sent after the compaction, or kept by the harness, is
 * still in the context and is not compared. Two things keep the result from
 * misleading:
 *  - a detail the person later replaced is supposed to be gone. When every
 *    missing detail of a line comes up again, as a detail, in a later line
 *    that also has a detail of its own which the context does carry, the
 *    summary is up to date on that subject and the old line is left out
 *    (`superseded` counts those);
 *  - a dropped line brings along every later line that shares a detail with it
 *    which is rare among the person's lines, so that an earlier statement
 *    never stands without what was said on the subject afterwards.
 * Details are compared as details, never as substrings: an ordinary word
 * inside a code span would otherwise tie unrelated lines together.
 * `entries` holds a line by its place in `lines`: whether it is dropped itself
 * (`dropped`, with the later lines on its subject) and which dropped lines
 * brought it along. `details` counts the distinct details that are gone. */
export function droppedLines(items: UserItem[], state: Compaction) {
  // The same detail comes up in many lines; the context is searched for it once.
  const lacks = detailsMissingFrom(state.summary + '\n' + state.preservedText), looked = new Map<string, boolean>();
  const missing = (detail: string) => looked.get(detail) ?? (looked.set(detail, lacks(detail)), looked.get(detail)!);
  const inContext = (message: TranscriptEvent) => !message.other && (message.i > state.boundary || message.uuid !== undefined && state.preserved.has(message.uuid));
  const {lines, partial} = userLines(items);
  // Where each detail comes up, in order.
  const places = new Map<string, number[]>();
  lines.forEach(({keys}, at) => {for (const key of keys) {const found = places.get(key); if (found) found.push(at); else places.set(key, [at]);}});
  const carried: (string[] | undefined)[] = [];
  const has = (at: number) => carried[at] ??= lines[at]!.details.filter(detail => !missing(detail));
  const entries = new Map<number, {dropped: boolean; later: number[]; brought: number[]}>();
  const entry = (at: number) => entries.get(at) ?? entries.set(at, {dropped: false, later: [], brought: []}).get(at)!;
  const seen = new Set<string>(), gone = new Set<string>();
  let superseded = 0;
  lines.forEach((line, at) => {
    if (inContext(line.message) || seen.has(line.text)) return;
    const lost = line.details.filter(missing);
    if (!lost.length) return;
    seen.add(line.text);
    // Replaced: a later line names this detail and adds one of its own that the context has.
    const replaced = (detail: string) => detailKeys(detail).some(key => {
      const found = places.get(key) ?? [];
      let from = 0, to = found.length;
      while (from < to) {const middle = from + to >> 1; if (found[middle]! > at) to = middle; else from = middle + 1;}
      for (const other of found.slice(from, from + LATER_LOOKED_AT)) {
        if (lines[other]!.text !== line.text && has(other).some(own => !detailKeys(own).some(part => line.keys.has(part)))) return true;
      }
      return false;
    });
    if (lost.every(replaced)) {superseded++; return;}
    for (const detail of lost) gone.add(detail);
    const later = new Set<number>();
    for (const key of line.keys) {
      const found = places.get(key)!;
      if (key.length >= 3 && found.length <= RARE_LINES) for (const other of found) if (other > at && lines[other]!.text !== line.text) later.add(other);
    }
    Object.assign(entry(at), {dropped: true, later: [...later].sort((a, b) => a - b)});
    for (const other of later) entry(other).brought.push(at);
  });
  return {lines, entries, details: gone.size, superseded, partial};
}

export type FollowUp = {text: string; form: 'nothing-dropped' | 'dropped-lines' | 'dropped-lines+read-now' | 'dropped-pointer';
  details: number; dropped: number; later: number; superseded: number; shown: number};
/** What the first tool result after a compaction adds: the lines `droppedLines`
 * chose, word for word and in the order written, each later line on a subject
 * marked as the one that counts. Over budget, the newest lines are kept, an
 * earlier statement is never shown without the later ones on its subject, and
 * the policy decides whether the agent is told to read the rest. */
export function droppedContext(items: UserItem[], state: Compaction, path: string | null, {policy = recordPolicy, cap = INLINE_CAP}:
  {policy?: typeof recordPolicy; cap?: number} = {}): FollowUp {
  const HEAD = RECORD_MARK + 'Your context was compacted into a summary a moment ago. OpenCrawl compared that summary with what the user actually wrote. ';
  const hint = recallHint(items, 'compact'), full = recordText(items);
  const where = ' ' + record(full, path) + `; ${path ? 'read' : 'run'} it when you need a message in full.` + hint;
  const {lines, entries, details, superseded, partial} = droppedLines(items, state);
  const order = [...entries.keys()].sort((a, b) => a - b), dropped = order.filter(at => entries.get(at)!.dropped).length;
  const counts = {details, dropped, later: order.length - dropped, superseded};
  const compared = partial ? ' Very long messages were compared only in part.' : '';
  if (!order.length) {
    return {text: HEAD + `The summary kept every exact detail (names, numbers, code) of the user's ${plural(items.length, 'message')} that still holds.` + compared + where, form: 'nothing-dropped', ...counts, shown: 0};
  }
  const gone = `The summary no longer contains ${plural(details, 'exact detail')} of the user's messages.`;
  const intro = (left: number) => gone + ' The lines that hold them follow, word for word, in the order they were written'
    + (left ? ` (${plural(left, 'line')} left out for length; the complete record has ${left === 1 ? 'it' : 'them'})` : '')
    + '. Where the user returned to a subject later, the later line is included and marked, and it overrides the earlier one. Where the summary and these lines disagree, the lines are right.' + compared;
  const shownText = (at: number) => {const {text} = lines[at]!; return text.length > LINE_CAP ? text.slice(0, LINE_CAP) + ' [...]' : text;};
  // A line says where it is from, and what it is to the lines around it.
  const tag = (at: number, shown: Set<number>) => {
    const {number} = lines[at]!, {later, brought} = entries.get(at)!;
    if (brought.some(other => shown.has(other))) return `from message ${number}, written later on the same subject as a line above: where they differ, this one counts`;
    const again = [...new Set(later.map(other => lines[other]!.number))].filter(other => other !== number);
    return `from message ${number}` + (!later.length ? '' : `; the user came back to this later (${again.length ? `message ${again.join(', ')}` : 'in the same message'}), see below`);
  };
  const render = (shown: number[], tail: string) => {
    const inside = new Set(shown);
    let body = '', last = '';
    for (const at of shown) {
      // Consecutive lines that say the same about themselves share it.
      const own = tag(at, inside);
      body += (own === last ? '\n' : `\n\n[${own}]\n`) + shownText(at);
      last = own;
    }
    return HEAD + intro(order.length - shown.length) + body + '\n\n' + tail.trimStart();
  };
  /** The newest lines that fit, in order. */
  const fit = (tail: string) => {
    let budget = cap - render([], tail).length, shown: number[] = [];
    const inside = new Set<number>();
    // What a line will say about itself if the line that brought it along is shown too.
    const likely = (at: number) => tag(at, new Set(entries.get(at)!.brought));
    for (const at of [...order].reverse()) {
      const {dropped, later} = entries.get(at)!;
      // An earlier statement is not shown without the later ones on its subject.
      if (dropped && !later.every(other => inside.has(other))) continue;
      const cost = (shown.length && likely(shown[0]!) === likely(at) ? 0 : likely(at).length + 5) + 1 + shownText(at).length;
      if (cost > budget) continue;
      shown.unshift(at); inside.add(at); budget -= cost;
    }
    for (;;) {
      // A line that was only brought along goes when the line that brought it does.
      const kept = new Set(shown);
      shown = shown.filter(at => entries.get(at)!.dropped || entries.get(at)!.brought.some(other => kept.has(other)));
      if (shown.length < kept.size) continue;
      if (!shown.length || render(shown, tail).length <= cap) return shown;
      shown.shift();
    }
  };
  let tail = where, shown = fit(tail);
  if (shown.length < order.length && policy('compact', false).overflow === 'read-now') {
    // More was dropped than a hook may put in the context: the record has to be read.
    tail = ' More was dropped than fits here. ' + (path ? `Read the complete word-for-word record of the user's messages now, before you continue: ${path} (${full.length} characters).`
      : `Run \`opencrawl recall --user\` now, before you continue: it prints the complete word-for-word record of the user's messages (${full.length} characters).`) + hint;
    shown = fit(tail);
  }
  if (!shown.length) return {text: (HEAD + gone + compared + tail).slice(0, cap), form: 'dropped-pointer', ...counts, shown: 0};
  return {text: render(shown, tail), form: tail === where ? 'dropped-lines' : 'dropped-lines+read-now', ...counts, shown: shown.length};
}

/** The complete record of the person's messages, one private file per session,
 * replaced whole at every compaction. Returns its path, or null if it could
 * not be written: the context then points at `opencrawl recall --user`. */
export function writeRecord(directory: string, session: string, items: UserItem[], now = Date.now()): string | null {
  try {
    // Session IDs are UUIDs; anything else gets a name that is safe on every filesystem.
    const file = join(directory, 'records', (/^[\w.-]{1,120}$/.test(session) ? session : hash(session).slice(0, 32)) + '.md');
    atomicFile(file, recordHeading(items) + '\n\n' + recordText(items) + '\n');
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

export type CompactionReport = {compaction: number; at: string | null; details: number; inSummary: number; inContext: number; restoredByRecord: number; gone: string[]};
/** What each compaction of a session did to the person's own words: of the
 * exact details in what they had said by then, how many the summary has, how
 * many are still in the context (the summary, or a record the harness kept
 * word for word), how many the record put back before the next compaction,
 * and which are gone. Needs every kind, with `hook` and `boundary`. */
export function compactionReports(events: TranscriptEvent[]): CompactionReport[] {
  const boundaries = events.filter(event => event.kind === 'boundary');
  // The compaction a context belongs to is the last one before it; but SessionStart hooks run
  // before the harness writes the compaction down, so theirs can stand just ahead of its boundary.
  const compaction = (event: TranscriptEvent) => {
    const next = boundaries.findIndex(boundary => boundary.i > event.i);
    return next < 0 ? boundaries.length : event.hook === 'SessionStart' && boundaries[next]!.i - event.i <= 3 ? next + 1 : next;
  };
  const given = events.filter(event => event.kind === 'hook' && event.text.includes(RECORD_MARK)).map(event => ({number: compaction(event), text: event.text}));
  const reports: CompactionReport[] = [];
  for (let number = 1; number <= boundaries.length; number++) {
    const state = afterCompaction(events, number);
    if (!state) continue;
    const {anchors: details, lost: notInSummary} = drift(events.filter(event => event.i < state.boundary), state.summary);
    const lost = notInSummary.filter(detailsMissingFrom(state.preservedText));
    const gone = lost.filter(detailsMissingFrom(given.filter(one => one.number === number).map(one => one.text).join('\n')));
    reports.push({compaction: number, at: state.at, details, inSummary: details - notInSummary.length, inContext: details - lost.length, restoredByRecord: lost.length - gone.length, gone});
  }
  return reports;
}

export type DriftRecord = {ts: string; session: string | null; trigger: string | null; anchors: number; kept: number; lost: string[]; summaryChars: number};
/** One line per compaction, private to this user, and after it one line of
 * counts for what the record gave back. The file keeps its newest half when it
 * passes a mebibyte. */
export async function recordDrift(directory: string, record: DriftRecord) {
  const file = join(directory, DRIFT_FILE);
  await withSessionLock('capture:drift', async () => {
    appendFileSync(file, JSON.stringify(record) + '\n', {mode: 0o600});
    if (statSync(file).size <= DRIFT_MAX_BYTES) return;
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    atomicFile(file, lines.slice(Math.ceil(lines.length / 2)).join('\n') + '\n');
  }, 2000);
}

/** The latest measurement as counts, with what the record gave back after
 * that compaction if it has. What was lost is the person's own words, so
 * status reports how many, never which. */
export function latestDrift(directory: string) {
  let lines: string[];
  try {lines = readFileSync(join(directory, DRIFT_FILE), 'utf8').trimEnd().split('\n');} catch {return null;}
  let after: any;
  for (let at = lines.length - 1; at >= 0; at--) {
    try {
      const line = JSON.parse(lines[at]!), {ts, session, trigger, anchors, kept, summaryChars} = line;
      if (line.event === 'record') {after ??= line; continue;}
      if (typeof ts !== 'string' || !Number.isFinite(anchors) || !Number.isFinite(kept)) continue;
      const {form, details, dropped, later, superseded, shown} = after?.session === session && after.ts >= ts ? after : {} as any;
      return {ts, session, trigger, anchors, kept, lost: anchors - kept, summaryChars, ...(form ? {record: {form, details, dropped, later, superseded, shown}} : {})};
    } catch {}
  }
  return null;
}

type Enrollment = {config: {disabled?: boolean; exclusions?: CaptureExclusions; installedAt?: string} | null; directory: string; until?: number; now?: number; env?: NodeJS.ProcessEnv};
/** A Claude Code hook payload for a session this installation may act on. */
function claudeSession(payload: any, config: Enrollment['config']) {
  // Hooks already loaded by a running session outlive an uninstall.
  if (!config || config.disabled) return null;
  // Cursor-format runtimes also load Claude Code hook files; theirs is not a Claude Code transcript.
  if (!payload || typeof payload !== 'object' || typeof payload.cursor_version === 'string') return null;
  const transcript = payload.transcript_path;
  if (typeof transcript !== 'string' || !transcript.endsWith('.jsonl')) return null;
  const id = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : null;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined;
  // An excluded project or session is read back to its own agent, but nothing
  // about it is stored, and it neither gives nor gets the record of other sessions.
  return {transcript, id, name: id ?? basename(transcript, '.jsonl'), enrolled: enrolledSince(config), excluded: (session = id) => captureExcluded(config, {sessionId: session ?? undefined, cwd})};
}
/** What a hook puts in the context, and what `recall` prints, becomes part of
 * a session that capture uploads. Capture enrolls the sessions written to
 * since it was installed and imports earlier history only with approval, so
 * no other session from before that is read: the time capture was installed,
 * or never when it cannot be told. */
export const enrolledSince = (config: {installedAt?: string}) => {
  const since = Date.parse(config.installedAt ?? '');
  return Number.isFinite(since) ? since : Infinity;
};
/** The person's messages for a session's record: this session's and, unless it
 * is excluded, those of the project's other sessions within the policy's reach. */
function gather(session: NonNullable<ReturnType<typeof claudeSession>>, at: 'startup' | 'compact', {until, now, kinds = ['user', 'queued']}: {until: number; now: number; kinds?: readonly EventKind[]}) {
  const alone = session.excluded();
  const {sessions, omitted} = readProject(session.transcript, {kinds, otherKinds: ['user', 'queued'], until, now,
    reach: alone ? {sessions: 0, days: 0, megabytes: 0} : {...recordPolicy(at, true).reach, since: session.enrolled}, skip: id => session.excluded(id)});
  return {alone, sessions, omitted: alone ? 0 : omitted, events: sessions.find(one => !one.other)?.transcript.events ?? []};
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
  if (payload?.hook_event_name !== 'PostToolUse') return '';
  const session = claudeSession(payload, config), marker = session && pendingFile(directory, session, env);
  if (!session || !marker) return '';
  let since: number;
  try {since = Date.parse(JSON.parse(readFileSync(marker, 'utf8')).at);} catch {sweepPending(directory, now); return '';}
  const clear = () => {try {unlinkSync(marker);} catch {} sweepPending(directory, now);};
  if (!(now - since < PENDING_MS) || session.excluded()) {clear(); return '';}
  // A subagent's tool result belongs to the subagent's context, not to the agent
  // that was compacted. Its calls still end a comparison that has waited too long.
  if (typeof payload.agent_id === 'string') return '';
  try {
    const {sessions, events} = gather(session, 'compact', {until, now, kinds: [...EVENT_KINDS, 'boundary']});
    const state = afterCompaction(events), items = projectItems(sessions);
    // Not in the transcript yet, or still the compaction before this one: try at the next tool result.
    if (!state || state.at !== null && Date.parse(state.at) < since - 120_000) return '';
    clear();
    if (!items.length) return '';
    const {text, ...counts} = droppedContext(items, state, writeRecord(directory, session.name, items, now));
    // Counts only: what was dropped is the person's own words.
    try {appendFileSync(join(directory, DRIFT_FILE), JSON.stringify({ts: new Date(now).toISOString(), session: session.id, event: 'record', ...counts}) + '\n', {mode: 0o600});} catch {}
    return JSON.stringify({hookSpecificOutput: {hookEventName: 'PostToolUse', additionalContext: text}}) + '\n';
  } catch {
    // A comparison that cannot be made in time is given up, not tried again at every tool call.
    clear();
    return '';
  }
}

/** What a compaction hook prints for the harness: context for the agent, or
 * nothing. `until` is a Date.now() deadline for reading transcripts. */
export async function compactionHookOutput(payload: any, {config, directory, until = Infinity, now = Date.now(), env = process.env}: Enrollment): Promise<string> {
  if (payload?.hook_event_name === 'PostToolUse') return compactionFollowUp(payload, {config, directory, until, now, env});
  const session = claudeSession(payload, config);
  if (!session) return '';
  const context = (text: string) => JSON.stringify({hookSpecificOutput: {hookEventName: 'SessionStart', additionalContext: text}}) + '\n';
  if (payload.hook_event_name === 'SessionStart' && payload.source === 'startup') {
    // A new session knows nothing of what the person told the ones before it.
    const {alone, sessions, omitted} = gather(session, 'startup', {until, now});
    const items = projectItems(sessions.filter(one => one.other));
    if (alone || !items.length) return '';
    return context(startContext(items, writeRecord(directory, session.name, items, now), {at: 'startup', omitted}).text);
  }
  if (payload.hook_event_name === 'SessionStart' && payload.source === 'compact') {
    const {alone, sessions, omitted} = gather(session, 'compact', {until, now});
    const items = projectItems(sessions);
    if (!items.length) return '';
    const path = alone ? null : writeRecord(directory, session.name, items, now);
    const {text, dropped} = startContext(items, path, {omitted});
    // The comparison needs the summary, which the harness has not written yet.
    const marker = pendingFile(directory, session, env);
    if (marker) try {
      if (!path || !dropped) unlinkSync(marker);
      // Another hook may remove the directory as it empties: once more, then.
      else try {atomicJson(marker, {at: new Date(now).toISOString()});} catch {atomicJson(marker, {at: new Date(now).toISOString()});}
    } catch {}
    sweepPending(directory, now);
    return context(text);
  }
  if (payload.hook_event_name === 'PostCompact' && typeof payload.compact_summary === 'string' && payload.compact_summary && !session.excluded()) {
    const measured = drift(readTranscript(session.transcript, {kinds: ['user', 'queued'], until}).events, payload.compact_summary);
    await recordDrift(directory, {ts: new Date().toISOString(), session: session.id, trigger: typeof payload.trigger === 'string' ? payload.trigger : null,
      ...measured, lost: measured.lost.slice(0, DRIFT_MAX_LOST), summaryChars: payload.compact_summary.length});
  }
  return '';
}
