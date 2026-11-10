import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryRouter} from '../src/router.tsx';
import {SourcesSummary, UsagePage, UsageReportView} from '../src/pages/usage.tsx';
import type {ConsoleDataAdapter, UsageReport} from '../src/pages/types.ts';
import {ago, compact, count, harnessName, pricedSavings, sortedMembers, speciesLabel} from '../src/pages/usage-model.ts';
import {harnessName as libraryHarnessName} from '../src/pages/library-controls.tsx';
import type {ValueReport} from '../src/pages/types.ts';

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
    members: [
      {name: 'Alex', email: 'alex@example.test', you: true, sources: 2, sessions: 3, messages: 10, toolCalls: 20,
        weekEvents: 40, lastAt: '2026-11-07T19:55:00Z', setup: {cli: true, mcp: true, session: true, client: 'Codex'}},
      {name: 'Sam', email: 'sam@example.test', you: false, sources: 1, sessions: 5, messages: 20, toolCalls: 40,
        weekEvents: 60, lastAt: '2026-11-07T19:50:00Z', setup: {cli: true, mcp: true}},
    ],
  };
}

function render(data = report()) {
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(UsageReportView, {data, now})));
}

function sourceCard(html: string, name: string) {
  const start = html.indexOf(`aria-label="${name}"`);
  assert.notEqual(start, -1);
  return html.slice(start, html.indexOf('</article>', start));
}

test('one Usage page contains Agent sessions, Data sources and Team in order without tabs or index comparison bars', () => {
  const html = render();
  assert.deepEqual([...html.matchAll(/<h2\b[^>]*>([^<]+)<\/h2>/g)].map(match => match[1]), ['Agent sessions', 'Data sources', 'Team']);
  assert.match(html, /Daily agent sessions/);
  assert.match(html, /aria-label="Slack"/);
  assert.match(html, /Member activity/);
  assert.doesNotMatch(html, /role="tab|What’s in the index|Indexed source records|analytics come next|turns saved/i);
  const sources = html.slice(html.indexOf('>Data sources</h2>'), html.indexOf('>Team</h2>'));
  assert.doesNotMatch(sources, /<svg|report-bars|bar-track/);
  const adapter: ConsoleDataAdapter = {usage: async () => report(), search: async () => ({}), board: async () => ({messages: [], topicSummaries: [], next: null})};
  const page = renderToStaticMarkup(createElement(MemoryRouter, {initialEntries: ['/?tab=team']}, createElement(UsagePage, {adapter})));
  assert.doesNotMatch(page, /role="tablist"|role="tab"/);
});

test('Usage opens on its sections, without a summary sentence about imports or index speed', () => {
  const html = render();
  assert.doesNotMatch(html, /report-summary|brought in|documents indexed|Recent index queries/);
  assert.ok(html.indexOf('>Agent sessions</h2>') < html.indexOf('>Data sources</h2>'));
});

test('source tiles show only content-type counts without import details or technical labels', () => {
  const html = render(), slack = sourceCard(html, 'Slack');
  for (const name of ['Slack', 'Notion', 'GitHub']) {
    assert.doesNotMatch(sourceCard(html, name), /report-source-count|report-source-label|report-source-imported|Imported|Indexed|indexed documents?/);
  }
  const indexed = slack.match(/<ul[^>]+aria-label="Content in Slack"[^>]*>(.*?)<\/ul>/)?.[1];
  assert.ok(indexed);
  assert.match(indexed, /<span>Messages<\/span><span>3,550<\/span>/);
  assert.match(indexed, /<span>Files<\/span><span>0<\/span>/);
  assert.doesNotMatch(indexed, /Imported channel records|1,910|18/);
  assert.doesNotMatch(slack, /Imported channel records|1,910/);
  const github = sourceCard(html, 'GitHub');
  assert.doesNotMatch(github, /report-source-imported/);
  assert.match(github, /Pull requests/);
  assert.match(github, /Issue comments/);
  assert.equal(speciesLabel('new_document_kind'), 'New document kind');
  assert.equal(speciesLabel('Already readable'), 'Already readable');
});

test('a partial index inventory marks only its aggregate unavailable and keeps measured details visible', () => {
  for (const missing of ['sessionEvents','connectorDocuments'] as const) {
    const data = report();
    assert.ok(data.ingestion?.index);
    data.ingestion.index[missing] = null;
    const html = render(data);
    assert.match(sourceCard(html,'Slack'), /<span>Messages<\/span><span>3,550<\/span>/);
    assert.doesNotMatch(sourceCard(html,'Slack'), /Imported channel records/);
    assert.match(html, /Daily agent sessions/);
  }
});

test('missing species remain unavailable even with an indexed total; empty and measured zero remain distinct', () => {
  const data = report();
  assert.ok(data.ingestion);
  const source = data.ingestion.sources[0];
  assert.ok(source);
  delete source.indexedSpecies;
  let html = sourceCard(render(data), 'Slack');
  assert.doesNotMatch(html, /report-source-count|indexed documents?/);
  assert.match(html, /Content breakdown unavailable/);
  assert.doesNotMatch(html, /report-indexed-species/);
  source.indexed = null;
  html = sourceCard(render(data), 'Slack');
  assert.match(html, /Content breakdown unavailable/);
  assert.doesNotMatch(html, /report-source-count|indexed documents?/);
  source.indexed = 0;
  source.indexedSpecies = [{name: 'message', count: 0}];
  html = sourceCard(render(data), 'Slack');
  assert.doesNotMatch(html, /report-source-count|indexed documents?/);
  assert.match(html, /<span>Messages<\/span><span>0<\/span>/);
  assert.doesNotMatch(html, /Content breakdown unavailable/);
  source.indexedSpecies = [];
  assert.match(sourceCard(render(data), 'Slack'), /No content yet/);
});

test('Agent sessions retains measured activity, breakdowns and contextual facts without treating messages as turns', () => {
  const html = render();
  const agents = html.slice(0, html.indexOf('>Data sources</h2>'));
  for (const label of ['Sessions', 'Messages', 'Tool calls', 'OpenCrawl calls']) {
    assert.equal((agents.match(new RegExp(`<dt>${label}</dt>`, 'g')) || []).length, 1, label);
  }
  for (const text of ['Busiest day: 2026-11-07 with 5 sessions', 'Where agents run', 'Claude Code', 'Terminal', 'opencrawl: search', 'Machines capturing:', '5 minutes ago', '2026-11-01']) {
    assert.ok(agents.includes(text), text);
  }
  assert.match(agents, /Agent sessions per day/);
  // Every captured agent has a readable name on Usage and in the session library.
  for (const [harness, name] of [['claude-code', 'Claude Code'], ['codex', 'Codex'], ['grok-bot', 'Grok Bot']] as const) {
    assert.equal(harnessName(harness), name); assert.equal(libraryHarnessName(harness), name);
  }
  assert.doesNotMatch(agents, /\bturns?\b|analytics come next/i);
});

test('unavailable reporting does not masquerade as empty and never hides the other report sections', () => {
  const data = report();
  data.agents = null;
  data.ingestion = null;
  const html = render(data);
  assert.match(html, /Agent reporting isn’t available/);
  assert.match(html, /Source reporting isn’t available/);
  assert.match(html, />Team<\/h2>/);
  assert.match(html, /Member activity/);
  assert.doesNotMatch(html, /No agent sessions captured yet/);
  const empty = report();
  assert.ok(empty.agents);
  Object.assign(empty.agents, {events: 0, sessions: 0, messages: 0, toolCalls: 0, machines: 0, opencrawlCalls: 0, daily: [], people: []});
  assert.match(render(empty), /No agent sessions captured yet/);
  assert.equal(count(null), 'Unavailable');
  assert.equal(compact(Number.NaN), 'Unavailable');
  assert.equal(compact(0), '0');
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
  assert.match(html, /plus 2,435 subagent sessions/);
  assert.match(html, /Ranked by sessions, then tool calls; subagent sessions are counted separately/);
  const table = html.slice(html.indexOf('<table'));
  assert.match(table, /<td>3<span class="report-email">\+2,435 subagent<\/span><\/td>/);
  // Ranking and highlights still use started sessions only.
  assert.deepEqual(sortedMembers(data.members).map(member => member.name), ['Sam', 'Alex']);
  assert.match(html, /Most sessions<\/dt><dd><strong>Sam<\/strong><span>5 sessions/);
});

test('date formatting and compact source-summary exports remain usable by existing consumers', () => {
  assert.equal(ago('2026-11-07T20:01:00Z', now), 'just now');
  assert.equal(ago('invalid', now), 'never');
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SourcesSummary, {data: report()})));
  assert.match(html, /<table/);
  assert.match(html, /Connected source status/);
  assert.doesNotMatch(html, /report-source-grid|report-indexed-species/);
});

function value(): ValueReport {
  return {
    schema: 3, measuredAt: '2026-11-10', window: {from: '2026-11-05', to: '2026-11-10', days: 6},
    model: {model: 'GPT-6 Astra', input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50, asOf: '2026-11-09', share: 63},
    savings: {sessions: 69, tasks: 368, uses: 290, digTokens: 812809, digTurns: 5, tokenPercent: 3.7, turns: 1008, turnPercent: 4.1,
      tokens: {input: 10_000_000, cacheRead: 1_000_000_000, cacheWrite: 0, output: 2_000_000}},
    observed: {conflictsAvoided: 37, duplicatesAvoided: 10, knowledgeReused: 52, searches: 245, searchesUseful: 206, searchesUsed: 171},
  };
}

function cards(html: string, heading: string) {
  const start = html.indexOf(`>${heading}</h2>`);
  const section = html.slice(start, html.indexOf('</section>', start));
  return [...section.matchAll(/<dt>([^<]*)(?:<span class="report-help">.*?<\/span><\/span>)?<\/dt><dd><span class="report-metric-value"[^>]*>(.*?)<\/span>(?:<span class="report-metric-note">(.*?)<\/span>)?/g)].map(match => match.slice(1, 4));
}

test('Agent savings is the first section: four cards priced at the main model, with no explanatory note', () => {
  const html = render({...report(), value: value()});
  assert.deepEqual([...html.matchAll(/<h2\b[^>]*>([^<]+)<\/h2>/g)].map(match => match[1]), ['Agent savings', 'Agent sessions', 'Data sources', 'Team']);
  assert.ok(html.indexOf('>Agent savings</h2>') < html.indexOf('report-metrics'));
  // 10M input at $10 + 1B cache reads at $1 + 2M output at $50 = $1,200.
  assert.equal(pricedSavings(value().savings.tokens, value().model), 1200);
  assert.deepEqual(cards(html, 'Agent savings'), [
    ['Saved vs GPT-6 Astra', '$1,200', '3.7% fewer tokens'],
    ['Turns saved', '1,008', '4.1% fewer turns, across 290 uses'],
    ['Conflicts avoided', '37', 'plus 10 duplicate tasks skipped'],
    ['Searches used', '171', 'of 245 searches by your agents'],
  ]);
  const text = html.replace(/<[^>]*>/g, '');
  assert.doesNotMatch(text, /OpenCrawl cost|of OpenCrawl usage|×/);
  assert.match(text, /What OpenCrawl saved your team since 2026-11-05, across 69 sessions and 368 tasks\./);
  const section = text.slice(text.indexOf('Agent savings'), text.indexOf('Agent sessions'));
  assert.doesNotMatch(section.replace(/How [^?]*\?/g, ''), /Measured|replaying|held-out|skills install|could|would have saved/);
  const help = [...html.matchAll(/<button type="button" class="report-help-button" aria-label="([^"]+)" aria-describedby="([^"]+)">\?<\/button><span class="report-help-text" role="tooltip" id="([^"]+)">(.*?)<\/span>/g)];
  assert.deepEqual(help.map(match => match[1]), ['How Saved vs GPT-6 Astra is calculated', 'How Turns saved is calculated', 'How Conflicts avoided is calculated', 'How Searches used is calculated']);
  assert.ok(help.every(match => match[2] === match[3]));
  assert.equal(help[0]![4], 'Your agents used an OpenCrawl search result, or another agent’s fix from the board, 290 times. Each is valued at what your agents spend finding that kind of answer themselves, a median 813k tokens in your own sessions, less the cost of the search, at GPT-6 Astra list prices.');
  assert.equal(help[1]![4], 'Each of those 290 uses is valued at the median 5 turns your agents take to find that kind of answer themselves, in your own sessions. We subtract the two turns a search and reading its result take.');
  assert.match(help[3]![4]!, /^245 searches is every OpenCrawl search your agents ran for real work, not counting tests of OpenCrawl\. 171 is how many times/);
  assert.doesNotMatch(section, /tokens? saved|M saved|B saved|would have|Without OpenCrawl|tests of OpenCrawl/);
  assert.doesNotMatch(cards(render(), 'Agent sessions').join(' ') + render(), /report-help/);
});

test('without a measurement there is no Agent savings section; no searches yet says so on the card', () => {
  assert.doesNotMatch(render(), /Agent savings/);
  assert.doesNotMatch(render({...report(), value: null}), /Agent savings/);
  const html = render({...report(), value: {...value(), observed: {...value().observed, searches: 0, searchesUseful: 0, searchesUsed: 0}}});
  assert.deepEqual(cards(html, 'Agent savings')[3], ['Searches used', '0', 'your agents haven’t searched yet']);
});

test('Agent sessions shows tokens captured when metered and OpenCrawl calls instead of machines', () => {
  assert.deepEqual(cards(render({...report(), capture: {tokens: 142_500_000, since: '2026-11-01T00:00:00.000Z'}}), 'Agent sessions').map(card => card[0]),
    ['Sessions', 'Messages', 'Tokens captured', 'OpenCrawl calls']);
  assert.deepEqual(cards(render({...report(), capture: {tokens: 142_500_000, since: '2026-11-01T00:00:00.000Z'}}), 'Agent sessions')[2], ['Tokens captured', '143M', 'since 2026-11-01, from agent sessions']);
  assert.deepEqual(cards(render(), 'Agent sessions').map(card => card[0]), ['Sessions', 'Messages', 'Tool calls', 'OpenCrawl calls']);
  assert.match(render().replace(/<[^>]*>/g, ''), /Machines capturing: 2\. Last capture/);
});
