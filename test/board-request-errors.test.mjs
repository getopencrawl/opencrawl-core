import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createBoardHandler} from '../dist/src/board/http.mjs';
import {boardStateFixture} from './fixtures/board-state.mjs';
import {z} from 'zod';

test('existing board HTTP clients can correct a rejected request using only its message', async t => {
  const {make} = await boardStateFixture(t);
  const board = make();
  const handler = createBoardHandler({board, authenticate: async () => ({tenantId:'team-a', userId:'caller'})});
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const send = (op, input) => fetch('http://127.0.0.1:' + server.address().port + '/api/board/' + op, {
    method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(input),
  });
  async function rejected(op, input, status=400) {
    const response = await send(op, input);
    assert.equal(response.status, status);
    const {error} = await response.json();
    assert.equal(error.code, 'BOARD_REQUEST_FAILED');
    return error.message;
  }
  const session = 'existing-session', startup = {session, harness:'codex'};
  const missing = await rejected('register', startup);
  assert.match(missing, /name is required/);
  assert.match(missing, /task is required/);
  const flags = missing.match(/--name ([\w.-]+) --task "([^"]+)"/);
  assert.ok(flags, 'provide example flags a legacy CLI can use');
  assert.match(flags[1], /^agent-[0-9a-f]{12}$/);
  assert.match(missing, /Replace the quoted task/);
  const profile = {...startup, name:flags[1], task:'Check the board error message'};
  const partial = await rejected('register', {...startup, name:profile.name});
  assert.match(partial, /--task/);
  assert.doesNotMatch(partial, /--name/);
  assert.match(await rejected('register', {...profile, name:'docs review'}), /start with a letter or digit/);
  for (const resumed of [false, true]) {
    const response = await send('register', profile);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.resumed, resumed);
  }
  assert.match(await rejected('register', {...profile,name:'other-name'},409), new RegExp('--name '+profile.name));
  assert.match(await rejected('v2/post', {session, posts:[{id:'one'}]}), /posts\[0\]\.text is required/);
  assert.match(await rejected('v2/thread', {threadId:0}), /more than 0/);
  const extra = await rejected('register', {...profile, 'private-extra-field':'private-content'});
  assert.match(extra, /Use only .*session.*name.*task/);
  assert.doesNotMatch(extra, /private/);
  board.agent.list = async () => z.object({internalSetting:z.string()}).parse({});
  const unavailable = await send('v2/list', {});
  assert.equal(unavailable.status, 503);
  const {error} = await unavailable.json();
  assert.equal(error.code,'BOARD_UNAVAILABLE');
  assert.match(error.message,/Try again/);
  assert.doesNotMatch(error.message,/internalSetting/);
});
