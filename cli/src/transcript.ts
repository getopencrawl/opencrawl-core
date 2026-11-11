import {openSync, readSync, closeSync, readdirSync, statSync} from 'node:fs';
import {join, dirname, basename, resolve} from 'node:path';
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
 *  hook        context a hook put into the conversation, such as the record
 *              this CLI gives back after a compaction
 *  boundary    a compaction happened here; `preserved` names the records the
 *              harness kept word for word
 * `hook` and `boundary` are read only when asked for. */
export type EventKind = 'user' | 'queued' | 'notice' | 'assistant' | 'tool_use' | 'tool_result' | 'summary' | 'hook' | 'boundary';
/** `uuid` is the transcript record's own. `omitted` counts the characters left
 * out of the middle of a long tool call or result. `hook` names the hook event
 * whose hook added a context. `session` numbers the session of the project an
 * event comes from when several are read together, and `other` marks one that
 * is not the current session. `unsent` marks a message the person sent that
 * its session ended without receiving. */
export type TranscriptEvent = {i: number; ts: string | null; kind: EventKind; text: string; uuid?: string; omitted?: number; preserved?: string[]; hook?: string;
  session?: number; other?: boolean; unsent?: boolean};
/** `unsent` holds what the person sent while the agent was busy and that was
 * neither handed to the agent nor taken back by the end of the transcript. */
export type Transcript = {events: TranscriptEvent[]; compactions: number; unsent: {ts: string | null; text: string}[]};
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
  const add = (ts: unknown, kind: EventKind, value: string): TranscriptEvent | undefined => {
    if (!want.has(kind)) return;
    let text = value.trim(), omitted: number | undefined;
    if (!text) return;
    if ((kind === 'tool_use' || kind === 'tool_result') && text.length > TOOL_HEAD + TOOL_TAIL) {
      omitted = text.length - TOOL_HEAD - TOOL_TAIL;
      text = text.slice(0, TOOL_HEAD) + TOOL_GAP + text.slice(-TOOL_TAIL);
    }
    events.push({i: events.length, ts: typeof ts === 'string' ? ts : null, kind, text, ...(uuid ? {uuid} : {}), ...(omitted ? {omitted} : {})});
    return events.at(-1);
  };
  const people = want.has('user') || want.has('queued') || want.has('notice') || want.has('summary');
  const tools = want.has('tool_use') || want.has('tool_result');
  const types = [...(people || tools ? ['user'] : []), ...(people || want.has('hook') ? ['attachment'] : []), ...(tools || want.has('assistant') ? ['assistant'] : []),
    ...(want.has('queued') ? ['queue-operation'] : []), 'system'];
  const relevant = new RegExp(`"type"\\s*:\\s*"(?:${types.join('|')})"`);
  const seen = new Set<string>(), recalls = new Set<string>();
  // What was queued while the agent was busy, what reached the agent, and what was taken out of the queue.
  const queued: {ts: string | null; text: string}[] = [], received = new Set<string>(), withdrawn: string[] = [];
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
      received.add(blocksText(content).trim());
      add(ts, person ? 'user' : 'notice', blocksText(content));
      if (Array.isArray(content)) for (const block of content) {
        if (block?.type === 'tool_result' && !recalls.has(block.tool_use_id)) add(ts, 'tool_result', resultText(block.content));
      }
    } else if (entry.type === 'attachment') {
      const attached = entry.attachment;
      if (attached?.type === 'hook_additional_context') {
        const added = add(ts, 'hook', Array.isArray(attached.content) ? attached.content.join('\n') : typeof attached.content === 'string' ? attached.content : '');
        if (added && typeof attached.hookEvent === 'string') added.hook = attached.hookEvent;
      }
      if (attached?.type !== 'queued_command') continue;
      const person = fromPerson(attached.origin) && (attached.commandMode === undefined || attached.commandMode === 'prompt');
      received.add(blocksText(attached.prompt).trim());
      if (attached.isMeta && person) continue;
      add(attached.timestamp ?? ts, person ? 'queued' : 'notice', blocksText(attached.prompt));
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
    } else if (entry.type === 'queue-operation' && typeof entry.content === 'string') {
      // Claude Code logs a message sent while the agent is busy when it is queued,
      // and again when it is removed from the queue, with the reason.
      if (entry.operation === 'enqueue') queued.push({ts: typeof ts === 'string' ? ts : null, text: entry.content.trim()});
      else withdrawn.push(entry.content);
    }
  }
  // Still queued when the transcript ends: sent, and never handed to the agent.
  // A message that reached the agent is in the transcript again, word for word,
  // on its own or as lines of a longer one; one that was removed for any other
  // reason (taken back for editing, dropped by a hook) is not the person's
  // standing word. The queue record does not say who sent an entry, so what
  // does not read as typed by a person is left out: an envelope such as a task
  // notification or another agent's message, and a slash command.
  const arrived = (text: string) => received.has(text) || [...received].some(whole => ('\n' + whole + '\n').includes('\n' + text + '\n'));
  const unsent = queued.filter(({text}, at) => text && !/^<[a-z][\w-]*[\s>]/.test(text) && !/^\/[\w:-]+(?:\s|$)/.test(text) && !arrived(text)
    && !withdrawn.some(taken => taken.includes(text)) && queued.findIndex(other => other.text === text) === at);
  return {events, compactions, unsent};
}

/** What the agent still has after a compaction (the newest unless `number`
 * counts one from the first): the summary, and the text of the records the
 * harness kept word for word. Null until the transcript shows that compaction:
 * the harness appends the boundary and its summary only after the compaction
 * hooks have run. Needs every kind, and `boundary`. */
export function afterCompaction(events: TranscriptEvent[], number?: number) {
  const boundaries = events.filter(event => event.kind === 'boundary');
  const boundary = boundaries[number === undefined ? boundaries.length - 1 : number - 1], next = boundary && boundaries[boundaries.indexOf(boundary) + 1];
  const summary = boundary && events.find(event => event.kind === 'summary' && event.i > boundary.i && (!next || event.i < next.i));
  if (!boundary || !summary) return null;
  const preserved = new Set(boundary.preserved);
  const kept = events.filter(event => event.i < boundary.i && event.uuid !== undefined && preserved.has(event.uuid) && !['summary', 'boundary', 'hook'].includes(event.kind));
  return {at: boundary.ts, boundary: boundary.i, until: next ? next.i : Infinity, summary: summary.text, preserved, preservedText: kept.map(event => event.text).join('\n')};
}

/** Everything the person said, oldest first. */
export const userMessages = (events: TranscriptEvent[]) => events.filter(event => event.kind === 'user' || event.kind === 'queued');

/** How far back the sessions of a project are read: at most this many other
 * sessions, written to within this many days, and this much transcript; and
 * with `since` (epoch milliseconds), none that was last written to before it. */
export type Reach = {sessions: number; days: number; megabytes: number; since?: number};
export type ProjectSession = {id: string; number: number; started: string | null; other: boolean; transcript: Transcript};

/** The other sessions of a project are the transcripts beside this one, the
 * most recently written first. Subagent transcripts live below their session
 * and are not sessions. */
function otherSessions(transcript: string) {
  const found: {id: string; file: string; written: number; size: number}[] = [];
  try {
    for (const name of readdirSync(dirname(transcript))) {
      if (!name.endsWith('.jsonl') || name === basename(transcript)) continue;
      try {
        const stat = statSync(join(dirname(transcript), name));
        if (stat.isFile() && stat.size) found.push({id: name.slice(0, -6), file: join(dirname(transcript), name), written: stat.mtimeMs, size: stat.size});
      } catch {}
    }
  } catch {}
  return found.sort((a, b) => b.written - a.written || a.id.localeCompare(b.id));
}

/** The sessions of one project read together, oldest first by when they began:
 * this one, and the others from the most recently written back as far as the
 * reach goes. Another session is one of the project's when the person said
 * something in it, whichever kinds are read from it, so that the sessions and
 * their numbers are the same for every reader. `skip` leaves a session out (an
 * excluded one). `omitted` counts the transcripts beyond the reach, and those
 * that could not be read in time. A message that a session never received
 * counts as said only once that session is over, so only in the other
 * sessions, where it becomes a `queued` event marked `unsent`. */
export function readProject(transcript: string, {kinds = EVENT_KINDS, otherKinds = kinds, reach, until = Infinity, now = Date.now(), skip = () => false}:
  {kinds?: readonly EventKind[]; otherKinds?: readonly EventKind[]; reach: Reach; until?: number; now?: number; skip?: (id: string) => boolean}) {
  const read: Omit<ProjectSession, 'number'>[] = [];
  const started = (events: TranscriptEvent[]) => events.find(event => event.ts)?.ts ?? null;
  // A new session has no transcript until its first message is written.
  try {
    const own = readTranscript(transcript, {kinds, until});
    if (own.events.length) read.push({id: basename(transcript, '.jsonl'), other: false, transcript: own, started: started(own.events)});
  } catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
  const others = (id: string, file: string) => {
    const session = readTranscript(file, {kinds: [...new Set<EventKind>([...otherKinds, 'user', 'queued'])], until});
    for (const {ts, text} of session.unsent) session.events.push({i: session.events.length, ts, kind: 'queued', text, unsent: true});
    const said = userMessages(session.events);
    if (!said.length) return false;
    read.push({id, other: true, started: started(said), transcript: {...session, events: session.events.filter(event => otherKinds.includes(event.kind))}});
    return true;
  };
  let omitted = 0, taken = 0, bytes = 0;
  for (const {id, file, written, size} of otherSessions(transcript)) {
    if (skip(id)) continue;
    // Past the count or the age, everything older is out; a transcript too large for what is left of the budget is passed over.
    if (taken >= reach.sessions || now - written > reach.days * 86_400_000 || written < (reach.since ?? 0) || bytes + size > reach.megabytes * 1024 * 1024) {omitted++; continue;}
    bytes += size;
    try {if (others(id, file)) taken++;} catch {omitted++;}
  }
  read.sort((a, b) => (a.started ?? '').localeCompare(b.started ?? '') || a.id.localeCompare(b.id));
  return {sessions: read.map((session, at): ProjectSession => ({...session, number: at + 1})), omitted};
}

export type UserItem = {number: number; message: TranscriptEvent; count: number; started?: string | null};
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
/** The record of several sessions: each session's messages in turn, numbered
 * through, every message carrying the number of its session. */
export function projectItems(sessions: ProjectSession[]): UserItem[] {
  // A project whose only session is this one has the plain record of a session.
  if (sessions.length === 1 && !sessions[0]!.other) return userItems(sessions[0]!.transcript.events);
  return sessions.flatMap(({number, other, started, transcript}) => userItems(transcript.events)
    .map(item => ({...item, started, message: {...item.message, session: number, other}}))).map((item, index) => ({...item, number: index + 1}));
}
/** Whether a record spans sessions: its heading, its layout and what is said about it follow from that. */
export const spansSessions = (items: UserItem[]) => items.some(item => item.message.session !== undefined);
export const recordHeading = (items: UserItem[]) => spansSessions(items)
  ? '# Every message the user sent in this project, session by session, word for word, oldest first'
  : '# Every message the user sent in this session, word for word, oldest first';
export function recordText(items: UserItem[]) {
  const parts: string[] = [];
  let session: number | undefined;
  for (const {number, message, count, started} of items) {
    if (message.session !== session) {session = message.session; parts.push(`## Session ${session}${started ? ` (started ${started})` : ''}`);}
    parts.push(`[message ${number}${message.ts ? `, sent ${message.ts}` : ''}${count > 1 ? `, repeated ${count} times, latest shown` : ''}`
      + `${message.unsent ? ', sent while the agent was busy and never handed to it before that session ended' : ''}]\n${message.text}`);
  }
  return parts.join('\n\n');
}

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
