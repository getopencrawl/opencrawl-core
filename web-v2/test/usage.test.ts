import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryRouter} from '../src/router.tsx';
import {SourcesSummary, UsagePage, UsageReportView} from '../src/pages/usage.tsx';
import type {ConsoleDataAdapter, UsageReport} from '../src/pages/types.ts';
import {ago, compact, count, sortedMembers, speciesLabel} from '../src/pages/usage-model.ts';

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

test('the restored top-level narrative uses measured imports, index totals and query speed before the report sections', () => {
  const html = render();
  const summary = html.match(/<p class="report-summary">(.*?)<\/p>/)?.[1];
  assert.ok(summary);
  assert.equal(summary.replace(/<[^>]*>/g, ''), 'OpenCrawl has brought in 13,144 records from 3 sources, with 1,357,516 documents indexed. Recent index queries took a median 28 ms.');
  assert.deepEqual([...summary.matchAll(/<strong>(.*?)<\/strong>/g)].map(match => match[1]), ['13,144 records', '1,357,516 documents indexed', '28 ms']);
  assert.ok(html.indexOf('report-summary') < html.indexOf('>Agent sessions</h2>'));
});

test('the summary distinguishes measured zero from missing or incomplete reporting', () => {
  const data = report();
  assert.ok(data.ingestion?.index);
  data.ingestion.sources = [{name: 'Example source', icon: '/source.svg', state: 'synced', records: 0, indexed: 0, lastSyncedAt: null}];
  Object.assign(data.ingestion.index, {sessionEvents: 0, connectorDocuments: 0, searchMs: 0});
  let summary = render(data).match(/<p class="report-summary">(.*?)<\/p>/)?.[1] ?? '';
  assert.match(summary, /<strong>0 records<\/strong> from 1 source, with <strong>0 documents indexed<\/strong>/);
  assert.match(summary, /median <strong>0 ms<\/strong>/);
  data.ingestion.sources[0]!.records = Number.NaN;
  data.ingestion.index.connectorDocuments = Number.NaN;
  data.ingestion.index.searchMs = null;
  summary = render(data).match(/<p class="report-summary">(.*?)<\/p>/)?.[1] ?? '';
  assert.match(summary, /OpenCrawl is connected to 1 source/);
  assert.match(summary, /Imported record counts are unavailable/);
  assert.doesNotMatch(summary, /brought in|documents indexed|median|NaN|<strong>0/);
  data.ingestion.sources = [];
  assert.match(render(data), /No sources are connected yet\. Connect your team’s tools/);
  data.ingestion = null;
  summary = render(data).match(/<p class="report-summary">(.*?)<\/p>/)?.[1] ?? '';
  assert.equal(summary, 'Source reporting is unavailable.');
});

test('source tiles show indexed and imported breakdowns without redundant aggregate totals', () => {
  const html = render(), slack = sourceCard(html, 'Slack');
  for (const name of ['Slack', 'Notion', 'GitHub']) {
    assert.doesNotMatch(sourceCard(html, name), /report-source-count|indexed documents?|<strong>Imported<\/strong>/);
  }
  const indexed = slack.match(/<ul[^>]+aria-label="Indexed content in Slack"[^>]*>(.*?)<\/ul>/)?.[1];
  assert.ok(indexed);
  assert.match(indexed, /<span>Messages<\/span><span>3,550<\/span>/);
  assert.match(indexed, /<span>Files<\/span><span>0<\/span>/);
  assert.doesNotMatch(indexed, /Imported channel records|1,910|18/);
  assert.doesNotMatch(slack, /1,910/);
  assert.match(slack, /<h4 class="report-source-label">Imported<\/h4>/);
  assert.match(slack, /aria-label="Imported records from Slack"/);
  assert.match(slack, /Imported channel records/);
  assert.match(slack, /<span>Imported channel records<\/span><span>18<\/span>/);
  const github = sourceCard(html, 'GitHub');
  assert.doesNotMatch(github, /report-source-imported/);
  assert.match(github, /Pull requests/);
  assert.match(github, /Issue comments/);
  assert.equal(speciesLabel('new_document_kind'), 'New document kind');
  assert.equal(speciesLabel('Already readable'), 'Already readable');
});

test('missing species remain unavailable even with an indexed total; empty and measured zero remain distinct', () => {
  const data = report();
  assert.ok(data.ingestion);
  const source = data.ingestion.sources[0];
  assert.ok(source);
  delete source.indexedSpecies;
  let html = sourceCard(render(data), 'Slack');
  assert.doesNotMatch(html, /report-source-count|indexed documents?/);
  assert.match(html, /Indexed breakdown unavailable/);
  assert.doesNotMatch(html, /report-indexed-species/);
  source.indexed = null;
  html = sourceCard(render(data), 'Slack');
  assert.match(html, /Indexed breakdown unavailable/);
  assert.doesNotMatch(html, /report-source-count|indexed documents?/);
  source.indexed = 0;
  source.indexedSpecies = [{name: 'message', count: 0}];
  html = sourceCard(render(data), 'Slack');
  assert.doesNotMatch(html, /report-source-count|indexed documents?/);
  assert.match(html, /<span>Messages<\/span><span>0<\/span>/);
  assert.doesNotMatch(html, /Indexed breakdown unavailable/);
  source.indexedSpecies = [];
  assert.match(sourceCard(render(data), 'Slack'), /No indexed content yet/);
});

test('Agent sessions retains measured activity, breakdowns and contextual facts without treating messages as turns', () => {
  const html = render();
  const agents = html.slice(0, html.indexOf('>Data sources</h2>'));
  for (const label of ['Sessions', 'Messages', 'Tool calls', 'Machines']) {
    assert.equal((agents.match(new RegExp(`<dt>${label}</dt>`, 'g')) || []).length, 1, label);
  }
  for (const text of ['Busiest day: 2026-11-07 with 5 sessions', 'Where agents run', 'Claude Code', 'Terminal', 'opencrawl: search', 'OpenCrawl tool calls:', '5 minutes ago', '2026-11-01']) {
    assert.ok(agents.includes(text), text);
  }
  assert.match(agents, /Agent sessions per day/);
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
  assert.match(html, /Most sources connected/);
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
