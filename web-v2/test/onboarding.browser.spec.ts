import {test, expect, type Page} from '@playwright/test';
import type {} from './fixtures/onboarding-app.tsx';

const receipt = {observedAt: '2026-11-07T12:00:00.000Z'};
const complete = {cli: receipt, mcpTest: receipt, session: receipt};
const connected = [{id: 'slack', name: 'Slack', icon: '/assets/connectors/slack.svg', state: 'syncing', auth: 'oauth'}];

test.beforeEach(async ({request}) => {await request.post('/__test/reset', {data: {}});});

async function refresh(page: Page) {await page.evaluate(() => window.dispatchEvent(new Event('online')));}

test('receipts, manual copy, and the three-step flow preserve one browser document', async ({page, request}) => {
  let documentLoads = 0;
  page.on('request', request => {if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentLoads++;});
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: async () => {throw new Error('Clipboard denied');}}}));
  await page.goto('/onboarding');
  await expect(page.getByRole('heading', {name: 'Connect your primary coding agent'})).toBeVisible();
  await expect(page.getByRole('link', {name: 'Next', exact: true})).toHaveCount(0);
  await page.getByRole('button', {name: 'Show setup prompt'}).click();
  await expect(page.locator('#connect-preview')).toBeVisible();
  await page.getByRole('button', {name: 'Copy setup prompt', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Copy this prompt'})).toBeVisible();
  await expect(page.getByLabel('Prompt to copy')).toBeFocused();
  expect(await page.getByLabel('Prompt to copy').evaluate((node: HTMLTextAreaElement) => node.selectionEnd - node.selectionStart)).toBeGreaterThan(100);
  await page.getByRole('button', {name: 'I’ve copied it'}).click();
  await expect(page.locator('.copy-prompt')).toBeFocused();

  await request.post('/__test/state', {data: {status: {cli: receipt, mcp: receipt, history: {...receipt, state: 'complete'}}}});
  await refresh(page);
  await expect(page.getByRole('heading', {name: 'Ask your agent to test the connection'})).toBeVisible();
  await expect(page.getByRole('link', {name: 'Next', exact: true})).toHaveCount(0);
  await request.post('/__test/state', {data: {status: complete}});
  await refresh(page);
  await expect(page.getByRole('heading', {name: 'Connect your primary coding agent'})).toBeVisible();
  await expect(page.getByRole('link', {name: 'Next', exact: true})).toBeVisible();
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByRole('link', {name: 'Next', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Connect your sources'})).toBeVisible();
  await expect(page.getByRole('link', {name: 'Next', exact: true})).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole('heading', {name: 'Connect your primary coding agent'})).toBeVisible();
  await page.getByRole('link', {name: 'Next', exact: true}).click();
  await page.getByRole('button', {name: 'Connect Granola', exact: true}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('API key')).toBeFocused();
  await page.getByLabel('API key').fill('test-only-key');
  await page.getByRole('dialog').getByRole('button', {name: 'Connect Granola', exact: true}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', {name: 'Connected to Granola'})).toBeVisible();
  await page.getByRole('link', {name: 'Next', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Invite your teammates'})).toBeVisible();
  await page.getByRole('textbox', {name: 'Email address'}).fill('teammate@example.com');
  await page.getByRole('textbox', {name: 'Email address'}).press('Enter');
  await expect(page.getByText('teammate@example.com', {exact: true})).toBeVisible();
  await expect(page.getByRole('textbox', {name: 'Email address'})).toHaveValue('');
  await expect(page.getByRole('textbox', {name: 'Email address'})).toBeFocused();
  await page.getByRole('button', {name: 'Open workspace'}).click();
  await expect(page.getByRole('heading', {name: 'Workspace overview'})).toBeVisible();
  expect(documentLoads).toBe(1);
  const state = await (await request.get('/__test/state')).json() as {requests: {finish: number; invite: number}};
  expect(state.requests.finish).toBe(1);
  expect(state.requests.invite).toBe(1);
});

test('finish errors stay in the flow and do not infer completion from a button click', async ({page, request}) => {
  await request.post('/__test/state', {data: {status: complete, sources: connected, finishError: true}});
  await page.goto('/onboarding/invite');
  await page.getByRole('button', {name: 'Skip for now'}).click();
  await expect(page.getByRole('alert')).toHaveText('Complete the required setup checks first.');
  await expect(page).toHaveURL(/\/onboarding\/invite$/);
  await expect(page.getByRole('button', {name: 'Skip for now'})).toBeEnabled();
});

test('leaving a route aborts the pending receipt request', async ({page, request}) => {
  await request.post('/__test/state', {data: {delayStatus: 20_000}});
  await page.goto('/onboarding');
  await expect.poll(async () => ((await (await request.get('/__test/state')).json()) as {requests: {status: number}}).requests.status).toBe(1);
  await page.evaluate(() => window.__onboardingTestNavigate?.('/away'));
  await expect(page.getByRole('heading', {name: 'Different route'})).toBeVisible();
  await expect.poll(async () => ((await (await request.get('/__test/state')).json()) as {requests: {aborted: number}}).requests.aborted).toBe(1);
});

test('OAuth is an explicit external navigation and returns to the same source step', async ({page, request}) => {
  await request.post('/__test/state', {data: {status: complete}});
  await page.route('https://provider.example/authorize', route => route.fulfill({contentType: 'text/html', body: '<h1>Provider authorization fixture</h1>'}));
  await page.goto('/onboarding/sources');
  await page.getByRole('button', {name: 'Connect Slack', exact: true}).click();
  await expect(page).toHaveURL('https://provider.example/authorize');
  await request.post('/__test/state', {data: {sources: connected}});
  await page.goto('/onboarding/sources');
  await expect(page.getByRole('button', {name: 'Connected to Slack'})).toBeVisible();
  await expect(page.getByRole('link', {name: 'Next', exact: true})).toBeVisible();
  await expect(page).toHaveURL(/\/onboarding\/sources$/);
});

for (const viewport of [{name: 'desktop', width: 1440, height: 1000}, {name: 'mobile', width: 390, height: 844}]) {
  test(`preserves approved onboarding geometry and long-text usability at ${viewport.name} width`, async ({page, request}, testInfo) => {
    await request.post('/__test/state', {data: {status: complete}});
    await page.setViewportSize({width: viewport.width, height: viewport.height});
    await page.goto('/legacy/onboarding');
    await expect(page.getByRole('link', {name: 'Next', exact: true})).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const legacy = await page.locator('.focus-panel').boundingBox();
    const typography = await page.getByRole('heading', {name: 'Connect your primary coding agent'}).evaluate(node => ({size: getComputedStyle(node).fontSize, weight: getComputedStyle(node).fontWeight, family: getComputedStyle(node).fontFamily, lineHeight: getComputedStyle(node).lineHeight}));
    await page.screenshot({path: testInfo.outputPath(`legacy-${viewport.name}.png`), fullPage: true});
    await page.goto('/onboarding');
    await expect(page.getByRole('link', {name: 'Next', exact: true})).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const react = await page.locator('.focus-panel').boundingBox();
    const reactTypography = await page.getByRole('heading', {name: 'Connect your primary coding agent'}).evaluate(node => ({size: getComputedStyle(node).fontSize, weight: getComputedStyle(node).fontWeight, family: getComputedStyle(node).fontFamily, lineHeight: getComputedStyle(node).lineHeight}));
    await page.screenshot({path: testInfo.outputPath(`react-${viewport.name}.png`), fullPage: true});
    expect(reactTypography).toEqual(typography);
    expect(legacy).not.toBeNull(); expect(react).not.toBeNull();
    for (const axis of ['x', 'y', 'width', 'height'] as const) expect(Math.abs((legacy?.[axis] ?? 0) - (react?.[axis] ?? 0)), `panel ${axis}`).toBeLessThanOrEqual(2);
    await page.getByRole('button', {name: 'Show setup prompt'}).click();
    await expect(page.locator('#connect-preview')).toBeVisible();
    await page.screenshot({path: testInfo.outputPath(`react-long-prompt-${viewport.name}.png`), fullPage: true});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await request.post('/__test/state', {data: {invitations: [{email: `${'long-address-'.repeat(10)}@example.com`}]}});
    await page.getByRole('link', {name: 'Next', exact: true}).click();
    await page.evaluate(() => window.__onboardingTestNavigate?.('/onboarding/invite'));
    await expect(page.locator('.invitation-email')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
