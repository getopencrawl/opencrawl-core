import {test, expect} from '@playwright/test';
import type {SessionSummary,TranscriptEvent} from '../src/pages/library-types.js';

const base: SessionSummary = {userId: 'alice', harness: 'codex', sessionId: 'single', title: 'Single machine', private: false, mine: true, origin: 'desktop', host: 'laptop.local', hosts: ['laptop.local'], hostsTruncated: false, firstActivityAt: null, lastActivityAt: '2026-11-11T10:00:00Z', events: 2};
const sessions: SessionSummary[] = [{...base, capturedTokens: 12432},
  {...base, sessionId: 'multiple', title: 'Continued on another machine', hosts: ['laptop.local', 'runner-42'], capturedTokens: 1200000},
  {...base, sessionId: 'missing', title: 'Older capture', host: null, hosts: [], capturedTokens: null},
  {...base, sessionId: 'legacy', title: 'Older adapter', host: 'legacy.local', hosts: undefined},
  {...base, sessionId: 'long', title: 'Long hostname', host: 'build-'.repeat(40) + '.local', hosts: ['build-'.repeat(40) + '.local']},
  {...base, sessionId: 'bounded', title: 'Many capture machines', hosts: ['runner-a', 'runner-b'], hostsTruncated: true, capturedTokens: 0},
];

for (const width of [1440, 390]) test(`multiple participants filter sessions, preserve search and browser history at ${width}px`, async ({page, request}, testInfo) => {
  await request.post('/__test/reset', {data: {}});
  await page.setViewportSize({width, height: 900});
  const alice = {id: 'replicas:50000000-0000-4000-8000-000000000001', name: 'Alice'}, bob = {id: 'replicas:50000000-0000-4000-8000-000000000002', name: 'Bob'};
  const rows: SessionSummary[] = [{...base, mine: false, title: 'Shared lighthouse session', participants: [alice, bob]}, {...base, mine: false, sessionId: 'second', title: 'Bob lighthouse session', participants: [bob]}, {...base, mine: false, sessionId: 'unknown', title: 'Unknown lighthouse sender', participants: []}];
  const reads: Array<{participant?: string; query?: string; limit?: number}> = [];
  await page.route('**/api/library/**', async route => {
    const input = route.request().postDataJSON() as {participant?: string; query?: string; limit?: number}; reads.push(input);
    const shown = rows.filter(session => (!input.participant || session.participants?.some(person => person.id === input.participant)) && (!input.query || session.title.includes(input.query)));
    await route.fulfill({json: {sessions: shown, limit: input.limit}});
  });
  await page.goto('/sessions?q=lighthouse');
  await expect(page.getByRole('tab', {name: 'My sessions'})).toHaveCount(0);
  await expect(page.locator('.oc-rows .oc-row')).toHaveCount(3);
  await expect(page.locator('.oc-row-participants').getByRole('link', {name: 'Alice', exact: true})).toBeVisible();
  let navigations = 0; page.on('request', request => {if (request.isNavigationRequest()) navigations++;});
  await page.locator('.oc-row-participants').getByRole('link', {name: 'Alice', exact: true}).press('Enter');
  await expect(page.getByRole('button', {name: 'Remove participant filter: Alice'})).toBeVisible();
  await expect(page.locator('.oc-rows .oc-row')).toHaveCount(1);
  expect(reads.at(-1)).toEqual({scope: 'all', query: 'lighthouse', participant: alice.id, limit: 50});
  await page.locator('.oc-row-participants').getByRole('link', {name: 'Bob', exact: true}).click();
  await expect(page.locator('.oc-rows .oc-row')).toHaveCount(2);
  await expect(page.getByRole('button', {name: 'Remove participant filter: Bob'})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path: testInfo.outputPath(`session-participants-${width}.png`), fullPage: true});
  await page.getByRole('button', {name: 'Remove participant filter: Bob'}).click();
  await expect(page.locator('.oc-rows .oc-row')).toHaveCount(3);
  await expect(page.getByRole('searchbox', {name: 'Search sessions'})).toHaveValue('lighthouse');
  await page.goBack(); await expect(page.getByRole('button', {name: 'Remove participant filter: Bob'})).toBeVisible();
  await page.goBack(); await expect(page.getByRole('button', {name: 'Remove participant filter: Alice'})).toBeVisible();
  await page.goForward(); await expect(page.getByRole('button', {name: 'Remove participant filter: Bob'})).toBeVisible();
  expect(navigations).toBe(0);
  await page.reload();
  await expect(page.getByRole('button', {name: 'Remove participant filter: Bob'})).toBeVisible();
  await expect(page.locator('.oc-rows .oc-row')).toHaveCount(2);
});

for(const width of [1440,390]) test(`shared Replicas transcript labels each sender at ${width}px`,async({page,request},testInfo)=>{
  await request.post('/__test/reset',{data:{}});
  await page.setViewportSize({width,height:900});
  const actor:NonNullable<TranscriptEvent['actor']>={provider:'replicas',assurance:'collector-reported',kind:'human',workspaceId:'10000000-0000-4000-8000-000000000001',nativeId:'40000000-0000-4000-8000-000000000001',messageId:'user-1',userId:'50000000-0000-4000-8000-000000000001',name:'Alice'};
  const message=(id:string,text:string,sender:typeof actor):TranscriptEvent=>({eventId:id,kind:'message',timestamp:null,actor:sender,entries:[{type:'message',role:'user',text}]});
  const events=[message('first','First human message',actor),message('second','Second human message',{...actor,userId:'50000000-0000-4000-8000-000000000002',name:'Bob',messageId:'user-2'}),message('unknown','API input',{...actor,kind:'unknown',userId:undefined,name:undefined,messageId:'api-3'})];
  await page.route('**/api/library/**',route=>route.fulfill({json:{session:base,events,total:3,next:null,authors:{alice:'Workspace capture'}}}));
  await page.goto('/sessions?user=alice&harness=codex&id=single');
  const gutter=page.locator('.oc-log-user .oc-log-gutter strong');
  await expect(gutter).toHaveText(['Alice','Bob','Unknown sender']);
  await expect(gutter.first()).toHaveAttribute('title','Replicas sender reported by capture');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath(`replicas-senders-${width}.png`),fullPage:true});
});

for (const width of [1440, 1024, 801, 390]) {
  test(`session hostnames stay readable and navigable at ${width}px`, async ({page, request}, testInfo) => {
    await request.post('/__test/reset', {data: {}});
    await page.setViewportSize({width, height: 900});
    await page.route('**/api/library/**', async route => {
      const input = route.request().postDataJSON() as {sessionId?: string};
      const session = sessions.find(value => value.sessionId === input.sessionId) ?? base;
      await route.fulfill({json: route.request().url().endsWith('/sessions/read')
        ? {session, events: [], total: 0, next: null, authors: {alice: 'Alex'}}
        : {sessions, limit: 50, authors: {alice: 'Alex'}}});
    });
    await page.goto('/sessions');
    const row = (name: string) => page.locator('.oc-row-item').filter({has: page.getByRole('link', {name: new RegExp(name)})});
    await expect(row('Single machine').locator('.oc-row-host')).toContainText('laptop.local');
    await expect(row('Single machine').locator('.oc-row-tokens')).toContainText('12.4k');
    await expect(row('Single machine').locator('.oc-row-tokens')).toHaveAttribute('title', /^12,432 captured tokens/);
    await expect(row('Continued on another machine').locator('.oc-row-tokens')).toContainText('1.2M');
    await expect(row('Older capture').locator('.oc-row-tokens')).toContainText('—');
    await expect(row('Older adapter').locator('.oc-row-tokens')).toContainText('—');
    await expect(row('Many capture machines').locator('.oc-row-tokens')).toContainText('0');
    await expect(row('Continued on another machine').locator('.oc-row-host')).toContainText('Multiple hosts');
    await expect(row('Continued on another machine').locator('.oc-row-host')).toHaveAttribute('title', /laptop\.local, runner-42/);
    await expect(row('Older capture').locator('.oc-row-host')).toContainText('—');
    await expect(row('Older adapter').locator('.oc-row-host')).toContainText('legacy.local');
    await expect(row('Many capture machines').locator('.oc-row-host')).toContainText('Multiple hosts');
    await expect(row('Many capture machines').locator('.oc-row-host')).toHaveAttribute('aria-label', 'Hostname: runner-a, runner-b, …');
    await expect(row('Long hostname').locator('.oc-row-host')).toHaveAttribute('title', /build-build-build-/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width > 800) await expect(page.locator('.oc-row-heading .oc-row-host')).toHaveText('Hostname');
    await page.screenshot({path: testInfo.outputPath(`session-hostnames-${width}.png`), fullPage: true});

    let documents = 0;
    page.on('request', request => {if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++;});
    const link = row('Continued on another machine').getByRole('link', {name: 'Continued on another machine', exact: true});
    await link.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.oc-library-meta')).toContainText('laptop.local, runner-42');
    await page.goBack();
    await expect(row('Single machine')).toBeVisible();
    await page.goForward();
    await expect(page.locator('.oc-library-meta')).toContainText('laptop.local, runner-42');
    expect(documents).toBe(0);
  });
}
