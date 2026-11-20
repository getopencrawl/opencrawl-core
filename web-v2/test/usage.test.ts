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
      daily: [{date: '2026-11-06', sessions: 3, events: 40, tokens: 1_200_000}, {date: '2026-11-07', sessions: 5, events: 60, tokens: 800_000}],
      indexedTokens: 9_500_000, tokenHistory: [{date: '2026-11-04', tokens: 7_500_000}, {date: '2026-11-05', tokens: 0}, {date: '2026-11-06', tokens: 1_200_000}, {date: '2026-11-07', tokens: 800_000}],
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

function cards(html: string, heading: string) {
  const start = html.indexOf(`>${heading}</h2>`);
  const section = html.slice(start, html.indexOf('</section>', start));
  return [...section.matchAll(/<dt>([^<]*)(?:<span class="report-help">.*?<\/span><\/span>)?<\/dt><dd><span class="report-metric-value"[^>]*>(.*?)<\/span>(?:<span class="report-metric-note">(.*?)<\/span>)?/g)].map(match => match.slice(1, 4));
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


const headings = (html: string) => [...html.matchAll(/<h([23])\b[^>]*>([^<]+)<\/h\1>/g)].map(match => match[2]);
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

test('Usage leads with consumption, then sources, then team, without billing, setup or tool rankings', () => {
  const html = render({...report(), capture});
  assert.deepEqual(headings(html), ['Overview', 'Indexed session tokens', 'Indexed items by source', 'Team', 'Agent sessions per day']);
  assert.deepEqual(cards(html, 'Overview').map(card => card.slice(0, 2)), [['Session tokens indexed', '2M'], ['Source items indexed', '19.7k']]);
  // Cards carry a label and a number only.
  assert.ok(cards(html, 'Overview').every(card => card[2] === undefined));
  assert.doesNotMatch(html, /Tokens captured|since 2026-11-01|Machines capturing|Where agents run|Most used|Setup|set up|Rank|Main session overlap|report-line-chart|Proactive searches|Most sessions/);
  const adapter: ConsoleDataAdapter = {usage: async () => report(), search: async () => ({}), board: async () => ({messages: [], topicSummaries: [], next: null})};
  const page = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(UsagePage, {adapter})));
  assert.doesNotMatch(page.slice(page.indexOf('<header'), page.indexOf('</header>')), /<p>/);
});

test('session tokens chart by session day; a 30-day total is unavailable when a day was not measured', () => {
  const html = render();
  assert.match(html, /<title>2026-11-06: 1,200,000 tokens<\/title>/);
  assert.match(html, /title="2,000,000">2M</);
  const partial = report();
  delete partial.agents!.daily[0]!.tokens;
  const unmeasured = render(partial);
  assert.match(unmeasured, /<title>2026-11-06: not tracked<\/title>/);
  assert.equal(cards(unmeasured, 'Overview')[0]![1], 'Unavailable');
});

test('sources list indexed items largest first; failed counts and missing reporting are not shown as zero', () => {
  const html = render();
  const sources = text(html.slice(html.indexOf('Indexed items by source'), html.indexOf('>Team</h2>')));
  assert.match(sources, /GitHub 16,136 Slack 3,550 Notion 12/);
  assert.match(html, /href="\/integrations"[^>]*>Manage</);
  const failed = render({...report(), failedSources: ['connectors']});
  assert.match(failed, /Indexed item counts unavailable/);
  assert.doesNotMatch(failed, /report-bars/);
  assert.match(render({...report(), ingestion: {sources: [], index: null}}), /No sources connected/);
  assert.match(render({...report(), ingestion: null}), /Source reporting isn’t available/);
});

test('failed session activity shows notices instead of zero tokens or a zero team ranking', () => {
  const html = render({...report(), agents: null, failedSources: ['sessions']});
  assert.match(html, /Session activity couldn’t load/);
  assert.doesNotMatch(html, /Session tokens indexed|Indexed session tokens/);
  assert.match(html, /Team activity couldn’t load/);
  assert.doesNotMatch(html, /Team usage/);
  assert.match(html, /Indexed items by source/);
});

test('team table orders measured sessions then tool calls and reports subagents beside them', () => {
  const html = render();
  const rows = [...html.matchAll(/<th scope="row"><span class="report-member">([^<]+)/g)].map(match => match[1]);
  assert.deepEqual(rows, ['Sam', 'Alex']);
  const data = report();
  data.members[0]!.subagentSessions = 2;
  assert.match(text(render(data)), /Alex you 3 \+2 subagents 10 20/);
  assert.deepEqual([...render().matchAll(/<th scope="col">([^<]+)/g)].map(match => match[1]), ['Member', 'Sessions', 'Messages', 'Tool calls', 'Last active']);
});

test('shared helpers: readable agent names everywhere, unavailable is never zero, ranking does not mutate', () => {
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
  assert.equal(count(null), 'Unavailable');
  assert.equal(compact(Number.NaN), 'Unavailable');
  assert.equal(compact(0), '0');
  const data = report();
  assert.deepEqual(sortedMembers(data.members).map(member => member.name), ['Sam', 'Alex']);
  assert.deepEqual(data.members.map(member => member.name), ['Alex', 'Sam']);
  const empty = report();
  Object.assign(empty.agents!, {events: 0, sessions: 0, daily: [], people: []});
  assert.match(render(empty), /No agent sessions captured yet/);
});
