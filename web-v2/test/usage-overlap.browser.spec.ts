import {test, expect} from '@playwright/test';
import type {UsageReport} from '../src/pages/types.ts';

const report = (): UsageReport => ({workspace: 'Example workspace', days: 30, generatedAt: '2026-11-13T12:00:00Z', ingestion: {sources: [], index: null}, members: [],
  agents: {events: 50, lifetimeEvents: 100, sessions: 20, messages: 30, toolCalls: 20, machines: 2, opencrawlCalls: 5, tools: [], harnesses: [], origins: [], firstAt: '2026-10-01T00:00:00Z', lastAt: '2026-11-13T11:00:00Z', daily: []},
  overlap: {timeZone: 'UTC', measuredAt: '2026-11-13T12:00:00Z', sessions: 20, daily: Array.from({length: 30}, (_, i) => ({date: new Date(Date.UTC(2026, 9, 15 + i)).toISOString().slice(0, 10), average: 1 + i % 6 / 2, peak: 4 + i % 9, partial: i === 29}))},
});

test('overlap chart shows average/peak with hover details and fits desktop/mobile', async ({page}, info) => {
  await page.route('**/api/console/usage', route => route.fulfill({json: report()}));
  await page.goto('/usage');
  const panel = page.getByRole('region', {name: 'Main session overlap', exact: true});
  await expect(panel.locator('.report-line-legend').getByText('Daily average', {exact: true})).toBeVisible();
  await expect(panel.locator('.report-line-legend').getByText('Daily peak', {exact: true})).toBeVisible();
  await expect(panel.locator('details')).toHaveCount(0);
  await expect(panel.getByRole('table')).toHaveCount(0);
  await panel.locator('.report-line-hit').first().hover();
  await expect(panel.locator('figcaption')).toHaveCount(0);
  await expect(panel.locator('.report-line-hit').first().locator('title')).toHaveText('2026-10-15: average 1, peak 4 sessions');
  for (const width of [1440, 390]) {
    await page.setViewportSize({width, height: 1000});
    await panel.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    await expect(panel.getByRole('img')).toBeVisible();
    await panel.screenshot({path: info.outputPath(`overlap-${width}.png`)});
  }
});

test('failed refresh retains the overlap chart, recovery replaces it, and access denial clears it', async ({page}) => {
  await page.clock.install();
  let status = 200, reads = 0;
  const data = report();
  await page.route('**/api/console/usage', route => {
    reads++;
    return status === 200 ? route.fulfill({json: data}) : route.fulfill({status, json: {error: 'Usage request failed'}});
  });
  await page.goto('/usage');
  const chart = page.locator('.report-line-chart');
  await expect(chart).toBeVisible();
  const initialReads = reads;
  status = 503;
  await page.clock.runFor(60_001);
  await expect.poll(() => reads).toBeGreaterThan(initialReads);
  await expect(page.getByText('Usage couldn’t update.', {exact: false})).toBeVisible();
  await expect(chart).toBeVisible();
  await expect(page.getByText('Session overlap is unavailable.', {exact: false})).toHaveCount(0);
  status = 200;
  data.overlap!.daily[0]!.peak = 99;
  await page.clock.runFor(60_001);
  await expect(chart.locator('.report-line-hit').first().locator('title')).toContainText('peak 99 sessions');
  status = 403;
  await page.clock.runFor(60_001);
  await expect(chart).toHaveCount(0);
});
