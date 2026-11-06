import {realmResponse} from './realm-fixture.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {createConnectorPipeline} from '../src/connectors/pipeline.mjs';
import {createConnectorSearch} from '../src/connectors/search.mjs';
import {validateBinding, documentId, selectedObject} from '../src/connectors/scope.mjs';
import {passages} from '../src/connectors/documents.mjs';
import {normalizeGitHub} from '../src/connectors/github.mjs';
import {workspaceAccumulator} from '../src/connectors/workspace.mjs';

export const bindingFor = provider => ({tenantId: 'fixture-team', connectionId: 'fixture-conn', workspaceId: 'workspace', provider,
  access: 'workspace-global', rawPrefix: `raw/v1/source=${provider}/workspace=workspace/connection=fixture-conn/`});
const env = (data, at = 2000) => ({_airbyte_extracted_at: at, _airbyte_data: data});
const keyFor = (binding, stream, name = '1') => `${binding.rawPrefix}stream=${stream}/date=2026-11-05/sync=1/${name}.jsonl.gz`;
function harness(provider) {
  const binding = bindingFor(provider), objects = new Map(), docs = new Map();
  let fail = false, active = true;
  const store = {get: async key => objects.get(key), put: async (key, bytes) => objects.set(key, bytes),
    listPage: async prefix => ({keys: [...objects.keys()].filter(k => k.startsWith(prefix)).reverse()})};
  const search = {identity: 'fixture', putDocuments: async (_, b, items) => {
    for (const item of items) docs.set(item.id, item.document);
    if (fail) {fail = false; throw new Error('crash after committed bulk');}
  }};
  const pipeline = createConnectorPipeline({binding, store, search, checkActive: async () => {if (!active) throw new Error('revoked');}});
  return {binding, objects, docs, pipeline, fail: () => {fail = true;}, revoke: () => {active = false;},
    raw(stream, rows, name = '1', at = 2000) {const key = keyFor(binding, stream, name); objects.set(key, gzipSync(rows.map(d => JSON.stringify(env(d, at))).join('\n'))); return key;},
    async run() {const page = await pipeline.listPage(); const results = []; for (const key of page.keys) results.push(await pipeline.processObject({key})); return results;}};
}
const date = '2026-11-05T12:00:00Z';

test('explicit global access required; providers, tenants, connections and prefixes cannot collide', () => {
  const b = bindingFor('notion');
  for (const bad of [{...b, access: 'team-public'}, {...b, provider: 'gmail'}, {...b, rawPrefix: b.rawPrefix.replace('notion', 'github')}, {...b, tenantId: ''}]) assert.throws(() => validateBinding(bad));
  assert.notEqual(documentId(b, 'comment', '1'), documentId({...b, tenantId: 'other'}, 'comment', '1'));
  assert.notEqual(documentId(b, 'comment', '1'), documentId(bindingFor('github'), 'comment', '1'));
  assert.equal(selectedObject(bindingFor('github'), keyFor(bindingFor('github'), 'files')), false);
  assert.equal(selectedObject(bindingFor('github'), keyFor(bindingFor('github'), 'discussions')), false);
});
test('passages preserve every token, ordered overlap, speaker and time across oversized turns', () => {
  const words = Array.from({length: 900}, (_, i) => `word${i}`);
  const chunks = passages([{text: words.join(' ') + '.', speaker: 'Ada', startTime: '12', endTime: '95'}]);
  assert.ok(chunks.length > 2);
  for (const word of words) assert.ok(chunks.some(c => c.text.includes(word)), word);
  assert.ok(chunks.every(c => c.speakers.includes('Ada') && c.startTime === '12' && c.endTime === '95'));
  const small = passages(Array.from({length: 80}, (_, i) => ({text: `Sentence ${i} has useful shared meeting context and explanation.`, speaker: 'Ada', startTime: String(i)})));
  assert.ok(small[1].text.includes(small[0].text.split('\n').at(-1)));
});
for (const provider of ['granola', 'circleback']) test(`${provider}: group transcript across files, deduplicate retries, link ordered passages and retain summary`, async () => {
  const h = harness(provider), granola = provider === 'granola';
  h.raw(granola ? 'notes' : 'meetings', [granola ? {id: 'm1', title: 'Planning', updated_at: date, summary_markdown: 'Meeting summary'} :
    {id: 'm1', name: 'Planning', updatedAt: date, notes: 'Meeting summary', actionItems: [{title: 'Ship the worker', description: 'Validate the production connection', status: 'PENDING'}]}]);
  const rows = Array.from({length: 80}, (_, i) => granola ?
    {note_id: 'm1', note_updated_at: date, speaker: {name: 'Ada'}, start_time: String(i), end_time: String(i + 1), text: `Sentence ${i} includes pineapple evidence and a useful explanation.`} :
    {meeting_id: 'm1', meeting_updated_at: date, speaker: 'Ada', timestamp: i, text: `Sentence ${i} includes pineapple evidence and a useful explanation.`});
  h.raw('transcripts', rows.slice(40), 'last'); h.raw('transcripts', rows.slice(0, 40), 'first'); h.raw('transcripts', rows, 'retry');
  await h.run();
  const meeting = [...h.docs.values()].find(d => d.kind === 'meeting'), chunks = [...h.docs.values()].filter(d => d.kind === 'transcript');
  assert.match(meeting.text, /Meeting summary/); assert.ok(chunks.length > 1); assert.equal(meeting.chunkCount, chunks.length);
  if (!granola) {assert.match(meeting.text, /Ship the worker/); assert.match(meeting.text, /Validate the production connection/); assert.match(meeting.text, /PENDING/);}
  for (let i = 0; i < chunks.length; i++) {assert.equal(chunks[i].sequence, i); assert.equal(chunks[i].parentId, 'm1'); assert.equal(chunks[i].resourceVersion, meeting.resourceVersion);}
  const original = [...h.docs.keys()].sort();
  assert.equal((await h.run())[0].records, 0);
  h.raw('transcripts', rows, 'another-retry', 3000); await h.run();
  assert.deepEqual([...h.docs.keys()].sort(), original);
});
test('Notion joins title, row properties, headings and markdown; comments and database definitions are separate', async () => {
  const h = harness('notion');
  h.raw('pages', [{id: 'page', last_edited_time: date, properties: {Name: {type: 'title', title: [{plain_text: 'Roadmap'}]}, Status: {type: 'status', status: {name: 'In progress'}}}}]);
  const markdown = '# Roadmap\n## Milestone\n' + 'Useful detailed paragraph for indexing pineapple.\n'.repeat(150);
  h.raw('page_markdown', [{id: 'page', page_last_edited_time: date, markdown, truncated: false, unknown_block_ids: []}]);
  h.raw('comments', [{id: 'comment', page_id: 'page', last_edited_time: date, discussion_id: 'thread', rich_text: [{plain_text: 'Needs review'}]}]);
  h.raw('data_sources', [{id: 'db', last_edited_time: date, title: [{plain_text: 'Projects'}], properties: {Owner: {type: 'people'}}}]);
  h.raw('users', [{id: 'private-person', name: 'Must not be searchable'}]);
  await h.run();
  const docs = [...h.docs.values()], page = docs.find(d => d.kind === 'page');
  assert.match(page.text, /Status: In progress/); assert.ok(docs.some(d => d.kind === 'passage' && d.heading === 'Roadmap > Milestone'));
  assert.ok(docs.some(d => d.kind === 'comment' && d.relatedId === 'page' && d.discussionId === 'thread'));
  assert.ok(docs.some(d => d.kind === 'database' && d.text.includes('Owner: people')));
  assert.ok(!JSON.stringify(docs).includes('Must not be searchable'));
});
test('incomplete markdown and orphan transcripts fail without a receipt; partial writes replay safely', async () => {
  const h = harness('notion');
  h.raw('pages', [{id: 'p', last_edited_time: date}]);
  h.raw('page_markdown', [{id: 'p', page_last_edited_time: date, markdown: 'Partial', truncated: true}]);
  await assert.rejects(h.run(), /incomplete/);
  assert.ok(![...h.objects.keys()].some(k => k.startsWith('derived/')));
  const orphan = harness('circleback'); orphan.raw('transcripts', [{meeting_id: 'm', meeting_updated_at: date, timestamp: 1, text: 'Orphan'}]);
  await assert.rejects(orphan.run(), /missing meeting/);
  const good = harness('notion'); good.raw('pages', [{id: 'p', last_edited_time: date}]); good.fail();
  await assert.rejects(good.run(), /crash/); assert.ok(![...good.objects.keys()].some(k => k.startsWith('derived/')));
  await good.run(); assert.equal(good.docs.size, 1); good.revoke(); await assert.rejects(good.run(), /revoked/);
});
test('GitHub allowlist indexes every agreed species including both review schemas, never patches or code', async () => {
  const h = harness('github');
  const common = {repository: 'team/repo', updated_at: date, files: [{patch: 'SECRETDIFF', content: 'SECRETCODE'}], diff_hunk: 'SECRETHUNK'};
  for (const [stream, record] of Object.entries({
    commits: {sha: 'abcdef', message: 'Commit pineapple', committer_date: date},
    pull_requests: {number: 7, title: 'Pull request', body: 'Reasoning', reviews: [{databaseId: 1, id: 'graph-id', body: 'Review one', state: 'APPROVED'}, {id: 2, body: 'Review two', user: {login: 'Ada'}}]},
    issues: {number: 8, title: 'Bug', body: 'Issue body'}, issue_comments: {id: 11, body: 'Conversation'},
    review_comments: {id: 12, body: 'Inline reasoning'}, commit_comments: {id: 13, body: 'Commit comment'}, releases: {id: 14, tag_name: 'v1', body: 'Release notes'},
  })) h.raw(stream, [{...common, ...record}]);
  h.raw('files', [{...common, content: 'SECRETCODE'}]); h.raw('discussions', [{...common, body: 'SECRETDISCUSSION'}]);
  await h.run();
  assert.deepEqual([...h.docs.values()].map(d => d.kind).sort(), ['commit', 'commit_comment', 'issue', 'issue_comment', 'pull_request', 'release', 'review', 'review', 'review_comment'].sort());
  assert.ok(!JSON.stringify([...h.docs.values()]).includes('SECRET'));
  assert.equal((await h.run()).reduce((n, r) => n + r.records, 0), 0);
  const docs = normalizeGitHub(h.binding, 'commits', env({...common, sha: 'abc', message: 'Long diff ignored', files: [{patch: 'x'.repeat(5 * 1024 * 1024)}]}), 'key');
  assert.ok(JSON.stringify(docs).length < 2000);
});
test('search enforces current parent revision and rejects forged provider/parent scopes', async () => {
  const h = harness('circleback');
  h.raw('meetings', [{id: 'm', name: 'Call', updatedAt: date, notes: 'Summary'}]);
  h.raw('transcripts', [{meeting_id: 'm', meeting_updated_at: date, timestamp: 0, text: 'Pineapple decision'}]);
  await h.run();
  const entries = [...h.docs.entries()], [childId, child] = entries.find(([, d]) => d.kind === 'transcript'), [parentId, parent] = entries.find(([, d]) => d.kind === 'meeting');
  let stale = false, forged = false;
  const search = createConnectorSearch({endpoint: 'http://localhost:9200', index: 'fixture', tenantId: h.binding.tenantId, fetch: async (url, options) => {
    if (url.pathname.endsWith('/_search')) return realmResponse('connector',{hits: {hits: [{_id: childId, _source: {...child, provider: forged ? 'notion' : child.provider}, _score: 1}]}});
    return realmResponse('connector',{docs: [{_id: parentId, found: true, _source: {...parent, resourceVersion: stale ? 'old' : parent.resourceVersion}}]});
  }});
  const principal = {tenantId: h.binding.tenantId};
  assert.equal((await search.search(principal, [h.binding], {query: 'pineapple'})).hits.length, 1);
  stale = true; assert.equal((await search.search(principal, [h.binding], {query: 'pineapple', raw: true})).responses[0].hits.hits.length, 0);
  forged = true; await assert.rejects(search.search(principal, [h.binding], {query: 'pineapple'}), /scope/);
  await assert.rejects(search.search({tenantId: 'other'}, [h.binding], {query: 'pineapple'}), /scope/);
});

test('snapshot memory accounting releases obsolete transcript revisions', () => {
  const accumulator = workspaceAccumulator(bindingFor('granola'));
  const priorText = 'x'.repeat(8 * 1024 * 1024);
  // More than 128 MiB passes through the reader, but only one 8 MiB revision is
  // retained. This used to count discarded revisions and fail a small snapshot.
  for (let revision = 0; revision < 17; revision++) {
    accumulator.add('transcripts', env({note_id: 'm1', note_updated_at: new Date(1000 + revision).toISOString(),
      start_time: '0', text: priorText}), 'snapshot-' + revision);
  }
  accumulator.add('transcripts', env({note_id: 'm1', note_updated_at: date, start_time: '0', text: 'Current short transcript'}), 'current');
  accumulator.add('notes', env({id: 'm1', updated_at: date, title: 'Current meeting'}), 'current');
  const docs = [...accumulator.documents()].map(item => item.document);
  assert.equal(docs.filter(doc => doc.kind === 'transcript').length, 1);
  assert.match(docs.find(doc => doc.kind === 'transcript').text, /Current short transcript/);
});
