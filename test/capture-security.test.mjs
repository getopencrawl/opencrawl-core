import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createSessionIngest, sessionScope, digest, MAX_ATTACHMENT_BYTES, MAX_BATCH_BYTES} from '../src/sessions/ingest.mjs';
import {createObjectStore} from '../src/sessions/s3-store.mjs';
import {createOnboardingStatus} from '../src/onboarding-status.mjs';

const owner = {tenantId: 'team-a', userId: 'author'};
const batch = attachments => ({schemaVersion: 1, owner, installationId: 'device', sessionId: 'session',
  harness: 'codex', origin: 'cli', events: [{id: 'event', kind: 'message', data: 'fixture'}], attachments});

test('batch validation rejects malformed or oversized input before reading any stored objects', async () => {
  const ingest = createSessionIngest({store: {get: async () => assert.fail('must validate before storage access'), put: async () => assert.fail()}});
  const captured = {status: 'captured', sha256: digest('fixture')};
  await assert.rejects(ingest.putBatch(owner, {...batch([captured]), extra: 'x'.repeat(MAX_BATCH_BYTES)}), {status: 413});
  await assert.rejects(ingest.putBatch(owner, batch([captured, null])), {status: 400});
  await assert.rejects(ingest.putBatch(owner, {...batch([]), events: [null]}), {status: 400});
});

test('repeated attachment references use one bounded metadata check and never download bodies', async () => {
  const calls = [], bytes = Buffer.from('fixture'), hash = digest(bytes);
  const ingest = createSessionIngest({store: {
    get: async () => assert.fail('metadata-capable stores must not download attachments'),
    has: async (key, options) => {calls.push({key, options}); return key.endsWith('/attachments/' + hash);},
    put: async () => {},
  }});
  const value = batch(Array.from({length: 1000}, () => ({status: 'captured', sha256: hash})));
  assert.equal((await ingest.putBatch(owner, value)).stored, true);
  const attachments = calls.filter(call => call.key.includes('/attachments/'));
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].options.maxBytes, MAX_ATTACHMENT_BYTES);
});

test('get-only stores check each attachment once with a bound', async () => {
  const calls = [], bytes = Buffer.from('fixture'), hash = digest(bytes);
  const ingest = createSessionIngest({store: {
    get: async (key, options) => {calls.push({key, options}); return key.endsWith('/attachments/' + hash) ? bytes : null;}, put: async () => {},
  }});
  await ingest.putBatch(owner, batch([{status: 'captured', sha256: hash}, {status: 'captured', sha256: hash}]));
  assert.equal(calls.filter(call => call.key.includes('/attachments/')).length, 1);
  assert.equal(calls[0].options.maxBytes, MAX_ATTACHMENT_BYTES);
  assert.ok(calls.every(call => Number.isSafeInteger(call.options.maxBytes)));
});

test('upload-only principals cannot read batches or onboarding through direct core operations', async () => {
  const store = {get: async () => assert.fail('unauthorized reads must not reach storage'), put: async () => {}};
  const principal = {...owner, captureAccess: 'write'};
  await assert.rejects(createSessionIngest({store}).getBatch(principal, {}), {status: 403});
  await assert.rejects(createOnboardingStatus({store}).read(principal), {status: 403});
});

test('S3 metadata checks distinguish missing, bounded and oversized objects', async () => {
  const requests = [];
  const store = createObjectStore({bucket: 'fixture', credentials: {accessKeyId: 'test', secretAccessKey: 'test'}, fetch: async (url, options) => {
    requests.push(options.method);
    if (url.pathname.endsWith('/missing')) return new Response(null, {status: 404});
    return new Response(null, {headers: {'content-length': url.pathname.endsWith('/oversized') ? '33' : '32'}});
  }});
  assert.equal(await store.has('missing', {maxBytes: 32}), false);
  assert.equal(await store.has('valid', {maxBytes: 32}), true);
  await assert.rejects(store.has('oversized', {maxBytes: 32}), /read limit/);
  assert.deepEqual(requests, ['HEAD', 'HEAD', 'HEAD']);
});

test('signed S3 requests do not follow redirects or disclose credential headers', async t => {
  const targetRequests = [];
  const target = createServer((req, res) => {targetRequests.push(req.headers); res.end('redirected');});
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => target.close(resolve)));
  const source = createServer((req, res) => {
    res.writeHead(307, {location: 'http://127.0.0.1:' + target.address().port + '/capture'}); res.end();
  });
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => source.close(resolve)));
  const store = createObjectStore({endpoint: 'http://127.0.0.1:' + source.address().port, bucket: 'fixture',
    credentials: {accessKeyId: 'test', secretAccessKey: 'test', sessionToken: 'sensitive-session-token'}});
  await assert.rejects(store.get('object'), /fetch failed/);
  await assert.rejects(store.put('object', 'private fixture'), /fetch failed/);
  assert.equal(targetRequests.length, 0);
});


test('unknown capture capabilities fail closed before upload or read storage access', async () => {
  const store = {get: async () => assert.fail('unknown capability must not read'), put: async () => assert.fail('unknown capability must not write')};
  const ingest = createSessionIngest({store}), onboarding = createOnboardingStatus({store});
  const bytes = Buffer.from('fixture');
  assert.equal(sessionScope({...owner, captureAccess: 'write'}), sessionScope(owner));
  for (const captureAccess of ['read', '', null, false, {}]) {
    const principal = {...owner, captureAccess};
    assert.throws(() => sessionScope(principal), {status: 403});
    await assert.rejects(ingest.putAttachment(principal, digest(bytes), bytes), {status: 403});
    await assert.rejects(ingest.putBatch(principal, batch([])), {status: 403});
    await assert.rejects(ingest.getBatch(principal, {}), {status: 403});
    await assert.rejects(onboarding.read(principal), {status: 403});
  }
});
