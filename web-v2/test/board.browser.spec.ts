import {test, expect} from '@playwright/test';
import type {BoardMessage} from '../src/pages/types.js';

const topic = 'café & notes/?';
const thread = '/diagnostics?view=board&topic=' + encodeURIComponent(topic);
const permalink = (id: number) => thread + '&message=' + id;
const messages: BoardMessage[] = Array.from({length: 60}, (_, index) => ({id: index + 1, topic, agent: 'example-agent', name: 'codex:example', timestamp: 1_800_000_000_000 + index, text: `Message ${index + 1}\n\nFull message text.`}));

test.beforeEach(async ({page}) => {
  await page.route('**/api/console/board?*', route => {
    const query = new URL(route.request().url()).searchParams;
    const before = Number(query.get('before')) || Infinity;
    const matching = messages.filter(message => message.id < before && (!query.get('topic') || message.topic === query.get('topic'))).toReversed();
    return route.fulfill({json: {messages: matching.slice(0, 20), next: matching.length > 20 ? matching[19]!.id : null, topicSummaries: [{topic, posts: 60, latest: {name: 'codex:example', timestamp: messages[59]!.timestamp}}]}});
  });
});

for (const width of [1440, 390]) {
  test(`message IDs provide keyboard-accessible SPA permalinks at ${width}px`, async ({page}, info) => {
    await page.setViewportSize({width, height: 900});
    await page.goto('/diagnostics?view=stream');
    const link = page.getByRole('link', {name: 'Permalink to message #55', exact: true});
    await expect(link).toHaveAttribute('href', permalink(55));
    let documents = 0;
    page.on('request', request => {if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++;});
    await link.focus(); await page.keyboard.press('Enter');
    await expect(page).toHaveURL(permalink(55));
    const post = page.locator('[data-board-anchor="post:55"]');
    await expect(post).toBeFocused();
    await expect(post).toContainText('Message 55');
    await expect(page.locator('.oc-forum-post').first()).toBeFocused();
    await page.screenshot({path: info.outputPath(`message-permalink-${width}.png`)});
    await page.goBack(); await expect(page).toHaveURL('/diagnostics?view=stream');
    await page.goForward(); await expect(post).toBeFocused();
    expect(documents).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('opening and reloading an older permalink reads its exact page without walking newer history', async ({page}) => {
  const reads: URLSearchParams[] = [];
  page.on('request', request => {if (request.url().includes('/api/console/board?')) reads.push(new URL(request.url()).searchParams);});
  await page.goto(permalink(10));
  const post = page.locator('[data-board-anchor="post:10"]');
  await expect(post).toBeFocused();
  expect(reads).toHaveLength(1);
  expect(reads[0]!.get('topic')).toBe(topic);
  expect(reads[0]!.get('before')).toBe('11');
  await page.reload(); await expect(post).toBeFocused();
  await expect(page.getByRole('link', {name: 'Permalink to message #10', exact: true})).toHaveAttribute('href', permalink(10));
});

test('a missing or wrong-topic message is explicit and invalid IDs do not become cursors', async ({page}) => {
  await page.goto('/diagnostics?view=board&topic=another-topic&message=10');
  await expect(page.getByText('Message #10 is unavailable in this topic.', {exact: true})).toBeVisible();
  await expect(page.locator('.oc-forum-post')).toHaveCount(0);
  const reads: URLSearchParams[] = [];
  page.on('request', request => {if (request.url().includes('/api/console/board?')) reads.push(new URL(request.url()).searchParams);});
  for (const id of ['-1', '1.5', '1e3', '9007199254740992', 'NaN']) {
    await page.goto(thread + '&message=' + id);
    await expect(page.locator('.oc-forum-post')).toHaveCount(20);
  }
  expect(reads).toHaveLength(5);
  expect(reads.every(query => !query.has('before'))).toBe(true);
});

test('revoking access to a permalink clears its loaded message', async ({page}) => {
  await page.goto(permalink(10));
  await expect(page.locator('[data-board-anchor="post:10"]')).toBeFocused();
  await page.route('**/api/console/board?*', route => route.fulfill({status: 403, json: {error: 'Workspace access revoked'}}));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.oc-forum-post')).toHaveCount(0);
  await expect(page.getByText('Workspace access revoked', {exact: true})).toBeVisible();
});
