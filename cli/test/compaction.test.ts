import {test, expect} from 'bun:test';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync, statSync, utimesSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {anchors, detailsMissingFrom, drift, startContext, droppedContext, afterCompactionPolicy, writeRecord, recordDrift, latestDrift,
  compactionHookOutput, compactionFollowUp, INLINE_CAP} from '../src/capture/compaction.ts';
import {installCapture, uninstallCapture, upgradeCaptureHooks} from '../src/capture/install.ts';
import {captureDir, captureStatus, readCaptureConfig, HOOK_MODE} from '../src/capture/runtime.ts';
import {purgeLocalCapture} from '../src/capture/controls.ts';
import {skillFiles, startupInstruction} from '../src/skills.ts';
import {participationInstructions} from '../src/board.ts';
import {userItems, recordText, RECORD_HEADING, type TranscriptEvent} from '../src/transcript.ts';
import {transcriptFixture} from './fixtures/transcript.ts';

const cli = resolve(import.meta.dir, '../src/cli.ts');
const RECALL = ' For anything else from before the compaction that you need exactly (your own decisions and the reasons for them, values, error messages, command output), '
  + 'run `opencrawl recall "<a few distinctive words>"`: it searches the full transcript of this session and prints the matching passages verbatim.';
const said = (i: number, text: string, uuid = `u${i}`): TranscriptEvent => ({i, ts: `2026-01-05T08:${String(i).padStart(2, '0')}:00.000Z`, kind: 'user', text, uuid});

/** A private configuration home; `enroll` leaves it as collect install does, without a server. */
async function home(run: (f: {dir: string; env: NodeJS.ProcessEnv; enroll: (extra?: object) => void}) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), 'opencrawl-compaction-')), saved = {...process.env};
  try {
    Object.assign(process.env, {OPENCRAWL_CONFIG_HOME: join(dir, 'config'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), CODEX_HOME: join(dir, 'codex'), OPENCRAWL_NO_UPDATE: '1', HOME: dir, USERPROFILE: dir});
    for (const name of ['OPENCRAWL_SESSIONS_TOKEN', 'OPENCRAWL_TOKEN', 'OPENCRAWL_API_URL', 'CLAUDE_CODE_REMOTE', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID']) delete process.env[name];
    const enroll = (extra: object = {}) => {
      mkdirSync(captureDir(), {recursive: true});
      writeFileSync(join(captureDir(), 'config.json'), JSON.stringify({schemaVersion: 1, hookMode: HOOK_MODE, api: 'http://127.0.0.1:9', installationId: 'fixture', owner: {tenantId: 'team', userId: 'person'},
        installedAt: new Date().toISOString(), roots: {'claude-code': join(dir, 'claude'), codex: join(dir, 'codex')}, harnesses: ['claude-code'], command: [process.execPath], ...extra}) + '\n');
    };
    await run({dir, env: process.env, enroll});
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved); rmSync(dir, {recursive: true, force: true});
  }
}
/** Run a command the way a harness runs a hook: the payload on stdin, the answer on stdout. */
async function spawned(command: string[], payload: unknown, env: NodeJS.ProcessEnv) {
  const child = Bun.spawn(command, {env, stdin: new Blob([typeof payload === 'string' ? payload : JSON.stringify(payload)]), stdout: 'pipe', stderr: 'pipe'});
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return {exit, stdout, stderr};
}
const hook = (payload: unknown, env: NodeJS.ProcessEnv) => spawned(['bun', cli, 'collect', 'compaction'], payload, env);

test('exact details are code spans, numbers, versions and marked identifiers; ordinary hyphenated words are not', () => {
  expect(anchors('Set `thumb_width` to 240 and `x` to 1; keep 7070 open, limit 2,400,000, v3.8.1-rc2 by 2024.06, pi is 3.14; keep well-known and long-running jobs, '
    + 'gallery-v2, Content-Type, x-request-id, cache_size, a `two words` span and an unclosed `span'))
    .toEqual(['2,400,000', '2024.06', '240', '3.14', '3.8.1-rc2', '7070', 'Content-Type', 'cache_size', 'gallery-v2', 'thumb_width', 'two words']);
  // A version keeps a pre-release tag, not the word that happens to follow a hyphen.
  expect(anchors('the 2.1.321-era build, 1.2.3-beta and 10.0.0.1:8080')).toEqual(['1.2.3', '10.0.0.1', '2.1.321', '8080']);
  expect(anchors('first `a b` here\nsecond `c d` there')).toEqual(['a b', 'c d']);
  expect(anchors('nothing exact here, on 2 lines of 10 words')).toEqual([]);
  // A number is the same number with or without thousands separators.
  const missing = detailsMissingFrom('We allow 2400000 uploads over 12,000 files on 7070.');
  expect(['2,400,000', '12000', '7070', '7,250', '315', 'thumb_width'].map(missing)).toEqual([false, false, false, true, true, true]);
});

test('the drift meter counts the exact details a summary kept, and never writes a credential down', () => {
  const token = 'ghp_' + 'a'.repeat(36);
  const events = [said(0, 'Use `thumb_width` 240 and answer on 7070.'), {...said(1, `Push with \`${token}\` and password: hunter2-Example.`), kind: 'queued' as const},
    {...said(2, 'The summary of an earlier compaction mentions 77777.'), kind: 'summary' as const}, {...said(3, 'I chose 5555.'), kind: 'assistant' as const}];
  expect(drift(events, 'The user wants thumb_width 240.')).toEqual({anchors: 3, kept: 2, lost: ['7070']});
  expect(drift(events, 'Nothing useful.')).toEqual({anchors: 3, kept: 0, lost: ['240', '7070', 'thumb_width']});
  expect(drift([], 'Anything.')).toEqual({anchors: 0, kept: 0, lost: []});
});

test('after a compaction the whole record goes into the context when it fits', () => {
  const items = userItems([said(0, 'Build the importer.\nIt must accept CSV.'), said(1, 'Rename the flag to --dry-run.')]);
  expect(afterCompactionPolicy({wholeFits: true})).toEqual({start: 'whole', dropped: false});
  expect(startContext(items, '/state/records/s.md')).toEqual({dropped: false, text:
    'OpenCrawl verbatim record. Your context was just compacted into a summary, and summaries lose detail. Below is every message the user sent in this session, word for word, oldest first. '
    + 'Where the summary and these messages disagree, these messages are right, and a later message overrides an earlier one.' + RECALL
    + '\n\n[message 1, sent 2026-01-05T08:00:00.000Z]\nBuild the importer.\nIt must accept CSV.\n\n[message 2, sent 2026-01-05T08:01:00.000Z]\nRename the flag to --dry-run.'});
});

test('a record too long for the context becomes an index and a pointer, with no claim about the summary', () => {
  const body = (n: number) => `Requirement ${n}: the exporter\n` + Array.from({length: 12}, (_, line) => `- detail line ${line} of requirement ${n}, with enough words to take up room in the record`).join('\n');
  const items = userItems(Array.from({length: 14}, (_, n) => said(n, body(n))));
  const size = recordText(items).length;
  expect(size).toBeGreaterThan(INLINE_CAP);
  expect(afterCompactionPolicy({wholeFits: false})).toEqual({start: 'pointer', dropped: true});
  const {text, dropped} = startContext(items, '/state/records/s.md');
  expect(dropped).toBe(true);
  expect(text.length).toBeLessThanOrEqual(INLINE_CAP);
  expect(text).toBe('OpenCrawl verbatim record. Your context was just compacted into a summary, and summaries lose detail. The user has sent 14 messages in this session:\n'
    + items.map(({number, message}) => `[message ${number}, ${message.ts}] Requirement ${number - 1}: the exporter`).join('\n')
    + `\n\nThe complete word-for-word record of the user's messages (${size} characters) is in the file /state/records/s.md. `
    + 'Read it when you need a message in full; where the summary disagrees with it, the file is right.' + RECALL);
  expect(text).not.toMatch(/kept|dropped/);
  // The policy is one function: the same plumbing can tell the agent to read the record at once.
  const now = startContext(items, '/state/records/s.md', () => ({start: 'read-now', dropped: false}));
  expect(now.dropped).toBe(false);
  expect(now.text).toContain('is in the file /state/records/s.md. Read that file in full now, before you continue: it is the authority on what was asked, and where the summary disagrees with it, the file is right. A later message overrides an earlier one.');
  // With no file (an excluded project, a read-only disk) the record is one command away.
  expect(startContext(items, null).text).toContain(`(${size} characters) is printed by \`opencrawl recall --user\`. Run it when you need a message in full; where the summary disagrees with it, that record is right.`);
  // However many messages: the first and the newest are listed, and the cap holds.
  const many = userItems(Array.from({length: 400}, (_, n) => said(n, `Instruction number ${n} about the ${n % 2 ? 'importer' : 'exporter'} and its many settings, written out at some length`)));
  const long = startContext(many, '/state/records/s.md').text;
  expect(long.length).toBeLessThanOrEqual(INLINE_CAP);
  expect(long).toContain('\n[message 1, '); expect(long).toContain('\n[message 400, '); expect(long).not.toContain('\n[message 2, ');
  expect(long).toMatch(/\n\(\d+ earlier messages not listed here; the complete record has them\)\n\nThe complete word-for-word record/);
  for (const cap of [200, 500, 1_000]) expect(startContext(many, '/state/records/s.md', undefined, cap).text.length).toBeLessThanOrEqual(cap);
});

test('the first tool result after a compaction shows the lines whose details are in neither the summary nor what the harness kept', () => {
  const items = userItems([
    said(0, 'Build the gallery service.\n- Use `thumb_width` of 240.\n- The bucket is gallery-v2.\n- Keep long-running jobs off the main thread.'),
    said(1, 'Accept at most 2,400,000 uploads.\n- Use `thumb_width` of 240.\n- The bucket is gallery-v2.'),
    said(2, 'Ship release 3.8.1-rc2 behind flag 7070.'),
    said(4, 'Sent after the compaction: use flag 7171.'),
  ]);
  const state = {at: null, boundary: 3, summary: 'The user wants a gallery service with thumb_width 240 that accepts 2400000 uploads.', preserved: new Set(['u2']), preservedText: 'Ship release 3.8.1-rc2 behind flag 7070.'};
  const where = ` The complete word-for-word record of the user's messages (${recordText(items).length} characters) is in the file /state/records/s.md; read it when you need a message in full.` + RECALL;
  const head = 'OpenCrawl verbatim record. Your context was compacted into a summary a moment ago. OpenCrawl compared that summary with what the user actually wrote. ';
  // gallery-v2 is the one detail that is gone; its line is shown once although two messages have it.
  expect(droppedContext(items, state, '/state/records/s.md')).toBe(head + "The summary dropped or changed 1 exact detail of the user's messages. The lines that hold them follow, word for word, oldest first. "
    + 'Where the summary and these lines disagree, the lines are right, and a later message overrides an earlier one.\n\n[from message 1]\n- The bucket is gallery-v2.\n\n' + where.trimStart());
  // A message the harness kept, or one sent after the boundary, is still in the context.
  expect(droppedContext(items, {...state, summary: 'Nothing exact.', preservedText: ''}, '/state/records/s.md')).not.toMatch(/3\.8\.1-rc2|flag 7171/);
  expect(droppedContext(items, {...state, preserved: new Set<string>(), preservedText: ''}, '/state/records/s.md')).toContain('\n\n[from message 3]\nShip release 3.8.1-rc2 behind flag 7070.\n\n');
  expect(droppedContext(items, {...state, summary: state.summary + ' Bucket: gallery-v2.'}, '/state/records/s.md')).toBe(head + "The summary kept every exact detail (names, numbers, code) of the user's 4 messages." + where);
  expect(droppedContext(items, state, null)).toEndWith('is printed by `opencrawl recall --user`; run it when you need a message in full.' + RECALL);

  // Over budget the newest lines are kept, the count left out is stated, and the cap holds.
  const lines = (n: number) => Array.from({length: 150}, (_, line) => `- setting_${n}_${line} must be ${1000 + n * 150 + line} for the service to start cleanly`).join('\n');
  const big = userItems([said(0, lines(0)), said(1, lines(1))]);
  const text = droppedContext(big, {at: null, boundary: 2, summary: 'The user listed many settings.', preserved: new Set<string>(), preservedText: ''}, '/state/records/s.md');
  expect(text.length).toBeLessThanOrEqual(INLINE_CAP);
  expect(text.length).toBeGreaterThan(INLINE_CAP - 200);
  const left = Number(/\((\d+) older lines left out for length; the complete record has them\)/.exec(text)![1]);
  expect(left).toBeGreaterThan(100);
  expect(text).toContain(`The summary dropped or changed 600 exact details of the user's messages.`);
  expect(text).toContain('\n- setting_1_149 must be 1299 for the service to start cleanly\n\nThe complete word-for-word record');
  expect(text).not.toContain('setting_0_0 ');
  expect(text.match(/\[from message 2\]/g)).toHaveLength(1);
  expect(text.split('\n').filter(line => line.startsWith('- setting_'))).toHaveLength(300 - left);
});

test('the SessionStart hook prints the record as context, writes it to a private file, and fails silently', () => home(async ({dir, env, enroll}) => {
  enroll();
  const t = transcriptFixture();
  const first = t.user('Build the importer.\nIt must accept CSV with `;` between fields.'), second = t.queued([{type: 'text', text: 'Rename the flag to --dry-run.'}]);
  t.user('<task-notification>\nbackground shell finished</task-notification>', {origin: {kind: 'task-notification'}});
  t.tool('Bash', {command: 'ls'}, 'importer.ts');
  const transcript = t.write(join(dir, 'claude', 'projects', 'p', t.session + '.jsonl'));
  const payload = {hook_event_name: 'SessionStart', source: 'compact', session_id: t.session, transcript_path: transcript, cwd: dir};
  const record = `[message 1, sent ${first.timestamp}]\nBuild the importer.\nIt must accept CSV with \`;\` between fields.\n\n[message 2, sent ${second.timestamp}]\nRename the flag to --dry-run.`;

  const ran = await hook(payload, env);
  expect(ran.stderr).toBe(''); expect(ran.exit).toBe(0);
  expect(ran.stdout).toEndWith('}\n'); expect(ran.stdout.trim().split('\n')).toHaveLength(1);
  const output = JSON.parse(ran.stdout);
  expect(Object.keys(output)).toEqual(['hookSpecificOutput']);
  expect(Object.keys(output.hookSpecificOutput)).toEqual(['hookEventName', 'additionalContext']);
  expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart');
  expect(output.hookSpecificOutput.additionalContext).toStartWith('OpenCrawl verbatim record. Your context was just compacted into a summary, and summaries lose detail. Below is every message the user sent in this session, word for word, oldest first.');
  expect(output.hookSpecificOutput.additionalContext).toEndWith(RECALL + '\n\n' + record);
  const file = join(captureDir(), 'records', t.session + '.md');
  expect(readFileSync(file, 'utf8')).toBe(RECORD_HEADING + '\n\n' + record + '\n');
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  // The whole record is in the context, so no comparison is owed.
  expect(readdirSync(join(captureDir(), 'records'))).toEqual([t.session + '.md']);
  expect(existsSync(join(captureDir(), 'pending'))).toBe(false);

  // Anything unexpected ends quietly: no output, exit code 0.
  for (const input of ['not json', '', JSON.stringify({...payload, transcript_path: join(dir, 'missing.jsonl')}), JSON.stringify({...payload, transcript_path: dir})]) {
    expect(await hook(input, env)).toEqual({exit: 0, stdout: '', stderr: ''});
  }
  const options = {config: readCaptureConfig(), directory: captureDir(), env: {}};
  expect(await compactionHookOutput(payload, options)).toBe(ran.stdout);
  for (const other of [{...payload, source: 'startup'}, {...payload, source: 'resume'}, {...payload, hook_event_name: 'PreCompact'}, {...payload, cursor_version: '1.7.0'},
    {...payload, transcript_path: undefined}, {...payload, transcript_path: join(dir, 'notes.txt')}, null, 'text', []]) {
    expect(await compactionHookOutput(other, options)).toBe('');
  }
  // A session with no message from the person has nothing to give back.
  const silent = transcriptFixture('99999999-0000-4000-8000-000000000000');
  silent.user('<task-notification>\nscheduled run</task-notification>', {origin: {kind: 'task-notification'}});
  expect(await compactionHookOutput({...payload, session_id: silent.session, transcript_path: silent.write(join(dir, 'silent.jsonl'))}, options)).toBe('');
  // Hooks a running session loaded earlier do nothing once capture is uninstalled, or was never installed.
  expect(await compactionHookOutput(payload, {...options, config: {...options.config!, disabled: true}})).toBe('');
  expect(await compactionHookOutput(payload, {...options, config: null})).toBe('');
  enroll({disabled: true});
  expect(await hook(payload, env)).toEqual({exit: 0, stdout: '', stderr: ''});
  // An excluded project still gets its own messages back, but nothing about it is stored.
  rmSync(join(captureDir(), 'records'), {recursive: true});
  const excluded = await compactionHookOutput(payload, {...options, config: {exclusions: {projects: [], sessions: [t.session]}}});
  expect(JSON.parse(excluded).hookSpecificOutput.additionalContext).toEndWith(record);
  expect(existsSync(join(captureDir(), 'records'))).toBe(false);
}));

test('a long record leaves a comparison owed, and the first tool result of the compacted agent delivers what the summary dropped', () => home(async ({dir, env, enroll}) => {
  enroll();
  const t = transcriptFixture(undefined, Date.now() - 60_000);
  const filler = Array.from({length: 40}, (_, line) => `Background paragraph ${line}: keep the code simple, readable and well tested, and prefer small functions.`).join('\n');
  t.user('Build the gallery service.\n- Use `thumb_width` of 240.\n- The bucket is named gallery-v2.\n' + filler);
  t.tool('Bash', {command: 'ls'}, 'gallery.ts');
  t.user('Second requirement: accept at most 2,400,000 uploads and answer on 7070.\n' + filler);
  const kept = t.user('Third requirement: release 3.8.1-rc2 goes out first.\n' + filler);
  const transcript = t.write(join(dir, 'claude', 'projects', 'p', t.session + '.jsonl'));
  const common = {session_id: t.session, transcript_path: transcript, cwd: dir}, start = {...common, hook_event_name: 'SessionStart', source: 'compact'};
  const pending = join(captureDir(), 'pending'), marker = join(pending, t.session);

  const started = await hook(start, env);
  expect(started.exit).toBe(0); expect(started.stderr).toBe('');
  const context = JSON.parse(started.stdout).hookSpecificOutput.additionalContext;
  expect(context.length).toBeLessThanOrEqual(INLINE_CAP);
  expect(context).toContain('The user has sent 3 messages in this session:\n[message 1, ');
  expect(context).toContain(`is in the file ${join(captureDir(), 'records', t.session + '.md')}. Read it when you need a message in full`);
  expect(context).not.toContain('thumb_width');
  expect(readdirSync(pending)).toEqual([t.session]);
  expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({at: expect.any(String)});
  expect(readFileSync(join(captureDir(), 'records', t.session + '.md'), 'utf8')).toContain('- The bucket is named gallery-v2.\n');

  // The harness has not appended the boundary and summary yet: nothing to say, and the comparison stays owed.
  const tool = {...common, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {command: 'ls'}, tool_response: {stdout: 'gallery.ts'}};
  expect(await hook(tool, env)).toEqual({exit: 0, stdout: '', stderr: ''});
  expect(existsSync(marker)).toBe(true);
  t.compaction('The user wants a gallery service: thumb_width 240, at most 2400000 uploads, answering on 7070.', [kept.uuid]);
  t.write(transcript);
  // A subagent's tool result is not the compacted agent's.
  expect(await hook({...tool, agent_id: 'a1b2c3'}, env)).toEqual({exit: 0, stdout: '', stderr: ''});
  expect(existsSync(marker)).toBe(true);
  const delivered = await hook(tool, env);
  expect(delivered.exit).toBe(0); expect(delivered.stderr).toBe('');
  const followUp = JSON.parse(delivered.stdout);
  expect(followUp).toEqual({hookSpecificOutput: {hookEventName: 'PostToolUse', additionalContext: expect.any(String)}});
  const text = followUp.hookSpecificOutput.additionalContext;
  expect(text).toStartWith("OpenCrawl verbatim record. Your context was compacted into a summary a moment ago. OpenCrawl compared that summary with what the user actually wrote. The summary dropped or changed 1 exact detail of the user's messages.");
  expect(text).toContain('\n\n[from message 1]\n- The bucket is named gallery-v2.\n\nThe complete word-for-word record');
  expect(text).not.toMatch(/3\.8\.1-rc2|2,400,000|Background paragraph/);
  expect(text.length).toBeLessThanOrEqual(INLINE_CAP);
  // Said once. The directory goes with the last comparison, so the installed hook's shell test fails again.
  expect(existsSync(pending)).toBe(false);
  expect(await hook(tool, env)).toEqual({exit: 0, stdout: '', stderr: ''});

  const options = {config: readCaptureConfig(), directory: captureDir(), env: {}};
  const owe = (at: number, name = t.session) => {mkdirSync(pending, {recursive: true}); writeFileSync(join(pending, name), JSON.stringify({at: new Date(at).toISOString()}));};
  // A boundary older than the compaction that owes the comparison belongs to the one before it: wait.
  owe(Date.now() + 600_000);
  expect(compactionFollowUp(tool, options)).toBe('');
  expect(existsSync(marker)).toBe(true);
  // Nobody collected it within fifteen minutes: dropped.
  expect(compactionFollowUp(tool, {...options, now: Date.now() + 600_000 + 16 * 60_000})).toBe('');
  expect(existsSync(pending)).toBe(false);
  owe(Date.now());
  expect(compactionFollowUp({...tool, hook_event_name: 'PreToolUse'}, options)).toBe('');
  expect(compactionFollowUp(tool, {...options, config: {exclusions: {projects: [], sessions: [t.session]}}})).toBe('');
  expect(existsSync(pending)).toBe(false);
  // The file is named after the session ID Claude Code exports to hook commands: that is what the shell test looks for.
  const exported = {CLAUDE_CODE_SESSION_ID: 'exported-session-id'};
  await compactionHookOutput(start, {...options, env: exported});
  expect(readdirSync(pending)).toEqual(['exported-session-id']);
  expect(compactionFollowUp(tool, options)).toBe('');
  expect(compactionFollowUp(tool, {...options, env: exported})).toBe(delivered.stdout);
  expect(existsSync(pending)).toBe(false);
  // A comparison whose session never came back is swept by the next hook of any session.
  owe(Date.now(), 'abandoned-session');
  utimesSync(join(pending, 'abandoned-session'), new Date(Date.now() - 16 * 60_000), new Date(Date.now() - 16 * 60_000));
  expect(compactionFollowUp(tool, options)).toBe('');
  expect(existsSync(pending)).toBe(false);
  // A session ID that is not a plain file name owes nothing rather than writing outside the directory.
  await compactionHookOutput({...start, session_id: '../escape'}, options);
  expect(existsSync(pending)).toBe(false);
}));

test('PostCompact appends one private measurement; status reports its counts, never the words', () => home(async ({dir, enroll}) => {
  enroll();
  const t = transcriptFixture();
  t.user('Use `thumb_width` 240 on 7070 for gallery-v2.');
  t.queued('Target release 3.8.1-rc2.\n' + Array.from({length: 250}, (_, n) => `limit_${n}`).join(' '));
  const transcript = t.write(join(dir, 'claude', 'projects', 'p', t.session + '.jsonl'));
  const payload = {hook_event_name: 'PostCompact', trigger: 'auto', session_id: t.session, transcript_path: transcript, cwd: dir, compact_summary: 'The user set thumb_width to 240 for gallery-v2.'};
  const options = {config: readCaptureConfig(), directory: captureDir(), env: {}};
  expect(captureStatus().lastCompaction).toBeNull();
  expect(await compactionHookOutput(payload, options)).toBe('');
  const file = join(captureDir(), 'drift.jsonl');
  const [line, ...rest] = readFileSync(file, 'utf8').trimEnd().split('\n');
  expect(rest).toEqual([]);
  const measured = JSON.parse(line!);
  expect(Object.keys(measured)).toEqual(['ts', 'session', 'trigger', 'anchors', 'kept', 'lost', 'summaryChars']);
  expect(measured).toMatchObject({session: t.session, trigger: 'auto', anchors: 255, kept: 3, summaryChars: 47});
  expect(new Date(measured.ts).toISOString()).toBe(measured.ts);
  expect(measured.lost).toHaveLength(200); expect(measured.lost.slice(0, 3)).toEqual(['3.8.1-rc2', '7070', 'limit_0']);
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(captureStatus().lastCompaction).toEqual({ts: measured.ts, session: t.session, trigger: 'auto', anchors: 255, kept: 3, lost: 252, summaryChars: 47});
  expect(JSON.stringify(captureStatus())).not.toContain('limit_0');
  // Excluded work is not measured, and a payload without a summary measures nothing.
  for (const exclusions of [{projects: [], sessions: [t.session]}, {projects: [realpathSync(dir)], sessions: []}]) await compactionHookOutput(payload, {...options, config: {exclusions}});
  await compactionHookOutput({...payload, compact_summary: ''}, options);
  await compactionHookOutput({...payload, compact_summary: undefined}, options);
  expect(readFileSync(file, 'utf8').trimEnd().split('\n')).toHaveLength(1);
  await compactionHookOutput({...payload, trigger: 'manual', compact_summary: 'thumb_width 240 on 7070 for gallery-v2, release 3.8.1-rc2'}, options);
  expect(latestDrift(captureDir())).toMatchObject({trigger: 'manual', anchors: 255, kept: 5, lost: 250});
  // The file keeps its newest half once it passes a mebibyte.
  writeFileSync(file, Array.from({length: 600}, (_, n) => JSON.stringify({ts: new Date(n).toISOString(), session: 'old', trigger: 'auto', anchors: 1, kept: 1, lost: ['x'.repeat(2_000)], summaryChars: 1})).join('\n') + '\n');
  await recordDrift(captureDir(), {ts: '2026-01-05T09:00:00.000Z', session: 'new', trigger: 'auto', anchors: 2, kept: 1, lost: ['flag'], summaryChars: 9});
  const trimmed = readFileSync(file, 'utf8').trimEnd().split('\n');
  expect(trimmed).toHaveLength(300);
  expect(JSON.parse(trimmed[0]!).ts).toBe(new Date(301).toISOString());
  expect(latestDrift(captureDir())).toEqual({ts: '2026-01-05T09:00:00.000Z', session: 'new', trigger: 'auto', anchors: 2, kept: 1, lost: 1, summaryChars: 9});
  // A damaged last line does not hide the measurement before it.
  writeFileSync(file, readFileSync(file, 'utf8') + '{"ts":"2026-01-05T10:00:00.000Z","anch');
  expect(latestDrift(captureDir())).toMatchObject({session: 'new'});

  // Records are rewritten per session and removed a month after their session last compacted.
  const old = writeRecord(captureDir(), 'old-session', 'old')!, kept = writeRecord(captureDir(), 'kept-session', 'kept')!;
  utimesSync(old, new Date(Date.now() - 31 * 86_400_000), new Date(Date.now() - 31 * 86_400_000));
  expect(writeRecord(captureDir(), 'a session/with:odd*characters', 'text')).toMatch(/[\\/]records[\\/][a-f0-9]{32}\.md$/);
  expect(existsSync(old)).toBe(false); expect(readFileSync(kept, 'utf8')).toBe(RECORD_HEADING + '\n\nkept\n');
  // Local purge removes the measurements, the records and any comparison still owed with the rest.
  mkdirSync(join(captureDir(), 'pending')); writeFileSync(join(captureDir(), 'pending', t.session), '{}');
  enroll({disabled: true});
  await purgeLocalCapture(true);
  for (const name of ['drift.jsonl', 'records', 'pending']) expect(existsSync(join(captureDir(), name))).toBe(false);
  expect(captureStatus().lastCompaction).toBeNull();
}));

test('install adds the compaction hooks once, beside existing hooks; upgrade adds them; uninstall removes only them', () => home(async ({dir}) => {
  const settings = join(dir, 'claude', 'settings.json');
  mkdirSync(join(dir, 'claude'), {recursive: true});
  const own = {type: 'command', command: 'echo mine'};
  const before = {permissions: {allow: ['Read']}, hooks: {SessionStart: [{matcher: 'compact', hooks: [own]}], PostCompact: [{hooks: [own]}], PostToolUse: [{matcher: 'Bash', hooks: [own]}], Stop: [{hooks: [own]}]}};
  writeFileSync(settings, JSON.stringify(before, null, 2) + '\n');
  const options = {deferAuth: true, home: dir, command: [process.execPath, cli]};
  await installCapture('http://127.0.0.1:9', options);
  const once = readFileSync(settings, 'utf8'), installed = JSON.parse(once);
  expect(installed.permissions).toEqual(before.permissions);
  for (const event of ['SessionStart', 'PostCompact', 'PostToolUse', 'Stop'] as const) expect(installed.hooks[event][0]).toEqual(before.hooks[event][0]);
  // The capture hooks are exactly what they were: one asynchronous managed hook per event.
  expect(installed.hooks.SessionStart[1].matcher).toBeUndefined();
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SubagentStop', 'SessionEnd']) {
    const managed = installed.hooks[event].flatMap((group: any) => group.hooks).filter((entry: any) => entry.command.includes('--managed'));
    expect(managed).toEqual([{type: 'command', command: expect.stringContaining('collect hook --managed --harness claude-code'), async: true, timeout: 120, statusMessage: 'OpenCrawl session capture'}]);
  }
  // Claude Code waits on the hook that follows a compaction and on the one that completes it; nothing waits on the measurement.
  expect(installed.hooks.SessionStart).toHaveLength(3); expect(installed.hooks.PostCompact).toHaveLength(2); expect(installed.hooks.PostToolUse).toHaveLength(3);
  const start = installed.hooks.SessionStart[2], post = installed.hooks.PostCompact[1], owed = installed.hooks.PostToolUse[2];
  expect(start).toEqual({matcher: 'compact', hooks: [{type: 'command', command: expect.stringMatching(/runner\.cjs['"]? collect compaction$/), timeout: 10, statusMessage: 'OpenCrawl session capture'}]});
  const command = start.hooks[0].command;
  expect(post).toEqual({hooks: [{type: 'command', command, async: true, timeout: 10, statusMessage: 'OpenCrawl session capture'}]});
  // The second PostToolUse hook starts nothing unless its shell test finds a comparison owed.
  expect(owed).toEqual({hooks: [{type: 'command', timeout: 5, statusMessage: 'OpenCrawl session capture',
    command: process.platform === 'win32' ? command : `[ -e '${join(captureDir(), 'pending')}'/"$CLAUDE_CODE_SESSION_ID" ] || exit 0; ${command}`}]});
  expect(Object.keys(installed.hooks).sort()).toEqual(['PostCompact', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStop', 'UserPromptSubmit']);
  await installCapture('http://127.0.0.1:9', options);
  expect(readFileSync(settings, 'utf8')).toBe(once);
  expect(readCaptureConfig()!.hookMode).toBe(HOOK_MODE);

  if (process.platform !== 'win32') {
    // The installed command, run as the harness runs it, answers a compaction.
    const t = transcriptFixture();
    t.user('Keep the cache at 512.');
    const payload = {hook_event_name: 'SessionStart', source: 'compact', session_id: t.session, transcript_path: t.write(join(dir, 'claude', 'projects', 'p', t.session + '.jsonl')), cwd: dir};
    const answered = await spawned(['/bin/sh', '-c', command], payload, process.env);
    if (answered.exit !== 0) throw new Error(answered.stderr);
    expect(JSON.parse(answered.stdout).hookSpecificOutput.additionalContext).toEndWith('\nKeep the cache at 512.');

    // The shell test: the CLI starts only for a session that is owed a comparison,
    // or, where the harness exports no session ID, while any session is owed one.
    const ran = join(dir, 'started'), pending = join(captureDir(), 'pending');
    await installCapture('http://127.0.0.1:9', {...options, command: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(ran)},'started')`]});
    expect(readFileSync(settings, 'utf8')).toBe(once);
    const starts = async (variables: NodeJS.ProcessEnv) => {
      rmSync(ran, {force: true});
      const gate = await spawned(['/bin/sh', '-c', owed.hooks[0].command], '{}', {...process.env, ...variables});
      if (gate.exit !== 0) throw new Error(gate.stderr);
      expect(gate.stdout).toBe('');
      return existsSync(ran);
    };
    expect(await starts({CLAUDE_CODE_SESSION_ID: 'mine'})).toBe(false);
    expect(await starts({})).toBe(false);
    mkdirSync(pending); writeFileSync(join(pending, 'theirs'), '{}');
    expect(await starts({CLAUDE_CODE_SESSION_ID: 'mine'})).toBe(false);
    expect(await starts({})).toBe(true);
    writeFileSync(join(pending, 'mine'), '{}');
    expect(await starts({CLAUDE_CODE_SESSION_ID: 'mine'})).toBe(true);
    rmSync(pending, {recursive: true});
    await installCapture('http://127.0.0.1:9', options);
  }

  // An installation made before these hooks existed gets them from the next hook or command.
  const earlier = JSON.parse(once);
  earlier.hooks.SessionStart.splice(2); earlier.hooks.PostCompact.splice(1); earlier.hooks.PostToolUse.splice(2);
  writeFileSync(settings, JSON.stringify(earlier, null, 2) + '\n');
  writeFileSync(join(captureDir(), 'config.json'), JSON.stringify({...readCaptureConfig()!, hookMode: 'managed-v3'}));
  await upgradeCaptureHooks();
  expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual(installed);
  expect(readCaptureConfig()!.hookMode).toBe(HOOK_MODE);

  // Codex has no such hooks.
  const codex = readFileSync(join(dir, 'codex', 'hooks.json'), 'utf8');
  expect(codex).toContain('--managed --harness codex'); expect(codex).not.toContain('collect compaction'); expect(codex).not.toContain('PostCompact');

  await uninstallCapture(dir);
  expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual(before);
  expect(readFileSync(join(dir, 'codex', 'hooks.json'), 'utf8')).not.toContain('OpenCrawl');
}));

test('the skill says what to do after a compaction and leaves board participation and the start-up instruction alone', () => {
  const skill = skillFiles()['SKILL.md'];
  expect(skill).toContain('\n## After a compaction\n\nThis applies in Claude Code where capture is installed.');
  expect(skill).toContain("OpenCrawl gives you the user's own words back");
  expect(skill).toContain('run `opencrawl recall "<a few distinctive words>"` instead of guessing or redoing the work');
  expect(skill.indexOf('## After a compaction')).toBeGreaterThan(skill.indexOf('## Retrieval and capture'));
  expect(skill.indexOf('## After a compaction')).toBeLessThan(skill.indexOf('## Posting'));
  expect(skillFiles()['references/participation.md']).toBe(participationInstructions() + '\nFor Codex functions.exec, use the [listener example](codex-listener.md).\n');
  expect(participationInstructions()).not.toContain('opencrawl recall');
  expect(startupInstruction()).toBe('At session start, read the installed opencrawl skill and follow its participation instructions using the configured CLI server: register this session once and keep one native notification listener active. If the skill is unavailable, run opencrawl board instructions.');
});
