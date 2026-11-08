import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createConnectorSearch} from '../dist/src/connectors/search.mjs';
import {documentId} from '../dist/src/connectors/scope.mjs';
import {realmResponse} from './realm-fixture.mjs';

const binding = {tenantId: 'team', connectionId: 'github', workspaceId: 'workspace', provider: 'github', access: 'workspace-global', rawPrefix: 'raw/v1/source=github/workspace=workspace/connection=github/'};
const principal = {tenantId: binding.tenantId};
const hit = (kind, sourceId, metadata = {}) => ({_id: documentId(binding, kind, sourceId), _score: 1,
  _source: {tenantId: binding.tenantId, connectionId: binding.connectionId, workspaceId: binding.workspaceId, provider: binding.provider, kind, sourceId, deleted: false, text: 'matching text', ...metadata}});

function fixture({repeat = false} = {}) {
  // Both are valid native identities, but only the newer resource revision is visible.
  let tied = 'zz';
  while (documentId(binding, 'issue', tied) < documentId(binding, 'review', tied)) tied += 'z';
  const stale = {parentKind: 'pull_request', parentId: 'root', resourceVersion: 'old'};
  const candidates = [...Array.from({length: 99}, (_, i) => hit('review', 'aa' + String(i).padStart(3, '0'), stale)), hit('review', tied, stale), hit('issue', tied)];
  const requests = [];
  const search = createConnectorSearch({endpoint: 'http://search.test', tenantId: binding.tenantId, fetch: async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.pathname.endsWith('/_mget')) return realmResponse('connector', {docs: [{...hit('pull_request', 'root', {resourceVersion: 'current'}), found: true}]});
    requests.push(body);
    const fields = body.sort.map(sort => Object.keys(sort)[0]);
    const values = candidate => fields.map(field => field === '_score' ? candidate._score : field === 'id' ? candidate._id : candidate._source[field.replace('connector.', '')]);
    const compare = (a, b) => {
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return (a[i] < b[i] ? -1 : 1) * (body.sort[i][fields[i]] === 'desc' ? -1 : 1);
      return 0;
    };
    const eligible = candidates.filter(candidate => repeat || !body.search_after || compare(values(candidate), body.search_after) > 0);
    eligible.sort((a, b) => compare(values(a), values(b)));
    return realmResponse('connector', {hits: {hits: eligible.slice(0, body.size).map(candidate => ({...candidate, sort: values(candidate)}))}});
  }});
  return {search, requests, expected: candidates.at(-1)._id};
}

test('connector pagination retains visible results when native identities tie across kinds', async () => {
  const f = fixture();
  const result = await f.search.search(principal, [binding], {query: 'matching', limit: 1});
  assert.deepEqual(result.hits.map(h => h.id), [f.expected]);
  assert.equal(f.requests.length, 2);
  assert.equal(result.truncated, false);
});

test('a repeated engine cursor fails instead of returning a falsely exhausted candidate window', async () => {
  await assert.rejects(fixture({repeat: true}).search.search(principal, [binding], {query: 'matching', limit: 1}), /non-advancing/);
});
