import {test, expect} from 'bun:test';
import {mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {gunzipSync} from 'node:zlib';
import {createLocalSessionStore} from '../../dist/src/sessions/local-store.mjs';
import {createSessionIngest} from '../../dist/src/sessions/ingest.mjs';
import {batchDocuments} from '../../dist/src/sessions/indexer.mjs';
import {transcriptEntries} from '../../dist/src/sessions/library.mjs';
import {standaloneCapture} from '../../dist/tools/test-fixtures/capture.mjs';
import {captureDir, captureHook, captureStatus, drainCaptureNotices, flushCaptureWork} from '../src/capture/runtime.ts';
import {hash} from '../src/capture/parse.ts';

// Exercise the same durable spool, receiver, stored transcript and indexer used
// by other clients. These are synthetic hook contracts, not live Cloud proof.
test('Devin hooks survive a lost upload receipt and stay distinct, searchable and tenant scoped', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'opencrawl-devin-pipeline-'));
  const saved = {...process.env};
  const principal = {tenantId: 'synthetic-tenant-a', userId: 'synthetic-owner'};
  const token = 'synthetic-devin-upload-token-0123456789';
  const store = createLocalSessionStore(join(scratch, 'objects'));
  const ingest = createSessionIngest(({store, onStored: undefined}));
  const fallback = standaloneCapture(({token, principal, store}));
  const received: any[] = [];
  let loseReceipt = true;
  const server = createServer(async (req, res) => {
    if (req.url !== '/api/sessions/batches') return fallback(req, res);
    if (req.headers.authorization !== 'Bearer ' + token) {res.writeHead(401); res.end('{}'); return;}
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const batch = JSON.parse((req.headers['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes).toString());
    received.push(batch);
    const result = await ingest.putBatch(principal, batch);
    res.writeHead(loseReceipt ? 401 : 200, {'content-type': 'application/json'});
    res.end(JSON.stringify(loseReceipt ? {error: {code: 'SYNTHETIC_LOST_RECEIPT'}} : {data: result}));
  });
  try {
    await new Promise<void>((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
    const api = 'http://127.0.0.1:' + (server.address() as {port: number}).port;
    Object.assign(process.env, {OPENCRAWL_CONFIG_HOME: join(scratch, 'config'), OPENCRAWL_API_URL: api,
      OPENCRAWL_SESSIONS_TOKEN: token, OPENCRAWL_NO_UPDATE: '1'});
    delete process.env.OPENCRAWL_AUTH;
    delete process.env.OPENCRAWL_TOKEN;
    mkdirSync(captureDir(), {recursive: true});
    writeFileSync(join(captureDir(), 'config.json'), JSON.stringify({schemaVersion: 1, hookMode: 'native-v4',
      harnesses: ['devin'], api, installationId: 'synthetic-installation', owner: principal,
      installedAt: new Date().toISOString(), roots: {'claude-code': join(scratch, 'claude'), codex: join(scratch, 'codex')}, command: [process.execPath]}));
    const hook = (hook_event_name: string, values: Record<string, unknown> = {}) => ({hook_event_name,
      session_id: 'devin-native-synthetic', prompt_id: 'turn-one', ...values});
    const longOutput = 'OC_DEVIN_LONG_START\n' + 'synthetic output\n'.repeat(15000) + 'OC_DEVIN_LONG_END';
    const events = [
      hook('SessionStart', {prompt_id: undefined}),
      hook('UserPromptSubmit', {prompt: 'OC_DEVIN_FIRST_PROMPT'}),
      hook('PostToolUse', {tool_name: 'exec', tool_input: {command: 'synthetic repeated command'}, tool_response: {success: true, output: longOutput, error: null}}),
      hook('PostToolUse', {tool_name: 'exec', tool_input: {command: 'synthetic repeated command'}, tool_response: {success: true, output: longOutput, error: null}}),
      hook('PostToolUse', {tool_name: 'exec', tool_response: {success: false, output: 'partial output', error: 'OC_DEVIN_ERROR'}}),
      hook('PostCompaction', {summary: 'OC_DEVIN_COMPACTION'}),
      hook('Stop', {last_assistant_message: 'OC_DEVIN_FIRST_REPLY'}),
      hook('SessionStart', {prompt_id: undefined}),
      hook('UserPromptSubmit', {prompt_id: 'turn-two', prompt: 'OC_DEVIN_RESUME_PROMPT'}),
      hook('Stop', {prompt_id: 'turn-two', last_assistant_message: 'OC_DEVIN_RESUME_REPLY'}),
    ];
    for (const event of events) await captureHook('devin', event);
    expect(captureStatus().pendingHooks).toBe(events.length);
    expect(received).toHaveLength(0); // Native hooks hand off locally first.
    expect(await drainCaptureNotices()).toBe(events.length);
    expect(await drainCaptureNotices()).toBe(0);
    expect(captureStatus().pendingHooks).toBe(0);
    await expect(flushCaptureWork()).rejects.toThrow();
    expect(received.length).toBeGreaterThan(0);
    expect(captureStatus().queued).toBeGreaterThan(0);
    const firstWire = JSON.stringify(received[0]);
    // A later process can finish from durable files without reading the hook
    // input again. Its retry must retain the immutable batch and event IDs.
    loseReceipt = false;
    await flushCaptureWork();
    expect(received.some((batch, index) => index > 0 && JSON.stringify(batch) === firstWire)).toBe(true);
    expect(captureStatus()).toMatchObject({queued: 0, pendingHooks: 0, lastError: null});
    const unique = [...new Map(received.map(batch => [hash(JSON.stringify(batch)), batch])).values()];
    const all = unique.flatMap(batch => batch.events).sort((a, b) => a.sequence - b.sequence);
    const messages = all.filter(event => event.kind === 'message');
    expect(messages.map(event => event.data.content[0].text)).toEqual([
      'OC_DEVIN_FIRST_PROMPT', 'OC_DEVIN_FIRST_REPLY', 'OC_DEVIN_RESUME_PROMPT', 'OC_DEVIN_RESUME_REPLY',
    ]);
    expect(messages.map(event => event.turnId)).toEqual(['turn-one', 'turn-one', 'turn-two', 'turn-two']);
    const calls = all.filter(event => event.kind === 'tool_call');
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map(event => event.data.call_id)).size).toBe(3);
    const results = all.filter(event => event.kind === 'tool_result');
    expect(results[0].data.output).toBe(longOutput);
    const renderedFailure = transcriptEntries(results[2])[0];
    if (renderedFailure?.type !== 'tool_result') throw new Error('Missing rendered tool result');
    expect(renderedFailure.text).toContain('OC_DEVIN_ERROR');
    expect(all.every(event => /^wire1:[a-f0-9]{64}$/.test(event.id))).toBe(true);
    expect(new Set(all.map(event => event.id)).size).toBe(all.length);
    const documents: any[] = [];
    for (const batch of unique) {
      expect(batch).toMatchObject({harness: 'devin', origin: 'cloud', sessionId: 'devin-native-synthetic', owner: principal});
      const identity = {harness: 'devin', installationId: batch.installationId, sessionId: batch.sessionId, batchId: hash(JSON.stringify(batch))};
      const stored = await ingest.getBatch(principal, identity);
      expect(stored).not.toBeNull();
      expect(await ingest.getBatch({...principal, tenantId: 'synthetic-tenant-b'}, identity)).toBeNull();
      const key = `capture-v1/tenants/${hash(principal.tenantId)}/users/${hash(principal.userId)}/devin/${hash(batch.installationId)}/${hash(batch.sessionId)}/${identity.batchId}.json.gz`;
      documents.push(...batchDocuments({prefix: 'capture-v1', key, batch: stored!, principal}).map(item => item.document));
    }
    expect(documents.some(document => document.role === 'user' && document.text.includes('OC_DEVIN_FIRST_PROMPT'))).toBe(true);
    expect(documents.some(document => document.role === 'assistant' && document.text.includes('OC_DEVIN_RESUME_REPLY'))).toBe(true);
    expect(documents.some(document => document.kind === 'tool_result' && document.text.includes('OC_DEVIN_ERROR'))).toBe(true);
    expect(documents.some(document => document.kind === 'hook')).toBe(false);
    expect(readdirSync(join(captureDir(), 'queue'))).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(scratch, {recursive: true, force: true});
  }
});
