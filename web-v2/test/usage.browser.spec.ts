import {test, expect, type Page} from '@playwright/test';
import type {UsageReport} from '../src/pages/types.ts';

const day = (offset: number) => new Date(Date.UTC(2026, 10, 19 - offset)).toISOString().slice(0, 10);
const daily = Array.from({length: 30}, (_, i) => ({date: day(29 - i), sessions: i % 4, events: 10 * (i % 4), tokens: 1000 * i}));
const history = [{date: '2026-09-01', tokens: 5000}, ...daily.map(({date, tokens}) => ({date, tokens}))];

const report = (): UsageReport => ({workspace: 'Example workspace', days: 30, generatedAt: '2026-11-19T12:00:00Z', overlap: null,
  ingestion: {sources: [{name: 'Slack', icon: '/assets/integrations/slack.svg', state: 'synced', records: 9, indexed: 9, lastSyncedAt: null}],
    index: {sessionEvents: 100, connectorDocuments: 9, sources: [{name: 'Slack', count: 9}], searchMs: null}},
  members: [{userId: 'user_alex', name: 'Alex Example', email: 'alex@example.test', you: true, sources: 1, sessions: 3, messages: 4, toolCalls: 5, weekEvents: 1, lastAt: null, setup: {}}],
  agents: {events: 50, lifetimeEvents: 100, sessions: 20, messages: 30, toolCalls: 20, machines: 2, opencrawlCalls: 5, tools: [], harnesses: [], origins: [],
    firstAt: '2026-09-01T00:00:00Z', lastAt: '2026-11-19T11:00:00Z', daily, indexedTokens: 440_000, tokenHistory: history},
});
const row = (i: number) => ({id: `row-${i}`, at: new Date(Date.UTC(2026, 10, 19, 12) - i * 3_600_000).toISOString(), userId: i % 2 ? 'user_unknown' : 'user_alex',
  operation: 'search', queries: [`query ${i}`], harness: 'codex', sessionId: `s${i}`, messageId: null, message: null, returned: 1, outcome: 'complete', delivered: false});
const totals = {cacheScope: 'usage-fixture', since: day(29) + 'T00:00:00Z', calls: 90, agentSearches: 60, proactiveChecks: 20, nonSilent: 7, delivered: 6,
  daily: [{date: day(0), agentSearches: 12}, {date: day(1), agentSearches: 48}]};

async function serve(page: Page, rows = 60) {
  const reads: Array<string | undefined> = [];
  await page.route('**/api/console/usage', route => route.fulfill({json: report()}));
  await page.route('**/api/console/usage/calls', route => route.fulfill({json: totals}));
  await page.route('**/api/console/usage/search-history', route => {
    const {kind, before} = route.request().postDataJSON() as {kind: string; before?: string};
    expect(kind).toBe('agent');
    reads.push(before);
    const start = before ? Number(before.slice(-2)) : 0;
    const page = Array.from({length: Math.max(0, Math.min(25, rows - start))}, (_, i) => row(start + i));
    return route.fulfill({json: {cacheScope: 'usage-fixture', rows: page, next: start + 25 < rows ? 'cursor'.padEnd(30, 'x') + String(start + 25).padStart(2, '0') : null}});
  });
  return reads;
}

for (const width of [1440, 390]) test(`overview charts share one date range and fit at ${width}px`, async ({page}, info) => {
  await page.setViewportSize({width, height: 900});
  await serve(page);
  await page.goto('/usage?activity');
  const tokens = page.getByRole('region', {name: 'Indexed session tokens', exact: true});
  const queries = page.getByRole('region', {name: 'Agent queries', exact: true});
  await expect(page.locator('.report-metric').filter({hasText: 'OpenCrawl context edits'})).toContainText('7');
  await expect(page.locator('.report-metric').filter({hasText: 'Session tokens indexed'})).toContainText('435k');
  await expect(tokens.locator('rect')).toHaveCount(30);
  await expect(queries.locator('figure rect')).toHaveCount(30);
  await expect(queries.locator('figure rect').last().locator('title')).toHaveText(`${day(0)}: 12 queries`);
  await page.getByLabel('Date range').selectOption('all');
  await expect(page.locator('.report-metric').filter({hasText: 'Session tokens indexed'})).toContainText('440k');
  const span = await tokens.locator('rect').count();
  expect(span).toBeGreaterThan(70);
  await expect(queries.locator('figure rect')).toHaveCount(span);
  await expect(queries.locator('figure rect').first().locator('title')).toHaveText('2026-09-01: not tracked');
  await expect(tokens.locator('figcaption')).toContainText('2026-09-01');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
  await page.screenshot({path: info.outputPath(`usage-${width}.png`)});
});

test('agent queries show the five newest with who asked, and View all scrolls through every page', async ({page}) => {
  const reads = await serve(page);
  await page.goto('/usage?activity');
  const queries = page.getByRole('region', {name: 'Agent queries', exact: true});
  const table = queries.getByRole('table');
  await expect(table.locator('tbody tr')).toHaveCount(5);
  await expect(table.locator('thead th')).toHaveText(['Query', 'From', 'Time']);
  await expect(table.locator('tbody tr').first()).toContainText('query 0');
  await expect(table.locator('tbody tr').first()).toContainText('Alex Example');
  await expect(table.locator('tbody tr').first()).toContainText('Codex');
  await expect(table.locator('tbody tr').nth(1)).toContainText('Workspace member');
  await queries.getByRole('button', {name: 'View all'}).click();
  const dialog = page.getByRole('dialog', {name: 'Agent queries'});
  await expect(dialog.locator('tbody tr')).toHaveCount(25);
  for (let i = 0; i < 6 && await dialog.locator('tbody tr').count() < 60; i++) await dialog.locator('tbody tr').last().scrollIntoViewIfNeeded();
  await expect(dialog.locator('tbody tr')).toHaveCount(60);
  await expect(dialog.locator('tbody tr').last()).toContainText('query 59');
  expect(reads.filter(Boolean)).toHaveLength(2);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('View all is hidden when the five rows are everything', async ({page}) => {
  await serve(page, 4);
  await page.goto('/usage?activity');
  const queries = page.getByRole('region', {name: 'Agent queries', exact: true});
  await expect(queries.locator('tbody tr')).toHaveCount(4);
  await expect(queries.getByRole('button', {name: 'View all'})).toHaveCount(0);
});

test('without call tracking the page shows no query panel or context edits', async ({page}) => {
  await serve(page);
  await page.goto('/usage');
  await expect(page.getByRole('region', {name: 'Indexed session tokens', exact: true})).toBeVisible();
  await expect(page.getByRole('region', {name: 'Agent queries', exact: true})).toHaveCount(0);
  await expect(page.getByText('OpenCrawl context edits')).toHaveCount(0);
});

test('a failed refresh keeps the last report, recovery replaces it, and access denial clears it', async ({page}) => {
  await page.clock.install();
  let status = 200;
  const data = report();
  await page.route('**/api/console/usage', route => status === 200 ? route.fulfill({json: data}) : route.fulfill({status, json: {error: 'Usage request failed'}}));
  await page.goto('/usage');
  const chart = page.getByRole('region', {name: 'Indexed session tokens', exact: true});
  await expect(chart).toBeVisible();
  status = 503;
  await page.clock.runFor(60_001);
  await expect(page.getByText('Usage couldn’t update.', {exact: false})).toBeVisible();
  await expect(chart).toBeVisible();
  status = 200;
  data.agents!.daily.at(-1)!.tokens = 99;
  await page.clock.runFor(60_001);
  await expect(chart.locator('rect').last().locator('title')).toHaveText(`${day(0)}: 99 tokens`);
  status = 403;
  await page.clock.runFor(60_001);
  await expect(chart).toHaveCount(0);
});

test('a changed workspace clears the split report', async ({page}) => {
  await page.clock.install();
  const {workspace, value, capture, ...details} = report();
  let scope = 'usage-fixture';
  await page.route('**/api/console/usage/highlights', route => route.fulfill({json: {workspace, value, capture, days: 30, generatedAt: details.generatedAt, cacheScope: 'usage-fixture'}}));
  await page.route('**/api/console/usage/details', route => route.fulfill({json: {...details, cacheScope: scope}}));
  await page.goto('/usage?split');
  await expect(page.getByRole('heading', {name: 'Indexed session tokens'})).toBeVisible();
  scope = 'different-workspace';
  await page.clock.runFor(60_001);
  await expect(page.getByText('Your workspace changed. Reload this page.')).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Indexed session tokens'})).toHaveCount(0);
});

test('failed source counts are unavailable, not zero, and recover', async ({page}) => {
  await page.clock.install();
  let data: UsageReport = {...report(), failedSources: ['connectors']};
  await page.route('**/api/console/usage', route => route.fulfill({json: data}));
  await page.goto('/usage');
  const sources = page.getByRole('region', {name: 'Indexed items by source', exact: true});
  await expect(sources).toContainText('Indexed item counts unavailable.');
  await expect(sources.getByRole('list')).toHaveCount(0);
  data = report();
  await page.clock.runFor(60_001);
  await expect(sources.getByRole('list')).toHaveText('Slack9');
});
