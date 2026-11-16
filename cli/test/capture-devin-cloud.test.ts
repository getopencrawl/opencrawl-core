import {expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {devinEvents, devinOverflow, DEVIN_MAX_HOOK_BYTES} from '../src/capture/devin.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/devin-cloud/hooks.json', import.meta.url), 'utf8'));
const records: Array<{file: string; event: Record<string, any>}> = fixture.records;
const notice = (record: typeof records[number], sequence = 100) => ({id: record.file, at: '2026-11-16T03:08:00.000Z', sequence, event: record.event});

test('live Cloud payloads expose delivered assistant messages and an explicit first-turn gap', () => {
  const events = records.flatMap((record, i) => devinEvents(notice(record, i * 3)));
  const messages = events.filter(event => event.kind === 'message');
  expect(messages.filter(event => event.data.role === 'user')).toHaveLength(1);
  expect(messages.filter(event => event.data.role === 'assistant')).toHaveLength(3);
  const assistants = messages.filter(event => event.data.role === 'assistant');
  expect(assistants.map(event => event.data.final).sort()).toEqual([false, true, true]);
  expect(JSON.stringify(assistants)).toContain('OC_DEVIN_INTERIM_0a4f7b82');
  expect(JSON.stringify(assistants)).toContain('OC_DEVIN_REPLY_543d890a');
  expect(JSON.stringify(assistants)).toContain('OC_DEVIN_REPLY_2_c1500bf8');
  const firstTurn = records.find(record => record.event.hook_event_name === 'SessionStart')!.event.prompt_id;
  expect(records.filter(record => record.event.prompt_id === firstTurn).map(record => record.event.hook_event_name).sort())
    .toEqual(['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop']);
  expect(events.filter(event => event.kind === 'tool_call' && event.data.name === 'exec')).toHaveLength(4);
  expect(events.filter(event => event.kind === 'hook' && event.data.hook_event_name === 'Stop')).toHaveLength(2);
  const repeatCalls = events.filter(event => event.kind === 'tool_call' && event.data.name === 'exec' && JSON.stringify(event.data.input).includes('echo OC_DEVIN_REPEAT'));
  expect(repeatCalls).toHaveLength(2);
  expect(new Set(repeatCalls.map(event => event.nativeId)).size).toBe(2);
  expect(new Set(events.map(event => event.sequence)).size).toBe(events.length);
});

test('Cloud transport success does not hide a nonzero command exit', () => {
  const failed = records.find(record => record.event.hook_event_name === 'PostToolUse' && record.event.tool_input?.command?.includes('exit 7'))!;
  expect(devinEvents(notice(failed))[1]).toMatchObject({kind: 'tool_result', data: {
    transport_success: true, is_error: true, exit_code: 7,
  }});
  const unavailable = {...failed, event: {...failed.event, tool_response: {success: true, output: 'unstructured Exit code: 7', error: null}}};
  expect(devinEvents(notice(unavailable))[1]!.data).not.toHaveProperty('exit_code');
});

test('failed or pending message_user attempts never fabricate delivered assistant text', () => {
  const delivered = records.find(record => record.event.tool_name === 'message_user' && record.event.hook_event_name === 'PostToolUse')!;
  for (const event of [
    {...delivered.event, hook_event_name: 'PreToolUse'},
    {...delivered.event, tool_response: {success: false, output: null, error: 'not sent'}},
  ]) expect(devinEvents(notice({...delivered, event})).some(event => event.kind === 'message')).toBe(false);
});

test('worker restores the complete observed overflow shape and reports unavailable output honestly', async () => {
  const scratch = await realpath(mkdtempSync(join(tmpdir(), 'opencrawl-devin-overflow-')));
  try {
    const pool = join(scratch, 'pool'), dir = join(pool, 'shell-synthetic');
    mkdirSync(dir, {recursive: true});
    // Exact synthetic output commanded in the Cloud probe, verified against
    // the downloaded source: 5,001 lines, 138,920 bytes including final newline.
    const output = Array.from({length: 5000}, (_, i) => `${i + 1} OC_DEVIN_LONG_4623bb10\n`).join('') + 'OC_DEVIN_LONG_END_b4cc78fd\n';
    expect(Buffer.byteLength(output)).toBe(138920);
    const path = join(dir, 'content.txt');
    writeFileSync(path, output);
    const source = records.find(record => record.event.tool_response?.overflow_path)!;
    const event = {...source.event, tool_response: {...source.event.tool_response, overflow_path: path}};
    const recovered = await devinOverflow(event, pool);
    expect(recovered?.status).toBe('captured');
    if (recovered?.status !== 'captured') throw new Error('Missing recovered output');
    expect(recovered.bytes).toBe(138920);
    expect(recovered.output === output).toBe(true);
    const result = devinEvents(notice({...source, event}), recovered)[1]!;
    expect(result.data.output).toBe(output);
    expect(result.data).toMatchObject({exit_code: 0, is_error: false, outputCapture: {status: 'captured', bytes: 138920}});
    expect(devinEvents(notice({...source, event}))[1]!.data.outputCapture).toMatchObject({status: 'unavailable'});
    rmSync(path);
    expect(await devinOverflow(event, pool)).toEqual({status: 'unavailable'});
    writeFileSync(path, Buffer.alloc(DEVIN_MAX_HOOK_BYTES + 1));
    expect(await devinOverflow(event, pool)).toEqual({status: 'too_large'});
  } finally { rmSync(scratch, {recursive: true, force: true}); }
});

test('worker overflow admission accepts native Windows relative separators without relaxing file guards', async () => {
  const scratch = await realpath(mkdtempSync(join(tmpdir(), 'opencrawl-devin-separators-')));
  try {
    const pool = join(scratch, 'pool'), dir = join(pool, 'shell-synthetic');
    mkdirSync(dir, {recursive: true});
    const path = join(dir, 'content.txt'), output = 'synthetic complete native output';
    writeFileSync(path, output);
    // Exercise the Windows path.relative/sep contract in a separate process;
    // filesystem canonicalization and guarded open still read the real file.
    // This does not claim native Windows O_NOFOLLOW/filesystem acceptance.
    const script = `
      import {mock} from 'bun:test';
      const native = {...await import('node:path')};
      mock.module('node:path', () => ({...native, sep: '\\\\',
        relative: (from, to) => native.relative(from, to).split(native.sep).join('\\\\')}));
      const {devinOverflow} = await import(${JSON.stringify(new URL('../src/capture/devin.ts', import.meta.url).href)});
      const pool = ${JSON.stringify(pool)};
      const event = path => ({hook_event_name: 'PostToolUse', tool_name: 'exec', tool_response: {overflow_path: path}});
      const results = await Promise.all([
        devinOverflow(event(${JSON.stringify(path)}), pool),
        devinOverflow(event(${JSON.stringify(join(pool, 'shell-synthetic', 'nested', 'content.txt'))}), pool),
        devinOverflow(event(${JSON.stringify(join(scratch, 'shell-outside', 'content.txt'))}), pool),
        devinOverflow(event(${JSON.stringify(join(pool, 'shell-synthetic', 'other.txt'))}), pool),
      ]);
      process.stdout.write(JSON.stringify(results));
    `;
    const child = Bun.spawn([process.execPath, '--eval', script], {
      env: {HOME: scratch, USERPROFILE: scratch, OPENCRAWL_CONFIG_HOME: join(scratch, 'config')},
      stdout: 'pipe', stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe(''); expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual([
      {status: 'captured', output, bytes: Buffer.byteLength(output), sha256: expect.any(String)},
      {status: 'outside_root'}, {status: 'outside_root'}, {status: 'outside_root'},
    ]);
  } finally { rmSync(scratch, {recursive: true, force: true}); }
});

test('overflow reads are confined to regular native output files, never arbitrary tool paths', async () => {
  const scratch = await realpath(mkdtempSync(join(tmpdir(), 'opencrawl-devin-scope-')));
  try {
    const pool = join(scratch, 'pool'), native = join(pool, 'shell-test');
    mkdirSync(native, {recursive: true});
    const unrelated = join(scratch, 'private.txt');
    writeFileSync(unrelated, 'synthetic unrelated data');
    const event = (path: string) => ({hook_event_name: 'PostToolUse', tool_name: 'exec', tool_response: {overflow_path: path}});
    expect(await devinOverflow(event(unrelated), pool)).toEqual({status: 'outside_root'});
    expect(await devinOverflow(event('../private.txt'), pool)).toEqual({status: 'outside_root'});
    symlinkSync(unrelated, join(native, 'content.txt'));
    expect(await devinOverflow(event(join(native, 'content.txt')), pool)).toEqual({status: 'outside_root'});
    symlinkSync(scratch, join(pool, 'shell-link'));
    writeFileSync(join(scratch, 'content.txt'), 'synthetic unrelated data');
    expect(await devinOverflow(event(join(pool, 'shell-link', 'content.txt')), pool)).toEqual({status: 'outside_root'});
    rmSync(join(native, 'content.txt'));
    mkdirSync(join(native, 'content.txt'));
    expect(await devinOverflow(event(join(native, 'content.txt')), pool)).toEqual({status: 'not_regular'});
    expect(await devinOverflow({...event(unrelated), tool_name: 'message_user'}, pool)).toBeUndefined();
    expect(await devinOverflow({hook_event_name: 'PostToolUse', tool_name: 'exec', tool_input: {overflow_path: unrelated}}, pool)).toBeUndefined();
  } finally { rmSync(scratch, {recursive: true, force: true}); }
});
