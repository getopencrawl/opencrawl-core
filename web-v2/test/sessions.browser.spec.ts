import {test, expect} from '@playwright/test';
import type {SessionSummary,TranscriptEvent} from '../src/pages/library-types.js';

test('an old bookmark becomes a canonical link that reopens and reloads the same transcript',async({page})=>{
  const permalinkId='oc_'+'a'.repeat(32);
  const requested:Array<Record<string,unknown>>=[];
  await page.route('**/api/library/sessions/read',async route=>{
    requested.push(route.request().postDataJSON() as Record<string,unknown>);
    await route.fulfill({json:{session:{...base,permalinkId},events:[],total:0,next:null}});
  });
  await page.goto('/sessions?user=alice&harness=codex&id=single');
  await expect(page).toHaveURL(url=>url.pathname==='/sessions/'+permalinkId && url.search==='');
  await page.reload();
  await expect(page.getByRole('heading',{name:'Single machine'})).toBeVisible();
  expect(requested[0]).toMatchObject({userId:'alice',harness:'codex',sessionId:'single'});
  expect(requested.at(-1)).toMatchObject({permalinkId});
  expect(requested.at(-1)).not.toHaveProperty('userId');
});

const base: SessionSummary = {userId: 'alice', harness: 'codex', sessionId: 'single', title: 'Single machine', private: false, mine: true, origin: 'desktop', host: 'laptop.local', hosts: ['laptop.local'], hostsTruncated: false, firstActivityAt: null, lastActivityAt: '2026-11-11T10:00:00Z', events: 2};
const sessions: SessionSummary[] = [{...base, capturedTokens: 12432},
  {...base, sessionId: 'multiple', harness: 'external-recorder', title: 'Continued on another machine', hosts: ['laptop.local', 'runner-42'], capturedTokens: 1200000},
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
    await page.getByRole('button', {name: 'Session details', exact: true}).click();
    await expect(page.locator('.oc-library-meta')).toContainText('laptop.local, runner-42');
    await page.goBack();
    await expect(row('Single machine')).toBeVisible();
    await page.goForward();
    await page.getByRole('button', {name: 'Session details', exact: true}).click();
    await expect(page.locator('.oc-library-meta')).toContainText('laptop.local, runner-42');
    expect(documents).toBe(0);
  });
}

for (const width of [1440, 390]) test(`conversation shows full messages, event counts and the actual latest page at ${width}px`, async ({page, request}, testInfo) => {
  await request.post('/__test/reset', {data: {}});
  await page.setViewportSize({width, height: 844});
  const actor: NonNullable<TranscriptEvent['actor']> = {provider: 'replicas', assurance: 'collector-reported', kind: 'human', workspaceId: 'workspace', nativeId: 'session', messageId: 'human', userId: 'alice', name: 'Alice'};
  const empty: TranscriptEvent = {eventId: 'empty', kind: 'capture', timestamp: null, entries: []};
  const tool: TranscriptEvent = {eventId: 'tool', kind: 'tool', timestamp: null, entries: [{type: 'tool_call', name: 'Read', input: 'file', truncated: false}, {type: 'tool_result', text: 'result', truncated: false}]};
  const human: TranscriptEvent = {eventId: 'human', kind: 'message', timestamp: '2026-11-13T21:37:27Z', actor, entries: [{type: 'message', role: 'user', text: 'Complete beginning. ' + 'Recorded paragraph. '.repeat(180) + 'Final sentence.'}]};
  const assistant: TranscriptEvent = {eventId: 'assistant', kind: 'message', timestamp: '2026-11-13T21:38:00Z', entries: [{type: 'message', role: 'assistant', text: 'Latest response.'}]};
  const cursors: Array<string | undefined> = [];
  await page.route('**/api/library/**', async route => {
    const {direction, cursor} = route.request().postDataJSON();
    expect(direction).toBe('backward');
    cursors.push(cursor);
    await route.fulfill({json: {session: {...base, mine: false}, events: cursor ? [empty, tool, human] : [human, assistant], total: 4, next: cursor ? null : 'older', authors: {alice: 'Workspace capture'}}});
  });
  await page.goto('/sessions?user=alice&harness=codex&id=single');
  const reader = page.locator('.oc-session-reading');
  const bottomGap = () => reader.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
  await expect(page.getByRole('status')).toContainText('Showing 2 of 4 captured events.');
  await expect.poll(bottomGap).toBeLessThan(2);
  await expect(page.getByText('Latest response.', {exact: true})).toBeInViewport();
  expect(cursors).toEqual([undefined]);
  await reader.evaluate(el => {el.scrollTop = 0;});
  await page.getByRole('button', {name: 'Load older events'}).click();
  await expect(page.getByRole('status')).toContainText('Showing 4 of 4 captured events.');
  await expect(page.locator('.oc-log-user')).toContainText('Final sentence.');
  await expect(page.getByRole('button', {name: 'Show full message'})).toHaveCount(0);
  await expect(page.locator('.oc-log-tools > summary').first()).toHaveText('2 events');
  await page.locator('.oc-log-tools > summary').first().click();
  await page.locator('.oc-log-tool > summary').first().click();
  await expect(page.getByText('No displayable content in this event.')).toBeVisible();
  const info = page.getByRole('button', {name: 'Session details', exact: true});
  await expect(info).toHaveClass(/secondary/); await expect(info).toHaveText('');
  await info.press('Enter');
  await expect(page.getByRole('heading', {name: 'Session details'})).toBeFocused();
  await expect(page.getByRole('button', {name: 'Delete session', exact: true})).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(info).toBeFocused();
  await reader.evaluate(el => {el.scrollTop = 0;});
  expect(await page.locator('.oc-session-jump').evaluate(el => getComputedStyle(el).position)).toBe('absolute');
  await page.getByRole('button', {name: 'Jump to latest', exact: true}).click();
  await expect.poll(bottomGap).toBeLessThan(2);
  await expect(page.locator('.oc-log-user')).toHaveCount(1);
  await expect(page.getByText('Latest response.', {exact: true})).toBeInViewport();
  expect(cursors).toEqual([undefined, 'older']);
  await expect(page.getByText('End of captured session', {exact: true})).toHaveCount(0);
  await reader.evaluate(el => {el.scrollTop = el.scrollHeight - el.clientHeight - 199;});
  await expect(page.locator('.oc-session-jump')).toHaveCount(0);
  await reader.evaluate(el => {el.scrollTop = el.scrollHeight - el.clientHeight - 201;});
  await page.getByRole('button', {name: 'Jump to latest', exact: true}).click();
  await expect(page.locator('.oc-session-jump')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path: testInfo.outputPath(`conversation-${width}.png`)});
});

for (const width of [1440, 390]) test(`older pages preserve the reading position at ${width}px`, async ({page, request}) => {
  await request.post('/__test/reset', {data: {}});
  await page.setViewportSize({width, height: 844});
  const cursors: Array<string | undefined> = [];
  await page.route('**/api/library/**', async route => {
    const {cursor, direction} = route.request().postDataJSON();
    expect(direction).toBe('backward');
    cursors.push(cursor);
    const text = (cursor ?? 'Latest') + ' ' + 'Recorded paragraph. '.repeat(450);
    const event = {eventId: cursor ?? 'latest', kind: 'message', timestamp: null, entries: [{type: 'message', role: 'assistant', text}]};
    await route.fulfill({json: {session: base, events: [event], total: 3, next: cursor === 'first' ? null : cursor ? 'first' : 'middle'}});
  });
  await page.goto('/sessions?user=alice&harness=codex&id=single');
  const reader = page.locator('.oc-session-reading');
  const load = page.getByRole('button', {name: 'Load older events'});
  for (const [prefix, count] of [['Latest', 2], ['middle', 3]] as const) {
    await reader.evaluate(el => {el.scrollTop = 0;});
    const row = page.locator('.oc-log-assistant').filter({hasText: prefix});
    const top = await row.evaluate(el => el.getBoundingClientRect().top);
    await load.click();
    await expect(page.getByRole('status')).toContainText(`Showing ${count} of 3 captured events.`);
    expect(Math.abs(await row.evaluate(el => el.getBoundingClientRect().top) - top)).toBeLessThan(2);
  }
  expect(cursors).toEqual([undefined, 'middle', 'first']);
  await expect(load).toHaveCount(0);
  await expect(page.locator('.oc-log-assistant')).toHaveText([/first/, /middle/, /Latest/]);
  await page.reload();
  await expect(page.getByRole('status')).toContainText('Showing 1 of 3 captured events.');
  await expect.poll(() => reader.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2);
});

test('a denied transcript page clears already loaded conversation content', async ({page, request}) => {
  await request.post('/__test/reset', {data: {}});
  await page.route('**/api/library/**', async route => {
    const {cursor} = route.request().postDataJSON() as {cursor?: string};
    if (cursor) return route.fulfill({status: 403, json: {error: 'Session access was revoked.'}});
    await route.fulfill({json: {session: base, events: [{eventId: 'user', kind: 'message', timestamp: null, entries: [{type: 'message', role: 'user', text: 'Previously readable message.'}]}], total: 2, next: 'denied'}});
  });
  await page.goto('/sessions?user=alice&harness=codex&id=single');
  await expect(page.getByText('Previously readable message.')).toBeVisible();
  await page.getByRole('button', {name: 'Load older events', exact: true}).click();
  await expect(page.getByText('Session access was revoked.')).toBeVisible();
  await expect(page.getByText('Previously readable message.')).toHaveCount(0);
});

test('a network failure clears the transcript and retry refetches its initial page', async ({page, request}) => {
  await request.post('/__test/reset', {data: {}});
  let starts = 0;
  await page.route('**/api/library/**', async route => {
    const {cursor} = route.request().postDataJSON() as {cursor?: string};
    if (cursor) return route.abort('failed');
    starts++;
    await route.fulfill({json: {session: base, events: [{eventId: 'user', kind: 'message', timestamp: null, entries: [{type: 'message', role: 'user', text: starts === 1 ? 'Initially readable message.' : 'Freshly recovered message.'}]}], total: starts === 1 ? 2 : 1, next: starts === 1 ? 'unavailable' : null}});
  });
  await page.goto('/sessions?user=alice&harness=codex&id=single');
  await expect(page.getByText('Initially readable message.')).toBeVisible();
  await page.getByRole('button', {name: 'Load older events', exact: true}).click();
  const retry = page.getByRole('button', {name: 'Try again', exact: true});
  await expect(retry).toBeVisible();
  await expect(page.getByText('Initially readable message.')).toHaveCount(0);
  await retry.click();
  await expect(page.getByText('Freshly recovered message.')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Showing 1 of 1 captured events.');
  expect(starts).toBe(2);
});

for(const width of [390,1440])test(`linked history opens independently of live capture at ${width}px`,async({page,request})=>{
  await request.post('/__test/reset',{data:{}});
  await page.setViewportSize({width,height:900});
  const history={userId:'workload_replicas_test',harness:'replicas' as const,sessionId:'replicas-chat:test'};
  await page.route('**/api/library/**',r=>r.fulfill({json:{sessions:[{...base,historyCapture:history}],authors:{alice:'Alice'},limit:50}}));
  await page.goto('/sessions');
  await expect(page.locator('.oc-rows .oc-row')).toHaveCount(1);
  const live=page.getByRole('link',{name:/Single machine/}),archive=page.getByRole('link',{name:'Replicas history',exact:true});
  await expect(live).toHaveAttribute('href',/harness=codex/);
  await expect(archive).toHaveAttribute('href',/harness=replicas/);
  await archive.click();
  await expect(page).toHaveURL(/harness=replicas/);
});

for (const width of [1440, 390]) test(`sessions list and transcript show a brand spinner while loading at ${width}px`, async ({page, request}, testInfo) => {
  await request.post('/__test/reset', {data: {}});
  await page.setViewportSize({width, height: 900});
  let release = () => {}, held = Promise.resolve();
  await page.route('**/api/library/**', async route => {
    await held;
    const read = route.request().url().includes('read');
    await route.fulfill({json: read ? {session: base, events: [], total: 0, next: null, authors: {}} : {sessions, limit: 50}});
  });
  for (const [path, label, loaded] of [['/sessions', 'Loading sessions', page.locator('.oc-rows .oc-row').first()], ['/sessions?user=alice&harness=codex&id=single', 'Loading session', page.getByRole('heading', {name: 'Single machine'})]] as const) {
    held = new Promise<void>(resolve => {release = resolve;});
    await page.goto(path);
    const spinner = page.locator('.oc-loading-spinner');
    await expect(spinner).toBeVisible();
    await expect(spinner).toHaveCSS('opacity', '1');
    await expect(page.getByRole('status')).toHaveText(label);
    await expect(spinner.locator('svg.oc-spin')).toHaveCSS('color', 'rgb(125, 130, 255)');
    await page.screenshot({path: testInfo.outputPath(`${label.replaceAll(' ', '-').toLowerCase()}-${width}.png`)});
    release();
    await expect(loaded).toBeVisible();
    await expect(spinner).toHaveCount(0);
  }
});
