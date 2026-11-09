import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSingleOrganizationRegistry} from '../dist/src/integrations/local-registry.mjs';
const record = {tenantId: 'org_team', userId: 'user_a', integrationId: 'int_' + 'a'.repeat(26), environment: 'selfhost', provider: 'slack', scope: 'team', status: 'connecting', createdAt: '2026-11-01T00:00:00Z', startDate: '2026-10-01T00:00:00Z'};
test('a registry is pinned to one organization and survives restart and backup without losing pending intents', async t => {
  const root = await mkdtemp(join(tmpdir(), 'opencrawl-seam-registry-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const options = {path: join(root, 'registry.sqlite'), organizationId: record.tenantId};
  let registry = createSingleOrganizationRegistry(options);
  await registry.create(record);
  await registry.update(record, {status: 'provisioning', provisionIntent: {resource: 'sourceId', workspaceId: 'airbyte', name: 'source', attemptId: 'attempt', requestedAt: record.createdAt}}, {whenStatus: ['connecting']});
  registry.close(); registry = createSingleOrganizationRegistry(options);
  try {
    assert.equal((await registry.get(record.tenantId, record.userId, record.integrationId)).provisionIntent.attemptId, 'attempt');
    for (const operation of [() => registry.listTenant('org_other'), () => registry.get('org_other', record.userId, record.integrationId), () => registry.create({...record, tenantId: 'org_other'}), () => registry.update(record, {tenantId: 'org_other'})]) await assert.rejects(operation, {status: 403});
    assert.throws(() => createSingleOrganizationRegistry({...options, organizationId: 'org_other'}), /another organization/);
    assert.throws(() => createSingleOrganizationRegistry({...options, environment: 'production'}), /another organization/);
    const destination = join(root, 'restored.sqlite');
    await registry.backup(destination);
    await assert.rejects(registry.backup(destination), {code: 'EEXIST'});
    const restored = createSingleOrganizationRegistry({...options, path: destination});
    try {assert.deepEqual(await restored.listTenant(record.tenantId), await registry.listTenant(record.tenantId));} finally {restored.close();}
  } finally {registry.close();}
});
test('two independent registry connections cannot both claim the same provisioning revision', async t => {
  const root = await mkdtemp(join(tmpdir(), 'opencrawl-seam-registry-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const options = {path: join(root, 'registry.sqlite'), organizationId: record.tenantId};
  const a = createSingleOrganizationRegistry(options), b = createSingleOrganizationRegistry(options);
  try {
    await a.create(record);
    const results = await Promise.allSettled([a.update(record, {status: 'provisioning', provisionVersion: 'a'}, {whenStatus: ['connecting'], whenFields: {provisionVersion: undefined}}), b.update(record, {status: 'provisioning', provisionVersion: 'b'}, {whenStatus: ['connecting'], whenFields: {provisionVersion: undefined}})]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'ConditionalCheckFailedException');
    await assert.rejects(b.create(record), {code: 'ConditionalCheckFailedException'});
    assert.equal(await b.get(record.tenantId, 'user_other', record.integrationId), null);
  } finally {a.close(); b.close();}
});
