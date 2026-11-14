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
    await expect(post).toHaveClass(/selected/);
    await page.screenshot({path: info.outputPath(`message-permalink-${width}.png`)});
    await page.goBack(); await expect(page).toHaveURL('/diagnostics?view=stream');
    await page.goForward(); await expect(post).toBeFocused();
    expect(documents).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('opening and reloading an older permalink reads its exact page without walking newer history', async ({page}) => {
  const reads: URLSearchParams[] = [];
  page.on('request', request => {if (request.url().includes('/api/console/board?') && new URL(request.url()).searchParams.has('topic')) reads.push(new URL(request.url()).searchParams);});
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
  await expect(page.locator('.oc-board-post')).toHaveCount(0);
  const reads: URLSearchParams[] = [];
  page.on('request', request => {if (request.url().includes('/api/console/board?') && new URL(request.url()).searchParams.has('topic')) reads.push(new URL(request.url()).searchParams);});
  for (const id of ['-1', '1.5', '1e3', '9007199254740992', 'NaN']) {
    await page.goto(thread + '&message=' + id);
    await expect(page.locator('.oc-board-post')).toHaveCount(20);
  }
  expect(reads).toHaveLength(5);
  expect(reads.every(query => !query.has('before'))).toBe(true);
});

test('revoking access to a permalink clears its loaded message', async ({page}) => {
  await page.goto(permalink(10));
  await expect(page.locator('[data-board-anchor="post:10"]')).toBeFocused();
  await page.route('**/api/console/board?*', route => route.fulfill({status: 403, json: {error: 'Workspace access revoked'}}));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.oc-board-post')).toHaveCount(0);
  await expect(page.getByText('Workspace access revoked', {exact: true})).toBeVisible();
});

for (const width of [1440, 390]) {
  test(`board navigation, combined stream and separate search at ${width}px`, async ({page}, info) => {
    await page.setViewportSize({width, height: 900});
    await page.route('**/api/console/board?*', route => {
      const query = new URL(route.request().url()).searchParams;
      const mixed = messages.slice(-8).map((post, index) => ({...post, topic: index % 2 ? 'engineering' : 'release', agent: index % 2 ? 'one' : 'two', name: index % 2 ? 'codex:one' : 'codex:two'}));
      return route.fulfill({json: {messages: mixed.filter(post => !query.get('topic') || post.topic === query.get('topic')).toReversed(), next: null, topicSummaries: ['engineering', 'release'].map(topic => ({topic, posts: 4, latest: {name: 'codex:one', timestamp: mixed.at(-1)!.timestamp}}))}});
    });
    await page.goto('/diagnostics');
    await expect(page.getByRole('heading', {name: 'All topics', exact: true})).toBeVisible();
    await expect(page.locator('.oc-board-post')).toHaveCount(8);
    await expect(page.getByText(/Showing \d+ messages/)).toHaveCount(0);
    await expect(page.locator('.oc-board-message-topic')).toHaveCount(8);
    const hues = await page.locator('.oc-board-author-line h3').evaluateAll(nodes => nodes.map(node => ({name: node.textContent, color: getComputedStyle(node).color})));
    expect(new Set(hues.map(item => item.color)).size).toBe(2);
    await page.screenshot({path: info.outputPath(`all-topics-${width}.png`)});
    const openNavigation = async () => {if (width < 800) await page.getByRole('button', {name: 'Open workspace navigation', exact: true}).click();};
    await openNavigation();
    await page.getByRole('navigation', {name: 'Message board topics'}).getByRole('link', {name: 'engineering', exact: true}).click();
    await expect(page.getByRole('heading', {name: '# engineering'})).toBeVisible();
    await expect(page.locator('.oc-board-post')).toHaveCount(4);
    await expect(page.locator('.oc-board-message-topic')).toHaveCount(0);
    await page.screenshot({path: info.outputPath(`channel-${width}.png`)});
    expect(await page.locator('.oc-board-author-line h3').first().evaluate(node => getComputedStyle(node).color)).toBe(hues.find(item => item.name === 'codex:one')!.color);
    await openNavigation();
    const back = page.getByRole('link', {name: 'Back', exact: true});
    await expect(back).toHaveText('Back'); await expect(back.locator('svg')).toHaveCount(1);
    await back.click();
    await openNavigation();
    await page.getByRole('link', {name: 'Search playground', exact: true}).click();
    await expect(page).toHaveURL('/search');
    await expect(page.getByRole('heading', {name: 'Search playground'})).toBeVisible();
    await expect(page.getByLabel('Search query')).toBeVisible();
    await page.goto('/diagnostics?view=search');
    await expect(page).toHaveURL('/search');
  });
}

test('loading older and refreshing preserve a scrolled message position', async ({page}) => {
  await page.goto(thread);
  await expect(page.locator('.oc-board-post')).toHaveCount(20);
  await page.getByRole('button', {name: 'Load older messages'}).click();
  await expect(page.locator('.oc-board-post')).toHaveCount(39);
  const post = page.locator('[data-board-anchor="post:30"]');
  await post.scrollIntoViewIfNeeded();
  const top = (await post.boundingBox())!.y;
  await page.route('**/api/console/board?*', route => {
    const query = new URL(route.request().url()).searchParams;
    const before = Number(query.get('before')) || Infinity;
    const added = {...messages[59]!, id: 61, text: 'New live message', timestamp: messages[59]!.timestamp + 1000};
    const matching = [...messages, added].filter(item => item.id < before).toReversed();
    return route.fulfill({json: {messages: matching.slice(0, 20), next: matching.length > 20 ? matching[19]!.id : null, topicSummaries: [{topic, posts: 61, latest: {name: added.name, timestamp: added.timestamp}}]}});
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.oc-board-post')).toHaveCount(40);
  await expect(page.locator('.oc-board-stream')).toHaveAttribute('aria-busy', 'false');
  expect(Math.abs((await post.boundingBox())!.y - top)).toBeLessThan(2);
  await expect(post).toContainText('Message 30');
});

test('a focused permalink leaves room for long text at the desktop breakpoint', async ({page}, info) => {
  await page.setViewportSize({width: 801, height: 900});
  await page.route('**/api/console/board?*', route => route.fulfill({json: {messages: [{...messages[0]!, text: 'A long first line must stay readable beside its message permalink. '.repeat(12)}], next: null, topicSummaries: [{topic, posts: 1, latest: {name: messages[0]!.name, timestamp: messages[0]!.timestamp}}]}}));
  await page.goto(thread);
  const id = page.getByRole('link', {name: 'Permalink to message #1', exact: true});
  await id.focus();
  const overlaps = await page.locator('.oc-board-post').evaluate(post => {
    const link = post.querySelector('.oc-board-post-id')!.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(post.querySelector('p')!);
    return Array.from(range.getClientRects()).some(line => line.left < link.right && line.right > link.left && line.top < link.bottom && line.bottom > link.top);
  });
  expect(overlaps).toBe(false);
  await page.screenshot({path: info.outputPath('permalink-801.png')});
});
