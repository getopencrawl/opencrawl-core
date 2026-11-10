import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createProvisioning, provisioningLabel} from '../dist/src/integrations/provisioning.mjs';
import {createAirbyte} from '../dist/src/integrations/airbyte.mjs';

const initial = {environment: 'staging', tenantId: 'org_A', userId: 'user_A', integrationId: 'int_' + 'a'.repeat(26), provider: 'slack', status: 'provisioning', provisionProtocol: 1};
function fixture() {
  let record = structuredClone(initial);
  const registry = {
    get: async () => structuredClone(record),
    update: async (_, fields, {whenStatus, whenFields}) => {
      if (!whenStatus.includes(record.status) || Object.entries(whenFields).some(([key, value]) => record[key] !== value)) {
        throw Object.assign(new Error('Lost CAS'), {code: 'ConditionalCheckFailedException'});
      }
      Object.assign(record, structuredClone(fields)); return structuredClone(record);
    },
  };
  let resources = [];
  const airbyte = {sources: async () => structuredClone(resources), connections: async () => structuredClone(resources)};
  const service = () => createProvisioning({environment: 'staging', registry, airbyte});
  return {service, registry, record: () => structuredClone(record), resources: values => {resources = values;}};
}

test('two processes claim one external creation, even before either POST returns', async () => {
  const f = fixture(); let posts = 0, release;
  const create = () => {posts++; return new Promise(resolve => {release = () => resolve({sourceId: 'source'});});};
  const first = f.service().ensure(initial, 'sourceId', 'workspace', create);
  while (!release) await new Promise(setImmediate);
  await assert.rejects(f.service().ensure(initial, 'sourceId', 'workspace', create), {code: 'ProvisioningRecoveryPending'});
  assert.equal(posts, 1);
  release(); await first;
  assert.equal(f.record().airbyte.sourceId, 'source');
});

test('disconnect between reading the record and claiming the request prevents the POST', async () => {
  const f = fixture(), update = f.registry.update;
  f.registry.update = async (record, fields, conditions) => {
    if (fields.provisionIntent) await update(record, {status: 'disconnecting'}, {whenStatus: ['provisioning'], whenFields: {}});
    return update(record, fields, conditions);
  };
  await assert.rejects(f.service().ensure(initial, 'sourceId', 'workspace', () => assert.fail('POST after revoke')), {code: 'ConditionalCheckFailedException'});
  assert.equal(f.record().provisionIntent, undefined);
  assert.equal(f.record().status, 'disconnecting');
});

test('recovery rejects duplicate names, foreign workspace and mismatched connection endpoints', async () => {
  for (const failure of ['duplicate', 'foreign', 'endpoints']) {
    const f = fixture();
    const resource = failure === 'endpoints' ? 'connectionId' : 'sourceId';
    await f.registry.update(initial, {airbyte: {sourceId: 'source', destinationId: 'destination'}}, {whenStatus: ['provisioning'], whenFields: {}});
    if (resource === 'sourceId') await f.registry.update(initial, {airbyte: {}}, {whenStatus: ['provisioning'], whenFields: {}});
    await assert.rejects(f.service().ensure(initial, resource, 'workspace', async () => {throw new Error('Response lost');}), /Response lost/);
    const match = {name: provisioningLabel(initial), workspaceId: 'workspace', [resource]: 'recovered', sourceId: resource === 'connectionId' ? 'wrong' : 'recovered', destinationId: 'destination'};
    f.resources(failure === 'duplicate' ? [match, {...match, [resource]: 'duplicate'}] : [{...match, workspaceId: failure === 'foreign' ? 'other' : 'workspace'}]);
    await assert.rejects(f.service().reconcile(initial));
    assert.ok(f.record().provisionIntent);
    assert.notEqual(f.record().airbyte?.[resource], 'recovered');
  }
});

test('legacy interrupted setup adopts by scoped label and never issues an unjournaled retry', async () => {
  const f = fixture();
  await f.registry.update(initial, {provisionProtocol: null}, {whenStatus: ['provisioning'], whenFields: {}});
  await assert.rejects(f.service().ensure(initial, 'sourceId', 'workspace', () => assert.fail('duplicate legacy create')), {code: 'ProvisioningRecoveryPending'});
  f.resources([{sourceId: 'legacy-source', name: provisioningLabel(initial), workspaceId: 'workspace'}]);
  await f.service().reconcile(initial);
  assert.equal(f.record().airbyte.sourceId, 'legacy-source');
});

test('Airbyte reconciliation uses complete bounded workspace pages and fails closed on broken results', async () => {
  for (const mode of ['paged', 'proxy-next', 'missing', 'repeated', 'partial', 'foreign', 'wrong-next-workspace']) {
    const calls = [];
    const airbyte = createAirbyte({url: 'https://airbyte.test', clientId: 'id', clientSecret: 'secret', fetch: async input => {
      const url = new URL(input);
      if (url.pathname.endsWith('/applications/token')) return Response.json({access_token: 'token'});
      calls.push(url);
      assert.equal(url.origin, 'https://airbyte.test');
      assert.equal(url.searchParams.get('workspaceIds'), 'workspace');
      assert.equal(url.searchParams.get('includeDeleted'), 'false');
      if (mode === 'missing') return Response.json({});
      if (mode === 'partial') return Response.json({data: [], next: 'more'});
      if (mode === 'foreign') return Response.json({data: [{sourceId: 'foreign', workspaceId: 'other', name: 'x'}]});
      if (mode === 'proxy-next' || mode === 'wrong-next-workspace') {
        if (url.searchParams.get('offset') === '100') return Response.json({data: [], next: null});
        const next = new URL(url);
        next.host = 'internal-proxy.invalid'; next.searchParams.set('offset', '100');
        if (mode === 'wrong-next-workspace') next.searchParams.set('workspaceIds', 'other');
        return Response.json({data: [{sourceId: 'source', workspaceId: 'workspace', name: 'source'}], next: next.href});
      }
      const offset = mode === 'repeated' ? 0 : Number(url.searchParams.get('offset'));
      return Response.json({data: Array.from({length: offset ? 1 : 100}, (_, i) => ({sourceId: String(offset + i), workspaceId: 'workspace', name: 'source'}))});
    }});
    if (mode === 'paged') assert.equal((await airbyte.sources('workspace')).length, 101);
    else if (mode === 'proxy-next') { assert.equal((await airbyte.sources('workspace')).length, 1); assert.equal(calls.length, 2); }
    else await assert.rejects(airbyte.sources('workspace'), /listing/);
    assert.ok(calls.length <= 2);
  }
});
