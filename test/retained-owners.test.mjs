import assert from 'node:assert/strict';
import test from 'node:test';
import {retainedOwnerScopes} from '../dist/src/sessions/s3-store.mjs';

const a = 'a'.repeat(64), b = 'b'.repeat(64), user = 'c'.repeat(64);
const root = 'capture/tenants/';
const users = tenant => 'tenants/' + tenant + '/users/';

test('retained owner discovery walks both directory levels with opaque cursors and never lists raw objects', async () => {
  const queries = [];
  const token = 'opaque+/=&lt;';
  const store = {async listPage(path, options) {
    assert.equal(options.delimiter, '/');
    queries.push([path, options.continuationToken]);
    if (path === root) {
      const next = options.continuationToken === null;
      return {prefixes: [root + (next ? a : b) + '/'], keys: [], nextToken: next ? token : null};
    }
    assert.ok([a,b].some(tenant => path === 'capture/' + users(tenant)));
    return {prefixes: [path + user + '/'], keys: [], nextToken: null};
  }};
  assert.deepEqual(await Array.fromAsync(retainedOwnerScopes(store, 'capture')), [users(a) + user, users(b) + user]);
  assert.deepEqual(queries, [[root,null],['capture/' + users(a),null],[root,token],['capture/' + users(b),null]]);
});

test('single-tenant discovery binds every page to the supplied tenant', async () => {
  let pages = 0;
  const store = {async listPage(path, {continuationToken}) {
    assert.equal(path, 'capture/' + users(a));
    pages++;
    return continuationToken === null ? {keys:[],prefixes:[],nextToken:'more'} :
      {keys:[],prefixes:[path + user + '/'],nextToken:null};
  }};
  assert.deepEqual(await Array.fromAsync(retainedOwnerScopes(store, 'capture/', a)), [users(a) + user]);
  assert.equal(pages, 2);
  await assert.rejects(Array.fromAsync(retainedOwnerScopes(store, 'capture', '')), /Invalid.*tenant/);
  await assert.rejects(Array.fromAsync(retainedOwnerScopes(store, '')), /session prefix/);
  assert.equal(pages, 2);
});

test('incomplete, cyclic and escaped directory pages abort discovery', async () => {
  const path = 'capture/' + users(a);
  for (const invalid of ['capture/' + users(b) + user + '/',path + user + '/nested/',path + 'wrong/']) {
    const listPage = async () => ({keys:[],prefixes:[invalid],nextToken:null});
    await assert.rejects(Array.fromAsync(retainedOwnerScopes({listPage}, 'capture', a)), /Unexpected.*prefix/);
  }
  await assert.rejects(Array.fromAsync(retainedOwnerScopes({listPage:async()=>({keys:[],nextToken:null})}, 'capture')), /directory listings/);
  let count = 0;
  const listPage = async () => ({keys:[],prefixes:[],nextToken:['first','second','first'][count++]});
  await assert.rejects(Array.fromAsync(retainedOwnerScopes({listPage}, 'capture', a)), /cursor/);
  assert.equal(count, 3);
});
