import {basename} from 'node:path';
import {CliError} from './oauth.ts';
import {findTranscript, readTranscript, userItems, recordText, RECORD_HEADING, TOOL_HEAD, TOOL_GAP, type EventKind, type TranscriptEvent} from './transcript.ts';

/** `opencrawl recall`: the agent's own session transcript, searched on this
 * machine and quoted verbatim. No sign-in and no network: the transcript is
 * the harness's local file, whether or not capture is installed. */
const KINDS: Record<string, EventKind[]> = {
  user: ['user', 'queued'], assistant: ['assistant'], tool: ['tool_use', 'tool_result'],
  // A compaction summary is a paraphrase of the rest; quoting it would launder it into evidence.
  all: ['user', 'queued', 'notice', 'assistant', 'tool_use', 'tool_result'],
};
const SPEAKER: Partial<Record<EventKind, string>> = {
  user: 'the user said', queued: 'the user said (while you were working)', notice: 'an automated message or another agent said',
  assistant: 'you wrote', tool_use: 'you ran', tool_result: 'a tool returned',
};
/** What the person said outranks everything else, then the agent's own words. */
const WEIGHT: Partial<Record<EventKind, number>> = {user: 1.6, queued: 1.6, assistant: 1.2};
/** Passages are cut from at most this much of one message. */
const MAX_EVENT_CHARS = 60_000;

export type Passage = {timestamp: string | null; kind: EventKind; speaker: string; offset: number; text: string};
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
    timestamp: event.ts, kind: event.kind, speaker: SPEAKER[event.kind] ?? event.kind,
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

export function recallCommand(words: string[], values: Record<string, unknown>) {
  const query = words.join(' ').trim();
  if (values.session !== undefined && typeof values.session !== 'string') throw new CliError('INVALID_USAGE', 'Pass one --session ID.', 64);
  if (values.user) {
    // The complete record of what the person asked, as the compaction hook writes it.
    if (query || values.kind !== undefined || values.limit !== undefined || values.chars !== undefined) throw new CliError('INVALID_USAGE', 'Use opencrawl recall --user on its own, or opencrawl recall "words".', 64);
    const transcript = findTranscript({session: values.session});
    const items = userItems(readTranscript(transcript, {kinds: KINDS.user!}).events);
    return {session: basename(transcript, '.jsonl'), transcript, messages: items.length, record: recordText(items)};
  }
  if (!query) throw new CliError('INVALID_USAGE', 'Give recall a few distinctive words: opencrawl recall "words".', 64);
  const kind = values.kind ?? 'all';
  if (typeof kind !== 'string' || !Object.hasOwn(KINDS, kind)) throw new CliError('INVALID_USAGE', 'Use --kind user, assistant, tool or all.', 64);
  const limit = bounded(values.limit, 'limit', 8, 1, 50), chars = bounded(values.chars, 'chars', 1200, 200, 8000);
  const transcript = findTranscript({session: values.session});
  const {events, compactions} = readTranscript(transcript, {kinds: KINDS[kind]!});
  return {session: basename(transcript, '.jsonl'), transcript, compactions, ...rankPassages(events, query, {limit, chars})};
}

export function formatRecall(data: ReturnType<typeof recallCommand>) {
  if ('record' in data) return data.messages ? `${RECORD_HEADING}\n\n${data.record}` : "opencrawl recall: the user has sent no messages in this session's transcript.";
  if (!data.matched) return `opencrawl recall: nothing in this session's transcript matched "${data.query}". Try fewer or more distinctive words.`;
  return [`opencrawl recall: ${data.matched} passage${data.matched === 1 ? '' : 's'} matched in this session's transcript; showing ${data.passages.length}, oldest first, verbatim. A later statement overrides an earlier one.`,
    ...data.passages.map(passage => `\n--- [${passage.timestamp ?? '?'} | ${passage.speaker}${passage.offset ? ` | from character ${passage.offset}` : ''}] ---\n${passage.text}`)].join('\n');
}
