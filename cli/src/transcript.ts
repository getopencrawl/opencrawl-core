import {openSync, readSync, closeSync, readdirSync, statSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {homedir} from 'node:os';
import {CliError} from './oauth.ts';

/** A Claude Code session transcript (JSONL) as a flat list of verbatim events.
 *  user        a message the person typed
 *  queued      a message the person sent while the agent was working
 *  notice      a user-role message that is not the person's: a background task
 *              report, another agent, a scheduled prompt
 *  assistant   text the agent wrote
 *  tool_use    a tool call the agent made (command, path, written content)
 *  tool_result what a tool returned
 *  summary     a compaction summary: lossy, never evidence
 *  boundary    a compaction happened here; `preserved` names the records the
 *              harness kept word for word. Only read when asked for. */
export type EventKind = 'user' | 'queued' | 'notice' | 'assistant' | 'tool_use' | 'tool_result' | 'summary' | 'boundary';
/** `uuid` is the transcript record's own. `omitted` counts the characters left
 * out of the middle of a long tool call or result. */
export type TranscriptEvent = {i: number; ts: string | null; kind: EventKind; text: string; uuid?: string; omitted?: number; preserved?: string[]};
export type Transcript = {events: TranscriptEvent[]; compactions: number};
export const EVENT_KINDS: readonly EventKind[] = ['user', 'queued', 'notice', 'assistant', 'tool_use', 'tool_result', 'summary'];

/** A long tool call or result keeps this much of its start and of its end:
 * what matters in output (an error, a test summary) is usually at one of the two. */
export const TOOL_HEAD = 16_000, TOOL_TAIL = 4_000;
export const TOOL_GAP = '\n[… the middle of this output is not kept …]\n';

const blocksText = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '';
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => block?.type === 'text' && typeof block.text === 'string' ? block.text : typeof block?.content === 'string' ? block.content : null)
    .filter(text => text !== null).join('\n');
}
/** Claude Code stamps where a user-role message came from. Typed input has no
 * stamp, or `human`; anything else was written by a program or another agent. */
const fromPerson = (origin: any) => origin === undefined || origin === null || origin?.kind === 'human';
function toolCall(block: any): string {
  const input = block.input && typeof block.input === 'object' ? block.input : {};
  const text = (key: string) => typeof input[key] === 'string' || typeof input[key] === 'number' ? String(input[key]) : '';
  let body = text('command');
  if (!body) {
    body = ['file_path', 'path', 'pattern', 'query', 'url', 'skill', 'description'].map(text).filter(Boolean).join(' ');
    for (const key of ['prompt', 'content', 'new_string', 'message', 'plan']) if (text(key)) body += '\n' + text(key);
  }
  return `${block.name}: ${body}`;
}
/** Output of an earlier `opencrawl recall` only repeats passages already in the transcript. */
const isRecall = (block: any) => typeof block.input?.command === 'string' && /(?:^|[;&|(\n])\s*(?:\S*[\\/])?opencrawl(?:\.cjs)?\s+recall\b/.test(block.input.command);

/** Complete lines of a file, one at a time, without holding the file in memory.
 * A line is valid only until the next one is requested. */
function* fileLines(path: string, until: number): Generator<Buffer> {
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.allocUnsafe(1 << 20);
    let carry: Buffer[] = [];
    for (;;) {
      if (Date.now() > until) throw new CliError('TRANSCRIPT_DEADLINE', 'Reading the transcript took too long.');
      const size = readSync(fd, chunk, 0, chunk.length, null);
      if (!size) break;
      const bytes = chunk.subarray(0, size);
      let start = 0;
      for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, start)) {
        const piece = bytes.subarray(start, end);
        start = end + 1;
        if (carry.length) {carry.push(piece); yield Buffer.concat(carry); carry = [];}
        else yield piece;
      }
      // The chunk is reused, so an unfinished line is copied out of it.
      if (start < size) carry.push(Buffer.from(bytes.subarray(start)));
    }
    // A last line without a newline is complete or still being written; one
    // that does not parse is dropped by the caller.
    if (carry.length) yield Buffer.concat(carry);
  } finally {closeSync(fd);}
}

/** Read only what `kinds` asks for. Lines that cannot hold a wanted event are
 * never parsed: most of a long transcript is tool output. `until` is a
 * Date.now() deadline for callers that a harness is waiting on. */
export function readTranscript(path: string, {kinds = EVENT_KINDS, until = Infinity}: {kinds?: readonly EventKind[]; until?: number} = {}): Transcript {
  const want = new Set(kinds), events: TranscriptEvent[] = [];
  let uuid: string | undefined;
  const add = (ts: unknown, kind: EventKind, value: string) => {
    if (!want.has(kind)) return;
    let text = value.trim(), omitted: number | undefined;
    if (!text) return;
    if ((kind === 'tool_use' || kind === 'tool_result') && text.length > TOOL_HEAD + TOOL_TAIL) {
      omitted = text.length - TOOL_HEAD - TOOL_TAIL;
      text = text.slice(0, TOOL_HEAD) + TOOL_GAP + text.slice(-TOOL_TAIL);
    }
    events.push({i: events.length, ts: typeof ts === 'string' ? ts : null, kind, text, ...(uuid ? {uuid} : {}), ...(omitted ? {omitted} : {})});
  };
  const people = want.has('user') || want.has('queued') || want.has('notice') || want.has('summary');
  const tools = want.has('tool_use') || want.has('tool_result');
  const types = [...(people || tools ? ['user'] : []), ...(people ? ['attachment'] : []), ...(tools || want.has('assistant') ? ['assistant'] : []), 'system'];
  const relevant = new RegExp(`"type"\\s*:\\s*"(?:${types.join('|')})"`);
  const seen = new Set<string>(), recalls = new Set<string>();
  let compactions = 0;
  for (const bytes of fileLines(path, until)) {
    const line = bytes.toString('utf8');
    if (!relevant.test(line)) continue;
    // A tool result with no text block holds nothing a person wrote.
    if (!tools && /"type"\s*:\s*"tool_result"/.test(line) && !/"type"\s*:\s*"text"/.test(line)) continue;
    let entry: any;
    try {entry = JSON.parse(line);} catch {continue;}
    if (!entry || typeof entry !== 'object') continue;
    const ts = entry.timestamp;
    uuid = typeof entry.uuid === 'string' ? entry.uuid : undefined;
    if (entry.type === 'user') {
      const content = entry.message?.content;
      if (entry.isCompactSummary) {add(ts, 'summary', blocksText(content)); continue;}
      const person = fromPerson(entry.origin);
      // An unattributed meta entry is the harness talking: a caveat, an expansion.
      if (entry.isMeta && person) continue;
      add(ts, person ? 'user' : 'notice', blocksText(content));
      if (Array.isArray(content)) for (const block of content) {
        if (block?.type === 'tool_result' && !recalls.has(block.tool_use_id)) add(ts, 'tool_result', resultText(block.content));
      }
    } else if (entry.type === 'attachment') {
      const queued = entry.attachment;
      if (queued?.type !== 'queued_command') continue;
      const person = fromPerson(queued.origin) && (queued.commandMode === undefined || queued.commandMode === 'prompt');
      if (queued.isMeta && person) continue;
      add(queued.timestamp ?? ts, person ? 'queued' : 'notice', blocksText(queued.prompt));
    } else if (entry.type === 'assistant') {
      const content = entry.message?.content, id = entry.message?.id;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const text = block?.type === 'text' && typeof block.text === 'string' ? block.text : undefined;
        if (text === undefined && block?.type !== 'tool_use') continue;
        // One message is written over several lines, a block at a time in
        // current versions. Only a block already seen in that message repeats.
        if (id !== undefined) {
          const key = `${id}\n${text === undefined ? 'tool_use\n' + block.id : 'text\n' + text}`;
          if (seen.has(key)) continue;
          seen.add(key);
        }
        if (text !== undefined) add(ts, 'assistant', text);
        else if (isRecall(block)) {if (typeof block.id === 'string') recalls.add(block.id);}
        else add(ts, 'tool_use', toolCall(block));
      }
    } else if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      compactions++;
      const kept = entry.compactMetadata?.preservedMessages, uuids = Array.isArray(kept?.allUuids) && kept.allUuids.length ? kept.allUuids : kept?.uuids;
      if (want.has('boundary')) events.push({i: events.length, ts: typeof ts === 'string' ? ts : null, kind: 'boundary', text: '', ...(uuid ? {uuid} : {}),
        preserved: Array.isArray(uuids) ? uuids.filter((id: unknown) => typeof id === 'string') : []});
    }
  }
  return {events, compactions};
}

/** What the agent still has after the newest compaction: the summary, and the
 * text of the records the harness kept word for word. Null until the transcript
 * shows that compaction: the harness appends the boundary and its summary only
 * after the compaction hooks have run. Needs every kind, and `boundary`. */
export function afterCompaction(events: TranscriptEvent[]) {
  let boundary: TranscriptEvent | undefined;
  for (const event of events) if (event.kind === 'boundary') boundary = event;
  const summary = boundary && events.find(event => event.kind === 'summary' && event.i > boundary!.i);
  if (!boundary || !summary) return null;
  const preserved = new Set(boundary.preserved);
  const kept = events.filter(event => event.i < boundary!.i && event.uuid !== undefined && preserved.has(event.uuid) && event.kind !== 'summary' && event.kind !== 'boundary');
  return {at: boundary.ts, boundary: boundary.i, summary: summary.text, preserved, preservedText: kept.map(event => event.text).join('\n')};
}

/** Everything the person said, oldest first. */
export const userMessages = (events: TranscriptEvent[]) => events.filter(event => event.kind === 'user' || event.kind === 'queued');

export type UserItem = {number: number; message: TranscriptEvent; count: number};
/** The person's messages as a numbered record. A sender that repeats itself (a
 * scheduler, a notifier) opens every message the same way: those collapse to
 * the newest, with the number of times it was sent. */
export function userItems(events: TranscriptEvent[]): UserItem[] {
  const latest = new Map<string, {message: TranscriptEvent; count: number}>();
  for (const message of userMessages(events)) {
    const opening = message.text.slice(0, 48);
    latest.set(opening, {message, count: (latest.get(opening)?.count ?? 0) + 1});
  }
  return [...latest.values()].sort((a, b) => a.message.i - b.message.i).map((item, index) => ({number: index + 1, ...item}));
}
export const RECORD_HEADING = '# Every message the user sent in this session, word for word, oldest first';
export const recordText = (items: UserItem[]) => items.map(({number, message, count}) =>
  `[message ${number}${message.ts ? `, sent ${message.ts}` : ''}${count > 1 ? `, repeated ${count} times, latest shown` : ''}]\n${message.text}`).join('\n\n');

/** Claude Code names a project directory after its working directory, with
 * every character that is not a letter or digit replaced by a dash. */
const projectDirectory = (cwd: string) => resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');

/** The transcript of this session: the named one, else the one this command
 * runs inside, else the newest for this project. Never another project's:
 * that would hand an agent somebody else's conversation as its own. */
export function findTranscript({session, cwd = process.cwd(), env = process.env}: {session?: string; cwd?: string; env?: NodeJS.ProcessEnv} = {}): string {
  const projects = join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  const id = session ?? (env.CLAUDE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID);
  if (id) {
    if (!/^[\w.:-]{1,200}$/.test(id)) throw new CliError('INVALID_USAGE', 'Invalid session ID.', 64);
    let directories: string[] = [];
    try {directories = readdirSync(projects);} catch {}
    for (const directory of directories) {
      const file = join(projects, directory, id + '.jsonl');
      try {if (statSync(file).isFile()) return file;} catch {}
    }
    if (session !== undefined) throw new CliError('TRANSCRIPT_NOT_FOUND', `No Claude Code transcript for session ${id} under ${projects}.`);
  } else if (session !== undefined) throw new CliError('INVALID_USAGE', 'Invalid session ID.', 64);
  // Codex keeps its own transcripts; a Claude Code one here is some other session.
  else if (env.CODEX_THREAD_ID) throw new CliError('TRANSCRIPT_NOT_FOUND', 'opencrawl recall reads Claude Code transcripts; this is a Codex session. Pass --session <id> to search a Claude Code session.');
  // The agent may have changed directory inside the project it started in.
  for (let directory = resolve(env.CLAUDE_PROJECT_DIR || cwd); ; directory = dirname(directory)) {
    const project = join(projects, projectDirectory(directory));
    let newest: {file: string; mtime: number} | undefined, names: string[] = [];
    try {names = readdirSync(project);} catch {}
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        const stat = statSync(join(project, name));
        if (stat.isFile() && (!newest || stat.mtimeMs > newest.mtime)) newest = {file: join(project, name), mtime: stat.mtimeMs};
      } catch {}
    }
    if (newest) return newest.file;
    if (dirname(directory) === directory) break;
  }
  throw new CliError('TRANSCRIPT_NOT_FOUND', `No Claude Code transcript for this project under ${projects}. Pass --session <id>.`);
}
