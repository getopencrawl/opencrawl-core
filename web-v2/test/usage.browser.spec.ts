import {test, expect, type Page} from '@playwright/test';
import type {UsageReport} from '../src/pages/types.ts';

const DAY = 86_400_000, today = Date.UTC(2026, 10, 19);
const day = (offset: number) => new Date(today - offset * DAY).toISOString().slice(0, 10);
const span = (days: number, value: (i: number) => number | null) => Array.from({length: days}, (_, i) => ({date: day(days - 1 - i), value: value(i)}));
const scope = 'usage-fixture';

const details = (days: number | null): UsageReport & {cacheScope: string} => ({cacheScope: scope, workspace: null, days, generatedAt: '2026-11-19T12:00:00Z', overlap: null, ingestion: null,
  members: [{userId: 'user_alex', name: 'Alex Example', email: 'alex@example.test', you: true, sources: 1, sessions: days === 7 ? 2 : 3, messages: 4, toolCalls: 5, weekEvents: 1, lastAt: null, setup: {}},
    {userId: 'user_sam', name: 'Sam Example', email: 'sam@example.test', you: false, sources: 0, sessions: 1, messages: 2, toolCalls: 9, weekEvents: 0, lastAt: null, setup: {}}],
  agents: {events: 50, lifetimeEvents: 100, sessions: days === 7 ? 3 : 4, messages: 6, toolCalls: 14, machines: 2, opencrawlCalls: 5, tools: [], harnesses: [], origins: [],
    firstAt: null, lastAt: null, daily: span(days ?? 40, i => i % 2).map(({date, value}) => ({date, sessions: value ?? 0, events: value ?? 0}))},
});
const sessionRow = (i: number) => ({userId: i % 2 ? 'user_sam' : 'user_alex', harness: 'codex', sessionId: `session-${String(i).padStart(3, '0')}-abcdef`, tokens: 1000 + i, lastAt: new Date(today - i * 3_600_000).toISOString()});
const searchRow = (i: number, kind: string) => ({id: `${kind}-${i}`, at: new Date(today - i * 3_600_000).toISOString(), userId: i % 2 ? 'user_unknown' : 'user_alex', operation: 'search',
  queries: [`${kind} query ${i}`], harness: 'claude-code', sessionId: `s${i}`, messageId: null, message: kind === 'proactive' ? `prompt ${i}` : null, returned: 2, outcome: 'complete', delivered: false});

async function serve(page: Page, {sessions = 60}: {sessions?: number} = {}) {
  const requests: Record<string, unknown[]> = {tokens: [], sessions: [], calls: [], history: [], details: []};
  await page.route('**/api/console/usage/highlights', route => route.fulfill({json: {cacheScope: scope, workspace: 'Example', value: null, capture: null, days: 30, generatedAt: '2026-11-19T12:00:00Z'}}));
  await page.route('**/api/console/usage/details', route => {
    const {range} = route.request().postDataJSON() as {range: string};
    requests.details!.push(range);
    return route.fulfill({json: details(range === '7d' ? 7 : range === 'all' ? null : 30)});
  });
  await page.route('**/api/console/usage/tokens', route => {
    const {range} = route.request().postDataJSON() as {range: string};
    requests.tokens!.push(range);
    const days = range === '7d' ? 7 : range === 'all' ? 45 : 30;
    const daily = span(days, i => 1000 * (i + 1)).map(({date, value}) => ({date, count: value}));
    return route.fulfill({json: {cacheScope: scope, source: 'meter', range, total: daily.reduce((sum, d) => sum + (d.count ?? 0), 0), daily}});
  });
  await page.route('**/api/console/usage/token-sessions', route => {
    const input = route.request().postDataJSON() as {range: string; offset?: number};
    requests.sessions!.push(input);
    const start = input.offset ?? 0;
    return route.fulfill({json: {cacheScope: scope, rows: Array.from({length: Math.max(0, Math.min(25, sessions - start))}, (_, i) => sessionRow(start + i)), next: start + 25 < sessions ? start + 25 : null}});
  });
  await page.route('**/api/console/usage/calls', route => {
    const {range} = route.request().postDataJSON() as {range: string};
    requests.calls!.push(range);
    const days = range === '7d' ? 7 : range === 'all' ? 40 : 30;
    // Tracking began 35 days ago: earlier days are not tracked rather than zero.
    const daily = span(days, i => i).map(({date}, i) => date < day(34) ? {date, agentSearches: null, nonSilent: null} : {date, agentSearches: i, nonSilent: 2 * i});
    const sum = (key: 'agentSearches' | 'nonSilent') => daily.reduce((total, d) => total + (d[key] ?? 0), 0);
    return route.fulfill({json: {cacheScope: scope, since: day(34) + 'T00:00:00.000Z', calls: 999, agentSearches: sum('agentSearches'), proactiveChecks: 500, nonSilent: sum('nonSilent'), delivered: 0, daily}});
  });
  await page.route('**/api/console/usage/search-history', route => {
    const input = route.request().postDataJSON() as {kind: string; range?: string; edits?: boolean; before?: string};
    requests.history!.push(input);
    return route.fulfill({json: {cacheScope: scope, rows: Array.from({length: 3}, (_, i) => searchRow(i, input.kind)), next: null}});
  });
  return requests;
}

const tab = (page: Page, name: string) => page.getByRole('tab', {name, exact: true});
const metric = (page: Page, label: string) => page.locator('.report-metric').filter({hasText: label}).locator('.report-metric-value');
const chartTotal = (page: Page, title: string) => page.getByRole('region', {name: title, exact: true}).locator('.report-chart-total');
/** Hover one day's column and read the tooltip. */
async function hoverDay(page: Page, title: string, index: number) {
  const region = page.getByRole('region', {name: title, exact: true});
  const hits = region.locator('.report-bar-hit');
  await hits.nth(index < 0 ? await hits.count() + index : index).hover();
  return region.locator('.report-bar-tip');
}

for (const width of [1440, 390]) test(`tabs and the date range sit on one bar and every tab fits at ${width}px`, async ({page}, info) => {
  await page.setViewportSize({width, height: 900});
  await serve(page);
  await page.goto('/usage?split&activity');
  await expect(page.getByRole('tablist', {name: 'Usage'}).getByRole('tab')).toHaveText(['Overview', 'Searches', 'Proactive context', 'Team', 'Activity', 'Sources']);
  await expect(tab(page, 'Overview')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Date range').locator('option')).toHaveText(['Last 30 days', 'Last 7 days', 'All time']);
  for (const name of ['Overview', 'Searches', 'Proactive context', 'Team', 'Activity', 'Sources']) {
    await tab(page, name).click();
    if (['Overview', 'Searches', 'Proactive context', 'Team'].includes(name)) await expect(page.locator('.report-bar-chart')).toHaveCount(1);
    if (['Overview', 'Searches', 'Proactive context', 'Team'].includes(name)) await expect(page.locator('.report-bar-chart .report-bar-axis').first()).toHaveText('0');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    await page.screenshot({path: info.outputPath(`${name.replace(/ /g, '-').toLowerCase()}-${width}.png`)});
  }
});

test('Overview shows the billed totals, metered tokens per day and sessions with who ran them', async ({page}) => {
  const requests = await serve(page);
  await page.goto('/usage?split&activity');
  await expect(chartTotal(page, 'Session tokens indexed')).toHaveText('465k');
  await expect(metric(page, 'Session tokens indexed')).toHaveCount(0);
  await expect(metric(page, 'Agent searches')).toHaveText('435');
  await expect(metric(page, 'Proactive context edits')).toHaveText('870');
  const chart = page.getByRole('region', {name: 'Session tokens indexed', exact: true});
  await expect(chart.locator('.report-bar')).toHaveCount(30);
  await expect(await hoverDay(page, 'Session tokens indexed', -1)).toHaveText(`${day(0)}30,000 tokens`);
  // The y-axis starts at zero and its top gridline covers the tallest day.
  await expect(chart.locator('.report-bar-axis').first()).toHaveText('0');
  await expect(chart.locator('.report-bar-axis').nth(3)).toHaveText('30K');
  await page.mouse.move(0, 0);
  await expect(chart.locator('.report-bar-tip')).toHaveCount(0);
  await chart.locator('svg').focus();
  await page.keyboard.press('ArrowRight');
  await expect(chart.getByRole('status')).toHaveText(`${day(29)}: 1,000 tokens`);
  const table = page.getByRole('region', {name: 'Sessions', exact: true}).getByRole('table');
  await expect(table.locator('thead th')).toHaveText(['Session', 'From', 'Tokens', 'Last active']);
  await expect(table.locator('tbody tr').first()).toContainText('Alex Example');
  await expect(table.locator('tbody tr').first()).toContainText('Codex');
  await expect(table.locator('tbody tr').first().getByRole('link')).toHaveAttribute('href', '/sessions?user=user_alex&harness=codex&id=session-000-abcdef');
  await expect(table.locator('tbody tr').nth(1)).toContainText('Sam Example');
  await expect(table.locator('tbody tr')).toHaveCount(25);
  for (let i = 0; i < 6 && await table.locator('tbody tr').count() < 60; i++) await page.getByRole('region', {name: 'Sessions', exact: true}).locator('[aria-hidden="true"]').last().scrollIntoViewIfNeeded();
  await expect(table.locator('tbody tr')).toHaveCount(60);
  await expect(page.getByRole('button', {name: 'Load more'})).toHaveCount(0);
  await page.getByLabel('Date range').selectOption('7d');
  await expect(chart.locator('.report-bar')).toHaveCount(7);
  await expect(chartTotal(page, 'Session tokens indexed')).toHaveText('28k');
  expect(requests.tokens).toEqual(['30d', '7d']);
  expect(requests.sessions!.at(-1)).toEqual({range: '7d'});
});

test('Searches and Proactive context each count, chart and list only their own events for the selected range', async ({page}) => {
  const requests = await serve(page);
  await page.goto('/usage?split&activity');
  await tab(page, 'Searches').click();
  await expect(chartTotal(page, 'Agent searches')).toHaveText('435');
  await expect(page.locator('.report-metric')).toHaveCount(0);
  const searches = page.getByRole('region', {name: 'Agent searches', exact: true});
  await expect(await hoverDay(page, 'Agent searches', -1)).toHaveText(`${day(0)}29 searches`);
  await expect(searches.locator('.report-bar')).toHaveCount(30);
  const list = page.getByRole('region', {name: 'Searches', exact: true}).getByRole('table');
  await expect(list.locator('thead th')).toHaveText(['Time', 'Query', 'From', 'Session']);
  await expect(list.locator('tbody tr').first()).toContainText('agent query 0');
  await expect(list.locator('tbody tr').first()).toContainText('Alex Example');
  await expect(list.locator('tbody tr').nth(1)).toContainText('Workspace member');
  await page.getByLabel('Date range').selectOption('all');
  await expect(searches.locator('.report-bar')).toHaveCount(40);
  await expect(await hoverDay(page, 'Agent searches', 0)).toHaveText(`${day(39)}Not tracked`);
  await tab(page, 'Proactive context').click();
  await expect(chartTotal(page, 'Proactive context edits')).toHaveText('1,540');
  await expect(await hoverDay(page, 'Proactive context edits', -1)).toHaveText(`${day(0)}78 edits`);
  const edits = page.getByRole('region', {name: 'Edits', exact: true}).getByRole('table');
  await expect(edits.locator('thead th')).toHaveText(['Time', 'Triggering message', 'Search', 'Results', 'From', 'Session']);
  await expect(edits.locator('tbody tr').first()).toContainText('prompt 0');
  expect(requests.history).toContainEqual({kind: 'agent', range: '30d'});
  expect(requests.history).toContainEqual({kind: 'agent', range: 'all'});
  expect(requests.history).toContainEqual({kind: 'proactive', range: 'all', edits: true});
  expect(requests.history!.some(input => (input as {kind: string}).kind === 'proactive' && !(input as {edits?: boolean}).edits)).toBe(false);
});

test('Team keeps the leaders and member activity and follows the range', async ({page}) => {
  const requests = await serve(page);
  await page.goto('/usage?split&activity');
  await tab(page, 'Team').click();
  await expect(metric(page, 'Sessions')).toHaveText('4');
  await expect(metric(page, 'Active members')).toHaveText('2 of 2');
  await expect(page.getByText('Most sessions')).toBeVisible();
  await expect(page.getByText('Most tool calls')).toBeVisible();
  await expect(page.getByRole('region', {name: 'Team usage'}).locator('tbody tr').first()).toContainText('Alex Example');
  await page.getByLabel('Date range').selectOption('7d');
  await expect(metric(page, 'Sessions')).toHaveText('3');
  await expect(page.getByRole('region', {name: 'Agent sessions per day', exact: true}).locator('.report-bar')).toHaveCount(7);
  await expect(await hoverDay(page, 'Agent sessions per day', -1)).toHaveText(`${day(0)}0 sessions`);
  expect(requests.details).toEqual(expect.arrayContaining(['30d', '7d']));
});

test('a changed workspace clears the report instead of showing another workspace’s numbers', async ({page}) => {
  await serve(page);
  await page.route('**/api/console/usage/tokens', route => route.fulfill({json: {cacheScope: 'another-workspace', source: 'meter', range: '30d', total: 5, daily: []}}));
  await page.goto('/usage?split&activity');
  await expect(page.getByText('Your workspace changed. Reload this page.')).toBeVisible();
  await expect(chartTotal(page, 'Session tokens indexed')).toHaveCount(0);
});

test('a failed session page can be retried without losing the totals', async ({page}) => {
  await serve(page);
  let fail = true;
  await page.route('**/api/console/usage/token-sessions', route => fail ? route.fulfill({status: 503, json: {error: 'unavailable'}}) : route.fulfill({json: {cacheScope: scope, rows: [sessionRow(0)], next: null}}));
  await page.goto('/usage?split&activity');
  const sessions = page.getByRole('region', {name: 'Sessions', exact: true});
  await expect(sessions.getByText('Sessions couldn’t load.')).toBeVisible();
  await expect(chartTotal(page, 'Session tokens indexed')).toHaveText('465k');
  fail = false;
  await sessions.getByRole('button', {name: 'Try again'}).click();
  await expect(sessions.getByRole('table').locator('tbody tr')).toHaveCount(1);
});

test('without usage tabs data the page still shows the team report', async ({page}) => {
  await page.route('**/api/console/usage', route => route.fulfill({json: {...details(30), workspace: 'Example'}}));
  await page.goto('/usage');
  await expect(page.getByRole('tablist', {name: 'Usage'}).getByRole('tab')).toHaveText(['Team', 'Activity', 'Sources']);
  await expect(page.getByRole('region', {name: 'Team usage'})).toBeVisible();
});

const withActivity = (days: number | null) => ({...details(days),
  overlap: {timeZone: 'UTC' as const, measuredAt: '2026-11-19T12:00:00Z', sessions: 9, daily: span(days ?? 365, i => i).map(({date}, i) => ({date, average: i % 5, peak: 2 + i % 7, partial: false}))},
  agents: {...details(days).agents!, harnesses: [{name: 'codex', count: 900}, {name: 'claude-code', count: 80}], origins: [{name: 'desktop', count: 700}, {name: 'subagent', count: 280}],
    tools: [{name: 'exec', count: 500}, {name: 'mcp__opencrawl__opencrawl_search_v1', count: 40}]},
  ingestion: {sources: [{name: 'Slack', icon: '/assets/integrations/slack.svg', state: 'synced', records: 9, indexed: 9, indexedSpecies: [{name: 'message', count: 7}, {name: 'channel', count: 2}], lastSyncedAt: null},
    {name: 'GitHub', icon: '/assets/integrations/github.svg', state: 'syncing', records: 30, indexed: 30, indexedSpecies: [{name: 'commit', count: 30}], lastSyncedAt: null}],
    index: {sessionEvents: 100, connectorDocuments: 39, sources: [{name: 'Slack', count: 9}, {name: 'GitHub', count: 30}], searchMs: null}},
});

test('Activity shows main session overlap with hover, where agents run and tools, following the range', async ({page}) => {
  await serve(page);
  const ranges: string[] = [];
  await page.route('**/api/console/usage/details', route => {
    const {range} = route.request().postDataJSON() as {range: string};
    ranges.push(range);
    return route.fulfill({json: withActivity(range === '7d' ? 7 : range === 'all' ? null : 30)});
  });
  await page.goto('/usage?split&activity');
  await tab(page, 'Activity').click();
  const overlap = page.getByRole('region', {name: 'Main session overlap', exact: true});
  await overlap.locator('.report-line-hit').last().hover();
  await expect(overlap.locator('.report-bar-tip')).toHaveText(`${day(0)}Average 4Peak 3`);
  await expect(page.getByRole('list', {name: 'Captured events by agent'})).toContainText('Codex');
  await expect(page.getByRole('list', {name: 'Captured events by surface'})).toContainText('Subagents');
  await expect(page.getByRole('list', {name: 'Most used agent tools'})).toContainText('opencrawl: opencrawl_search_v1');
  await page.getByLabel('Date range').selectOption('all');
  await expect(overlap).toContainText('last 365 days');
  await expect(overlap.locator('.report-line-hit')).toHaveCount(365);
  expect(ranges).toEqual(expect.arrayContaining(['30d', 'all']));
});

test('Sources lists everything indexed from each source, largest first, and never shows failed counts as zero', async ({page}) => {
  await serve(page);
  let data: ReturnType<typeof withActivity> = withActivity(30);
  await page.route('**/api/console/usage/details', route => route.fulfill({json: data}));
  await page.goto('/usage?split&activity');
  await tab(page, 'Sources').click();
  const summary = page.getByRole('region', {name: 'Items indexed by source', exact: true});
  await expect(summary.locator('.report-chart-total')).toHaveText('39');
  await expect(summary.getByRole('list')).toHaveText('GitHub30Slack9');
  await expect(page.getByRole('article', {name: 'Slack'})).toContainText('Messages7');
  await expect(page.getByRole('article', {name: 'GitHub'})).toContainText('Syncing');
  data = {...withActivity(30), failedSources: ['connectors']};
  await tab(page, 'Team').click();
  await page.getByLabel('Date range').selectOption('7d');
  await tab(page, 'Sources').click();
  await expect(summary).toContainText('Indexed item counts unavailable.');
  await expect(summary.locator('.report-chart-total')).toHaveText('Unavailable');
});
