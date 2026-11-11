import {test, expect} from 'bun:test';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {queryTerms, rankPassages, recallCommand, formatRecall, driftCommand, formatDrift} from '../src/recall.ts';
import {compactionReports} from '../src/capture/compaction.ts';
import {readTranscript, EVENT_KINDS, TOOL_HEAD, TOOL_GAP} from '../src/transcript.ts';
import {transcriptFixture, projectDirectory} from './fixtures/transcript.ts';

function session() {
  const t = transcriptFixture();
  t.user('Build the gallery importer. Thumbnails must be `240px` wide, the cache size is 640, and `thumb_width` stays in the config until v3.8.1-rc2 replaces 2024.06.');
  t.assistant('Understood: the cache size will be 640 and thumbnails 240px wide.');
  t.tool('Bash', {command: 'git tag --list'}, 'v3.7.9\nv3.8.0\nv3.8.1-rc1');
  for (let module = 0; module < 30; module++) t.tool('Bash', {command: `ls src/module${module}`}, Array.from({length: 20}, (_, file) => `file${file}.ts ${module * 31 + file} bytes`).join('\n'));
  t.queued([{type: 'text', text: 'Change of plan: the cache size is now 512, not 640.'}]);
  t.user('<task-notification>\nthumbnail job finished with the cache size unchanged</task-notification>', {origin: {kind: 'task-notification'}});
  t.compaction('The user wants a gallery importer. The cache size is 640 and the cache size must stay the cache size.');
  t.assistant('Continuing with the gallery importer.');
  return t;
}
const events = (kinds?: Parameters<typeof readTranscript>[1]) => {
  const dir = mkdtempSync(join(tmpdir(), 'opencrawl-recall-'));
  try {return readTranscript(session().write(join(dir, 'session.jsonl')), kinds).events;} finally {rmSync(dir, {recursive: true, force: true});}
};

test('identifiers, dotted versions and tagged releases are searched whole and as their parts', () => {
  expect(queryTerms('thumb_width')).toEqual(['thumb_width', 'thumb', 'width']);
  expect(queryTerms('Release 2024.06 of v3.8.1-rc2')).toEqual(['2024.06', 'v3.8.1-rc2', 'release', '2024', '06', 'of', 'v3', 'rc2']);
  expect(queryTerms('a b ! ?')).toEqual([]);
  expect(queryTerms('Größe der Tabelle')).toEqual(['größe', 'der', 'tabelle']);
});

test('recall puts what the user said first, quotes it verbatim oldest first, and never quotes a summary', () => {
  const all = events({kinds: ['user', 'queued', 'notice', 'assistant', 'tool_use', 'tool_result']});
  const best = rankPassages(all, 'cache size', {limit: 1});
  expect(best.passages).toEqual([{timestamp: expect.any(String), kind: 'queued', speaker: 'the user said (while you were working)', offset: 0, text: 'Change of plan: the cache size is now 512, not 640.'}]);
  const result = rankPassages(all, 'cache size');
  expect(result.terms).toEqual(['cache', 'size']);
  expect(result.matched).toBe(4);
  expect(result.passages.map(passage => passage.kind)).toEqual(['user', 'assistant', 'queued', 'notice']);
  expect(result.passages[0]!.text).toStartWith('Build the gallery importer. Thumbnails must be `240px` wide');
  // The summary repeats the words most often, and is not evidence.
  expect(JSON.stringify(result)).not.toContain('must stay the cache size');
  // The two user passages outrank the agent's own echo of them.
  expect(rankPassages(all, 'cache size', {limit: 2}).passages.map(passage => passage.kind)).toEqual(['user', 'queued']);
  const text = formatRecall({session: 's', transcript: 'f', sessions: 1, compactions: 1, ...result});
  expect(text).toStartWith("opencrawl recall: 4 passages matched in this session's transcript; showing 4, oldest first, verbatim. A later statement overrides an earlier one.\n\n--- [2026-01-05T08:00:01.000Z | the user said] ---\nBuild the gallery importer.");
  expect(text).toContain('\n\n--- [2026-01-05T08:01:05.000Z | the user said (while you were working)] ---\nChange of plan: the cache size is now 512, not 640.');
  expect(formatRecall({session: 's', transcript: 'f', sessions: 1, compactions: 0, ...rankPassages(all, 'zeppelin')})).toBe(`opencrawl recall: nothing in this session's transcript matched "zeppelin". Try fewer or more distinctive words.`);
});

test('a term matches whole words and identifiers, in any case, never the inside of a longer word', () => {
  const all = events();
  expect(rankPassages(all, 'thumb_width').passages.map(passage => passage.kind)).toEqual(['user']);
  expect(rankPassages(all, 'THUMB_WIDTH').matched).toBe(1);
  expect(rankPassages(all, 'v3.8.1-rc2').passages[0]!.kind).toBe('user');
  // The whole version is rarer than its parts, so the message that has it comes first.
  expect(rankPassages(all, '2024.06', {limit: 1}).passages[0]!.text).toContain('replaces 2024.06');
  // "size" is not found inside "oversized" or "sizes", and "module" not inside "module7".
  expect(rankPassages([{i: 0, ts: null, kind: 'user', text: 'An oversized resize of sizes.'}], 'size').matched).toBe(0);
  expect(rankPassages(all, 'module').matched).toBe(0);
  expect(rankPassages(all, 'module7').passages.map(passage => passage.text)).toEqual(['Bash: ls src/module7']);
  expect(() => rankPassages(all, '? !')).toThrow('distinctive words');
});

test('a long message is quoted as the window that matches, with its position', () => {
  const filler = (count: number) => Array.from({length: count}, (_, index) => `line ${index} of ordinary build output`).join('\n');
  const long = filler(200) + '\nERROR: the thumbnail worker ran for 1310 milliseconds\n' + filler(200);
  const tail = 'x'.repeat(TOOL_HEAD + 30_000) + ' the upload folder was left open';
  const list = [
    {i: 0, ts: '2026-01-05T08:00:00.000Z', kind: 'tool_result' as const, text: long},
    {i: 1, ts: null, kind: 'tool_result' as const, text: tail.slice(0, TOOL_HEAD) + TOOL_GAP + tail.slice(-4_000), omitted: tail.length - TOOL_HEAD - 4_000},
  ];
  const found = rankPassages(list, 'error milliseconds', {chars: 400, limit: 1}), [passage] = found.passages;
  expect(passage!.text.length).toBeLessThanOrEqual(400);
  expect(passage!.text).toContain('ERROR: the thumbnail worker ran for 1310 milliseconds');
  expect(passage!.offset).toBeGreaterThan(0);
  expect(long.slice(passage!.offset, passage!.offset + passage!.text.length)).toBe(passage!.text);
  expect(formatRecall({session: 's', transcript: 'f', sessions: 1, compactions: 0, ...found})).toContain(`--- [2026-01-05T08:00:00.000Z | a tool returned | from character ${passage!.offset}] ---`);
  // Positions past the part left out of a long output refer to the original output.
  const end = rankPassages(list, 'upload folder', {limit: 1}).passages[0]!;
  expect(end.text).toEndWith('the upload folder was left open');
  expect(tail.slice(end.offset)).toBe(end.text);
});

test('opencrawl recall runs locally: no sign-in, no server, the named or current session only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencrawl-recall-cli-'));
  try {
    const cwd = resolve(dir, 'project'), t = session();
    const transcript = t.write(join(dir, 'claude', 'projects', projectDirectory(cwd), t.session + '.jsonl'));
    const env: NodeJS.ProcessEnv = {...process.env, HOME: dir, USERPROFILE: dir, OPENCRAWL_CONFIG_HOME: join(dir, 'config'), CLAUDE_CONFIG_DIR: join(dir, 'claude'),
      // Recall must not need a deployment: an unusable one changes nothing.
      OPENCRAWL_API_URL: 'not a deployment', OPENCRAWL_NO_UPDATE: '1'};
    for (const name of ['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PROJECT_DIR', 'CODEX_THREAD_ID', 'OPENCRAWL_TOKEN', 'OPENCRAWL_SESSIONS_TOKEN']) delete env[name];
    mkdirSync(join(cwd, 'src'), {recursive: true});
    const run = (args: string[], variables = env, directory = dir) => {
      const child = Bun.spawnSync(['bun', resolve(import.meta.dir, '../src/cli.ts'), 'recall', ...args], {env: variables, cwd: directory, stdout: 'pipe', stderr: 'pipe'});
      return {exit: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString()};
    };
    const found = run(['cache size', '--session', t.session, '--json']);
    expect(found.stderr).toBe(''); expect(found.exit).toBe(0);
    const {schemaVersion, data} = JSON.parse(found.stdout);
    expect(schemaVersion).toBe(1);
    expect(data).toMatchObject({session: t.session, transcript, sessions: 1, compactions: 1, query: 'cache size', terms: ['cache', 'size'], matched: 4});
    expect(data.passages.map((passage: any) => passage.speaker)).toEqual(['the user said', 'you wrote', 'the user said (while you were working)', 'an automated message or another agent said']);
    // Unquoted words are one query; the session comes from the harness's environment.
    const current = run(['cache', 'size', '--kind', 'user', '--limit', '1'], {...env, CLAUDE_CODE_SESSION_ID: t.session});
    expect(current.exit).toBe(0);
    expect(current.stdout).toBe("opencrawl recall: 2 passages matched in this session's transcript; showing 1, oldest first, verbatim. A later statement overrides an earlier one.\n\n--- [2026-01-05T08:01:05.000Z | the user said (while you were working)] ---\nChange of plan: the cache size is now 512, not 640.\n");
    // With no session named, the newest transcript of the project the command runs in. The project is named
    // here rather than taken from the child's working directory, which the OS may report under another path.
    expect(run(['git tag', '--kind', 'tool', '--chars', '200'], {...env, CLAUDE_PROJECT_DIR: join(cwd, 'src')}).stdout).toContain('| you ran] ---\nBash: git tag --list');
    // Every message the user sent, as the compaction hook records it.
    const record = run(['--user', '--session', t.session]);
    expect(record.exit).toBe(0);
    expect(record.stdout).toStartWith('# Every message the user sent in this session, word for word, oldest first\n\n[message 1, sent 2026-01-05T08:00:01.000Z]\nBuild the gallery importer.');
    expect(record.stdout).toEndWith('[message 2, sent 2026-01-05T08:01:05.000Z]\nChange of plan: the cache size is now 512, not 640.\n');
    expect(JSON.parse(run(['--user', '--session', t.session, '--json']).stdout).data).toMatchObject({session: t.session, sessions: 1, messages: 2});
    for (const [args, code] of [[[], 'INVALID_USAGE'], [['cache', '--kind', 'everything'], 'INVALID_USAGE'], [['cache', '--limit', '0'], 'INVALID_USAGE'], [['cache', '--chars', '9'], 'INVALID_USAGE'],
      [['cache', '--user'], 'INVALID_USAGE'], [['cache', '--session', 'no-such-session'], 'TRANSCRIPT_NOT_FOUND'], [['cache'], 'TRANSCRIPT_NOT_FOUND']] as const) {
      const failed = run([...args, '--json']);
      expect(JSON.parse(failed.stdout)).toMatchObject({schemaVersion: 1, error: {code}});
      expect(failed.exit).toBe(code === 'INVALID_USAGE' ? 64 : 1);
    }
  } finally {rmSync(dir, {recursive: true, force: true});}
});

/** A private home with the project's transcripts where Claude Code keeps them. The commands run in this
 * process, as `session` when one is given; `cli` starts the real one. */
function project(run: (f: {dir: string; transcripts: string; as: <T>(session: string | undefined, body: () => T) => T;
  cli: (command: string, args: string[], session?: string) => {exit: number | null; stdout: string; stderr: string}}) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'opencrawl-recall-project-')), saved = {...process.env};
  try {
    const cwd = resolve(dir, 'project'), transcripts = join(dir, 'claude', 'projects', projectDirectory(cwd));
    Object.assign(process.env, {HOME: dir, USERPROFILE: dir, OPENCRAWL_CONFIG_HOME: join(dir, 'config'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), CLAUDE_PROJECT_DIR: cwd,
      OPENCRAWL_API_URL: 'not a deployment', OPENCRAWL_NO_UPDATE: '1'});
    for (const name of ['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'OPENCRAWL_TOKEN', 'OPENCRAWL_SESSIONS_TOKEN']) delete process.env[name];
    run({dir, transcripts,
      as: (session, body) => {
        if (session) process.env.CLAUDE_CODE_SESSION_ID = session;
        try {return body();} finally {delete process.env.CLAUDE_CODE_SESSION_ID;}
      },
      cli: (command, args, session) => {
        const child = Bun.spawnSync(['bun', resolve(import.meta.dir, '../src/cli.ts'), command, ...args], {env: {...process.env, ...(session ? {CLAUDE_CODE_SESSION_ID: session} : {})}, cwd: dir, stdout: 'pipe', stderr: 'pipe'});
        return {exit: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString()};
      }});
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved); rmSync(dir, {recursive: true, force: true});
  }
}

test('recall reaches the other sessions of the project and says which session a passage is from', () => project(({dir, transcripts, as, cli}) => {
  const earlier = transcriptFixture('cccccccc-0000-4000-8000-000000000001', Date.parse('2026-01-03T10:00:00Z'));
  earlier.user('The staging database is `orders_staging` on port 6543.');
  earlier.assistant('I will use orders_staging on 6543 for staging.');
  earlier.tool('Bash', {command: 'psql -p 6543 -l'}, 'orders_staging | owner');
  earlier.queue('enqueue', 'Never run migrations against `orders_live`.');
  earlier.write(join(transcripts, earlier.session + '.jsonl'));
  const t = session();
  t.write(join(transcripts, t.session + '.jsonl'));
  const recall = (words: string[], values: Record<string, unknown> = {}, current: string | undefined = t.session) => as(current, () => recallCommand(words, values));
  const printed = (words: string[], values: Record<string, unknown> = {}, current: string | undefined = t.session) => formatRecall(recall(words, values, current));

  const found = cli('recall', ['staging database', '--json'], t.session);
  expect(found.stderr).toBe(''); expect(found.exit).toBe(0);
  const {data} = JSON.parse(found.stdout);
  expect(data).toMatchObject({session: t.session, sessions: 2, compactions: 1, matched: 3});
  expect(data.passages).toEqual([
    {timestamp: '2026-01-03T10:00:01.000Z', kind: 'user', speaker: 'the user said', session: 1, offset: 0, text: 'The staging database is `orders_staging` on port 6543.'},
    {timestamp: '2026-01-03T10:00:02.000Z', kind: 'assistant', speaker: 'the agent wrote', session: 1, offset: 0, text: 'I will use orders_staging on 6543 for staging.'},
    {timestamp: '2026-01-03T10:00:04.000Z', kind: 'tool_result', speaker: 'a tool returned', session: 1, offset: 0, text: 'orders_staging | owner'}]);
  expect(recall(['staging database'])).toEqual(data);
  // What this session said carries no session label; what another one said does, and there the agent was not "you".
  expect(cli('recall', ['orders_staging', 'thumb_width', '--kind', 'user'], t.session).stdout).toBe("opencrawl recall: 3 passages matched in the transcripts of this project's 2 sessions; showing 3, oldest first, verbatim. A later statement overrides an earlier one.\n\n"
    + '--- [2026-01-03T10:00:01.000Z | session 1 of this project | the user said] ---\nThe staging database is `orders_staging` on port 6543.\n\n'
    // A message the earlier session never received is on record, and says so.
    + '--- [2026-01-03T10:00:05.000Z | session 1 of this project | the user said (never handed to the agent)] ---\nNever run migrations against `orders_live`.\n\n'
    + '--- [2026-01-05T08:00:01.000Z | the user said] ---\nBuild the gallery importer. Thumbnails must be `240px` wide, the cache size is 640, and `thumb_width` stays in the config until v3.8.1-rc2 replaces 2024.06.\n');
  expect(printed(['psql'], {kind: 'tool'})).toContain('--- [2026-01-03T10:00:03.000Z | session 1 of this project | the agent ran] ---\nBash: psql -p 6543 -l');
  // A named session is searched alone.
  const alone = `opencrawl recall: nothing in this session's transcript matched "staging database". Try fewer or more distinctive words.`;
  expect(printed(['staging database'], {session: t.session}, undefined)).toBe(alone);
  expect(recall(['staging database'], {session: earlier.session}, undefined)).toMatchObject({session: earlier.session, sessions: 1, matched: 3});
  // The record of the project, session by session.
  expect(printed([], {user: true})).toBe('# Every message the user sent in this project, session by session, word for word, oldest first\n\n'
    + '## Session 1 (started 2026-01-03T10:00:01.000Z)\n\n[message 1, sent 2026-01-03T10:00:01.000Z]\nThe staging database is `orders_staging` on port 6543.\n\n'
    + '[message 2, sent 2026-01-03T10:00:05.000Z, sent while the agent was busy and never handed to it before that session ended]\nNever run migrations against `orders_live`.\n\n'
    + '## Session 2 (started 2026-01-05T08:00:01.000Z)\n\n[message 3, sent 2026-01-05T08:00:01.000Z]\nBuild the gallery importer. Thumbnails must be `240px` wide, the cache size is 640, and `thumb_width` stays in the config until v3.8.1-rc2 replaces 2024.06.\n\n'
    + '[message 4, sent 2026-01-05T08:01:05.000Z]\nChange of plan: the cache size is now 512, not 640.');
  expect(recall([], {user: true})).toMatchObject({session: t.session, sessions: 2, messages: 4});

  // What recall prints lands in the transcript of the session that ran it. A session excluded from capture
  // is therefore not read for another session, and an excluded session reads only itself.
  const config = (exclusions: object, extra: object = {}) => {
    mkdirSync(join(dir, 'config', 'opencrawl', 'capture'), {recursive: true});
    writeFileSync(join(dir, 'config', 'opencrawl', 'capture', 'config.json'), JSON.stringify({schemaVersion: 1, installedAt: '2026-01-01T00:00:00.000Z', exclusions, ...extra}));
  };
  config({projects: [], sessions: []});
  expect(recall(['staging database'])).toMatchObject({sessions: 2, matched: 3});
  for (const exclusions of [{projects: [], sessions: [earlier.session]}, {projects: [], sessions: [t.session]}, {projects: [join(realpathSync(dir), 'project')], sessions: []}]) {
    config(exclusions);
    expect(printed(['staging database'])).toBe(alone);
    expect(recall([], {user: true})).toMatchObject({sessions: 1, messages: 2});
  }
  // Nor is a session from before capture was installed: capture imports earlier history only with approval.
  config({projects: [], sessions: []}, {installedAt: new Date(Date.now() + 3_600_000).toISOString()});
  expect(printed(['staging database'])).toBe(alone);
  // Once capture is uninstalled nothing is uploaded, and recall reads the project again.
  config({projects: [], sessions: [earlier.session]}, {installedAt: new Date(Date.now() + 3_600_000).toISOString(), disabled: true});
  expect(recall(['staging database'])).toMatchObject({sessions: 2, matched: 3});
  // A configuration that cannot be read is no licence to read on.
  writeFileSync(join(dir, 'config', 'opencrawl', 'capture', 'config.json'), '{');
  expect(printed(['staging database'])).toBe(alone);
}));

test('opencrawl drift says what each compaction did to the exact details of what the user said', () => project(({transcripts, as, cli}) => {
  const t = transcriptFixture();
  t.user('Use `thumb_width` 240 on port 7070 for gallery-v2.');
  const kept = t.user('Release 3.8.1-rc2 goes first.');
  t.assistant('Working on it.');
  // The first compaction: the summary has two details, the harness kept a message with a third, and the record gave two back.
  t.hook('OpenCrawl verbatim record. Your context was just compacted into a summary, and summaries lose detail. The user has sent 2 messages in this session:');
  t.compaction('The user wants thumb_width 240.', [kept.uuid]);
  t.hook('Another tool says the port 7070 is busy and mentions 2,400,000.', 'PostToolUse');
  t.hook('OpenCrawl verbatim record. Your context was compacted into a summary a moment ago.\n\n[from message 1]\nUse `thumb_width` 240 on port 7070 for gallery-v2.', 'PostToolUse');
  t.queued('Cap uploads at 2,400,000.');
  // The second: nothing was given back.
  t.compaction('thumb_width 240; release 3.8.1-rc2.');
  const file = t.write(join(transcripts, t.session + '.jsonl'));
  const reports = compactionReports(readTranscript(file, {kinds: [...EVENT_KINDS, 'hook', 'boundary']}).events);
  expect(reports).toEqual([
    {compaction: 1, at: expect.any(String), details: 5, inSummary: 2, inContext: 3, restoredByRecord: 2, gone: []},
    {compaction: 2, at: expect.any(String), details: 6, inSummary: 3, inContext: 3, restoredByRecord: 0, gone: ['2,400,000', '7070', 'gallery-v2']}]);
  const table = "opencrawl drift: exact details of the user's messages (code, numbers, names) after each compaction\n"
    + 'compaction  details  in summary  in context  restored  gone\n'
    + '         1        5           2           3         2     0\n'
    + '         2        6           3           3         0     3\n\n';
  expect(formatDrift({compactions: reports, show: 12})).toBe(table + 'Gone from the context after the latest compaction (3): `2,400,000`, `7070`, `gallery-v2`\nRun `opencrawl recall "<one of them>"` to read the passage that holds it.');
  expect(formatDrift({compactions: reports.slice(0, 1), show: 12})).toEndWith('\n\nNothing the user wrote is missing from the context after the latest compaction.');

  const human = cli('drift', ['--limit', '2'], t.session);
  expect(human.stderr).toBe(''); expect(human.exit).toBe(0);
  expect(human.stdout).toBe(table + 'Gone from the context after the latest compaction (3): `2,400,000`, `7070` ...\nRun `opencrawl recall "<one of them>"` to read the passage that holds it.\n');
  const json = cli('drift', ['--session', t.session, '--json']);
  expect(json.exit).toBe(0);
  expect(JSON.parse(json.stdout)).toEqual({schemaVersion: 1, data: {session: t.session, transcript: file, compactions: reports}});
  // A session that was never compacted has not drifted.
  const fresh = transcriptFixture('dddddddd-0000-4000-8000-000000000001');
  fresh.user('Use `thumb_width` 240.');
  fresh.write(join(transcripts, fresh.session + '.jsonl'));
  expect(driftCommand([], {session: fresh.session}).compactions).toEqual([]);
  expect(formatDrift(as(fresh.session, () => driftCommand([], {})))).toBe('opencrawl drift: this session has not been compacted yet; nothing has drifted.');
  expect(() => driftCommand(['extra'], {})).toThrow('Use opencrawl drift [--session ID] [--json].');
  expect(() => driftCommand([], {limit: '0'})).toThrow('Use --limit 1..200.');
  expect(() => driftCommand([], {session: 'no-such-session'})).toThrow('No Claude Code transcript for session no-such-session');
  const failed = cli('drift', ['extra', '--json']);
  expect(JSON.parse(failed.stdout)).toMatchObject({schemaVersion: 1, error: {code: 'INVALID_USAGE'}});
  expect(failed.exit).toBe(64);
}));
