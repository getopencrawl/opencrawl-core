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
  await page.clock.setFixedTime(new Date(today + 12 * 3600000));
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
    return route.fulfill({json: {cacheScope: scope, source: 'index', range, total: daily.reduce((sum, d) => sum + (d.count ?? 0), 0), daily}});
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
  await expect(page.getByRole('tablist', {name: 'Usage'}).getByRole('tab')).toHaveText(['Overview', 'Searches', 'Proactive suggestions', 'Team', 'Activity', 'Sources']);
  await expect(tab(page, 'Overview')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', {name:'30 days', exact:true})).toHaveAttribute('aria-pressed','true');
  for (const name of ['Overview', 'Searches', 'Proactive suggestions', 'Team', 'Activity', 'Sources']) {
    await tab(page, name).click();
    if (['Overview', 'Searches', 'Proactive suggestions', 'Team'].includes(name)) await expect(page.locator('.report-bar-chart')).toHaveCount(name === 'Overview' ? 2 : 1);
    if (['Overview', 'Searches', 'Proactive suggestions', 'Team'].includes(name)) await expect(page.locator('.report-bar-chart .report-bar-axis').first()).toHaveText('0');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    await page.screenshot({path: info.outputPath(`${name.replace(/ /g, '-').toLowerCase()}-${width}.png`)});
  }
});

test('Overview shows the three observed metrics, both UTC charts and five searchable events', async ({page}) => {
  const receipts = await serve(page);
  const page2 = 'a'.repeat(32);
  const history: unknown[] = [];
  await page.route('**/api/console/usage/search-history', route => {
    const input = route.request().postDataJSON();
    history.push(input);
    const keywords=Array.from({length:input.before?2:7},(_,i)=>({...searchRow(i + (input.before?7:0),'agent'), agentName:i===0?'Otter':undefined}));
    const blanks=[[],[''],['  \t']].map((queries,i)=>({...searchRow(100+i,'agent'),queries}));
    return route.fulfill({json:{cacheScope:scope,rows:[...blanks,...keywords],next:input.before?null:page2}});
  });
  await page.goto('/usage?split&activity');
  await expect(page.locator('.report-metric dt')).toHaveText(['Agent searches','OpenCrawl context edits','Session tokens indexed']);
  await expect(metric(page,'Agent searches')).toHaveText('735');
  await expect(metric(page,'Session tokens indexed')).toHaveText('0.92 Mtok');
  const left = page.getByRole('img',{name:'Agent searches per day'}), right = page.getByRole('img',{name:'Session tokens indexed per day'});
  await expect(left.locator('.report-bar-hit')).toHaveCount(30);
  await expect(right.locator('.report-bar-hit')).toHaveCount(30);
  const recent=page.getByRole('region',{name:'Recent agent queries',exact:true});
  await expect(recent.locator('tbody tr')).toHaveCount(5);
  await expect(recent.locator('.usage-query')).toHaveText(Array.from({length:5},(_,i)=>'agent query '+i));
  await expect(recent.getByRole('img',{name:'Alex Example / Otter'})).toBeVisible();
  await page.getByRole('button',{name:'View all searches'}).click();
  const dialog=page.getByRole('dialog',{name:'Recent agent queries'});
  await expect(dialog.locator('tbody tr').first()).toContainText('agent query 0');
  await dialog.locator('tbody tr').last().scrollIntoViewIfNeeded();
  await expect(dialog.locator('tbody tr')).toHaveCount(9);
  await page.keyboard.press('Escape');
  await expect(recent.locator('tbody tr')).toHaveCount(5);
  await page.getByRole('button',{name:'90 days',exact:true}).click();
  await expect(right.locator('.report-bar-hit')).toHaveCount(90);
  await expect(left.locator('.report-bar-hit')).toHaveCount(90);
  await page.getByRole('button',{name:'7 days',exact:true}).click();
  await expect(right.locator('.report-bar-hit')).toHaveCount(7);
  await expect(left.locator('.report-bar-hit')).toHaveCount(7);
  await page.getByRole('button',{name:'Cumulative',exact:true}).click();
  await expect(page.getByRole('img',{name:'Cumulative indexed session tokens'}).locator('polyline')).toBeVisible();
  expect(receipts.tokens).toEqual(['all']);
  expect(history).toContainEqual({kind:'agent',range:'30d',basis:'events',withQuery:true,before:page2});
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
  await tab(page, 'Proactive suggestions').click();
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
  await expect(page.locator('.report-metric')).toHaveCount(0);
});

test('recent query retries leave the independent token chart visible', async ({page}) => {
  await serve(page);
  let fail=true;
  await page.route('**/api/console/usage/search-history',route=>fail?route.fulfill({status:503,json:{error:'unavailable'}}):route.fulfill({json:{cacheScope:scope,rows:[searchRow(0,'agent')],next:null}}));
  await page.goto('/usage?split&activity');
  await expect(page.getByText('Recent searches couldn’t update.')).toBeVisible();
  await expect(page.getByRole('img',{name:'Session tokens indexed per day'})).toBeVisible();
  fail=false;
  await page.getByRole('button',{name:'Try again'}).click();
  await expect(page.getByRole('region',{name:'Recent agent queries'}).getByRole('table')).toContainText('agent query 0');
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
  await page.goto('/usage?split&activity');
  await tab(page, 'Sources').click();
  await expect(summary).toContainText('Indexed item counts unavailable.');
  await expect(summary.locator('.report-chart-total')).toHaveText('Unavailable');
});

test('slow lists and charts show a visible spinner instead of a blank panel', async ({page}) => {
  await serve(page);
  let release = () => {};
  const held = new Promise<void>(resolve => {release = resolve;});
  await page.route('**/api/console/usage/search-history', async route => {await held; await route.fulfill({json: {cacheScope:scope,rows:[searchRow(0,'agent')],next:null}});});
  await page.goto('/usage?split&activity');
  await expect(page.getByText('Loading recent searches…')).toBeVisible();
  release();
  await expect(page.getByRole('region',{name:'Recent agent queries'}).getByRole('table')).toBeVisible();
});

test('with a billing meter every search row shows what it cost and why, and the arithmetic adds up', async ({page}) => {
  await serve(page);
  const charge = (credits: number, reason: string) => ({charge: {credits, reason}});
  const agentRows = [
    {...searchRow(0, 'agent'), operation: 'Workspace', returned: 4, ...charge(3, 'charged')},
    {...searchRow(1, 'agent'), userId: 'user_sam', operation: 'Board', returned: 0, ...charge(0, 'no_results')},
    {...searchRow(2, 'agent'), operation: 'Sessions', returned: null, outcome: 'failed', ...charge(0, 'failed')},
    {...searchRow(3, 'agent'), userId: 'user_sam', operation: 'Workspace', queries: [], sessionId: null, returned: 2, withheld: 'private', ...charge(3, 'charged')},
    {...searchRow(4, 'agent'), queries: [], sessionId: null, withheld: 'session_deleted', ...charge(3, 'charged')},
    {...searchRow(5, 'agent'), userId: '', operation: '', queries: [], harness: null, sessionId: null, returned: null, withheld: 'unrecorded', ...charge(3, 'charged')},
  ];
  await page.route('**/api/console/usage/calls', route => route.fulfill({json: {cacheScope: scope, since: day(3) + 'T00:00:00.000Z', calls: 9, agentSearches: 4, proactiveChecks: 9, nonSilent: 1, delivered: 0,
    charged: true, rates: {agent: 3, proactive: 10}, uncharged: {noResults: 1, failed: 1}, daily: span(30, () => 0).map(({date}) => ({date, agentSearches: 0, nonSilent: 0}))}}));
  await page.route('**/api/console/usage/search-history', route => {
    const {kind} = route.request().postDataJSON() as {kind: string};
    return route.fulfill({json: {cacheScope: scope, next: null, rows: kind === 'agent' ? agentRows : [{...searchRow(0, 'proactive'), operation: 'Context check', returned: 1, ...charge(10, 'charged')}]}});
  });
  await page.goto('/usage?split&activity');
  await tab(page, 'Searches').click();
  const panel = page.getByRole('region', {name: 'Searches', exact: true}), list = panel.getByRole('table'), rows = list.locator('tbody tr');
  await expect(panel.locator('.usage-charge-summary')).toHaveText('4 searches charged × 3 credits = 12 credits. 1 search with no results and 1 failed: free.');
  await expect(list.locator('thead th')).toHaveText(['Time', 'Query', 'Searched', 'Results', 'From', 'Session', 'Charge']);
  await expect(rows).toHaveCount(6);
  const cells = (index: number) => rows.nth(index).locator('td');
  await expect(cells(0)).toContainText(['agent query 0', 'Workspace', '4', 'Alex Example', 's0', '3 credits']);
  await expect(cells(1).nth(6)).toHaveText('FreeNo results');
  await expect(cells(2).nth(6)).toHaveText('FreeSearch failed');
  await expect(cells(3).nth(1)).toHaveText('Private session');
  await expect(cells(3).nth(6)).toHaveText('3 credits');
  await expect(cells(3).nth(4)).toContainText('Sam Example');
  await expect(cells(4).nth(1)).toHaveText('Deleted with its session');
  await expect(cells(5).nth(1)).toHaveText('Recorded before search text was kept');
  await expect(cells(5).nth(4)).toHaveText('Not recorded');
  // The charged rows on screen are the charge.
  expect(await rows.filter({hasText: '3 credits'}).count()).toBe(4);
  await tab(page, 'Proactive suggestions').click();
  const edits = page.getByRole('region', {name: 'Edits', exact: true});
  await expect(edits.locator('.usage-charge-summary')).toHaveText('1 edit charged × 10 credits = 10 credits.');
  await expect(edits.getByRole('table').locator('thead th')).toHaveText(['Time', 'Triggering message', 'Search', 'Results', 'From', 'Session', 'Charge']);
  await expect(edits.getByRole('table').locator('tbody tr').first()).toContainText('10 credits');
});

test('Overview ignores billing snapshots and retains observed metrics across range changes', async ({page}) => {
  await serve(page);
  await page.route('**/api/console/usage/tokens',route=>route.fulfill({json:{cacheScope:scope,source:'meter',range:'all',total:5_000_000,daily:[]}}));
  await page.goto('/usage?split&activity');
  await expect(metric(page,'Session tokens indexed')).toHaveText('Unavailable');
  await expect(metric(page,'Agent searches')).toHaveText('735');
  await page.getByRole('button',{name:'7 days',exact:true}).click();
  await expect(metric(page,'Agent searches')).toHaveText('252');
  await expect(page.getByText('Tokens stored')).toHaveCount(0);
});
