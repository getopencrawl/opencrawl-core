import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {devinConversationEvent, devinSessionApi} from '../dist/src/integrations/devin-api.mjs';
import {authorizedDevinFetch, DevinRateLimitError, identifyDevinServiceUser} from '../dist/src/integrations/devin-events-client.mjs';
import {readDevinToolPage} from '../dist/src/integrations/devin-tool-page.mjs';
import {readDevinSessionStep} from '../dist/src/integrations/devin-live-session.mjs';

const org = 'org-' + 'a'.repeat(32);
const id = 'devin-' + 'b'.repeat(32);
const key = 'cog_fixture';
const session = {session_id:id, org_id:org, created_at:1780000000, updated_at:1780000002, status:'running', title:'Packaging verification'};
const message = {event_id:'event-first', source:'devin', created_at:1780000001, message:'Build passed.'};

test('uses the service-user organization from Devin and rejects human or enterprise identities', async () => {
  const identity = data => identifyDevinServiceUser(key, async (url, init) => {
    assert.equal(url, 'https://api.devin.ai/v3/self');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.get('authorization'), 'Bearer ' + key);
    return Response.json(data);
  });
  assert.equal(await identity({principal_type:'service_user', org_id:org}), org);
  await assert.rejects(identity({principal_type:'pat_user', org_id:org}), {status:403});
  await assert.rejects(identity({principal_type:'service_user', org_id:null}), {status:403});
});

test('discovers sessions and reads chronological conversation pages through the bound origin', async () => {
  const urls = [];
  const api = devinSessionApi(key, org, async (input, init) => {
    const url = new URL(input);
    urls.push(url);
    assert.equal(url.origin, 'https://api.devin.ai');
    assert.equal(init.headers.get('authorization'), 'Bearer ' + key);
    assert.equal(init.redirect, 'error');
    return url.pathname.endsWith('/messages')
      ? Response.json({items:[message], has_next_page:false, end_cursor:null})
      : Response.json({items:[session], has_next_page:true, end_cursor:'catalog-next'});
  });
  const page = await api.sessions({createdAfter:1780000000, updatedAfter:1780000001, after:'catalog-prior'});
  assert.equal(page.end_cursor, 'catalog-next');
  assert.equal(page.items[0].session_id, id);
  const messages = await api.messages(id, 'messages-next');
  assert.equal(urls[0].pathname, '/v3/organizations/' + org + '/sessions');
  assert.equal(urls[0].searchParams.get('created_after'), '1780000000');
  assert.equal(urls[0].searchParams.get('after'), 'catalog-prior');
  assert.equal(urls[1].pathname, '/v3/organizations/' + org + '/sessions/' + id + '/messages');
  assert.equal(urls[1].searchParams.get('after'), 'messages-next');
  assert.deepEqual(devinConversationEvent(messages.items[0]), {
    id:'devin-event:event-first', nativeId:'event-first', kind:'message',
    timestamp:new Date(message.created_at * 1000).toISOString(),
    data:{role:'assistant', content:[{type:'text', text:'Build passed.'}]},
  });
});

test('rejects foreign sessions, incomplete pagination and off-origin destinations', async () => {
  for (const result of [
    {items:[{...session, org_id:'org-' + 'f'.repeat(32)}], has_next_page:false},
    {items:[session], has_next_page:true, end_cursor:null},
  ]) {
    const api = devinSessionApi(key, org, async () => Response.json(result));
    await assert.rejects(api.sessions({createdAfter:1780000000}));
  }
  assert.throws(() => authorizedDevinFetch('https://example.org/', 1024, key, AbortSignal.timeout(1000), fetch));
  let calls = 0;
  const api = devinSessionApi(key, org, async () => { calls++; throw Error('unexpected request'); });
  await assert.rejects(api.messages('../unrelated'));
  assert.equal(calls, 0);
});

test('honors Devin rate-limit delays without including the provider error body', async () => {
  const api = devinSessionApi(key, org, async () => new Response('private body', {status:429, headers:{'Retry-After':'45'}}));
  await assert.rejects(api.messages(id), error => error instanceof DevinRateLimitError &&
    error.retryAfterMs === 45000 && !error.message.includes('private body'));
  const event = devinConversationEvent({...message, source:'user', message:'token=never-print-this'});
  assert.equal(event.data.role, 'user');
  assert.equal(event.data.content[0].text, 'token=[REDACTED]');
});

test('collects real provider shell receipts with native identity and excerpt status across pages', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/devin-first-turn.json',import.meta.url)));
  const requests = [];
  const read = async input => {
    requests.push(input);
    if (input.action === 'list') {
      if (input.after) return fixture.listLines.split('\n').filter(row => row.includes('shell_process_completed')).join('\n');
      return 'More results available. Pass after=next to fetch the next page.\n' +
        fixture.listLines.split('\n').filter(row => !row.includes('shell_process_completed')).join('\n');
    }
    return fixture.details.find(item => item.id === input.event_ids[0]).response;
  };
  const first = await readDevinToolPage(read, fixture.sessionId, 0, Date.UTC(2027,0,1));
  assert.equal(first.after, 'next');
  assert.equal(first.events.length, 1);
  const second = await readDevinToolPage(read, fixture.sessionId, 0, Date.UTC(2027,0,1), first.after);
  const [call, result] = [first.events[0], second.events[0]];
  assert.equal(call.kind, 'tool_call');
  assert.equal(result.kind, 'tool_result');
  assert.equal(call.data.call_id, result.data.call_id);
  assert.equal(result.data.outputCapture.status, 'provider_excerpt');
  assert.match(result.data.output, /OCRESULT/);
  assert.equal(requests.filter(row => row.action === 'details').length, 2);
  assert.ok(requests.every(row => row.session_id === fixture.sessionId));
});

test('checks consent before content and enforces private prompts before tool reads', async () => {
  let messageCalls = 0, toolCalls = 0;
  const options = {session, cursor:{phase:'messages'}, enabledAt:session.created_at * 1000 - 100, now:session.updated_at * 1000,
    audience:'https://opencrawl.test', api:{messages:async () => {
      messageCalls++;
      return {items:[{...message,source:'user',message:'/oc-private personal task'}], has_next_page:false};
    }}, withEvents:async () => {toolCalls++; throw Error('unexpected tool call');}};
  assert.equal((await readDevinSessionStep({...options,enabledAt:session.created_at * 1000 + 3000})).state,'before-consent');
  assert.equal(messageCalls,0);
  const result = await readDevinSessionStep(options);
  assert.equal(result.state,'private');
  assert.deepEqual(result.events,[]);
  assert.equal(toolCalls,0);
});

test('retains the final message page across restarts and resumes at native message IDs', async () => {
  const opening = {...message,event_id:'event-opening',source:'user',message:'Check the release'};
  const pages = [
    {items:[opening], has_next_page:true,end_cursor:'page-2'},
    {items:[message], has_next_page:false,end_cursor:null},
    {items:[message,{...message,event_id:'event-followup',message:'Release passed'}],has_next_page:false,end_cursor:null}
  ];
  const after = [];
  const options = {session, enabledAt:session.created_at * 1000 - 100, now:session.updated_at * 1000 + 5000,
    audience:'https://opencrawl.test',api:{messages:async (_id,cursor) => {after.push(cursor);return pages.shift();}},
    withEvents:async read => read(async () => '')};
  let cursor = {phase:'messages'};
  const ids = [];
  for(let i=0;i<4;i++){
    const step = await readDevinSessionStep({...options,cursor});
    cursor = JSON.parse(JSON.stringify(step.cursor));
    ids.push(...step.events.map(event => event.nativeId));
  }
  assert.deepEqual(after,[undefined,'page-2','page-2']);
  assert.deepEqual(ids,['event-opening','event-first','event-followup']);
});
