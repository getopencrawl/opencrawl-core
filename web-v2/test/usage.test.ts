import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryRouter} from '../src/router.tsx';
import {UsagePage, UsageReportView} from '../src/pages/usage.tsx';
import type {ConsoleDataAdapter, UsageReport} from '../src/pages/types.ts';
import {ago, compact, count, harnessName, sortedMembers} from '../src/pages/usage-model.ts';
import {harnessName as libraryHarnessName} from '../src/pages/library-controls.tsx';
import {SessionsPage, sessionPath} from '../src/pages/sessions.tsx';
import type {LibraryAdapter} from '../src/pages/library-types.ts';
import {ConsoleDataProvider} from '../src/data.tsx';
import {copyText} from '../src/onboarding/copy.tsx';
import type {ValueReport} from '../src/pages/types.ts';
import {reconcileUsage} from '../src/pages/usage-recovery.ts';

const now = Date.parse('2026-11-07T20:00:00Z');

function report(): UsageReport {
  return {
    workspace: 'Example workspace', team: true, days: 30, generatedAt: new Date(now).toISOString(),
    ingestion: {
      sources: [
        {name: 'Slack', icon: '/assets/integrations/slack.svg', account: 'Example', state: 'syncing', records: 1910,
          units: ['message', 'messages'], indexed: 3550, indexedSpecies: [{name: 'message', count: 3550}, {name: 'file', count: 0}],
          rows: [{label: 'Imported channel records', count: 18}], lastSyncedAt: '2026-11-07T19:40:00Z'},
        {name: 'Notion', icon: '/assets/integrations/notion.svg', account: 'example', state: 'synced', records: 4,
          units: ['page', 'pages'], indexed: 12, indexedSpecies: [{name: 'page', count: 12}], lastSyncedAt: '2026-11-07T19:41:00Z'},
        {name: 'GitHub', icon: '/assets/integrations/github.svg', account: 'example, 60 repositories', state: 'synced', records: 11230,
          units: ['commit', 'commits'], indexed: 16136,
          indexedSpecies: [{name: 'commit', count: 11230}, {name: 'pull_request', count: 4000}, {name: 'issue_comment', count: 906}],
          lastSyncedAt: '2026-11-07T19:41:00Z'},
      ],
      index: {sessionEvents: 1337818, connectorDocuments: 19698, sources: [{name: 'Slack', count: 3550}, {name: 'Notion', count: 12}, {name: 'GitHub', count: 16136}], searchMs: 28, probes: [24, 28, 31]},
    },
    agents: {
      events: 100, lifetimeEvents: 1337818, sessions: 8, messages: 30, toolCalls: 60, machines: 2, opencrawlCalls: 4,
      people: [{userId: 'first'}, {userId: 'second'}], tools: [{name: 'mcp__opencrawl__search', count: 4}],
      harnesses: [{name: 'claude-code', count: 70}, {name: 'codex', count: 30}], origins: [{name: 'cli', count: 90}, {name: 'cloud', count: 10}],
      firstAt: '2026-11-01T10:00:00Z', lastAt: '2026-11-07T19:55:00Z',
      daily: [{date: '2026-11-06', sessions: 3, events: 40}, {date: '2026-11-07', sessions: 5, events: 60}],
    },
    overlap: {timeZone: 'UTC', measuredAt: new Date(now).toISOString(), sessions: 8, daily: [{date: '2026-11-07', average: 1, peak: 2, partial: true}]},
    members: [
      {userId: 'first', name: 'Alex', email: 'alex@example.test', you: true, sources: 2, sessions: 3, messages: 10, toolCalls: 20,
        weekEvents: 40, lastAt: '2026-11-07T19:55:00Z', setup: {cli: true, mcp: true, session: true, client: 'Codex'}},
      {userId: 'second', name: 'Sam', email: 'sam@example.test', you: false, sources: 1, sessions: 5, messages: 20, toolCalls: 40,
        weekEvents: 60, lastAt: '2026-11-07T19:50:00Z', setup: {cli: true, mcp: true}},
    ],
  };
}

function render(data = report()) {
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(UsageReportView, {data, now})));
}


test('partial refresh preserves only failed sections and their original freshness; recovery clears stale state', () => {
  const initial=report(),later={...report(),generatedAt:'2026-11-07T21:00:00Z',overlap:null,failedSources:['overlap'] as UsageReport['failedSources']};
  later.agents!.sessions=99;
  const partial=reconcileUsage(initial,later);
  assert.equal(partial.agents!.sessions,99);assert.deepEqual(partial.overlap,initial.overlap);
  assert.deepEqual(partial.staleSections,{overlap:initial.generatedAt});
  const again=reconcileUsage(partial,{...later,generatedAt:'2026-11-07T22:00:00Z'});
  assert.deepEqual(again.staleSections,partial.staleSections);
  const recovered=reconcileUsage(again,report());assert.deepEqual(recovered.staleSections,{});
  assert.equal(reconcileUsage(undefined,later).overlap,null);
  assert.equal(reconcileUsage(initial,{...later,days:7}).overlap,null);
  assert.equal(reconcileUsage(initial,{...later,failedSources:[]}).overlap,null);
  const missing={...report(),members:[],failedSources:['members'] as UsageReport['failedSources']};
  assert.deepEqual(reconcileUsage(missing,missing).staleSections,{});
});

test('Team leaderboard orders measured sessions then tool calls and retains actual member stats without mutating input', () => {
  const data = report();
  const html = render(data);
  assert.doesNotMatch(html, /Most sources connected/);
  assert.match(html, /Most sessions/);
  assert.match(html, /Most tool calls/);
  assert.match(html, /Ranked by sessions, then tool calls/);
  assert.match(html, /aria-label="Sessions not set up"/);
  assert.match(html, /report-email">Codex/);
  assert.match(html, /Alex<em>you<\/em>/);
  assert.deepEqual(sortedMembers(data.members).map(member => member.name), ['Sam', 'Alex']);
  assert.deepEqual(data.members.map(member => member.name), ['Alex', 'Sam']);
  const table = html.slice(html.indexOf('<table'));
  assert.ok(table.indexOf('Sam') < table.indexOf('Alex'));
  assert.match(table, /<th scope="col">Messages<\/th>/);
  assert.doesNotMatch(table, /score/i);
  const alex = data.members[0];
  assert.ok(alex);
  alex.sessions = 5;
  alex.toolCalls = 50;
  assert.equal(sortedMembers(data.members)[0]?.name, 'Alex');
  alex.name = '<script>alert(1)</script>';
  assert.doesNotMatch(render(data), /<script>/);
});

test('subagent sessions are reported beside, not inside, the sessions a person started', () => {
  const data = report();
  assert.doesNotMatch(render(data), /plus [\d,]+ subagent|\+[\d,]+ subagent/);
  if (!data.agents) throw new Error('fixture has agents');
  data.agents.subagentSessions = 2435;
  const [alex, sam] = data.members;
  if (!alex || !sam) throw new Error('fixture has members');
  alex.subagentSessions = 2435;
  const html = render(data);
  assert.match(html, /Ranked by sessions, then tool calls; subagent sessions are counted separately/);
  const table = html.slice(html.indexOf('<table'));
  assert.match(table, /<td>3<span class="report-email">\+2,435 subagent<\/span><\/td>/);
  // Ranking and highlights still use started sessions only.
  assert.deepEqual(sortedMembers(data.members).map(member => member.name), ['Sam', 'Alex']);
  assert.match(html, /Most sessions<\/dt><dd><strong>Sam<\/strong><span>5 sessions/);
});

test('relative date formatting handles recent and invalid values', () => {
  assert.equal(ago('2026-11-07T20:01:00Z', now), 'just now');
  assert.equal(ago('invalid', now), 'never');
});

function value(): ValueReport {
  return {
    schema: 4, measuredAt: '2026-11-10', window: {from: '2026-11-05', to: '2026-11-10', days: 6},
    model: {model: 'GPT-6 Astra', input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50, asOf: '2026-11-09', share: 63},
    work: {sessions: 386, tasks: 368},
    spend: {input: 10_000_000, cacheRead: 1_000_000_000, cacheWrite: 0, output: 2_000_000},
    drift: {conflictsAvoided: 35, duplicatesAvoided: 7},
    usage: {searches: 340, boardMessages: 3690},
    value: {searchesUsed: 221, fixesReused: 69, found: {teammateWork: 116, whereThingsLive: 65, pastDecisions: 34, pastFixes: 2, other: 4}},
  };
}


const capture = {tokens: 52_500_000, since: '2026-11-01T00:00:00.000Z'};

test('Usage ignores historical model judgments and renders captured activity', () => {
  const current = render({...report(), value: null, capture});
  const legacy = render({...report(), value: value(), capture});
  assert.equal(legacy, current);
  assert.doesNotMatch(legacy, /Agent alignment|Drift saves|Answers agents used/);
});

test('Usage offers the onboarding prompt in its header only when the workspace supplies one', () => {
  const adapter: ConsoleDataAdapter = {usage: async () => report(), search: async () => ({}), board: async () => ({messages: [], topicSummaries: [], next: null})};
  const prompt = 'Set up OpenCrawl across all coding agents and environments I use.';
  const page = (setupPrompt?: string) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(UsagePage, {adapter, setupPrompt})));
  const header = (html: string) => html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  const offered = header(page(prompt));
  // One shared button to the right of the title, with a status region for the confirmation.
  assert.match(offered, /<h1[^>]*>Usage<\/h1>.*<div class="actions"><button type="button" class="oc-button secondary[^"]*">(?:<svg.*?<\/svg>)?Copy onboarding prompt<\/button><span class="sr-only" role="status"><\/span><\/div>$/s);
  // The prompt is copied on request; it is not printed into the page.
  assert.doesNotMatch(page(prompt), /Set up OpenCrawl across/);
  for (const html of [page(), page('')]) {
    assert.match(header(html), /<h1[^>]*>Usage<\/h1>/);
    assert.doesNotMatch(html, /Copy onboarding prompt|class="actions"/);
  }
});

test('copying writes the exact prompt and reports when the browser cannot copy', async () => {
  const prompt = 'Set up OpenCrawl.\n\n1. Prepare without asking: run opencrawl whoami --api https://app.example.test --json “once”.';
  const written: string[] = [];
  assert.equal(await copyText(prompt, {writeText: async text => {written.push(text);}}), true);
  assert.deepEqual(written, [prompt]);
  // A refused or failing write, or no clipboard at all, reports false: the button then opens Agent setup, which has the manual copy path.
  assert.equal(await copyText(prompt, {writeText: async () => {throw new Error('Clipboard denied');}}), false);
  assert.equal(await copyText(prompt, {writeText: () => {throw new Error('Clipboard unavailable');}}), false);
  assert.equal(await copyText(prompt, {} as Pick<Clipboard, 'writeText'>), false);
  assert.equal(await copyText(prompt), false);
  assert.deepEqual(written, [prompt]);
});

test('shared setup is labeled once instead of marking personal installations missing',()=>{
 const data=report();
 for(const member of data.members)member.setup={shared:{name:'Replicas',observedAt:'2026-11-13T00:00:00Z'}};
 const html=renderToStaticMarkup(createElement(MemoryRouter,null,createElement(UsageReportView,{data,now})));
 assert.match(html,/Shared Replicas setup/);assert.doesNotMatch(html,/CLI not set up|MCP not set up|Sessions not set up/);
});

const headings = (html: string) => [...html.matchAll(/<h([23])\b[^>]*>([^<]+)<\/h\1>/g)].map(match => match[2]);

test('Team shows its totals, sessions per day, the leaders and member activity, in that order', () => {
  const html = render();
  assert.deepEqual(headings(html), ['Agent sessions per day', 'Member activity']);
  assert.deepEqual([...html.matchAll(/<dt>([^<]+)<\/dt><dd><span class="report-metric-value"[^>]*>([^<]+)/g)].map(match => [match[1], match[2]]),
    [['Sessions', '8'], ['Active members', '2 of 2'], ['Tool calls', '60']]);
  assert.match(html, /<title>2026-11-07: 5 sessions<\/title>/);
  assert.ok(html.indexOf('Agent sessions per day') < html.indexOf('Most sessions'));
  assert.ok(html.indexOf('Most sessions') < html.indexOf('Member activity'));
  assert.doesNotMatch(html, /Tokens captured|Machines capturing|Where agents run|Main session overlap|Data sources/);
});

test('failed session or team reads show notices instead of zero totals or an invented ranking', () => {
  const failed = render({...report(), agents: null, failedSources: ['sessions']});
  assert.match(failed, /Session activity couldn’t load/);
  assert.match(failed, /Team activity couldn’t load/);
  assert.doesNotMatch(failed, /Ranked by sessions|report-metric|Agent sessions per day/);
  const empty = report();
  Object.assign(empty.agents!, {events: 0, sessions: 0, messages: 0, toolCalls: 0, daily: [], people: []});
  assert.match(render(empty), /No agent sessions captured yet/);
  assert.match(render({...report(), members: []}), /Team reporting isn’t available/);
  assert.equal(count(null), 'Unavailable');
  assert.equal(compact(Number.NaN), 'Unavailable');
  assert.equal(compact(0), '0');
});

test('every captured agent has one readable name on Usage and in the session library', () => {
  for (const [harness, name] of [['claude-code', 'Claude Code'], ['codex', 'Codex'], ['cursor', 'Cursor'], ['grok-bot', 'Grok Bot'], ['antigravity', 'Antigravity']] as const) {
    assert.equal(harnessName(harness), name); assert.equal(libraryHarnessName(harness), name);
  }
  const library: LibraryAdapter = async () => new Promise(() => {});
  const viewerHtml = renderToStaticMarkup(createElement(ConsoleDataProvider, {
    scopeKey: 'antigravity-viewer',
    children: createElement(MemoryRouter, {initialEntries: [sessionPath({userId: 'alice', harness: 'antigravity', sessionId: 'conv-1'})]},
      createElement(SessionsPage, {adapter: library})),
  }));
  assert.match(viewerHtml, /aria-label="Back to sessions"[^>]*href="\/sessions"/);
});
