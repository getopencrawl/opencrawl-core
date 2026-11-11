import {basename} from 'node:path';
import {CliError} from './oauth.ts';
import {findTranscript, readTranscript, readProject, projectItems, recordText, recordHeading, EVENT_KINDS, TOOL_HEAD, TOOL_GAP, type EventKind, type TranscriptEvent, type Reach} from './transcript.ts';
import {recordPolicy, compactionReports, enrolledSince} from './capture/compaction.ts';
import {captureExcluded} from './capture/policy.ts';
import {readCaptureConfig} from './capture/runtime.ts';

/** `opencrawl recall`: the transcripts of this session and of the project's
 * other sessions, searched on this machine and quoted verbatim. No sign-in and
 * no network: they are the harness's local files, whether or not capture is
 * installed. `opencrawl drift` reads the same file to say what each
 * compaction of the session did to the person's own words. */
const KINDS: Record<string, EventKind[]> = {
  user: ['user', 'queued'], assistant: ['assistant'], tool: ['tool_use', 'tool_result'],
  // A compaction summary is a paraphrase of the rest; quoting it would launder it into evidence.
  all: ['user', 'queued', 'notice', 'assistant', 'tool_use', 'tool_result'],
};
const SPEAKER: Partial<Record<EventKind, string>> = {
  user: 'the user said', queued: 'the user said (while you were working)', notice: 'an automated message or another agent said',
  assistant: 'you wrote', tool_use: 'you ran', tool_result: 'a tool returned',
};
/** In another session of the project the agent was not this one. */
const ELSEWHERE: Partial<Record<EventKind, string>> = {...SPEAKER, queued: 'the user said (while the agent was working)', assistant: 'the agent wrote', tool_use: 'the agent ran'};
const speaker = (event: TranscriptEvent) => event.unsent ? 'the user said (never handed to the agent)' : (event.other ? ELSEWHERE : SPEAKER)[event.kind] ?? event.kind;
/** What the person said outranks everything else, then the agent's own words. */
const WEIGHT: Partial<Record<EventKind, number>> = {user: 1.6, queued: 1.6, assistant: 1.2};
/** Passages are cut from at most this much of one message. */
const MAX_EVENT_CHARS = 60_000;

/** `session` numbers the session a passage comes from when it is not the current one. */
export type Passage = {timestamp: string | null; kind: EventKind; speaker: string; offset: number; text: string; session?: number};
export type Recall = {query: string; terms: string[]; matched: number; passages: Passage[]};

/** `thumb_width`, `2024.06` and `v3.8.1-rc2` are searched whole and as their parts. */
export function queryTerms(query: string): string[] {
  const text = query.toLowerCase();
  return [...new Set([...(text.match(/[\p{L}\p{N}]+(?:[_.-][\p{L}\p{N}]+)+/gu) ?? []), ...(text.match(/[\p{L}\p{N}]+/gu) ?? [])])].filter(term => term.length > 1);
}

function wordCharacter(text: string, at: number) {
  if (at < 0 || at >= text.length) return false;
  const code = text.charCodeAt(at);
  if (code < 128) return code >= 48 && code <= 57 || code >= 97 && code <= 122 || code >= 65 && code <= 90;
  return code >= 0xd800 && code <= 0xdfff || /[\p{L}\p{N}]/u.test(text[at]!);
}
/** Where `term` stands as a whole word or identifier, not inside a longer one. */
function occurrences(text: string, term: string, end: number): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(term); at >= 0 && at + term.length <= end; at = text.indexOf(term, at + term.length)) {
    if (!wordCharacter(text, at - 1) && !wordCharacter(text, at + term.length)) found.push(at);
  }
  return found;
}

/** BM25 over passages: a short message is one passage, a long one overlapping
 * windows. Only the query's terms are counted, so nothing is tokenised. */
export function rankPassages(events: TranscriptEvent[], query: string, {limit = 8, chars = 1200}: {limit?: number; chars?: number} = {}): Recall {
  const terms = queryTerms(query);
  if (!terms.length) throw new CliError('INVALID_USAGE', 'Give recall a few distinctive words: opencrawl recall "words".', 64);
  const step = chars - Math.min(200, Math.floor(chars / 4));
  type Hit = {event: TranscriptEvent; offset: number; length: number; counts: number[]; score: number};
  const hits: Hit[] = [], documents = terms.map(() => 0);
  let passages = 0, characters = 0;
  for (const event of events) {
    const whole = event.text.length <= chars * 1.3;
    const windows = whole ? 1 : Math.ceil(Math.min(event.text.length, MAX_EVENT_CHARS) / step);
    const length = (window: number) => whole ? event.text.length : Math.min(chars, event.text.length - window * step);
    passages += windows;
    for (let window = 0; window < windows; window++) characters += length(window);
    const lower = event.text.toLowerCase(), end = whole ? lower.length : (windows - 1) * step + chars;
    const found = new Map<number, number[]>();
    terms.forEach((term, index) => {
      for (const at of occurrences(lower, term, end)) {
        // Windows overlap, so one occurrence can lie wholly inside two of them.
        for (let window = whole ? 0 : Math.max(0, Math.ceil((at + term.length - chars) / step)); window < windows && window * step <= at; window++) {
          let counts = found.get(window);
          if (!counts) found.set(window, counts = terms.map(() => 0));
          counts[index]!++;
        }
      }
    });
    for (const [window, counts] of found) {
      counts.forEach((count, index) => {if (count) documents[index]!++;});
      hits.push({event, offset: window * step, length: length(window), counts, score: 0});
    }
  }
  const average = characters / Math.max(1, passages);
  for (const hit of hits) {
    hit.counts.forEach((count, index) => {
      if (!count) return;
      const rarity = Math.log(1 + (passages - documents[index]! + 0.5) / (documents[index]! + 0.5));
      hit.score += rarity * count * 2.2 / (count + 1.2 * (0.25 + 0.75 * hit.length / average));
    });
    hit.score *= WEIGHT[hit.event.kind] ?? 1;
  }
  const best = [...hits].sort((a, b) => b.score - a.score).slice(0, limit).sort((a, b) => a.event.i - b.event.i || a.offset - b.offset);
  return {query, terms, matched: hits.length, passages: best.map(({event, offset, length}) => ({
    timestamp: event.ts, kind: event.kind, speaker: speaker(event), ...(event.other ? {session: event.session} : {}),
    // Report where the passage starts in the original, before its middle was left out.
    offset: event.omitted && offset > TOOL_HEAD ? Math.max(TOOL_HEAD, offset - TOOL_GAP.length) + event.omitted : offset,
    text: event.text.slice(offset, offset + length),
  }))};
}

function bounded(value: unknown, name: string, fallback: number, min: number, max: number) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (typeof value !== 'string' || !/^\d+$/.test(value) || number < min || number > max) throw new CliError('INVALID_USAGE', `Use --${name} ${min}..${max}.`, 64);
  return number;
}

/** The sessions a command reads: the named session alone, else the current one
 * with the project's other sessions as far as the record reaches. What recall
 * prints becomes part of the transcript of the session that ran it. Where
 * capture is installed it therefore keeps to what the record keeps to: a
 * session excluded from capture is not read for another session and reads no
 * other, and no other session from before capture was installed is read. */
function sessionsOf(values: Record<string, unknown>, kinds: readonly EventKind[]) {
  if (values.session !== undefined && typeof values.session !== 'string') throw new CliError('INVALID_USAGE', 'Pass one --session ID.', 64);
  const transcript = findTranscript({session: values.session}), session = basename(transcript, '.jsonl'), alone: Reach = {sessions: 0, days: 0, megabytes: 0};
  let reach = values.session === undefined ? recordPolicy('compact', true).reach : alone, skip = (_id: string) => false;
  if (reach !== alone) try {
    const config = readCaptureConfig(), cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    if (config && !config.disabled) {
      skip = id => captureExcluded(config, {sessionId: id, cwd});
      reach = skip(session) ? alone : {...reach, since: enrolledSince(config)};
    }
  } catch {reach = alone;}
  return {session, transcript, sessions: readProject(transcript, {kinds, reach, skip}).sessions};
}

export function recallCommand(words: string[], values: Record<string, unknown>) {
  const query = words.join(' ').trim();
  if (values.user) {
    // The complete record of what the person asked, as the hooks write it.
    if (query || values.kind !== undefined || values.limit !== undefined || values.chars !== undefined) throw new CliError('INVALID_USAGE', 'Use opencrawl recall --user on its own, or opencrawl recall "words".', 64);
    const {session, transcript, sessions} = sessionsOf(values, KINDS.user!), items = projectItems(sessions);
    return {session, transcript, sessions: sessions.length, messages: items.length, record: items.length ? recordHeading(items) + '\n\n' + recordText(items) : ''};
  }
  if (!query) throw new CliError('INVALID_USAGE', 'Give recall a few distinctive words: opencrawl recall "words".', 64);
  const kind = values.kind ?? 'all';
  if (typeof kind !== 'string' || !Object.hasOwn(KINDS, kind)) throw new CliError('INVALID_USAGE', 'Use --kind user, assistant, tool or all.', 64);
  const limit = bounded(values.limit, 'limit', 8, 1, 50), chars = bounded(values.chars, 'chars', 1200, 200, 8000);
  const {session, transcript, sessions} = sessionsOf(values, KINDS[kind]!);
  // One list, oldest session first; an event of another session says which.
  const events: TranscriptEvent[] = [];
  for (const {number, other, transcript: {events: own}} of sessions) for (const event of own) events.push({...event, i: events.length, ...(sessions.length > 1 ? {session: number, other} : {})});
  return {session, transcript, sessions: sessions.length, compactions: sessions.find(one => !one.other)?.transcript.compactions ?? 0, ...rankPassages(events, query, {limit, chars})};
}

export function formatRecall(data: ReturnType<typeof recallCommand>) {
  const where = data.sessions > 1 ? `the transcripts of this project's ${data.sessions} sessions` : "this session's transcript";
  if ('record' in data) return data.record || `opencrawl recall: the user has sent no messages in ${where}.`;
  if (!data.matched) return `opencrawl recall: nothing in ${where} matched "${data.query}". Try fewer or more distinctive words.`;
  return [`opencrawl recall: ${data.matched} passage${data.matched === 1 ? '' : 's'} matched in ${where}; showing ${data.passages.length}, oldest first, verbatim. A later statement overrides an earlier one.`,
    ...data.passages.map(passage => `\n--- [${passage.timestamp ?? '?'} | ${passage.session === undefined ? '' : `session ${passage.session} of this project | `}${passage.speaker}`
      + `${passage.offset ? ` | from character ${passage.offset}` : ''}] ---\n${passage.text}`)].join('\n');
}

/** `opencrawl drift`: for each compaction of the session, what became of the
 * exact details in the person's messages. */
export function driftCommand(words: string[], values: Record<string, unknown>) {
  if (words.length) throw new CliError('INVALID_USAGE', 'Use opencrawl drift [--session ID] [--json].', 64);
  if (values.session !== undefined && typeof values.session !== 'string') throw new CliError('INVALID_USAGE', 'Pass one --session ID.', 64);
  const show = bounded(values.limit, 'limit', 12, 1, 200), transcript = findTranscript({session: values.session});
  return {session: basename(transcript, '.jsonl'), transcript, show, compactions: compactionReports(readTranscript(transcript, {kinds: [...EVENT_KINDS, 'hook', 'boundary']}).events)};
}

export function formatDrift({compactions, show}: Pick<ReturnType<typeof driftCommand>, 'compactions' | 'show'>) {
  if (!compactions.length) return 'opencrawl drift: this session has not been compacted yet; nothing has drifted.';
  const columns = ['compaction', 'details', 'in summary', 'in context', 'restored', 'gone'];
  const row = (cells: (string | number)[]) => cells.map((cell, at) => String(cell).padStart(columns[at]!.length)).join('  ');
  const last = compactions.at(-1)!.gone;
  return ["opencrawl drift: exact details of the user's messages (code, numbers, names) after each compaction", row(columns),
    ...compactions.map(one => row([one.compaction, one.details, one.inSummary, one.inContext, one.restoredByRecord, one.gone.length])), '',
    ...(last.length ? [`Gone from the context after the latest compaction (${last.length}): ${last.slice(0, show).map(detail => '`' + detail + '`').join(', ')}${last.length > show ? ' ...' : ''}`,
      'Run `opencrawl recall "<one of them>"` to read the passage that holds it.'] : ['Nothing the user wrote is missing from the context after the latest compaction.'])].join('\n');
}
