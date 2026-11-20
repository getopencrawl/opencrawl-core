import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {generateKeyPair, SignJWT} from 'jose';
import {McpServer, WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/server';
import {z} from 'zod';
import {firstTurnDevinEvent, readDevinEventDetail} from '../dist/src/integrations/devin-session-events.mjs';
import {readDevinStartupEvents} from '../dist/src/integrations/devin-first-turn.mjs';
import {withDevinEventClient} from '../dist/src/integrations/devin-events-client.mjs';
import {createDevinWorkloads, DEVIN_ISSUER} from '../dist/src/identity/devin.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/devin-first-turn.json', import.meta.url), 'utf8'));
const details = fixture.details.map(item => readDevinEventDetail(item.id, item.response));

test('the live provider fixture preserves the original user prompt, first command and corresponding completion', () => {
  const [user, call, terminalUpdate, result] = details.map(firstTurnDevinEvent);
  assert.equal(user.kind, 'message');
  assert.equal(user.data.role, 'user');
  assert.equal(user.data.content[0].text, details[0].contents.message);
  assert.match(user.data.content[0].text, /^OCFIRSTNATIVE7Q4X\./);
  assert.equal(call.kind, 'tool_call');
  assert.equal(call.data.input.command, details[1].contents.command);
  assert.equal(result.kind, 'tool_result');
  assert.equal(result.data.call_id, call.data.call_id);
  assert.equal(result.data.output, 'OCRESULT-1795135980\n');
  assert.equal(result.data.exit_code, 0);
  assert.equal(result.data.is_error, false);
  assert.equal(result.data.outputCapture.status, 'provider_excerpt');
  assert.equal(Buffer.from(details[2].contents.contents, 'base64').toString(), 'OCRESULT-1795135980\r\n');
  assert.equal(terminalUpdate, null);
  assert.deepEqual([user.nativeId, call.nativeId, result.nativeId], [details[0].id, details[1].id, details[3].id]);
  assert.deepEqual([user.timestamp, call.timestamp, result.timestamp], [details[0].timestamp, details[1].timestamp, details[3].timestamp]);
  assert.doesNotMatch(JSON.stringify(user), /SYNTHETIC_USERNAME|user@example\.invalid|github_username/);
});

test('mismatched IDs, malformed or truncated detail bodies cannot supply startup content', () => {
  const {id, response} = fixture.details[0];
  assert.throws(() => readDevinEventDetail(fixture.details[1].id, response));
  assert.throws(() => readDevinEventDetail(id, response.slice(0, -4)));
  assert.throws(() => readDevinEventDetail(id, response.replace('"type": "initial_user_message"', '"type": "other"')));
  assert.throws(() => readDevinEventDetail(id, response.replace(details[0].timestamp, 'yesterday')));
  const wrongDirection = response.replace('direction: incoming', 'direction: outgoing');
  assert.equal(firstTurnDevinEvent(readDevinEventDetail(id, wrongDirection)), null);
});

const keys = await generateKeyPair('RS256');
const org = 'org-11111111111141118111111111111111';
const tenant = 'org_local';
const installationId = 'test-installation';
const through = '2026-11-20T00:53:01Z';

async function startupFixture() {
  const state = {connected: true, forward: true, paused: false, enabledAt: '2026-11-20T00:50:00Z'};
  const requests = [];
  const audience = 'https://opencrawl.example';
  const workloads = createDevinWorkloads({audience, key: async () => keys.publicKey,
    resolveOrganization: async id => id === org && state.connected ? tenant : null});
  const token = await new SignJWT({org_id: org, devin_id: fixture.sessionId}).setProtectedHeader({alg: 'RS256'})
    .setIssuer(DEVIN_ISSUER).setAudience(audience).setSubject('org_id:' + org).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
  const identity = await workloads.identify(token);
  assert.equal(identity.status, 200);
  const client = {client:'devin', installed:true, forward:true, forwardSince:'2026-11-20T00:52:50Z'};
  const options = {
    now: () => Date.parse(through),
    workloads,
    setup: {async read(p) {
      assert.equal(p, identity.principal);
      return {record:{installations:[{installationId, clients:[{...client, forward:state.forward}]}]}};
    }},
    recording: {async read() {return {paused:state.paused,revision:'0'};},
      async capture(p, revision, timestamps, write) {
        assert.equal(p, identity.principal); assert.equal(revision,'0');
        assert.ok(timestamps.every(t=>Date.parse(t)<=Date.parse(through)));
        return write();
      }},
    async grant(t, o) {
      assert.equal(t,tenant); assert.equal(o,org);
      return {id:'test-grant', enabledAt:state.enabledAt, key:'cog_synthetic'};
    },
    async withClient(key, operation) {
      assert.equal(key, 'cog_synthetic');
      return operation(async input => {
        requests.push(input);
        assert.equal(input.session_id,fixture.sessionId);
        state.onRequest?.(input);
        if(input.action==='list') return state.page?.(input) ?? fixture.listLines;
        return fixture.details.find(item=>item.id===input.event_ids[0]).response;
      });
    },
  };
  return {state,requests,options,principal:identity.principal,read:()=>readDevinStartupEvents(options,identity.principal,installationId,through)};
}

test('the reader fetches details in the signed native session and returns paired source events', async () => {
  const {requests,read} = await startupFixture();
  const events = await read();
  assert.deepEqual(events.map(e=>e.kind), ['message','tool_call','tool_result']);
  assert.equal(events[1].data.call_id,events[2].data.call_id);
  assert.equal(events[2].data.output,'OCRESULT-1795135980\n');
  assert.deepEqual(requests.map(r=>r.action), ['list','details','details','details']);
  assert.equal(new Set(requests.map(r=>r.session_id)).size,1);
});

test('unverified identities, deselected recording and other installations make no upstream requests', async () => {
  const {state,options,requests,principal,read} = await startupFixture();
  await assert.rejects(readDevinStartupEvents(options,{...principal},installationId,through), {status:403});
  await assert.rejects(readDevinStartupEvents(options,principal,'another-installation',through), {status:403});
  state.forward=false;
  await assert.rejects(read(),{status:403});
  state.forward=true; state.paused=true;
  await assert.rejects(read(),{status:403});
  assert.equal(requests.length,0);
});

test('revocation while fetching details prevents release and subsequent reads', async () => {
  const {state,requests,read} = await startupFixture();
  state.onRequest = input => {if(input.action==='details') state.connected=false;};
  await assert.rejects(read(), {status:403});
  assert.equal(requests.length,2);
});

test('a recording opt-out while reading the final result prevents release', async () => {
  const {state,requests,read} = await startupFixture();
  state.onRequest = input => {if(input.event_ids?.includes(fixture.details[3].id)) state.forward=false;};
  await assert.rejects(read(), {status:403});
  assert.equal(requests.at(-1).event_ids[0],fixture.details[3].id);
});

test('new recording permission never backfills a session whose first message predates the grant', async () => {
  const {state,requests,read} = await startupFixture();
  state.enabledAt = '2026-11-20T00:52:48.600Z';
  assert.deepEqual(await read(), []);
  assert.deepEqual(requests.map(r=>r.action), ['list','details']);
});

test('a subsequent user message on another page bounds the first turn regardless of listing order', async () => {
  const {state,requests,read} = await startupFixture();
  state.page = ({after}) => after ?
    '[event-boundary] 2026-11-20 00:52:59 UTC <<< user_message (message): next turn' :
    'Showing 4\nMore results available. Pass after=abc== to fetch the next page.\n' + fixture.listLines;
  const events = await read();
  assert.deepEqual(events.map(event=>event.kind), ['message']);
  assert.deepEqual(requests.map(r=>r.action), ['list','list','details']);
  assert.deepEqual(requests.at(-1).event_ids,[fixture.details[0].id]);
  assert.equal(requests[1].after,'abc==');
});

test('a repeated provider cursor fails without requesting event contents', async () => {
  const {state,requests,read} = await startupFixture();
  state.page = ()=>'Showing 4\nMore results available. Pass after=abc== to fetch the next page.\n'+fixture.listLines;
  await assert.rejects(read(), {status:502});
  assert.deepEqual(requests.map(r=>r.action), ['list','list']);
});

test('real MCP transport reads only the named event tool and never serializes the service credential into results', async t => {
  const {options,principal} = await startupFixture();
  const server = new McpServer({name:'devin-event-fixture',version:'1'});
  const transport = new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:()=> 'synthetic',enableJsonResponse:true});
  const calls = [];
  server.registerTool('devin_session_events',{inputSchema:z.object({action:z.enum(['list','details']),session_id:z.string(),
    first:z.number().optional(),event_types:z.array(z.string()).optional(),event_ids:z.array(z.string()).optional(),
    max_content_length:z.number().optional(),after:z.string().optional()})},async input=>{
    calls.push(input);
    assert.equal(input.session_id,fixture.sessionId);
    const text = input.action==='list' ? fixture.listLines : fixture.details.find(row=>row.id===input.event_ids[0]).response;
    return {content:[{type:'text',text}]};
  });
  await server.connect(transport);
  t.after(()=>server.close());
  options.withClient=(key,callback)=>withDevinEventClient(key,callback,async (input,init)=>{
    const request = new Request(input,init);
    assert.equal(request.url,'https://mcp.devin.ai/mcp');
    assert.equal(request.redirect,'error');
    assert.equal(request.headers.get('authorization'),'Bearer cog_synthetic');
    return transport.handleRequest(request);
  });
  const events = await readDevinStartupEvents(options,principal,installationId,through);
  assert.deepEqual(events.map(event=>event.nativeId),[fixture.details[0].id,fixture.details[1].id,fixture.details[3].id]);
  assert.equal(calls.length,4);
  assert.doesNotMatch(JSON.stringify(events),/cog_synthetic/);
});
