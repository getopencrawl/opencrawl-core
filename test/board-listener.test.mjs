import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBoard} from '../dist/src/board/board.mjs';
import {createLocalBoardStore} from '../dist/src/board/local-store.mjs';
import {createBoardListeners, ticketTtlMs, tokenTtlMs} from '../dist/src/board/listener.mjs';
import {createWorkspaceSearch} from '../dist/src/search/workspace.mjs';
import {standaloneMcp} from '../dist/src/mcp/standalone.mjs';

const alice = {tenantId:'a', userId:'alice'}, bob = {tenantId:'a', userId:'bob'};
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'board-listener-'));
  const store = createLocalBoardStore(join(dir, 'board.sqlite')); let time = 1_000_000;
  t.after(async () => {store.close(); await rm(dir, {recursive:true, force:true});});
  const now = () => time;
  return {dir, board:createBoard({store, prefix:'test', now}), listeners:createBoardListeners({store, prefix:'test', now}), advance:ms => {time += ms;}};
}

test('only full principals issue tickets; tickets redeem once and expire', async t => {
  const f = await fixture(t);
  for (const principal of [null, {}, {tenantId:'a'}, {...alice, captureAccess:'write'}, {...alice, boardSession:'one'}]) await assert.rejects(f.listeners.issue(principal, {session:'one'}), {status:403});
  await assert.rejects(f.listeners.issue(alice, {}), {name:'ZodError'});
  const {ticket} = await f.listeners.issue(alice, {session:'one'});
  assert.match(ticket, /^oclt1_[a-f0-9]{64}$/);
  await assert.rejects(f.listeners.redeem(ticket, 'two'), {status:403}, 'mismatched session is refused');
  const results = await Promise.allSettled(Array.from({length:6}, () => f.listeners.redeem(ticket)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1, 'concurrent redemptions: exactly one wins');
  const won = results.find(r => r.status === 'fulfilled').value;
  assert.deepEqual({...won.principal}, {tenantId:'a', userId:'alice', name:null, email:null, boardSession:'one'});
  await assert.rejects(f.listeners.redeem(ticket), {status:401});
  await assert.rejects(f.listeners.redeem('oclt1_' + '0'.repeat(64)), {status:401});
  await assert.rejects(f.listeners.redeem(won.token), {status:401}, 'a token is not a ticket');
  const late = await f.listeners.issue(alice, {session:'one'}); f.advance(ticketTtlMs);
  await assert.rejects(f.listeners.redeem(late.ticket), {status:401});
  assert.equal(await f.listeners.authenticate(late.ticket), null);
  assert.ok(await f.listeners.authenticate(won.token));
  f.advance(tokenTtlMs);
  assert.equal(await f.listeners.authenticate(won.token), null, 'tokens expire');
});

test('listener principals are confined to board participation for their own session', async t => {
  const f = await fixture(t);
  const {ticket} = await f.listeners.issue(alice, {session:'one'});
  const {token} = await f.listeners.redeem(ticket);
  const listener = await f.listeners.authenticate(token);
  await f.board.participate(listener, 'register', {session:'one', name:'claude:one', task:'Cloud work', harness:'claude-code'});
  for (const [operation, input] of [['register', {session:'two', name:'claude:two', task:'x'}], ['inbox', {session:'two'}], ['subscribe', {session:'two', topics:[]}],
    ['publish', {session:'two', id:'1', topic:'t', text:'x'}], ['leave', {session:'two'}]]) await assert.rejects(f.board.participate(listener, operation, input), {status:403}, operation);
  assert.equal((await f.board.participate(listener, 'directory')).total, 1);
  await f.board.participate(listener, 'subscribe', {session:'one', topics:['build']});
  await f.board.participate(bob, 'register', {session:'b', name:'codex:b', task:'x'});
  await f.board.participate(bob, 'publish', {session:'b', id:'1', topic:'build', text:'@claude:one ready'});
  const {batch} = await f.board.participate(listener, 'inbox', {session:'one'});
  assert.deepEqual(batch.messages[0].reasons, ['mention', 'topic', 'homepage']);
  // Same identity as the signed-in owner: a full principal sees the same pending delivery.
  assert.equal((await f.board.participate(alice, 'inbox', {session:'one'})).batch.receipt, batch.receipt);
  for (const [operation, input] of [['sync', {workspace:'a', agent:'x'}], ['read', {}], ['topics', {workspace:'a'}]]) await assert.rejects(f.board[operation](listener, input), {status:403}, operation);
  const search = createWorkspaceSearch({sessions:{search:async () => assert.fail('must not search')}});
  await assert.rejects(search.search(listener, {query:'secret'}), {status:403});
  await assert.rejects(search.fetch(listener, {id:'sessions:x'}), {status:403});
  await assert.rejects(f.listeners.issue(listener, {session:'one'}), {status:403}, 'listeners cannot mint tickets');
});

test('HTTP: MCP issues a ticket, CLI-style redemption, session-bound use, leave revokes', async t => {
  const f = await fixture(t);
  const token = 'm'.repeat(32), port = 18000 + Math.floor(Math.random() * 2000), origin = `http://127.0.0.1:${port}`;
  const server = standaloneMcp({token, origin, boardPath:join(f.dir, 'http.sqlite')});
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const mcp = async (name, args) => {
    const response = await fetch(origin + '/mcp', {method:'POST', headers:{authorization:'Bearer ' + token, 'content-type':'application/json', accept:'application/json, text/event-stream'},
      body:JSON.stringify({jsonrpc:'2.0', id:1, method:'tools/call', params:{name, arguments:args}})});
    const text = await response.text(), json = JSON.parse(text.startsWith('{') ? text : text.split('\n').find(l => l.startsWith('data:')).slice(5));
    return json.result;
  };
  const board = async (operation, body, bearer) => {
    const response = await fetch(`${origin}/api/board/${operation}`, {method:'POST', headers:{'content-type':'application/json', ...(bearer ? {authorization:'Bearer ' + bearer} : {})}, body:JSON.stringify(body)});
    return {status:response.status, body:await response.json()};
  };
  const issued = await mcp('board_listener_ticket', {session:'cloud-1'});
  assert.ok(!issued.isError, JSON.stringify(issued));
  const {ticket, next} = JSON.parse(issued.content[0].text);
  assert.match(next, /--ticket oclt1_/);
  assert.equal((await board('listener', {ticket:'nope'})).status, 401);
  const redeemed = await board('listener', {ticket});
  assert.equal(redeemed.status, 200);
  assert.equal(redeemed.body.data.access, 'board-listener');
  assert.equal((await board('listener', {ticket})).status, 401, 'single use over HTTP');
  const listener = redeemed.body.data.token;
  assert.equal((await board('register', {session:'cloud-1', name:'claude:cloud', task:'E2E'}, listener)).status, 200);
  assert.equal((await board('register', {session:'other', name:'claude:other', task:'E2E'}, listener)).status, 403);
  assert.equal((await board('register', {session:'local', name:'codex:local', task:'E2E'}, token)).status, 200);
  assert.equal((await board('publish', {session:'local', id:'1', topic:'build', text:'@claude:cloud hello'}, token)).status, 200);
  const delivery = await board('inbox', {session:'cloud-1'}, listener);
  assert.equal(delivery.body.data.batch.messages[0].text, '@claude:cloud hello');
  // The listener token is not accepted by search, fetch, or MCP.
  for (const path of ['/api/search', '/api/search/fetch', '/mcp']) {
    const response = await fetch(origin + path, {method:'POST', headers:{authorization:'Bearer ' + listener, 'content-type':'application/json', accept:'application/json, text/event-stream'}, body:'{}'});
    assert.ok([401, 404, 503].includes(response.status) && response.status !== 200, path + ' ' + response.status);
  }
  assert.equal((await board('leave', {session:'cloud-1'}, listener)).status, 200);
  assert.equal((await board('inbox', {session:'cloud-1'}, listener)).status, 401, 'leave revokes the token');
});
