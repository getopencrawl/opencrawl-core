import {test, expect} from 'bun:test';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {queryTerms, rankPassages, formatRecall} from '../src/recall.ts';
import {readTranscript, RECORD_HEADING, TOOL_HEAD, TOOL_GAP} from '../src/transcript.ts';
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
  const text = formatRecall({session: 's', transcript: 'f', compactions: 1, ...result});
  expect(text).toStartWith("opencrawl recall: 4 passages matched in this session's transcript; showing 4, oldest first, verbatim. A later statement overrides an earlier one.\n\n--- [2026-01-05T08:00:01.000Z | the user said] ---\nBuild the gallery importer.");
  expect(text).toContain('\n\n--- [2026-01-05T08:01:05.000Z | the user said (while you were working)] ---\nChange of plan: the cache size is now 512, not 640.');
  expect(formatRecall({session: 's', transcript: 'f', compactions: 0, ...rankPassages(all, 'zeppelin')})).toBe(`opencrawl recall: nothing in this session's transcript matched "zeppelin". Try fewer or more distinctive words.`);
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
  expect(formatRecall({session: 's', transcript: 'f', compactions: 0, ...found})).toContain(`--- [2026-01-05T08:00:00.000Z | a tool returned | from character ${passage!.offset}] ---`);
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
    expect(data).toMatchObject({session: t.session, transcript, compactions: 1, query: 'cache size', terms: ['cache', 'size'], matched: 4});
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
    expect(record.stdout).toStartWith(RECORD_HEADING + '\n\n[message 1, sent 2026-01-05T08:00:01.000Z]\nBuild the gallery importer.');
    expect(record.stdout).toEndWith('[message 2, sent 2026-01-05T08:01:05.000Z]\nChange of plan: the cache size is now 512, not 640.\n');
    expect(JSON.parse(run(['--user', '--session', t.session, '--json']).stdout).data).toMatchObject({session: t.session, messages: 2});
    for (const [args, code] of [[[], 'INVALID_USAGE'], [['cache', '--kind', 'everything'], 'INVALID_USAGE'], [['cache', '--limit', '0'], 'INVALID_USAGE'], [['cache', '--chars', '9'], 'INVALID_USAGE'],
      [['cache', '--user'], 'INVALID_USAGE'], [['cache', '--session', 'no-such-session'], 'TRANSCRIPT_NOT_FOUND'], [['cache'], 'TRANSCRIPT_NOT_FOUND']] as const) {
      const failed = run([...args, '--json']);
      expect(JSON.parse(failed.stdout)).toMatchObject({schemaVersion: 1, error: {code}});
      expect(failed.exit).toBe(code === 'INVALID_USAGE' ? 64 : 1);
    }
  } finally {rmSync(dir, {recursive: true, force: true});}
});
