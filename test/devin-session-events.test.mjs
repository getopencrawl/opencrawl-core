import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import {generateKeyPair, SignJWT} from 'jose';
import {McpServer, WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/server';
import {z} from 'zod';
import {firstTurnDevinEvent, readDevinEventDetail} from '../dist/src/integrations/devin-session-events.mjs';
import {readDevinStartupEvents} from '../dist/src/integrations/devin-first-turn.mjs';
import {withDevinEventClient} from '../dist/src/integrations/devin-events-client.mjs';
import {createDevinWorkloads, DEVIN_ISSUER} from '../dist/src/identity/devin.mjs';
import {createSessionIngest} from '../dist/src/sessions/ingest.mjs';
import {createSessionPipeline} from '../dist/src/sessions/indexer.mjs';
import {createSessionSearch} from '../dist/src/sessions/search.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/devin-first-turn.json', import.meta.url), 'utf8'));
const details = fixture.details.map(item => readDevinEventDetail(item.id, item.response));
function fixtureList(input) {
  return fixture.listLines.split('\n').filter(line => input.event_types.some(type => line.includes(' ' + type + ' ('))).join('\n');
}

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
  const client = {client:'devin', installed:true, forward:true, forwardSince:through};
  const options = {
    audience,
    sessionAllowed:async()=>true,
    now: () => Date.parse(through),
    workloads,
    setup: {async read(p) {
      assert.equal(p, identity.principal);
      return {record:{installations:[{installationId, clients:[{...client, forward:state.forward}]}]},
        devinInitialForward:{installationId,forwardSince:client.forwardSince}};
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
    async withClient(key, organizationId, operation) {
      assert.equal(key, 'cog_synthetic');
      assert.equal(organizationId, org);
      return operation(async input => {
        requests.push(input);
        assert.equal(input.session_id,fixture.sessionId);
        state.onRequest?.(input);
        if(input.action==='list') return (input.first===2 ? undefined : state.page?.(input)) ?? fixtureList(input);
        const response = fixture.details.find(item=>item.id===input.event_ids[0]).response;
        if (input.event_ids[0]===fixture.details[0].id && state.privatePrompt) {
          return response.replace('OCFIRSTNATIVE7Q4X.', state.privatePrompt);
        }
        return response;
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
  assert.deepEqual(requests.map(r=>r.action), ['list','details','list','details','details']);
  assert.equal(new Set(requests.map(r=>r.session_id)).size,1);
});

test('an original privacy invocation prevents any request for tool details or summaries', async () => {
  const {state,requests,read} = await startupFixture();
  state.privatePrompt = '/oc-incognito';
  await assert.rejects(read(), {status:403});
  assert.deepEqual(requests.map(r=>r.action), ['list','details']);
  assert.deepEqual(requests[0].event_types, ['initial_user_message']);
});

test('an independent workspace member finds each original event after ingest and retry', async t => {
  const {principal,read} = await startupFixture();
  const directory = await mkdtemp(join(tmpdir(), 'devin-startup-search-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const endpoint = pathToFileURL(join(directory, 'search.sqlite')).href.replace('file:', 'sqlite:');
  const store = memorySessionStore();
  const options = {store, prefix: 'devin-first-turn/v1', endpoint};
  const search = createSessionSearch(options);
  const index = createSessionPipeline({...options, search, principal});
  const ingest = createSessionIngest({...options, scheduleIndexing: key => index.processObject({key})});
  const member = {tenantId: principal.tenantId, userId: 'workspace-reader'};
  const sessionId = principal.owner.sessionId;
  const batch = {schemaVersion: 1, owner: principal, harness: 'devin', origin: 'cloud', captureMode: 'live',
    installationId, sessionId, events: await read(), attachments: []};
  const receipt = await ingest.putBatch(principal, batch);
  const retry = await ingest.putBatch(principal, {...batch, events: await read()});
  assert.equal(retry.batchId, receipt.batchId);
  const find = (query, scope = member, includeToolOutputs = true) =>
    search.search(scope, {query, sessionId, includeToolOutputs});
  const opener = await find('OCFIRSTNATIVE7Q4X');
  assert.equal(opener.hits.length, 1);
  assert.equal(opener.hits[0].role, 'user');
  const commands = await find('printf');
  const calls = commands.hits.filter(row => row.kind === 'tool_call');
  assert.equal(calls.length, 1);
  const output = await find('1795135980');
  assert.equal(output.hits.length, 1);
  assert.equal(output.hits[0].kind, 'tool_result');
  assert.equal(output.hits[0].toolCallId, details[3].contents.process_id);
  assert.equal(calls[0].toolCallId, output.hits[0].toolCallId);
  for (const [hit, event] of [[opener.hits[0], details[0]], [calls[0], details[1]], [output.hits[0], details[3]]]) {
    assert.equal(hit.nativeId, event.id);
    assert.equal(hit.eventId, 'devin-event:' + event.id);
    assert.equal(hit.sessionId, sessionId);
    assert.equal(hit.userId, principal.userId);
    assert.equal(hit.installationId, installationId);
  }
  assert.equal((await find('1795135980', member, false)).total, 0);
  assert.equal((await find('OCFIRSTNATIVE7Q4X', {...member, tenantId: 'other-workspace'})).total, 0);
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
  assert.deepEqual(requests.map(r=>r.action), ['list','details','list','list']);
  assert.deepEqual(requests[1].event_ids,[fixture.details[0].id]);
  assert.equal(requests[3].after,'abc==');
});

test('a repeated provider cursor fails before requesting tool contents', async () => {
  const {state,requests,read} = await startupFixture();
  state.page = ()=>'Showing 4\nMore results available. Pass after=abc== to fetch the next page.\n'+fixture.listLines;
  await assert.rejects(read(), {status:502});
  assert.deepEqual(requests.map(r=>r.action), ['list','details','list','list']);
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
    const text = input.action==='list' ? fixtureList(input) : fixture.details.find(row=>row.id===input.event_ids[0]).response;
    return {content:[{type:'text',text}]};
  });
  await server.connect(transport);
  t.after(()=>server.close());
  let identityReads = 0;
  options.withClient=(key,organizationId,callback)=>withDevinEventClient(key,organizationId,callback,async (input,init)=>{
    const request = new Request(input,init);
    assert.equal(request.redirect,'error');
    assert.equal(request.headers.get('authorization'),'Bearer cog_synthetic');
    if (request.url === 'https://api.devin.ai/v3/self') {
      identityReads++;
      return Response.json({principal_type: 'service_user', org_id: org});
    }
    assert.equal(request.url,'https://mcp.devin.ai/mcp');
    assert.equal(identityReads, 1);
    return transport.handleRequest(request);
  });
  const events = await readDevinStartupEvents(options,principal,installationId,through);
  assert.deepEqual(events.map(event=>event.nativeId),[fixture.details[0].id,fixture.details[1].id,fixture.details[3].id]);
  assert.equal(calls.length,5);
  assert.doesNotMatch(JSON.stringify(events),/cog_synthetic/);
});

test('wrong-organization, personal and enterprise credentials are rejected before the session ID is sent', async () => {
  for (const identity of [{principal_type:'service_user', org_id:'org_foreign'},
    {principal_type:'pat_user', org_id:org}, {principal_type:'service_user', org_id:null}]) {
    const urls = [];
    const fetcher = async (input, init) => {
      urls.push(String(input));
      assert.equal(init.body, undefined);
      return Response.json(identity);
    };
    await assert.rejects(withDevinEventClient('cog_synthetic', org, read =>
      read({action:'list',session_id:fixture.sessionId,first:1,event_types:['initial_user_message']}), fetcher), {status:502});
    assert.deepEqual(urls, ['https://api.devin.ai/v3/self']);
  }
});
