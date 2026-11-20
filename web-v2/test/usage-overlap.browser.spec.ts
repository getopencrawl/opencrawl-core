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

test('a first-load overlap failure keeps healthy sections visible and retries only when requested or scheduled', async ({page}) => {
  await page.clock.install();
  let data: UsageReport={...report(),overlap:null,failedSources:['overlap']};
  let reads=0;
  await page.route('**/api/console/usage',route=>{reads++;return route.fulfill({json:data});});
  await page.goto('/usage');
  await expect(page.getByRole('heading',{name:'Daily agent sessions',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Data sources',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Team',exact:true})).toBeVisible();
  const overlap=page.getByRole('region',{name:'Main session overlap',exact:true});
  await expect(overlap.getByText('Session overlap couldn’t load.',{exact:false})).toBeVisible();
  await expect(page.locator('.report-line-chart')).toHaveCount(0);
  expect(reads).toBe(1);
  data=report();
  await overlap.getByRole('button',{name:'Try again'}).click();
  await expect(page.locator('.report-line-chart')).toBeVisible();
  await expect(overlap.getByRole('button',{name:'Try again'})).toHaveCount(0);
});

test('partial refresh updates healthy metrics, retains the failed chart with its age, and clears after denial', async ({page}) => {
  await page.clock.install();
  let data=report(),status=200;
  await page.route('**/api/console/usage',route=>status===200?route.fulfill({json:data}):route.fulfill({status,json:{error:'Access denied'}}));
  await page.goto('/usage');
  const chart=page.locator('.report-line-chart');
  await expect(chart).toBeVisible();
  data={...report(),overlap:null,failedSources:['overlap'],generatedAt:'2026-11-13T12:01:00Z'};
  data.agents!.sessions=99;
  await page.clock.runFor(60_001);
  await expect(page.getByText('99',{exact:true})).toBeVisible();
  await expect(chart).toBeVisible();
  await expect(page.getByText('Session overlap couldn’t update.',{exact:false})).toContainText('Showing data updated');
  data=report();data.overlap!.daily[0]!.peak=77;
  await page.clock.runFor(60_001);
  await expect(chart.locator('.report-line-hit').first().locator('title')).toContainText('peak 77 sessions');
  await expect(page.getByText('Session overlap couldn’t update.',{exact:false})).toHaveCount(0);
  status=403;
  await page.clock.runFor(60_001);
  await expect(chart).toHaveCount(0);
});

for (const width of [1440, 390]) test(`source counts fail locally, keep live connections and recover at ${width}px`, async ({page}, info) => {
  await page.setViewportSize({width, height: 900});
  await page.clock.install();
  const source = {name: 'Slack', icon: '/assets/integrations/slack.svg', state: 'synced', records: 25, indexed: null, lastSyncedAt: null};
  let data: UsageReport = {...report(), ingestion: {sources: [source], index: null}, failedSources: ['connectors']};
  await page.route('**/api/console/usage', route => route.fulfill({json: data}));
  await page.goto('/usage');
  const section = page.getByRole('region', {name: 'Data sources', exact: true});
  const card = section.getByRole('article', {name: 'Slack'});
  const retry = section.getByRole('button', {name: 'Retry counts'});
  await expect(card).toContainText('Indexed item counts unavailable.');
  await expect(card).toContainText('Synced');
  await expect(section.getByRole('status')).toHaveCount(0);
  await retry.focus();
  await expect(retry).toBeFocused();
  await section.screenshot({path: info.outputPath(`count-unavailable-${width}.png`)});

  data = {...report(), ingestion: {sources: [{...source, indexed: 7, indexedSpecies: [{name: 'message', count: 7}]}], index: null}};
  await retry.press('Enter');
  await expect(card.getByRole('list')).toHaveText('Messages7');
  await expect(retry).toHaveCount(0);
  // A fresh list can drop an old connection and change sync state even while counts fail.
  data = {...report(), ingestion: {sources: [{...source, name: 'GitHub', icon: '/assets/integrations/github.svg', state: 'syncing'}], index: null}, failedSources: ['connectors']};
  await page.clock.runFor(60_001);
  await expect(card).toHaveCount(0);
  const github = section.getByRole('article', {name: 'GitHub'});
  await expect(github).toContainText('Indexed item counts unavailable.');
  await expect(github).toContainText('Syncing');

  data = {...report(), ingestion: null, failedSources: ['integrations', 'connectors']};
  await page.clock.runFor(60_001);
  const notice = section.getByRole('status');
  await expect(notice).toContainText('Connected sources couldn’t update.');
  await expect(notice).toContainText('Showing data updated');
  await expect(github).toBeVisible();
  await expect(retry).toHaveCount(0);
  const message = await notice.getByText('Connected sources couldn’t update.', {exact: false}).boundingBox();
  const action = await notice.getByRole('button', {name: 'Try again'}).boundingBox();
  expect(message && action && (action.x >= message.x + message.width + 8 || action.y >= message.y + message.height + 4)).toBeTruthy();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
  await section.screenshot({path: info.outputPath(`list-unavailable-${width}.png`)});

  data = {...report(), ingestion: {sources: [{...source, indexed: 0, indexedSpecies: []}], index: null}};
  await page.clock.runFor(60_001);
  await expect(card).toContainText('No content yet.');
  await expect(notice).toHaveCount(0);
});

test('captured tokens render while charts are pending, and a changed workspace clears both', async ({page}) => {
  const data = report();
  const {workspace, value, capture, ...details} = data;
  let release = () => {};
  const held = new Promise<void>(resolve => {release = resolve;});
  let scope = 'usage-fixture', highlightReads = 0, detailReads = 0;
  await page.clock.install();
  await page.route('**/api/console/usage/highlights', route => {
    highlightReads++;
    return route.fulfill({json: {workspace, value, capture: {tokens: 42, since: '2026-11-01'}, days: data.days, generatedAt: data.generatedAt, cacheScope: 'usage-fixture'}});
  });
  await page.route('**/api/console/usage/details', async route => {
    detailReads++;
    await held;
    await route.fulfill({json: {...details, cacheScope: scope}});
  });
  try {
    await page.goto('/usage?split');
    await expect(page.getByText('42', {exact: true})).toBeVisible();
    await expect(page.getByText('Loading usage details')).toBeVisible();
    await expect(page.getByRole('heading', {name: 'Data sources'})).toHaveCount(0);
    expect([highlightReads, detailReads]).toEqual([1, 1]);
  } finally {release();}
  await expect(page.getByRole('heading', {name: 'Daily agent sessions'})).toBeVisible();
  scope = 'different-workspace';
  await page.clock.runFor(60_001);
  await expect(page.getByText('Your workspace changed. Reload this page.')).toBeVisible();
  await expect(page.getByText('42', {exact: true})).toHaveCount(0);
  await expect(page.getByRole('heading', {name: 'Daily agent sessions'})).toHaveCount(0);
});

for(const width of [1280,390])test(`search history shows the triggering turn and pages independently at ${width}px`,async({page},info)=>{
  await page.setViewportSize({width,height:900});
  const now='2026-11-19T12:45:00Z';
  const row={id:'first',at:now,userId:'user_member',operation:'Workspace',queries:['billing retry'],
    harness:'codex',sessionId:'abc-123',message:'Why did the retry fail?',messageId:'prompt-24',returned:1,outcome:'complete',delivered:false};
  await page.route('**/api/console/usage',route=>route.fulfill({json:report()}));
  await page.route('**/api/console/usage/calls',route=>route.fulfill({json:{cacheScope:'usage-fixture',since:now,calls:112,agentSearches:16,proactiveChecks:9,nonSilent:3,delivered:2}}));
  const reads:string[]=[];
  await page.route('**/api/console/usage/search-history',route=>{
    const {kind,before}=route.request().postDataJSON();reads.push(kind);
    return route.fulfill({json:{cacheScope:'usage-fixture',rows:[before?{...row,id:'older',queries:['previous query']}:row],next:!before&&kind==='agent'?'next-page':null}});
  });
  await page.goto('/usage?activity=1');
  const agent=page.getByRole('region',{name:'Agent searches',exact:true}).getByRole('table'),proactive=page.getByRole('region',{name:'Proactive searches',exact:true}).getByRole('table');
  await expect(proactive).toContainText('Why did the retry fail?');
  await expect(proactive).toContainText('prompt-24');
  await expect(proactive.getByRole('link')).toHaveAttribute('href','/sessions?user=user_member&harness=codex&id=abc-123');
  await expect(proactive).toContainText('Non-silent');
  await expect(agent).toContainText('billing retry');
  await page.getByRole('button',{name:'Older searches'}).click();
  await expect(agent).toContainText('previous query');
  await expect(proactive).toContainText('billing retry');
  await page.getByRole('button',{name:'Newer searches'}).click();
  await expect(agent).toContainText('billing retry');
  expect(reads.filter(kind=>kind==='proactive')).toHaveLength(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+1);
  await page.getByRole('region',{name:'OpenCrawl activity'}).screenshot({path:info.outputPath(`searches-${width}.png`)});
});
