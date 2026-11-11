import {test, expect} from 'bun:test';
import {mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {readTranscript, readProject, projectItems, userItems, recordText, recordHeading, afterCompaction, findTranscript, EVENT_KINDS, TOOL_HEAD, TOOL_TAIL, TOOL_GAP} from '../src/transcript.ts';
import {transcriptFixture, projectDirectory} from './fixtures/transcript.ts';

function scratch<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'opencrawl-transcript-'));
  try {return run(dir);} finally {rmSync(dir, {recursive: true, force: true});}
}

test('every transcript entry kind becomes the right verbatim event', () => scratch(dir => {
  const t = transcriptFixture();
  t.user('  Ship the exporter. The batch size is 275.  ');
  t.user([{type: 'text', text: 'Second part,'}, {type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'AAAA'}}, {type: 'text', text: 'in two blocks.'}]);
  t.user('Caveat: the messages below were generated while running local commands.', {isMeta: true});
  t.user('<task-notification>\nbackground shell finished</task-notification>', {origin: {kind: 'task-notification', producer: 'session-task'}});
  t.user('Typed on the keyboard of another host.', {origin: {kind: 'human'}});
  t.queued('Use the staging bucket instead.');
  t.queued([{type: 'text', text: 'And keep the old flag.'}]);
  t.queued('<task-notification>\nmonitor fired</task-notification>', {commandMode: 'task-notification', origin: {kind: 'task-notification'}});
  t.queued('<agent-message from="worker">done</agent-message>', {origin: {kind: 'peer', from: 'worker'}, isMeta: true});
  t.queued('ls -la', {commandMode: 'bash'});
  t.assistant('I will ship the exporter.');
  t.tool('Bash', {command: 'git status --short'}, ' M src/export.ts');
  t.tool('Write', {file_path: 'src/export.ts', content: 'export const batch = 275;'}, [{type: 'text', text: 'File written.'}, {type: 'tool_reference', content: 'nested text'}]);
  t.tool('Agent', {description: 'review', prompt: 'Review the exporter for off-by-one errors.'}, 'No errors found.');
  const kept = t.assistant('A message the harness keeps after compaction.');
  const {boundary} = t.compaction('The user asked for an exporter with a batch size.', [kept.uuid]);
  t.hook('OpenCrawl verbatim record. The batch size is 275.');
  t.raw('{"type":"user","message":{"content":"this line is not valid JSON"');
  t.raw(JSON.stringify({type: 'file-history-snapshot', snapshot: {note: 'ignored'}}));
  const file = t.write(join(dir, 'session.jsonl'), {partial: '{"type":"user","message":{"content":"still being wri'});

  const {events, compactions, unsent} = readTranscript(file);
  expect(unsent).toEqual([]);
  expect(events.map(event => [event.kind, event.text])).toEqual([
    ['user', 'Ship the exporter. The batch size is 275.'],
    ['user', 'Second part,\nin two blocks.'],
    ['notice', '<task-notification>\nbackground shell finished</task-notification>'],
    ['user', 'Typed on the keyboard of another host.'],
    ['queued', 'Use the staging bucket instead.'],
    ['queued', 'And keep the old flag.'],
    ['notice', '<task-notification>\nmonitor fired</task-notification>'],
    ['notice', '<agent-message from="worker">done</agent-message>'],
    ['notice', 'ls -la'],
    ['assistant', 'I will ship the exporter.'],
    ['tool_use', 'Bash: git status --short'],
    ['tool_result', 'M src/export.ts'],
    ['tool_use', 'Write: src/export.ts\nexport const batch = 275;'],
    ['tool_result', 'File written.\nnested text'],
    ['tool_use', 'Agent: review\nReview the exporter for off-by-one errors.'],
    ['tool_result', 'No errors found.'],
    ['assistant', 'A message the harness keeps after compaction.'],
    ['summary', 'The user asked for an exporter with a batch size.'],
  ]);
  expect(compactions).toBe(1);
  expect(events.map(event => event.i)).toEqual(events.map((_, index) => index));
  expect(events[0]).toMatchObject({ts: '2026-01-05T08:00:01.000Z', uuid: '00000000-0000-4000-8000-000000000001'});
  // A queued message carries the time it was sent when the attachment has one.
  const timed = transcriptFixture();
  timed.queued('sent earlier', {timestamp: '2026-01-05T07:59:00.000Z'});
  expect(readTranscript(timed.write(join(dir, 'timed.jsonl'))).events[0]!.ts).toBe('2026-01-05T07:59:00.000Z');

  // Only what is asked for is read; a boundary and what a hook added are events only on request.
  expect(readTranscript(file, {kinds: ['user', 'queued']}).events.map(event => event.kind)).toEqual(['user', 'user', 'user', 'queued', 'queued']);
  expect(readTranscript(file, {kinds: ['assistant']}).events).toHaveLength(2);
  const all = readTranscript(file, {kinds: [...EVENT_KINDS, 'hook', 'boundary']}).events;
  expect(all.filter(event => event.kind === 'boundary')).toEqual([{i: 17, ts: boundary.timestamp, kind: 'boundary', text: '', uuid: boundary.uuid, preserved: [kept.uuid]}]);
  expect(all.at(-1)).toMatchObject({i: 19, kind: 'hook', text: 'OpenCrawl verbatim record. The batch size is 275.'});
  expect(afterCompaction(all)).toEqual({at: boundary.timestamp, boundary: 17, until: Infinity, summary: 'The user asked for an exporter with a batch size.',
    preserved: new Set([kept.uuid]), preservedText: 'A message the harness keeps after compaction.'});
  expect(afterCompaction(all, 1)).toEqual(afterCompaction(all));
  expect(afterCompaction(all, 2)).toBeNull();
  // Until the harness has appended the summary there is nothing to compare with.
  expect(afterCompaction(all.filter(event => event.kind !== 'summary'))).toBeNull();
  expect(afterCompaction(readTranscript(file).events)).toBeNull();
}));

test('a message sent while the agent was busy and still queued when the transcript ends was never received', () => scratch(dir => {
  const t = transcriptFixture();
  t.user('Start the migration.');
  // Delivered at the next turn, delivered mid-turn, and delivered with other content blocks.
  t.queue('enqueue', 'Use the blue theme.'); t.queue('dequeue'); t.user('Use the blue theme.');
  t.queue('enqueue', 'Also add a legend.'); t.queued([{type: 'text', text: 'Also add a legend.'}]); t.queue('remove', 'Also add a legend.', {reason: 'absorbed_mid_turn'});
  // Two sent in a row and handed over as one message.
  t.queue('enqueue', 'Rename the column.'); t.queue('enqueue', 'Then rerun the report.'); t.queue('dequeue'); t.queue('dequeue'); t.user('Rename the column.\nThen rerun the report.');
  // Not the person's words to the agent: a background task's report and another agent's message waiting in the same queue, and a command.
  t.queue('enqueue', '<task-notification>\nbuild finished</task-notification>');
  t.queue('enqueue', '<agent-message from="reviewer">Looks fine to me.</agent-message>');
  t.queue('enqueue', '/usage'); t.queue('dequeue');
  t.queue('enqueue', '/review the open change');
  // Taken back for editing, and dropped by a hook: neither is the person's standing word.
  t.queue('enqueue', 'Delete the old tables.'); t.queue('popAll', 'Delete the old tables.');
  t.queue('enqueue', 'Print the key.'); t.queue('remove', 'Print the key.', {reason: 'dropped_by_hook'});
  // Still waiting when the session ended, the second time as well.
  const waiting = t.queue('enqueue', '  Keep the legacy endpoint until March.  ');
  t.queue('enqueue', 'Keep the legacy endpoint until March.');
  t.queue('enqueue');
  const file = t.write(join(dir, 'session.jsonl'));
  expect(readTranscript(file).unsent).toEqual([{ts: waiting.timestamp, text: 'Keep the legacy endpoint until March.'}]);
  expect(readTranscript(file, {kinds: ['user', 'queued']}).unsent).toHaveLength(1);
  expect(readTranscript(file, {kinds: ['assistant']}).unsent).toEqual([]);
  expect(readTranscript(file).events.map(event => event.text)).toEqual(['Start the migration.', 'Use the blue theme.', 'Also add a legend.', 'Rename the column.\nThen rerun the report.']);
  // A path at the start of a message is not a command.
  const path = transcriptFixture();
  path.user('Start.'); path.queue('enqueue', '/etc/hosts needs an entry for the staging host.');
  expect(readTranscript(path.write(join(dir, 'path.jsonl'))).unsent.map(one => one.text)).toEqual(['/etc/hosts needs an entry for the staging host.']);
}));

test('the sessions of a project are read together, oldest first, as far as the reach goes', () => scratch(dir => {
  const project = join(dir, 'claude', 'projects', 'p'), day = 86_400_000, now = Date.parse('2026-03-01T00:00:00Z');
  const session = (id: string, started: string, written: number, build: (t: ReturnType<typeof transcriptFixture>) => void) => {
    const t = transcriptFixture(id, Date.parse(started));
    build(t);
    const file = t.write(join(project, id + '.jsonl'));
    utimesSync(file, new Date(written), new Date(written));
    return file;
  };
  session('aaaa', '2026-02-20T09:00:00Z', now - 9 * day, t => {t.user('First session: build the importer.'); t.assistant('Building.'); t.queue('enqueue', 'And log every skipped row.');});
  session('bbbb', '2026-02-25T09:00:00Z', now - 4 * day, t => {t.user('Second session: add a dry run.'); t.tool('Bash', {command: 'ls'}, 'importer.ts');});
  const current = session('cccc', '2026-02-28T09:00:00Z', now, t => {t.user('Third session: write the docs.'); t.queue('enqueue', 'Mention the dry run.');});
  session('dddd', '2026-01-10T09:00:00Z', now - 50 * day, t => {t.user('Long ago: choose a name.');});
  writeFileSync(join(project, 'empty.jsonl'), '');
  // A transcript in which the person said nothing is not one of the project's sessions.
  session('ffff', '2026-02-26T09:00:00Z', now - 3 * day, t => {t.user('<task-notification>\nnightly job finished</task-notification>', {origin: {kind: 'task-notification'}}); t.assistant('Noted.');});
  mkdirSync(join(project, 'cccc', 'subagents'), {recursive: true}); writeFileSync(join(project, 'cccc', 'subagents', 'agent-a1.jsonl'), JSON.stringify({type: 'user', message: {content: 'subagent prompt'}}) + '\n');
  const reach = {sessions: 10, days: 30, megabytes: 64};

  const {sessions, omitted} = readProject(current, {kinds: ['user', 'queued'], reach, now});
  expect(sessions.map(({id, number, other, started}) => [id, number, other, started])).toEqual([
    ['aaaa', 1, true, '2026-02-20T09:00:01.000Z'], ['bbbb', 2, true, '2026-02-25T09:00:01.000Z'], ['cccc', 3, false, '2026-02-28T09:00:01.000Z']]);
  // The session written to fifty days ago is beyond the reach; an empty transcript is no session.
  expect(omitted).toBe(1);
  // What an earlier session never received is part of what was said in it; in the current one it is still on its way.
  expect(sessions[0]!.transcript.events.map(event => [event.kind, event.text, event.unsent ?? false])).toEqual([['user', 'First session: build the importer.', false], ['queued', 'And log every skipped row.', true]]);
  expect(sessions[2]!.transcript.events.map(event => event.text)).toEqual(['Third session: write the docs.']);
  const items = projectItems(sessions);
  expect(items.map(({number, message}) => [number, message.session, message.other, message.text])).toEqual([
    [1, 1, true, 'First session: build the importer.'], [2, 1, true, 'And log every skipped row.'], [3, 2, true, 'Second session: add a dry run.'], [4, 3, false, 'Third session: write the docs.']]);
  expect(recordHeading(items)).toBe('# Every message the user sent in this project, session by session, word for word, oldest first');
  expect(recordText(items)).toBe([
    '## Session 1 (started 2026-02-20T09:00:01.000Z)', '[message 1, sent 2026-02-20T09:00:01.000Z]\nFirst session: build the importer.',
    '[message 2, sent 2026-02-20T09:00:03.000Z, sent while the agent was busy and never handed to it before that session ended]\nAnd log every skipped row.',
    '## Session 2 (started 2026-02-25T09:00:01.000Z)', '[message 3, sent 2026-02-25T09:00:01.000Z]\nSecond session: add a dry run.',
    '## Session 3 (started 2026-02-28T09:00:01.000Z)', '[message 4, sent 2026-02-28T09:00:01.000Z]\nThird session: write the docs.'].join('\n\n'));

  // The other sessions can be read for less than the current one, left out one by one, or not at all.
  const mixed = readProject(current, {kinds: EVENT_KINDS, otherKinds: ['user', 'queued'], reach, now, skip: id => id === 'aaaa'});
  expect(mixed.sessions.map(one => [one.id, one.number, one.transcript.events.map(event => event.kind)])).toEqual([['bbbb', 1, ['user']], ['cccc', 2, ['user']]]);
  expect(readProject(current, {reach: {...reach, sessions: 1}, now}).sessions.map(one => one.id)).toEqual(['bbbb', 'cccc']);
  // The sessions and their numbers do not depend on what is read from them.
  expect(readProject(current, {kinds: ['tool_use', 'tool_result'], reach, now}).sessions.map(one => [one.id, one.number, one.transcript.events.map(event => event.kind)])).toEqual([
    ['aaaa', 1, []], ['bbbb', 2, ['tool_use', 'tool_result']]]);
  expect(readProject(current, {kinds: ['assistant'], reach, now}).sessions.map(one => [one.id, one.number, one.transcript.events.length])).toEqual([['aaaa', 1, 1], ['bbbb', 2, 0]]);
  expect(readProject(current, {reach: {...reach, days: 3}, now}).sessions.map(one => one.id)).toEqual(['cccc']);
  expect(readProject(current, {reach: {...reach, megabytes: 0}, now})).toMatchObject({sessions: [{id: 'cccc', number: 1, other: false}], omitted: 4});
  // A project whose only session is this one keeps the plain record of a session.
  const alone = projectItems(readProject(current, {reach: {sessions: 0, days: 0, megabytes: 0}, now}).sessions);
  expect(alone.map(({message}) => message.session)).toEqual([undefined]);
  expect(recordHeading(alone)).toBe('# Every message the user sent in this session, word for word, oldest first');
  expect(recordText(alone)).toBe('[message 1, sent 2026-02-28T09:00:01.000Z]\nThird session: write the docs.');
  // A new session has no transcript yet: the project is its earlier sessions.
  const fresh = readProject(join(project, 'eeee.jsonl'), {reach, now});
  expect(fresh.sessions.map(({id, other}) => [id, other])).toEqual([['aaaa', true], ['bbbb', true], ['cccc', true]]);
  expect(projectItems(fresh.sessions.slice(1, 2)).map(({number, message}) => [number, message.session])).toEqual([[1, 2]]);
}));

test('a message written over several lines keeps every block once', () => scratch(dir => {
  const t = transcriptFixture();
  t.user('Run both checks.');
  // Parallel tool calls of one message: same message ID, one block per line.
  const first = t.call('Bash', {command: 'npm test'}, 'msg_parallel'), second = t.call('Bash', {command: 'npm run lint'}, 'msg_parallel');
  t.assistant('Both are running.', 'msg_parallel');
  t.assistant('Both are running.', 'msg_parallel');
  t.lines.push({...first.entry, uuid: 'repeat'});
  t.result(first.toolId, 'tests pass');
  t.result(second.toolId, 'lint clean');
  const events = readTranscript(t.write(join(dir, 'session.jsonl'))).events;
  expect(events.map(event => event.text)).toEqual(['Run both checks.', 'Bash: npm test', 'Bash: npm run lint', 'Both are running.', 'tests pass', 'lint clean']);
}));

test('long tool output keeps its start and end, and earlier recall output is not read again', () => scratch(dir => {
  const t = transcriptFixture();
  const output = 'START ' + 'x'.repeat(TOOL_HEAD + 50_000) + ' END';
  t.tool('Bash', {command: 'cat build.log'}, output);
  t.tool('Bash', {command: 'cd /repo && opencrawl recall "batch size" --limit 3'}, 'opencrawl recall: 1 passage matched\nThe batch size is 275.');
  t.tool('Bash', {command: 'grep -rn "opencrawl recall" docs'}, 'docs/session-capture.md: opencrawl recall');
  const events = readTranscript(t.write(join(dir, 'session.jsonl'))).events;
  expect(events.map(event => event.kind)).toEqual(['tool_use', 'tool_result', 'tool_use', 'tool_result']);
  const [, long, , grep] = events;
  expect(long!.text).toHaveLength(TOOL_HEAD + TOOL_GAP.length + TOOL_TAIL);
  expect(long!.text).toStartWith('START xxx'); expect(long!.text).toEndWith('xxx END'); expect(long!.text).toContain(TOOL_GAP);
  expect(long!.omitted).toBe(output.length - TOOL_HEAD - TOOL_TAIL);
  expect(grep!.text).toBe('docs/session-capture.md: opencrawl recall');
}));

test('repeated automated messages collapse to the newest in the numbered record', () => {
  const t = transcriptFixture();
  t.user('Build the importer.\nIt must accept CSV.');
  t.user('[nightly check] the build is red as of the first run of the day: 3 failures');
  t.user('Rename the flag to --dry-run.');
  t.user('[nightly check] the build is red as of the first run of the day: 1 failure');
  t.queued('[nightly check] the build is red as of the first run of the day: 0 failures');
  const events = t.lines.map((line, i) => ({i, ts: line.timestamp, kind: line.type === 'user' ? 'user' as const : 'queued' as const, text: line.type === 'user' ? line.message.content : line.attachment.prompt}));
  const items = userItems(events);
  expect(items.map(item => [item.number, item.count, item.message.text.split('\n')[0]])).toEqual([
    [1, 1, 'Build the importer.'], [2, 1, 'Rename the flag to --dry-run.'], [3, 3, '[nightly check] the build is red as of the first run of the day: 0 failures'],
  ]);
  expect(recordText(items)).toBe([
    '[message 1, sent 2026-01-05T08:00:01.000Z]\nBuild the importer.\nIt must accept CSV.',
    '[message 2, sent 2026-01-05T08:00:03.000Z]\nRename the flag to --dry-run.',
    '[message 3, sent 2026-01-05T08:00:05.000Z, repeated 3 times, latest shown]\n[nightly check] the build is red as of the first run of the day: 0 failures',
  ].join('\n\n'));
  expect(userItems([])).toEqual([]);
});

test('the session transcript is the named one, else the running session, else the newest of this project only', () => scratch(dir => {
  const root = join(dir, 'claude'), projects = join(root, 'projects');
  const cwd = resolve(dir, 'work', 'repo'), here = join(projects, projectDirectory(cwd)), elsewhere = join(projects, projectDirectory(resolve(dir, 'other')));
  const write = (directory: string, name: string, seconds: number) => {
    const file = transcriptFixture(name).write(join(directory, name + '.jsonl'));
    utimesSync(file, seconds, seconds);
    return file;
  };
  const older = write(here, 'aaaaaaaa-0000-4000-8000-000000000001', 1_000), newer = write(here, 'aaaaaaaa-0000-4000-8000-000000000002', 2_000);
  const foreign = write(elsewhere, 'bbbbbbbb-0000-4000-8000-000000000003', 3_000);
  // Subagent transcripts live below the session and are never the session.
  write(join(here, 'aaaaaaaa-0000-4000-8000-000000000002', 'subagents'), 'agent-a1', 4_000);
  const env = {CLAUDE_CONFIG_DIR: root};
  expect(findTranscript({cwd, env})).toBe(newer);
  // The agent may have changed into a subdirectory of the project it started in.
  mkdirSync(join(cwd, 'cli', 'src'), {recursive: true});
  expect(findTranscript({cwd: join(cwd, 'cli', 'src'), env})).toBe(newer);
  expect(findTranscript({cwd, env: {...env, CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-0000-4000-8000-000000000001'}})).toBe(older);
  expect(findTranscript({cwd, env: {...env, CLAUDE_SESSION_ID: 'bbbbbbbb-0000-4000-8000-000000000003', CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-0000-4000-8000-000000000001'}})).toBe(foreign);
  expect(findTranscript({cwd, env: {...env, CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-0000-4000-8000-000000000001'}, session: 'aaaaaaaa-0000-4000-8000-000000000002'})).toBe(newer);
  // An ID the environment names but that has no transcript here falls back to the project.
  expect(findTranscript({cwd, env: {...env, CLAUDE_CODE_SESSION_ID: 'cccccccc-0000-4000-8000-000000000009'}})).toBe(newer);
  expect(() => findTranscript({cwd, env, session: 'cccccccc-0000-4000-8000-000000000009'})).toThrow('No Claude Code transcript for session');
  expect(() => findTranscript({cwd, env, session: '../../etc/passwd'})).toThrow('Invalid session ID');
  // Never another project's conversation, however recent.
  expect(() => findTranscript({cwd: resolve(dir, 'unrelated'), env})).toThrow('No Claude Code transcript for this project');
  expect(() => findTranscript({cwd, env: {...env, CODEX_THREAD_ID: 'thread'}})).toThrow('Codex session');
  expect(findTranscript({cwd, env: {...env, CODEX_THREAD_ID: 'thread'}, session: 'aaaaaaaa-0000-4000-8000-000000000001'})).toBe(older);
}));
