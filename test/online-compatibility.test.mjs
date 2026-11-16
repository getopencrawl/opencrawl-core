import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {lstatSync, readFileSync, writeFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {resolve, relative, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import {LEGACY_ONLINE_PACKAGE, LEGACY_ONLINE_MODULES, verifyLegacyArchiveIntegrity, verifyLegacyPackageMetadata, verifyLegacyArchiveMember} from '../tools/online-compatibility.mts';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const expectedGraph = [
  'dist/src/sessions/s3-store.mjs -> ./types.mjs',
  'dist/src/sessions/s3-store.mjs -> node:crypto',
  'dist/src/sessions/s3-store.mjs -> node:fs/promises',
].sort();
function importEdge(parent, specifier) {
  const edge = parent + ' -> ' + specifier;
  assert.ok(expectedGraph.includes(edge), 'Unexpected runtime import in exact legacy adapter');
  return edge;
}
function metadata() {
  return [{name: LEGACY_ONLINE_PACKAGE.name, version: LEGACY_ONLINE_PACKAGE.version, exports: {'./sessions/s3-store': './dist/src/sessions/s3-store.mjs'}}, {revision: LEGACY_ONLINE_PACKAGE.revision}];
}

test('published compatibility input pins exact package integrity, revision and owned export', () => {
  verifyLegacyPackageMetadata(...metadata());
  for (const change of [m => {m[0].version = '0.4.1';}, m => {m[0].name = 'other';}, m => {m[1].revision = '0'.repeat(40);}, m => {m[0].exports['./sessions/s3-store'] = './src/sessions/s3-store.mts';}]) {
    const value = metadata(); change(value); assert.throws(() => verifyLegacyPackageMetadata(...value));
  }
  assert.throws(() => verifyLegacyArchiveIntegrity(Buffer.from('unverified package')), /integrity differs/);
  assert.throws(() => verifyLegacyArchiveIntegrity(Buffer.alloc(0)), /bound/);
});

test('archive selection accepts only fixed regular members, never paths or links', () => {
  const member = 'package/dist/src/sessions/s3-store.mjs';
  verifyLegacyArchiveMember(member, '-rw-r--r-- 0/0 123 2026-11-16 00:00 ' + member + '\n');
  for (const path of ['../package.json', '/package/package.json', 'package/dist/../src/sessions/s3-store.mjs', 'package/node_modules/code.mjs']) assert.throws(() => verifyLegacyArchiveMember(path, '-rw-r--r-- ' + path));
  for (const details of ['lrwxrwxrwx ' + member + ' -> /tmp/code', 'hrw-r--r-- ' + member + ' link to other', '-rw-r--r-- ' + member + '\n-rw-r--r-- ' + member, '-rw-r--r-- package/wrong.mjs']) assert.throws(() => verifyLegacyArchiveMember(member, details));
});

test('published adapter dependency allowlist rejects extra code and traversals', () => {
  for (const name of ['./types.mjs', 'node:crypto', 'node:fs/promises']) importEdge(LEGACY_ONLINE_MODULES[0], name);
  for (const name of ['../../state/online-journal.mjs', './types.mts', 'node:child_process', 'undici', 'file:///tmp/code.mjs']) assert.throws(() => importEdge(LEGACY_ONLINE_MODULES[0], name));
  assert.throws(() => importEdge(LEGACY_ONLINE_MODULES[1], 'node:crypto'));
});

/** Synthetic transport only: both adapters make their real signed requests.
 * ETags depend on body bytes, as S3 does; the bridge itself must prevent ABA. */
function fakeS3() {
  const objects = new Map(), counts = {GET: 0, HEAD: 0, PUT: 0, DELETE: 0, LIST: 0, acceptedPuts: 0, conditionalRefusals: 0};
  let loseReplyFor = null;
  const missing = () => new Response('<Error><Code>NoSuchKey</Code></Error>', {status: 404});
  const fetch = async (input, init) => {
    const url = new URL(input), headers = new Headers(init.headers);
    assert.equal(url.origin, 'https://compatibility-fixture.s3.us-west-2.amazonaws.com');
    assert.equal(init.redirect, 'error'); assert.match(headers.get('authorization'), /^AWS4-HMAC-SHA256 /);
    const key = url.pathname.slice(1).split('/').map(decodeURIComponent).join('/');
    assert.ok(['GET', 'HEAD', 'PUT', 'DELETE'].includes(init.method));
    if (init.method === 'GET' && url.searchParams.get('list-type') === '2') {
      counts.LIST++;
      const prefix = url.searchParams.get('prefix') ?? '', limit = Number(url.searchParams.get('max-keys'));
      assert.ok(Number.isInteger(limit) && limit >= 1 && limit <= 1000);
      assert.equal(url.searchParams.get('continuation-token'), null, 'Fixture fits a single bounded physical page');
      const keys = [...objects.keys()].filter(k => k.startsWith(prefix)).sort(); assert.ok(keys.length <= limit);
      return new Response('<ListBucketResult><IsTruncated>false</IsTruncated>' + keys.map(k => '<Contents><Key>' + k + '</Key></Contents>').join('') + '</ListBucketResult>');
    }
    counts[init.method]++;
    const old = objects.get(key);
    if (init.method === 'GET' || init.method === 'HEAD') {
      if (key === '' && init.method === 'HEAD') return new Response(null);
      return old ? new Response(init.method === 'HEAD' ? null : old.bytes, {headers: {...Object.fromEntries(old.headers), etag: old.version, 'content-length': String(old.bytes.length)}}) : missing();
    }
    if (init.method === 'DELETE') {objects.delete(key); return new Response(null, {status: 204});}
    if (headers.get('if-none-match') === '*' && old || headers.has('if-match') && headers.get('if-match') !== old?.version) {
      counts.conditionalRefusals++; return new Response('<Error><Code>PreconditionFailed</Code></Error>', {status: 412});
    }
    const bytes = Buffer.from(init.body);
    const metadata = new Headers([...headers].filter(([k]) => k === 'content-type' || k.startsWith('x-amz-meta-')));
    const version = '"' + createHash('md5').update(bytes).digest('hex') + '"';
    objects.set(key, {bytes, headers: metadata, version}); counts.acceptedPuts++;
    if (key === loseReplyFor) {loseReplyFor = null; throw new Error('synthetic lost response after accepted PutObject');}
    return new Response(null, {headers: {etag: version}});
  };
  return {objects, counts, fetch, loseNextReply: key => {loseReplyFor = key;}};
}

const directory = process.env.OPENCRAWL_ONLINE_COMPATIBILITY_DIR;
test('exact published core428 adapter composes with gated journal writes and PostgreSQL recovery', {skip: !directory, timeout: 90_000}, async t => {
  const root = resolve(directory), legacyRoot = resolve(root, 'legacy'), completed = [], graph = new Set();
  let verified, verifiedArchiveSha256 = null, verifiedModules = [], hook, admin, pool, authorityPool, schema, fixture, passed = false, cleanupComplete = false, journalCounts;
  const currentRevision = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8', maxBuffer: 4096}).trim();
  try {
    assert.match(currentRevision, /^[a-f0-9]{40}$/);
    verified = JSON.parse(readFileSync(resolve(root, 'verified.json'), 'utf8'));
    assert.equal(verified.format, 1); assert.equal(verified.kind, 'verified-published-online-compatibility-input');
    assert.deepEqual(verified.legacy, LEGACY_ONLINE_PACKAGE); assert.equal(verified.currentRevision, currentRevision);
    assert.equal(verified.archive.filename, 'legacy-core-428.tgz');
    const archivePath = resolve(root, verified.archive.filename), archiveStat = lstatSync(archivePath);
    assert.ok(archiveStat.isFile() && !archiveStat.isSymbolicLink() && archiveStat.size <= 128 * 1024 * 1024);
    const archive = readFileSync(archivePath); verifyLegacyArchiveIntegrity(archive);
    assert.equal(archive.length, verified.archive.bytes); assert.equal(sha256(archive), verified.archive.sha256);
    assert.deepEqual(verified.modules.map(m => m.path), LEGACY_ONLINE_MODULES);
    for (const module of verified.modules) {
      const file = resolve(legacyRoot, module.path), stat = lstatSync(file);
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 4 * 1024 * 1024);
      const bytes = readFileSync(file); assert.equal(bytes.length, module.bytes); assert.equal(sha256(bytes), module.sha256);
      verifiedModules.push({path: module.path, bytes: bytes.length, sha256: sha256(bytes)});
    }
    verifiedArchiveSha256 = sha256(archive);
    // Validate every actual runtime dependency, including lazy imports during
    // operations, before allowing resolution. No current-source stand-in.
    hook = registerHooks({resolve(specifier, context, nextResolve) {
      if (context.parentURL?.startsWith(pathToFileURL(legacyRoot + sep).href)) {
        const parent = relative(legacyRoot, fileURLToPath(context.parentURL)).split(sep).join('/');
        graph.add(importEdge(parent, specifier));
        const answer = nextResolve(specifier, context);
        assert.equal(answer.url, specifier.startsWith('node:') ? specifier : pathToFileURL(resolve(legacyRoot, LEGACY_ONLINE_MODULES[1])).href);
        return answer;
      }
      return nextResolve(specifier, context);
    }});
    const {createObjectStore} = await import(pathToFileURL(resolve(legacyRoot, LEGACY_ONLINE_MODULES[0])).href);
    assert.equal(typeof createObjectStore, 'function'); assert.deepEqual([...graph].sort(), expectedGraph);
    const [{Pool}, {createOnlineJournal}, {createOnlineWriteAuthority}, {createOnlineMigrationS3Store}, {createOnlineMigrationObjectStore}] = await Promise.all([
      import('pg'), import('../dist/src/state/online-journal.mjs'), import('../dist/src/state/online-authority.mjs'),
      import('../dist/src/state/online-s3.mjs'), import('../dist/src/state/online-object-store.mjs'),
    ]);
    assert.ok(process.env.OPENCRAWL_TEST_POSTGRES_URL, 'Compatibility job requires actual PostgreSQL; it cannot silently skip');
    const url = new URL(process.env.OPENCRAWL_TEST_POSTGRES_URL);
    assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.search === '', 'Compatibility test accepts only a local PostgreSQL service');
    admin = new Pool({connectionString: url.href, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000});
    schema = 'oc_online_compat_' + randomUUID().replaceAll('-', ''); await admin.query('CREATE SCHEMA ' + schema);
    const options = {connectionString: url.href, max: 4, options: '-c search_path=' + schema, application_name: schema, connectionTimeoutMillis: 5000, query_timeout: 10000};
    pool = new Pool(options); authorityPool = new Pool({...options, max: 2});
    const namespace = 'compatibility-fixture', epoch = randomUUID(), sourceId = 'compatibility-source';
    let journal = createOnlineJournal({database: {pool, namespace}, epoch, sourceId}); await journal.ready();
    const authority = createOnlineWriteAuthority({database: {pool: authorityPool, namespace}, epoch, protocol: 'compatibility-fixture-v1'});
    await authority.prepare({receiptHash: 'a'.repeat(64)});
    fixture = fakeS3();
    const credentials = {accessKeyId: 'synthetic-fixture', secretAccessKey: 'synthetic-fixture'};
    const raw = createObjectStore({bucket: 'compatibility-fixture', region: 'us-west-2', credentials, fetch: fixture.fetch});
    const external = createOnlineMigrationS3Store({bucket: raw.bucket, region: 'us-west-2', credentials, fetch: fixture.fetch, epoch, sourceId, prefixes: ['state/']});
    const classify = key => key.startsWith('state/') ? {maxBytes: 4096} : null;
    const wrap = () => createOnlineMigrationObjectStore({raw, external, journal, classify, sourceId, writeAuthority: authority});
    let store = wrap();
    const count = async () => Number((await pool.query('SELECT count(*) AS count FROM opencrawl_online_migration_journal')).rows[0].count);
    async function check(name, run) {
      let success = false;
      await t.test(name, async () => {await run(); success = true;});
      assert.equal(success, true, 'Compatibility case failed; no passed receipt may be emitted');
      completed.push(name);
    }

    await check('published legacy bytes and conditional updates remain readable before activation', async () => {
      await raw.put('state/setting', Buffer.from('legacy'), 'text/plain');
      assert.deepEqual(await store.get('state/setting'), Buffer.from('legacy'));
      const observed = await store.readVersion('state/setting');
      assert.equal(await store.compareAndSet('state/setting', 'stale', Buffer.from('bad')), false);
      assert.equal(await store.compareAndSet('state/setting', observed.version, Buffer.from('legacy-next')), true);
      assert.deepEqual(await raw.get('state/setting'), Buffer.from('legacy-next'));
      assert.equal(fixture.objects.get('state/setting').headers.has('x-amz-meta-opencrawl-state-bridge'), false);
      assert.equal(await count(), 0);
    });
    await check('missing or mismatched enrollment cannot enable shadow writes', async () => {
      await assert.rejects(authority.activate({receiptHash: 'b'.repeat(64), verify: async binding => ({...binding, epoch: randomUUID(), receiptHash: 'b'.repeat(64)})}), {code: 'ONLINE_AUTHORITY_ENROLLMENT_EVIDENCE_MISMATCH'});
      assert.equal((await authority.status()).mode, 'legacy');
      const reader = createOnlineMigrationObjectStore({raw, external, journal, classify, sourceId});
      await assert.rejects(reader.put('state/setting', Buffer.from('denied')), {code: 'ONLINE_OBJECT_STORE_WRITE_AUTHORITY_NOT_CONFIGURED'});
      assert.equal(await count(), 0);
      // This is test enrollment evidence, never production admission evidence.
      await authority.activate({receiptHash: 'b'.repeat(64), verify: async binding => ({...binding, receiptHash: 'b'.repeat(64)})});
      assert.equal((await authority.status()).mode, 'journal');
    });
    await check('journaled CAS exposes logical bytes and prevents equal-value ABA', async () => {
      const old = await store.readVersion('state/setting');
      assert.equal(await store.compareAndSet('state/setting', 'stale', Buffer.from('bad')), false);
      assert.equal(await store.compareAndSet('state/setting', old.version, Buffer.from('current')), true);
      const first = await store.readVersion('state/setting');
      await store.put('state/setting', Buffer.from('current'), 'application/json');
      const second = await store.readVersion('state/setting'); assert.notEqual(first.version, second.version);
      assert.equal(await store.compareAndSet('state/setting', first.version, Buffer.from('late')), false);
      const reader = createOnlineMigrationObjectStore({raw, external, classify, sourceId});
      assert.deepEqual(await reader.get('state/setting'), Buffer.from('current'));
      assert.equal(fixture.objects.get('state/setting').headers.get('x-amz-meta-opencrawl-state-bridge'), '1');
    });
    await check('lost accepted reply survives pool restart and reconciles without duplicate write', async () => {
      const before = fixture.counts.acceptedPuts; fixture.loseNextReply('state/lost');
      await assert.rejects(store.put('state/lost', Buffer.from('first')), {code: 'ONLINE_MIGRATION_EXTERNAL_OUTCOME_UNCERTAIN'});
      const pending = await journal.pendingPage(); assert.equal(pending.entries.length, 1);
      assert.equal((await journal.frontierState()).pending, true);
      await pool.end(); pool = new Pool(options);
      journal = createOnlineJournal({database: {pool, namespace}, epoch, sourceId}); await journal.ready(); store = wrap();
      await store.put('state/lost', Buffer.from('second'));
      assert.equal((await journal.pendingPage()).entries.length, 0);
      assert.equal(fixture.counts.acceptedPuts - before, 2);
      assert.equal((await pool.query('SELECT state FROM opencrawl_online_migration_journal WHERE operation_id=$1', [pending.entries[0].operationId])).rows[0].state, 'applied');
      assert.deepEqual(await store.get('state/lost'), Buffer.from('second'));
    });
    await check('logical deletion preserves physical tombstone and conditional recreation', async () => {
      const deletes = fixture.counts.DELETE;
      await store.delete('state/setting'); const physical = fixture.objects.get('state/setting');
      assert.ok(physical); assert.equal(JSON.parse(physical.bytes).deleted, true);
      assert.equal(await store.get('state/setting'), null); assert.equal(await store.has('state/setting'), false);
      assert.deepEqual(await store.readVersion('state/setting'), {version: null, data: null});
      assert.ok(!(await store.listPage('state/', {maxKeys: 20})).keys.includes('state/setting'));
      assert.equal(await store.compareAndSet('state/setting', null, Buffer.from('recreated')), true);
      assert.deepEqual(await store.get('state/setting'), Buffer.from('recreated'));
      assert.equal(fixture.counts.DELETE, deletes);
    });
    await check('raw future capture retains exact gzip bytes and published streaming facade', async () => {
      const bytes = gzipSync(Buffer.from('{"synthetic":true}\n')), key = 'raw/session/events.jsonl.gz', before = await count();
      await store.put(key, bytes, 'application/gzip'); await store.checkAccess();
      assert.deepEqual(await raw.get(key), bytes); assert.deepEqual(await store.get(key), bytes);
      assert.deepEqual(Buffer.concat(await Array.fromAsync(store.read(key))), bytes);
      assert.equal(await store.has(key), true); assert.equal((await store.readVersion(key)).version, fixture.objects.get(key).version);
      assert.equal(fixture.objects.get(key).headers.get('content-type'), 'application/gzip');
      assert.equal(fixture.objects.get(key).headers.has('x-amz-meta-opencrawl-state-bridge'), false);
      assert.ok((await store.listPage('raw/', {maxKeys: 20})).keys.includes(key)); assert.equal(await count(), before);
    });
    assert.deepEqual([...graph].sort(), expectedGraph);
    journalCounts = (await pool.query('SELECT state,count(*)::integer AS count FROM opencrawl_online_migration_journal GROUP BY state ORDER BY state')).rows;
    assert.ok(!journalCounts.some(row => row.state === 'pending')); passed = true;
  } finally {
    hook?.deregister();
    try {
      await pool?.end(); await authorityPool?.end();
      if (schema) {
        const client = await admin.connect();
        try {await client.query('BEGIN'); await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:identity-schema:maintenance',0))"); await client.query('DROP SCHEMA ' + schema + ' CASCADE'); await client.query('COMMIT');}
        catch (error) {await client.query('ROLLBACK'); throw error;} finally {client.release();}
      }
      await admin?.end(); cleanupComplete = true;
    } finally {
      const receipt = {format: 1, kind: 'published-online-adapter-compatibility', state: passed && cleanupComplete ? 'passed' : 'failed',
        legacy: LEGACY_ONLINE_PACKAGE, archiveSha256: verifiedArchiveSha256, currentRevision,
        legacyModules: verifiedModules, actualRuntimeImports: [...graph].sort(), completedCases: completed,
        postgres: {used: !!schema, cleanupComplete, journalCounts: journalCounts ?? null}, transport: fixture?.counts ?? null,
        scope: {syntheticDataOnly: true, realPublishedAdapter: true, realPostgresJournal: !!schema, productionAdmission: false}};
      writeFileSync(resolve(root, 'test-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    }
  }
});
