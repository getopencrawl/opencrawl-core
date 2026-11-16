import {test, expect, type Page} from '@playwright/test';
import type {Bootstrap} from '../src/application/api.ts';

async function membership(page: Page, role: () => string) {
  await page.route('**/api/console/bootstrap', async route => {
    const response = await route.fetch();
    const data = await response.json() as Bootstrap;
    await route.fulfill({json: {...data, workspace: {...data.workspace, role: role()}}});
  });
}

test.beforeEach(async ({request}) => {await request.post('/__test/reset', {data: {}});});

for (const width of [1280, 390]) {
  test(`members never see integrations or fetch connectors through direct and legacy links at ${width}px`, async ({page}) => {
    await page.setViewportSize({width, height: 800});
    await membership(page, () => 'member');
    let sourceReads = 0;
    page.on('request', request => {if (request.url().includes('/api/console/sources')) sourceReads++;});
    for (const path of ['/sources', '/integrations', '/data', '/onboarding/sources']) {
      await page.goto(`${path}?full-app`);
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole('heading', {level: 1, name: 'Usage'})).toBeVisible();
      await expect(page.getByRole('link', {name: 'Integrations', exact: true, includeHidden: true})).toHaveCount(0);
      await expect(page.getByRole('heading', {level: 1, name: 'Integrations'})).toHaveCount(0);
    }
    expect(sourceReads).toBe(0);
  });
}

test('unknown membership and pending bootstrap do not expose integrations', async ({page}) => {
  let release = () => {};
  const pending = new Promise<void>(resolve => {release = resolve;});
  await page.route('**/api/console/bootstrap', async route => {
    await pending;
    const response = await route.fetch();
    const data = await response.json() as Bootstrap;
    await route.fulfill({json: {...data, workspace: {...data.workspace, role: 'unknown'}}});
  });
  let sourceReads = 0;
  page.on('request', request => {if (request.url().includes('/api/console/sources')) sourceReads++;});
  await page.goto('/sources?full-app');
  await expect(page.getByRole('heading', {level: 1, name: 'Workspace'})).toBeVisible();
  await expect(page.getByRole('link', {name: 'Integrations', exact: true, includeHidden: true})).toHaveCount(0);
  release();
  await expect(page).toHaveURL(/\/$/);
  expect(sourceReads).toBe(0);
});

test('admin navigation works and losing admin access unmounts integrations', async ({page}) => {
  let role = 'admin';
  await membership(page, () => role);
  await page.goto('/setup?full-app');
  await page.getByRole('link', {name: 'Integrations', exact: true}).click();
  await expect(page.getByRole('heading', {level: 1, name: 'Integrations'})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Connect Slack', exact: true})).toBeVisible();
  await page.evaluate(() => {document.body.dataset.accessNavigation = 'preserved';});
  role = 'member';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('link', {name: 'Integrations', exact: true, includeHidden: true})).toHaveCount(0);
  await expect(page.getByRole('heading', {level: 1, name: 'Integrations'})).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/setup\?full-app$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/$/);
  expect(await page.evaluate(() => document.body.dataset.accessNavigation)).toBe('preserved');
});
