import test from 'node:test';
import assert from 'node:assert/strict';
import {Connection} from '@temporalio/client';
import {NativeConnection, Worker} from '@temporalio/worker';
import {connectorClient} from '../dist/src/connectors/temporal/client.mjs';
import {createConnectorWorker} from '../dist/src/connectors/temporal/worker.mjs';
import {createSlackSourceWorker} from '../dist/src/connectors/temporal/source-worker.mjs';
import {createSessionWorker} from '../dist/src/sessions/temporal/worker.mjs';

const configuration = {address: 'operator-controlled:7233', namespace: 'single-tenant',
  taskQueue: 'test', bundlePath: '/unused/workflows.cjs', resolve: async () => {throw new Error('unused');}};

test('portable client passes TLS and refreshable credentials without changing namespace/address', async t => {
  let supplied;
  const connection = {close: async () => {}};
  t.mock.method(Connection, 'connect', async options => {supplied = options; return connection;});
  const apiKey = () => 'operator-token';
  const connectionOptions = Object.freeze({tls: {serverRootCACertificate: Buffer.from('operator-ca')}, apiKey});
  const result = await connectorClient({...configuration, connectionOptions});
  assert.equal(result.connection, connection);
  assert.equal(result.client.options.namespace, 'single-tenant');
  assert.deepEqual(supplied, {...connectionOptions, address: configuration.address});
  assert.equal(supplied.apiKey, apiKey);
  await connectorClient(configuration);
  assert.deepEqual(supplied, {address: configuration.address});
});

for (const [name, create] of [['connector', createConnectorWorker], ['source', createSlackSourceWorker], ['session', createSessionWorker]]) {
  test(`${name} worker forwards native TLS/API key options and returns rotatable connection`, async t => {
    let supplied, workerOptions, key;
    const connection = {setApiKey: async value => {key = value;}, close: async () => {}};
    t.mock.method(NativeConnection, 'connect', async options => {supplied = options; return connection;});
    const worker = {};
    t.mock.method(Worker, 'create', async options => {workerOptions = options; return worker;});
    const connectionOptions = Object.freeze({tls: {serverRootCACertificate: Buffer.from('operator-ca'), serverNameOverride: 'operator.example'}, apiKey: 'initial'});
    const result = await create({...configuration, connectionOptions});
    assert.equal(result.connection, connection);
    assert.equal(result.worker, worker);
    assert.equal(workerOptions.namespace, 'single-tenant');
    assert.equal(workerOptions.taskQueue, 'test');
    assert.deepEqual(supplied, {...connectionOptions, address: configuration.address});
    await result.connection.setApiKey('rotated');
    assert.equal(key, 'rotated');
    await create(configuration);
    assert.deepEqual(supplied, {address: configuration.address});
  });
  test(`${name} worker closes its connection if startup fails`, async t => {
    let closed = 0;
    t.mock.method(NativeConnection, 'connect', async () => ({close: async () => {closed++;}}));
    t.mock.method(Worker, 'create', async () => {throw new Error('synthetic start failure');});
    await assert.rejects(create({...configuration, connectionOptions: {apiKey: 'token', tls: true}}), /synthetic start failure/);
    assert.equal(closed, 1);
  });
}

test('connection options cannot override the configured endpoint or erase explicit scope', async t => {
  const normal = t.mock.method(Connection, 'connect', async () => {throw new Error('must not connect');});
  const native = t.mock.method(NativeConnection, 'connect', async () => {throw new Error('must not connect');});
  for (const create of [connectorClient, createConnectorWorker, createSlackSourceWorker, createSessionWorker]) {
    for (const connectionOptions of [null, [], 'token', {address: 'other-tenant:7233'}]) {
      await assert.rejects(create({...configuration, connectionOptions}), /Invalid Temporal connection options/);
    }
    await assert.rejects(create({...configuration, namespace: '', connectionOptions: {tls: true}}), /Explicit/);
  }
  assert.equal(normal.mock.callCount(), 0);
  assert.equal(native.mock.callCount(), 0);
});
