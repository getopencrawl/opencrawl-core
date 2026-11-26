import {test, expect} from '@playwright/test';
import type {BoardMessage} from '../src/pages/types.js';

const topic = 'café & notes/?';
const thread = '/messages?view=board&channel=' + encodeURIComponent(topic);
const permalink = (id: number) => thread + '&message=' + id;
const messages: BoardMessage[] = Array.from({length: 60}, (_, index) => ({id: index + 1, topic, agent: 'example-agent', name: 'codex:example', timestamp: 1_800_000_000_000 + index, text: `Message ${index + 1}\n\nFull message text.`}));

test.beforeEach(async ({page}) => {
  await page.route('**/api/console/board?*', route => {
    const query = new URL(route.request().url()).searchParams;
    const before = Number(query.get('before')) || Infinity;
    const matching = messages.filter(message => message.id < before && (!query.get('channel') || message.topic === query.get('channel'))).toReversed();
    return route.fulfill({json: {messages: matching.slice(0, 20), next: matching.length > 20 ? matching[19]!.id : null, topicSummaries: [{topic, posts: 60, latest: {name: 'codex:example', timestamp: messages[59]!.timestamp}}]}});
  });
});

test('the same displayed author keeps its pixel tile across registrations and older posts', async ({page}) => {
  const authors = [
    {agent: 'first-registration', name: 'codex:one'},
    {agent: 'codex:one', name: ''},
    {agent: 'another', name: 'café'},
    {agent: 'latest', name: ' cafe\u0301 '},
  ];
  await page.route('**/api/console/board?*', route => route.fulfill({json: {
    messages: authors.map((author, i) => ({...messages[i], ...author})).reverse(), next: null, topicSummaries: [],
  }}));
  await page.goto(thread);
  const faces = page.locator('.oc-agent-avatar');
  await expect(faces).toHaveCount(4);
  const tiles = await faces.evaluateAll(nodes => nodes.map(node => node.innerHTML));
  expect(tiles[1]).toBe(tiles[0]);
  expect(tiles[3]).toBe(tiles[2]);
  expect(tiles[2]).not.toBe(tiles[0]);

  const rows = await faces.first().evaluate(svg => {
    const layers = Array.from(svg.querySelectorAll<SVGGeometryElement>('rect, path')).reverse();
    const symbols: Record<string, string> = {'#241c35': '.', 'currentColor': 'x', '#fc8c9a': '+'};
    return Array.from({length: 12}, (_, y) => Array.from({length: 12}, (_, x) => {
      const pixel = layers.find(layer => layer.isPointInFill(new DOMPoint(x + 0.5, y + 0.5)));
      return symbols[pixel?.getAttribute('fill') ?? ''] ?? '?';
    }).join(''));
  });
  expect(rows).toEqual([
    '............', '............', '..xx....xx..', '...xxxxxx...',
    '...xxxxxx...', '...x+xx+x...', '..xxxxxxxx..', '...xxxxxx...',
    '..x..xx..x..', '...x....x...', '............', '............',
  ]);
});

test('wide workspace margins scroll the board conversation', async ({page}) => {
  await page.setViewportSize({width: 2560, height: 900});
  await page.goto(thread);
  const stream = page.getByLabel('Messages', {exact: true});
  await expect(stream.locator('.oc-board-post')).toHaveCount(20);
  await page.evaluate(() => document.fonts.ready);
  const scrollTop = () => stream.evaluate(element => element.scrollTop);
  await stream.evaluate(element => { element.scrollTop = 0; });
  const box = await stream.boundingBox();
  if (!box) throw new Error('Expected a visible workspace');
  await page.mouse.move(box.x + 8, box.y + box.height / 2);
  await page.mouse.wheel(0, 240);
  await expect.poll(scrollTop).toBeGreaterThan(50);
  await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2);
  await page.mouse.wheel(0, -240);
  await expect.poll(scrollTop).toBe(0);
});

test('each outside margin scrolls its adjacent reader when a board thread is open', async ({page}) => {
  await page.setViewportSize({width: 2560, height: 800});
  await page.route('**/api/console/board?*', async route => {
    if (!new URL(route.request().url()).searchParams.has('threadId')) return route.fallback();
    const replies = messages.slice(1, 21).reverse().map(message => ({...message, threadId: 1}));
    return route.fulfill({json: {threadRoot: messages[0], messages: replies, next: null, topicSummaries: []}});
  });
  await page.goto(thread + '&thread=1');
  const channel = page.getByLabel('Messages', {exact: true});
  const replies = page.getByLabel('Replies', {exact: true});
  await expect(channel.locator('.oc-board-post')).toHaveCount(20);
  await expect(replies.locator('.oc-board-post')).toHaveCount(21);
  await page.evaluate(() => document.fonts.ready);
  await channel.evaluate(element => { element.scrollTop = 0; });
  const box = await channel.boundingBox();
  if (!box) throw new Error('Expected a visible channel');
  await page.mouse.move(box.x + 8, box.y + box.height / 2);
  await page.mouse.wheel(0, 240);
  await expect.poll(() => channel.evaluate(element => element.scrollTop)).toBeGreaterThan(50);
  expect(await replies.evaluate(element => element.scrollTop)).toBe(0);
  const channelTop = await channel.evaluate(element => element.scrollTop);
  const right=await replies.boundingBox(); expect(right).toBeTruthy();
  await page.mouse.move(right!.x + right!.width - 8, right!.y + right!.height / 2);
  await page.mouse.wheel(0, 240);
  await expect.poll(() => replies.evaluate(element => element.scrollTop)).toBeGreaterThan(50);
  expect(await channel.evaluate(element => element.scrollTop)).toBe(channelTop);
});

for (const width of [1440, 390]) {
  test(`message IDs provide keyboard-accessible SPA permalinks at ${width}px`, async ({page}, info) => {
    await page.setViewportSize({width, height: 900});
    await page.goto('/messages?view=stream');
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
    await page.goBack(); await expect(page).toHaveURL('/messages?view=stream');
    await page.goForward(); await expect(post).toBeFocused();
    expect(documents).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('opening and reloading an older permalink reads its exact page without walking newer history', async ({page}) => {
  const reads: URLSearchParams[] = [];
  page.on('request', request => {if (request.url().includes('/api/console/board?') && new URL(request.url()).searchParams.has('channel')) reads.push(new URL(request.url()).searchParams);});
  await page.goto(permalink(10));
  const post = page.locator('[data-board-anchor="post:10"]');
  await expect(post).toBeFocused();
  expect(reads).toHaveLength(1);
  expect(reads[0]!.get('channel')).toBe(topic);
  expect(reads[0]!.get('before')).toBe('11');
  await page.reload(); await expect(post).toBeFocused();
  await expect(page.getByRole('link', {name: 'Permalink to message #10', exact: true})).toHaveAttribute('href', permalink(10));
});

test('a missing or wrong-topic message is explicit and invalid IDs do not become cursors', async ({page}) => {
  await page.goto('/messages?view=board&channel=another-topic&message=10');
  await expect(page.getByText('Message #10 is unavailable in this channel.', {exact: true})).toBeVisible();
  await expect(page.locator('.oc-board-post')).toHaveCount(0);
  const reads: URLSearchParams[] = [];
  page.on('request', request => {if (request.url().includes('/api/console/board?') && new URL(request.url()).searchParams.has('channel')) reads.push(new URL(request.url()).searchParams);});
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
      const mixed = messages.slice(-8).map((post, index) => ({...post, topic: index % 2 ? 'engineering' : 'release', agent: index % 2 ? 'one' : 'two', name: index % 2 ? 'codex:one' : 'codex:four'}));
      return route.fulfill({json: {messages: mixed.filter(post => !query.get('channel') || post.topic === query.get('channel')).toReversed(), next: null, topicSummaries: ['engineering', 'release'].map(topic => ({topic, posts: 4, latest: {name: 'codex:one', timestamp: mixed.at(-1)!.timestamp}}))}});
    });
    await page.goto('/messages');
    await expect(page.getByRole('heading', {name: 'Message board', level:1})).toBeVisible();
    await expect(page.locator('.oc-board-post')).toHaveCount(8);
    await expect(page.getByText(/Showing \d+ messages/)).toHaveCount(0);
    await expect(page.locator('.oc-board-message-topic')).toHaveCount(8);
    const header = page.locator('.oc-board-post-header').first();
    const channelBox = (await header.locator('.oc-board-message-topic').boundingBox())!;
    const authorBox = (await header.getByRole('heading').boundingBox())!;
    expect(channelBox.x).toBeGreaterThan(authorBox.x + authorBox.width);
    const hues = await page.locator('.oc-board-post-header h3').evaluateAll(nodes => nodes.map(node => ({name: node.textContent, color: getComputedStyle(node).color})));
    expect(new Set(hues.map(item => item.color)).size).toBe(2);
    const ink=await page.locator('.oc-board-message-group > .oc-agent-avatar path:first-of-type').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).fill));
    expect(ink).toEqual(hues.map(item=>item.color));
    await page.screenshot({path: info.outputPath(`all-topics-${width}.png`)});
    if (width < 800) await page.getByRole('button', {name:'Browse channels'}).click();
    await page.getByRole('navigation', {name:'Message board channels',exact:true}).getByRole('link', {name: 'engineering', exact: true}).click();
    await expect(page).toHaveURL(/channel=engineering$/);
    await expect(page.locator('.oc-board-post')).toHaveCount(4);
    await expect(page.locator('.oc-board-message-topic')).toHaveCount(0);
    await page.screenshot({path: info.outputPath(`channel-${width}.png`)});
    expect(await page.locator('.oc-board-post-header h3').first().evaluate(node => getComputedStyle(node).color)).toBe(hues.find(item => item.name === 'codex:one')!.color);
    if (width < 800) await page.getByRole('button', {name:'Open workspace navigation',exact:true}).click();
    await page.getByRole('link', {name: 'Search playground', exact: true}).click();
    await expect(page).toHaveURL('/search');
    await expect(page.getByRole('heading', {name: 'Search playground'})).toBeVisible();
    await expect(page.getByLabel('Search query')).toBeVisible();
    await page.goto('/messages?view=search');
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

test('background refresh retains pagination focus without accepting overlapping reads', async ({page}) => {
  await page.goto(thread);
  await expect(page.locator('.oc-board-post')).toHaveCount(20);
  let release = () => {}, reads = 0;
  const pending = new Promise<void>(resolve => {release = resolve;});
  await page.route('**/api/console/board?*', async route => {reads++; await pending; await route.fallback();});
  const older = page.getByRole('button', {name: 'Load older messages'});
  await older.focus();
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(older).toHaveAttribute('aria-disabled', 'true');
    await expect(older).toBeFocused();
    const active = reads;
    await page.keyboard.press('Enter');
    expect(reads).toBe(active);
    release();
    await expect(older).toHaveAttribute('aria-disabled', 'false');
    await expect(older).toBeFocused();
  } finally {release();}
});

for(const width of [1440,390])test(`thread pane preserves combined channel history and scroll at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:900});
 await page.route('**/api/console/board?*',async route=>{
  const q=new URL(route.request().url()).searchParams;
  if(!q.has('threadId'))return route.fallback();
  const root={...messages[29]!,threadId:30,replyCount:1};
  return route.fulfill({json:{threadRoot:root,messages:[{...root,id:61,text:'Reply in the side pane'}],next:null,topicSummaries:[]}});
 });
 await page.goto('/messages?view=board');
 await page.getByRole('button',{name:'Load older messages'}).click();
 const channel=page.locator('.oc-board-channel'),scroll=channel.getByLabel('Messages',{exact:true});
 await expect(channel.locator('.oc-board-post')).toHaveCount(39);
 const root=channel.locator('[data-board-anchor="post:30"]');await root.scrollIntoViewIfNeeded();
 const trigger=channel.getByRole('link',{name:'Show thread for message #30',exact:true});await trigger.focus();
 const before=await scroll.evaluate(node=>node.scrollTop),element=await root.elementHandle();
 await page.keyboard.press('Enter');await expect(page).toHaveURL('/messages?view=board&thread=30');
 await expect(page.getByRole('complementary',{name:'Thread',exact:true})).toBeVisible();
 expect(await element!.evaluate(node=>node.isConnected)).toBe(true);
 await expect(channel.locator('.oc-board-post')).toHaveCount(39);
 if(width>1100){const left=(await channel.boundingBox())!,right=(await page.locator('#board-thread').boundingBox())!;expect(right.x).toBeGreaterThanOrEqual(left.x+left.width-1);}
 await page.getByRole('button',{name:'Close thread',exact:true}).click();
 await expect(trigger).toBeFocused();expect(await scroll.evaluate(node=>node.scrollTop)).toBeCloseTo(before,0);
 await page.goBack();await expect(page.locator('#board-thread')).toBeVisible();
 await page.goForward();await expect(page.locator('#board-thread')).toHaveCount(0);
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

for(const width of [1440,390])test(`system announcement thread navigation and reply permalink at ${width}px`,async({page},info)=>{
 await page.setViewportSize({width,height:900});
 const root:BoardMessage={id:101,topic:'opencrawl',channel:'opencrawl',threadId:101,replyCount:1,system:true,agent:'system:opencrawl',name:'opencrawl',timestamp:1_800_000_000_000,text:'An operator announcement'};
 const reply:BoardMessage={id:102,topic:'opencrawl',channel:'opencrawl',threadId:101,agent:'client',name:'codex:client',timestamp:1_800_000_001_000,text:'Agent thread reply'};
 await page.route('**/api/console/board?*',route=>{
  const q=new URL(route.request().url()).searchParams;
  return route.fulfill({json:{messages:q.has('threadId')?[reply]:[root],...(q.has('threadId')?{threadRoot:root}:{}),next:null,topicSummaries:[],channelSummaries:[{channel:'opencrawl',readOnly:true,posts:2,latest:{name:'codex:client',timestamp:reply.timestamp}}]}});
 });
 await page.goto('/messages?view=board&channel=opencrawl');
 await expect(page.getByText('System announcements. Agents can reply in threads.')).toBeVisible();
 await expect(page.getByText('Agent thread reply',{exact:true})).toHaveCount(0);
 let documents=0;page.on('request',r=>{if(r.isNavigationRequest()&&r.frame()===page.mainFrame())documents++;});
 const link=page.getByRole('link',{name:'1 reply',exact:true});await link.focus();await page.keyboard.press('Enter');
 await expect(page).toHaveURL(/channel=opencrawl&thread=101$/);
 const pane=page.getByRole('complementary',{name:'Thread',exact:true});
 await expect(pane.getByText('An operator announcement',{exact:true})).toBeVisible();await expect(pane.getByText('Agent thread reply',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Close thread',exact:true})).toBeFocused();
 await page.keyboard.press('Escape');await expect(pane).toHaveCount(0);await expect(link).toBeFocused();
 await page.keyboard.press('Enter');await expect(pane).toBeVisible();
 await page.getByRole('link',{name:'Permalink to message #102',exact:true}).click();await expect(page.locator('[data-board-anchor="post:102"]')).toBeFocused();
 await page.goBack();await page.goBack();await expect(page.getByText('Agent thread reply',{exact:true})).toHaveCount(0);
 await page.goForward();await expect(page.getByText('Agent thread reply',{exact:true})).toBeVisible();expect(documents).toBe(0);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:info.outputPath(`announcement-thread-${width}.png`)});
 await page.route('**/api/console/board?*',route=>route.fulfill({status:403,json:{error:'Workspace access revoked'}}));
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(page.locator('.oc-board-post')).toHaveCount(0);
});

test('board search finds a reply and returns to its results after opening the thread',async({page})=>{
  const root={...messages[0]!,topic:'release',threadId:1,text:'Release planning'};
  const reply={...root,id:75,text:'The rollback is ready'};
  await page.route('**/api/console/board?*',route=>{
    const q=new URL(route.request().url()).searchParams;
    if(q.has('query'))return route.fulfill({json:{messages:[reply],topicSummaries:[],next:null,searchPage:{total:1,cursor:null}}});
    if(q.has('threadId'))return route.fulfill({json:{threadRoot:root,messages:[reply],topicSummaries:[],next:null}});
    return route.fallback();
  });
  await page.goto('/messages');
  const search=page.getByRole('searchbox',{name:'Search channels and messages'});
  await search.fill('rollback');
  const results=page.getByRole('region',{name:'Matching messages'});
  await expect(results.getByRole('heading')).toHaveText('1 message');
  await expect(results.locator('mark:visible')).toHaveText('rollback');
  await results.getByRole('link').click();
  await expect(page.getByRole('complementary',{name:'Thread'}).locator('[data-board-anchor="post:75"]')).toBeFocused();
  await page.getByRole('button',{name:'Close thread'}).click();
  await expect(search).toHaveValue('rollback');
  await expect(results.getByRole('link')).toBeVisible();
});

test('an old post bookmark opens its exact canonical target and survives reload',async({page})=>{
  const path='/board/fixtureboard1/posts/4';
  await page.route('**/api/console/board-target?*',route=>{
    const target=new URL(route.request().url()).searchParams.get('path');
    return target===path ? route.fulfill({json:{kind:'posts',channel:topic,id:4,root:4}}) : route.fulfill({status:404,json:{error:'Missing target'}});
  });
  await page.goto(permalink(4)+'&links');
  await expect(page).toHaveURL(url=>url.pathname===path && !url.search);
  const selected=page.locator('[data-board-anchor="post:4"]');
  await expect(selected).toBeFocused();
  await expect(selected.getByRole('link',{name:'Permalink to message #4'})).toHaveAttribute('href',path);
  await page.reload();
  await expect(selected).toBeFocused();
  await page.goto('/board/otherboard12/posts/4');
  await expect(page.getByText('Board destination unavailable',{exact:true})).toBeVisible();
  await expect(selected).toHaveCount(0);
});
